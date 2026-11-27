import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import type { Container, Disk, GpuInfo, GpuProc, HistorySeries, HostProc, ModelService, RangeKey, Snapshot } from "./types";

const run = promisify(execFile);
const exec = async (cmd: string, args: string[], timeout = 8000) => {
  const { stdout } = await run(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
};
const num = (s: string | undefined) => {
  const n = parseFloat(s ?? "");
  return Number.isFinite(n) ? n : null;
};

/* ---------- CPU ---------- */
type CpuTimes = { idle: number; total: number };
let prevCpu: CpuTimes[] | null = null;

async function readCpuTimes(): Promise<CpuTimes[]> {
  const txt = await readFile("/proc/stat", "utf8");
  return txt
    .split("\n")
    .filter((l) => /^cpu\d*\s/.test(l))
    .map((l) => {
      const f = l.trim().split(/\s+/).slice(1).map(Number);
      const idle = f[3] + (f[4] || 0);
      return { idle, total: f.reduce((a, b) => a + b, 0) };
    });
}

async function sampleCpu() {
  const cur = await readCpuTimes();
  let usage = cur.map(() => 0);
  if (prevCpu && prevCpu.length === cur.length) {
    usage = cur.map((c, i) => {
      const dt = c.total - prevCpu![i].total;
      const di = c.idle - prevCpu![i].idle;
      return dt > 0 ? Math.max(0, Math.min(100, (1 - di / dt) * 100)) : 0;
    });
  }
  prevCpu = cur;
  return { total: usage[0], cores: usage.slice(1) };
}

async function cpuTemp(): Promise<number | null> {
  try {
    const zones = (await readdir("/sys/class/thermal")).filter((z) => z.startsWith("thermal_zone"));
    const temps: number[] = [];
    for (const z of zones) {
      const t = num(await readFile(`/sys/class/thermal/${z}/temp`, "utf8").catch(() => ""));
      if (t !== null && t > 0) temps.push(t / 1000);
    }
    return temps.length ? Math.max(...temps) : null;
  } catch {
    return null;
  }
}

/* ---------- Memory ---------- */
async function sampleMem() {
  const txt = await readFile("/proc/meminfo", "utf8");
  const g = (k: string) => parseInt(txt.match(new RegExp(`^${k}:\\s+(\\d+)`, "m"))?.[1] ?? "0") * 1024;
  const total = g("MemTotal");
  return { total, used: total - g("MemAvailable"), free: g("MemFree"), swapTotal: g("SwapTotal"), swapUsed: g("SwapTotal") - g("SwapFree") };
}

/* ---------- Disks ---------- */
async function sampleDisks(): Promise<Disk[]> {
  try {
    const out = await exec("df", [
      "-B1", "-x", "tmpfs", "-x", "devtmpfs", "-x", "squashfs", "-x", "overlay", "-x", "efivarfs", "-x", "vfat",
      "--output=source,fstype,size,used,target",
    ]);
    const seen = new Set<string>();
    return out
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((f) => f.length >= 5 && f[0].startsWith("/dev/") && !seen.has(f[0]) && seen.add(f[0]))
      .map((f) => ({ device: f[0], fs: f[1], size: Number(f[2]), used: Number(f[3]), mount: f.slice(4).join(" ") }));
  } catch {
    return [];
  }
}

/* ---------- GPU ---------- */
async function sampleGpu(totalMem: number): Promise<{ gpu: GpuInfo | null; procs: GpuProc[] }> {
  try {
    const q = "name,driver_version,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,clocks.sm,clocks.max.sm";
    const out = await exec("nvidia-smi", [`--query-gpu=${q}`, "--format=csv,noheader,nounits"], 5000);
    const f = out.trim().split("\n")[0].split(",").map((s) => s.trim());
    let procs: GpuProc[] = [];
    try {
      const p = await exec("nvidia-smi", ["--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"], 5000);
      procs = p
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [pid, name, mem] = l.split(",").map((s) => s.trim());
          return { pid: Number(pid), name: name.split("/").pop() || name, memBytes: (num(mem) ?? 0) * 1024 * 1024 };
        })
        .sort((a, b) => b.memBytes - a.memBytes);
    } catch {}
    const memUsedRaw = num(f[3]);
    const memTotalRaw = num(f[4]);
    const unified = memUsedRaw === null || memTotalRaw === null;
    const gpu: GpuInfo = {
      name: f[0],
      driver: f[1],
      util: num(f[2]) ?? 0,
      unifiedMemory: unified,
      memUsed: unified ? procs.reduce((a, p) => a + p.memBytes, 0) : memUsedRaw! * 1024 * 1024,
      memTotal: unified ? totalMem : memTotalRaw! * 1024 * 1024,
      temp: num(f[5]),
      power: num(f[6]),
      powerLimit: num(f[7]),
      clock: num(f[8]),
      maxClock: num(f[9]),
    };
    return { gpu, procs };
  } catch {
    return { gpu: null, procs: [] };
  }
}

/* ---------- Docker ---------- */
const parseSize = (s: string) => {
  const m = s.trim().match(/^([\d.]+)\s*([KMGTP]?i?B)/i);
  if (!m) return null;
  const u: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 };
  return parseFloat(m[1]) * (u[m[2].toUpperCase()] ?? 1);
};
const pct = (s?: string) => num(s?.replace("%", ""));

async function sampleDocker(): Promise<{ containers: Container[]; error: string | null }> {
  try {
    const [psOut, statsOut] = await Promise.all([
      exec("docker", ["ps", "-a", "--no-trunc", "--format", "{{json .}}"]),
      exec("docker", ["stats", "--no-stream", "--format", "{{json .}}"], 15000).catch(() => ""),
    ]);
    const stats = new Map<string, Record<string, string>>();
    for (const l of statsOut.trim().split("\n").filter(Boolean)) {
      const s = JSON.parse(l);
      stats.set(s.ID, s);
    }
    const containers = psOut
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const c = JSON.parse(l);
        const s = [...stats.entries()].find(([id]) => c.ID.startsWith(id) || id.startsWith(c.ID.slice(0, 12)))?.[1];
        const [used, limit] = (s?.MemUsage ?? "").split("/");
        return {
          id: c.ID.slice(0, 12),
          name: c.Names,
          image: c.Image,
          state: c.State,
          status: c.Status,
          ports: c.Ports ?? "",
          cpu: pct(s?.CPUPerc),
          memUsed: used ? parseSize(used) : null,
          memLimit: limit ? parseSize(limit) : null,
          memPct: pct(s?.MemPerc),
          netIO: s?.NetIO ?? null,
          blockIO: s?.BlockIO ?? null,
        } satisfies Container;
      })
      .sort((a, b) => (a.state === "running" ? 0 : 1) - (b.state === "running" ? 0 : 1) || a.name.localeCompare(b.name));
    return { containers, error: null };
  } catch (e) {
    return { containers: [], error: e instanceof Error ? e.message.split("\n")[0] : "docker unavailable" };
  }
}

async function sampleDockerDisk(): Promise<number | null> {
  try {
    const out = await exec("docker", ["system", "df", "--format", "{{json .}}"], 590_000);
    let total = 0;
    for (const l of out.trim().split("\n").filter(Boolean)) total += parseSize(JSON.parse(l).Size ?? "") ?? 0;
    return total;
  } catch {
    return null;
  }
}

/* ---------- History (server-side ring buffers so charts survive page reloads) ---------- */
const RANGE_STEP: Record<RangeKey, number> = { "1h": 5_000, "6h": 30_000, "24h": 120_000 };
const MAX_POINTS = 720;
interface Ring extends HistorySeries { acc: { n: number; gpu: number; cpu: number; mem: number; start: number } }
const newRing = (): Ring => ({ t: [], gpu: [], cpu: [], mem: [], acc: { n: 0, gpu: 0, cpu: 0, mem: 0, start: 0 } });

function record(rings: Record<RangeKey, Ring>, snap: Snapshot) {
  const gpu = snap.gpu?.util ?? 0;
  const cpu = snap.cpu.total;
  const mem = (snap.mem.used / snap.mem.total) * 100;
  for (const k of Object.keys(RANGE_STEP) as RangeKey[]) {
    const r = rings[k];
    if (!r.acc.start) r.acc.start = snap.ts;
    r.acc.n++; r.acc.gpu += gpu; r.acc.cpu += cpu; r.acc.mem += mem;
    if (snap.ts - r.acc.start >= RANGE_STEP[k]) {
      const n = r.acc.n;
      r.t.push(snap.ts); r.gpu.push(r.acc.gpu / n); r.cpu.push(r.acc.cpu / n); r.mem.push(r.acc.mem / n);
      if (r.t.length > MAX_POINTS) for (const a of [r.t, r.gpu, r.cpu, r.mem]) a.shift();
      r.acc = { n: 0, gpu: 0, cpu: 0, mem: 0, start: snap.ts };
    }
  }
}

export function getHistory(range: RangeKey): HistorySeries {
  startSampler();
  const { t, gpu, cpu, mem } = state.rings[range];
  const since = Date.now() - { "1h": 3600e3, "6h": 21600e3, "24h": 86400e3 }[range];
  const i = t.findIndex((x) => x >= since);
  const from = i < 0 ? t.length : i;
  return { t: t.slice(from), gpu: gpu.slice(from), cpu: cpu.slice(from), mem: mem.slice(from) };
}

/* ---------- Host processes ---------- */
const CLK = 100;
interface PidInfo { name: string; ppid: number; start: number; cpu: number; rss: number }
let pidTable = new Map<number, PidInfo>();
let prevProcs = new Map<number, number>();
let prevProcTs = 0;

async function sampleProcs(): Promise<HostProc[]> {
  const now = Date.now();
  const dt = (now - prevProcTs) / 1000;
  const next = new Map<number, number>();
  const table = new Map<number, PidInfo>();
  const list: HostProc[] = [];
  const pids = (await readdir("/proc")).filter((d) => /^\d+$/.test(d));
  await Promise.all(
    pids.map(async (d) => {
      try {
        const st = await readFile(`/proc/${d}/stat`, "utf8");
        const l = st.lastIndexOf(")");
        const name = st.slice(st.indexOf("(") + 1, l);
        const f = st.slice(l + 2).split(" "); // f[0] = state (field 3)
        const ticks = Number(f[11]) + Number(f[12]);
        const rss = Number(f[21]) * 4096;
        const pid = Number(d);
        next.set(pid, ticks);
        const prev = prevProcs.get(pid);
        const cpu = prev !== undefined && prevProcTs && dt > 0 ? ((ticks - prev) / CLK / dt) * 100 : 0;
        list.push({ pid, name, cpu: Math.max(0, cpu), memBytes: rss });
        table.set(pid, { name, ppid: Number(f[1]), start: Number(f[19]), cpu: Math.max(0, cpu), rss });
      } catch {}
    }),
  );
  prevProcs = next;
  prevProcTs = now;
  pidTable = table;
  return list.sort((a, b) => b.cpu - a.cpu || b.memBytes - a.memBytes).slice(0, 8);
}


/* ---------- Model servers running directly on the host (vLLM, Ollama, python scripts...) ---------- */
interface Engine { label: string; re: RegExp; port: number; api: "openai" | "ollama" | null }
const ENGINES: Engine[] = [
  { label: "vLLM", re: /vllm/i, port: 8000, api: "openai" },
  { label: "Ollama", re: /\bollama\b/i, port: 11434, api: "ollama" },
  { label: "llama.cpp", re: /llama-server|llama-cli|llama_cpp|llama\.cpp/i, port: 8080, api: "openai" },
  { label: "SGLang", re: /sglang/i, port: 30000, api: "openai" },
  { label: "TGI", re: /text-generation-(launcher|server)/i, port: 8080, api: null },
  { label: "Triton", re: /tritonserver/i, port: 8000, api: null },
  { label: "TensorRT-LLM", re: /trtllm|tensorrt_llm/i, port: 8000, api: "openai" },
  { label: "LMDeploy", re: /lmdeploy/i, port: 23333, api: "openai" },
  { label: "MLC LLM", re: /mlc_llm|mlc-llm/i, port: 8000, api: "openai" },
  { label: "KoboldCpp", re: /koboldcpp/i, port: 5001, api: null },
  { label: "LocalAI", re: /local-?ai/i, port: 8080, api: "openai" },
  { label: "ComfyUI", re: /comfyui/i, port: 8188, api: null },
];
const NAME_RE = /python|ollama|llama|triton|vllm|trtllm|text-gen|kobold|local-?ai|sglang|mlc|lmdeploy|comfy/i;
const IGNORE_RE = /\b(pip3?|grep|pgrep|pytest|tail|less|vim?|nano|code)\b/;
const CONTAINER_RE = /docker|kubepods|containerd|libpod|crio-|lxc/i;

interface Meta { args: string[]; inContainer: boolean; uid: number }
const metaCache = new Map<string, Meta>();
async function metaFor(pid: number, info: PidInfo): Promise<Meta> {
  const key = `${pid}:${info.start}`;
  const hit = metaCache.get(key);
  if (hit) return hit;
  const [cmd, cg, st] = await Promise.all([
    readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => ""),
    readFile(`/proc/${pid}/cgroup`, "utf8").catch(() => ""),
    stat(`/proc/${pid}`).catch(() => null),
  ]);
  const m = { args: cmd.split("\0").filter(Boolean), inContainer: CONTAINER_RE.test(cg), uid: st?.uid ?? -1 };
  metaCache.set(key, m);
  if (metaCache.size > 4000) for (const k of [...metaCache.keys()].slice(0, 2000)) metaCache.delete(k);
  return m;
}

let passwd: Map<number, string> | null = null;
async function userName(uid: number) {
  if (!passwd) {
    passwd = new Map();
    const t = await readFile("/etc/passwd", "utf8").catch(() => "");
    for (const l of t.split("\n")) { const f = l.split(":"); if (f.length > 2) passwd.set(Number(f[2]), f[0]); }
  }
  return passwd.get(uid) ?? String(uid);
}

const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
function modelFromArgs(a: string[], label: string): string | undefined {
  const flag = a.findIndex((x) => /^--(model|model-path|model_path|model-id|model_id|served-model-name|model-name|hf-repo)$/.test(x));
  if (flag >= 0 && a[flag + 1]) return base(a[flag + 1]);
  const eq = a.find((x) => /^--(model|model-path|model_path|model-id|model_id|served-model-name)=/.test(x));
  if (eq) return base(eq.split("=").slice(1).join("="));
  const sv = a.indexOf("serve");
  if (sv >= 0 && a[sv + 1] && !a[sv + 1].startsWith("-")) return base(a[sv + 1]);
  if (label === "llama.cpp") { const m = a.findIndex((x) => x === "-m" || x === "--model"); if (m >= 0 && a[m + 1]) return base(a[m + 1]); }
  return undefined;
}
function scriptFromArgs(a: string[]): string | undefined {
  const m = a.indexOf("-m");
  if (m >= 0 && a[m + 1]) return a[m + 1];
  const s = a.slice(1).find((x) => /\.py$/.test(x));
  return s ? base(s) : undefined;
}

/** listening TCP ports per pid, refreshed in the background */
let listen = new Map<number, number[]>();
async function sampleListen() {
  try {
    const out = await exec("ss", ["-ltnpH"], 4000);
    const m = new Map<number, Set<number>>();
    for (const line of out.split("\n")) {
      const port = Number(line.trim().split(/\s+/)[3]?.split(":").pop());
      if (!port) continue;
      for (const x of line.matchAll(/pid=(\d+)/g)) {
        const pid = Number(x[1]);
        (m.get(pid) ?? m.set(pid, new Set()).get(pid)!).add(port);
      }
    }
    listen = new Map([...m].map(([k, v]) => [k, [...v]]));
  } catch {}
}

/** what the model server's HTTP API says is loaded (cached, refreshed in the background) */
const probes = new Map<number, { ts: number; ok: boolean; models: string[]; busy: boolean }>();
function probe(port: number, api: "openai" | "ollama") {
  const cur = probes.get(port) ?? { ts: 0, ok: false, models: [], busy: false };
  probes.set(port, cur);
  if (cur.busy || Date.now() - cur.ts < 8000) return cur;
  cur.busy = true;
  (async () => {
    try {
      const url = `http://127.0.0.1:${port}${api === "ollama" ? "/api/ps" : "/v1/models"}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as { data?: { id: string }[]; models?: { name?: string; model?: string }[] };
      cur.models = api === "ollama" ? (j.models ?? []).map((x) => x.name ?? x.model ?? "model") : (j.data ?? []).map((x) => base(x.id));
      cur.ok = true;
    } catch {
      cur.ok = false;
      cur.models = [];
    } finally {
      cur.ts = Date.now();
      cur.busy = false;
    }
  })();
  return cur;
}

async function buildServices(gpuProcs: GpuProc[]): Promise<ModelService[]> {
  const gpuMem = new Map<number, number>();
  for (const p of gpuProcs) gpuMem.set(p.pid, (gpuMem.get(p.pid) ?? 0) + p.memBytes);
  type C = { label: string; kind: "llm" | "other"; eng?: Engine; args: string[]; uid: number };
  const cls = new Map<number, C>();
  await Promise.all(
    [...pidTable].map(async ([pid, info]) => {
      const onGpu = gpuMem.has(pid);
      if (!onGpu && !NAME_RE.test(info.name)) return;
      const m = await metaFor(pid, info);
      if (m.inContainer || !m.args.length) return;
      const hay = `${info.name} ${m.args.join(" ")}`;
      if (IGNORE_RE.test(base(m.args[0]))) return;
      const eng = ENGINES.find((e) => e.re.test(hay));
      if (eng) cls.set(pid, { label: eng.label, kind: eng.label === "ComfyUI" ? "other" : "llm", eng, args: m.args, uid: m.uid });
      else if (onGpu && /python/i.test(info.name)) cls.set(pid, { label: "Python", kind: "other", args: m.args, uid: m.uid });
    }),
  );
  const rootOf = (pid: number) => {
    let cur = pid;
    for (let i = 0; i < 20; i++) {
      const pp = pidTable.get(cur)?.ppid;
      if (pp && cls.get(pp)?.label === cls.get(pid)!.label) cur = pp;
      else return cur;
    }
    return cur;
  };
  const groups = new Map<number, number[]>();
  for (const pid of cls.keys()) { const r = rootOf(pid); (groups.get(r) ?? groups.set(r, []).get(r)!).push(pid); }

  const out: ModelService[] = [];
  for (const [root, pids] of groups) {
    const c = cls.get(root)!;
    const ports = [...new Set(pids.flatMap((p) => listen.get(p) ?? []))].sort((a, b) => a - b);
    const wellKnown = ports.filter((p) => p < 32768); // drop internal ephemeral ports (zmq, workers)
    const shown = wellKnown.length ? wellKnown : ports.slice(0, 2);
    const info = pidTable.get(root)!;
    const model = [root, ...pids].map((p) => cls.get(p) && modelFromArgs(cls.get(p)!.args, c.label)).find(Boolean);
    let api: ModelService["api"] = "none";
    let models: string[] = [];
    if (c.eng?.api && ports.length) {
      const p = probe(ports.includes(c.eng.port) ? c.eng.port : ports[0], c.eng.api);
      api = p.ts === 0 ? "none" : p.ok ? "up" : "down";
      models = p.models;
    }
    out.push({
      id: `${c.label}-${root}`,
      engine: c.label,
      kind: c.kind,
      title: models[0] ?? model ?? scriptFromArgs(c.args) ?? c.label,
      pid: root,
      procs: pids.length,
      user: await userName(c.uid),
      cmd: c.args.join(" ").slice(0, 220),
      ports: shown,
      cpu: pids.reduce((a, p) => a + (pidTable.get(p)?.cpu ?? 0), 0),
      memBytes: pids.reduce((a, p) => a + (pidTable.get(p)?.rss ?? 0), 0),
      gpuMem: pids.reduce((a, p) => a + (gpuMem.get(p) ?? 0), 0),
      uptime: Math.max(0, os.uptime() - info.start / CLK),
      models,
      api,
    });
  }
  return out.sort((a, b) => Number(b.kind === "llm") - Number(a.kind === "llm") || b.gpuMem - a.gpuMem || b.memBytes - a.memBytes);
}

/* ---------- Static host info ---------- */
let cpuModel = "";
async function model() {
  if (cpuModel) return cpuModel;
  const txt = await readFile("/proc/cpuinfo", "utf8").catch(() => "");
  cpuModel = txt.match(/model name\s*:\s*(.+)/)?.[1] ?? "";
  if (!cpuModel) {
    // ARM: /proc/cpuinfo has no model name; lscpu lists one line per core type (e.g. big.LITTLE)
    const out = await exec("lscpu", [], 3000).catch(() => "");
    const rows = [...out.matchAll(/^Model name:\s*(.+)$/gm)].map((m) => m[1].trim());
    const cores = [...out.matchAll(/^Core\(s\) per socket:\s*(\d+)/gm)].map((m) => m[1]);
    cpuModel = rows.length ? rows.map((r, i) => (cores[i] && rows.length > 1 ? `${cores[i]}× ${r}` : r)).join(" + ") : os.cpus()[0]?.model || "CPU";
  }
  return cpuModel;
}
let osName = "";
async function osPretty() {
  if (osName) return osName;
  const t = await readFile("/etc/os-release", "utf8").catch(() => "");
  osName = t.match(/PRETTY_NAME="?([^"\n]+)/)?.[1] ?? os.type();
  return osName;
}

/* ---------- Singleton sampler ---------- */
type Listener = (s: Snapshot) => void;
interface State {
  latest: Snapshot | null;
  listeners: Set<Listener>;
  started: boolean;
  disks: Disk[];
  docker: { containers: Container[]; error: string | null };
  dockerDisk: number | null;
  rings: Record<RangeKey, Ring>;
}
const g = globalThis as unknown as { __sparkDash?: State };
const state: State = (g.__sparkDash ??= { latest: null, listeners: new Set(), started: false, disks: [], docker: { containers: [], error: null }, dockerDisk: null, rings: { "1h": newRing(), "6h": newRing(), "24h": newRing() } });

async function tick() {
  try {
    const [cpu, mem, temp, procs, m, osn] = await Promise.all([sampleCpu(), sampleMem(), cpuTemp(), sampleProcs(), model(), osPretty()]);
    const { gpu, procs: gpuProcs } = await sampleGpu(mem.total);
    const services = await buildServices(gpuProcs);
    const snap: Snapshot = {
      ts: Date.now(),
      host: { hostname: os.hostname(), os: osn, uptime: os.uptime(), load: os.loadavg() as [number, number, number], kernel: os.release(), arch: os.arch() },
      cpu: { model: m, total: cpu.total, cores: cpu.cores, temp },
      mem,
      disks: state.disks,
      gpu,
      gpuProcs,
      containers: state.docker.containers,
      dockerError: state.docker.error,
      dockerDisk: state.dockerDisk,
      procs,
      services,
    };
    state.latest = snap;
    record(state.rings, snap);
    state.listeners.forEach((l) => l(snap));
  } catch (e) {
    console.error("sampler tick failed", e);
  }
}

function loop(fn: () => Promise<void>, ms: number) {
  const go = async () => {
    await fn();
    setTimeout(go, ms).unref();
  };
  go();
}

export function startSampler() {
  if (state.started) return;
  state.started = true;
  loop(async () => { state.disks = await sampleDisks(); }, 15000);
  loop(async () => { state.docker = await sampleDocker(); }, 2500);
  loop(async () => { state.dockerDisk = (await sampleDockerDisk()) ?? state.dockerDisk; }, 600_000);
  loop(sampleListen, 4000);
  loop(tick, 1000);
}

export function subscribe(l: Listener) {
  startSampler();
  state.listeners.add(l);
  if (state.latest) l(state.latest);
  return () => void state.listeners.delete(l);
}

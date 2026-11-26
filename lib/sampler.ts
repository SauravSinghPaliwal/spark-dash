import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import type { Container, Disk, GpuInfo, GpuProc, HistorySeries, HostProc, RangeKey, Snapshot } from "./types";

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
let prevProcs = new Map<number, number>();
let prevProcTs = 0;

async function sampleProcs(): Promise<HostProc[]> {
  const now = Date.now();
  const dt = (now - prevProcTs) / 1000;
  const next = new Map<number, number>();
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
      } catch {}
    }),
  );
  prevProcs = next;
  prevProcTs = now;
  return list.sort((a, b) => b.cpu - a.cpu || b.memBytes - a.memBytes).slice(0, 8);
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
  loop(tick, 1000);
}

export function subscribe(l: Listener) {
  startSampler();
  state.listeners.add(l);
  if (state.latest) l(state.latest);
  return () => void state.listeners.delete(l);
}

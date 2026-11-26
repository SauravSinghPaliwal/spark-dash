"use client";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Container, HistorySeries, RangeKey, Snapshot } from "@/lib/types";
import { Activity, AppWindow, ArrowLeftRight, ArrowUpRight, Asterisk, Box, BrainCircuit, CircleCheck, Container as ContainerIcon, Cpu, Database, Download, Globe, Gpu, HardDrive, HeartPulse, LayoutDashboard, MemoryStick, Pause, Play, Radio, Server, Thermometer, TriangleAlert, X, Zap, type LucideIcon } from "lucide-react";
import { AnimatedNumber, Meter, Spark, fmtBytes, fmtParts } from "./ui";

const Ic = ({ i: I, size = 15 }: { i: LucideIcon; size?: number }) => <I size={size} strokeWidth={1.8} aria-hidden />;
const appIcon = (c: { name: string; image: string }): LucideIcon => {
  const k = `${c.name} ${c.image}`.toLowerCase();
  if (/milvus|etcd|minio|postgres|mysql|redis|mongo|db|qdrant|elastic/.test(k)) return Database;
  if (/nemotron|vllm|triton|llama|ocr|embed|model|ollama|nim/.test(k)) return BrainCircuit;
  if (/frontend|web|nginx|ui|next|react/.test(k)) return Globe;
  if (/backend|api|server|uvicorn|fastapi/.test(k)) return Server;
  return Box;
};
const eventIcon: Record<string, LucideIcon> = { NODE: Server, DOCKER: ContainerIcon, GPU: Gpu, ALERT: TriangleAlert };

const GPU_C = "#4c90f0";
const CPU_C = "#3dcc91";
const MEM_C = "#a082e0";
const DISK_C = "#ec9a3c";
const SPARK_LEN = 60;

type Drawer = { kind: "container"; id: string } | { kind: "gpu" } | { kind: "hw"; which: "GPU" | "CPU" | "Memory" | "Storage" } | { kind: "specs" } | null;
interface EventItem { id: number; time: string; message: string; warn: boolean; type: string }

const clock = (d = new Date()) => d.toLocaleTimeString("en-GB", { hour12: false });
const fmtUptime = (s: number) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return `${d}d ${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m`;
};
const archLabel = (a: string) => (a === "arm64" || a === "aarch64" ? "ARM64" : a.toUpperCase());

/* ------------------------------------------------------------------ data */
function useLive() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [online, setOnline] = useState(false);
  const [paused, setPaused] = useState(false);
  const [gpuH, setGpuH] = useState<number[]>([]);
  const [cpuH, setCpuH] = useState<number[]>([]);
  const pausedRef = useRef(false);
  const latest = useRef<Snapshot | null>(null);
  pausedRef.current = paused;

  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.onopen = () => setOnline(true);
    es.onerror = () => setOnline(false);
    es.onmessage = (e) => {
      const s: Snapshot = JSON.parse(e.data);
      latest.current = s;
      setOnline(true);
      if (pausedRef.current) return;
      setSnap(s);
      setGpuH((h) => [...h.slice(-(SPARK_LEN - 1)), s.gpu?.util ?? 0]);
      setCpuH((h) => [...h.slice(-(SPARK_LEN - 1)), s.cpu.total]);
    };
    return () => es.close();
  }, []);

  return { snap, online, paused, setPaused, gpuH, cpuH, latest };
}

function useHistory(range: RangeKey) {
  const [h, setH] = useState<HistorySeries | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`/api/history?range=${range}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => alive && setH(d))
        .catch(() => {});
    load();
    const id = setInterval(load, range === "1h" ? 5000 : 15000);
    return () => { alive = false; clearInterval(id); };
  }, [range]);
  return h;
}

/** Derives the operational event log by diffing consecutive snapshots. */
function useEvents(snap: Snapshot | null, alerts: string[]) {
  const [events, setEvents] = useState<EventItem[]>([]);
  const prev = useRef<{ states: Map<string, string>; gpuPids: Set<number>; alerts: Set<string>; ready: boolean }>({ states: new Map(), gpuPids: new Set(), alerts: new Set(), ready: false });
  const seq = useRef(0);
  const add = useCallback((message: string, warn: boolean, type: string) => {
    setEvents((e) => [{ id: seq.current++, time: clock(), message, warn, type }, ...e].slice(0, 7));
  }, []);

  useEffect(() => {
    if (!snap) return;
    const p = prev.current;
    const states = new Map(snap.containers.map((c) => [c.name, c.state]));
    const gpuPids = new Set(snap.gpuProcs.map((g) => g.pid));
    if (!p.ready) {
      add(`Connected to ${snap.host.hostname}`, false, "NODE");
      add(`${snap.containers.filter((c) => c.state === "running").length} running containers discovered`, false, "DOCKER");
      if (snap.gpu) add(`${snap.gpuProcs.length} GPU compute processes detected`, false, "GPU");
      p.ready = true;
    } else if (snap.containers.length || !snap.dockerError) {
      for (const [n, st] of states) {
        const old = p.states.get(n);
        if (old === undefined) add(`Container ${n} appeared (${st})`, false, "DOCKER");
        else if (old !== st) add(`Container ${n}: ${old} → ${st}`, st !== "running" && st !== "created", "DOCKER");
      }
      for (const n of p.states.keys()) if (!states.has(n)) add(`Container ${n} removed`, false, "DOCKER");
      for (const g of snap.gpuProcs) if (!p.gpuPids.has(g.pid)) add(`GPU process ${g.name} (pid ${g.pid}) started`, false, "GPU");
      for (const pid of p.gpuPids) if (!gpuPids.has(pid)) add(`GPU process pid ${pid} exited`, false, "GPU");
    }
    for (const a of alerts) if (!p.alerts.has(a)) add(a, true, "ALERT");
    for (const a of p.alerts) if (!alerts.includes(a)) add(`Recovered: ${a}`, false, "ALERT");
    p.states = states; p.gpuPids = gpuPids; p.alerts = new Set(alerts);
  }, [snap, alerts, add]);

  return events;
}

/* -------------------------------------------------------------- derived */
interface Check { label: string; value: string; ok: boolean }

function useDerived(s: Snapshot | null) {
  return useMemo(() => {
    if (!s) return { checks: [] as Check[], alerts: [] as string[] };
    const memPct = (s.mem.used / s.mem.total) * 100;
    const swapPct = s.mem.swapTotal ? (s.mem.swapUsed / s.mem.swapTotal) * 100 : 0;
    const disk = s.disks[0];
    const diskPct = disk ? (disk.used / disk.size) * 100 : 0;
    const checks: Check[] = [
      { label: "GPU temperature", value: s.gpu?.temp != null ? `${s.gpu.temp.toFixed(0)}°C` : "n/a", ok: s.gpu?.temp == null || s.gpu.temp < 85 },
      { label: "CPU temperature", value: s.cpu.temp != null ? `${s.cpu.temp.toFixed(0)}°C` : "n/a", ok: s.cpu.temp == null || s.cpu.temp < 95 },
      { label: "Memory pressure", value: `${memPct.toFixed(0)}% used`, ok: memPct < 92 },
      { label: "Swap usage", value: `${swapPct.toFixed(0)}%`, ok: swapPct < 80 },
      { label: "Storage capacity", value: disk ? `${diskPct.toFixed(0)}% used` : "n/a", ok: diskPct < 90 },
      { label: "Docker daemon", value: s.dockerError ? "Unreachable" : "Connected", ok: !s.dockerError },
    ];
    return { checks, alerts: checks.filter((c) => !c.ok).map((c) => `${c.label} ${c.value}`) };
  }, [s]);
}

/* ---------------------------------------------------------------- pieces */
const enter = (i: number) => ({
  initial: { opacity: 0, y: 18 },
  animate: { opacity: 1, y: 0 },
  transition: { type: "spring" as const, stiffness: 150, damping: 22, delay: 0.04 * i },
});

function Metric({ i, label, glyph, value, unit, sub, subClass, visual, foot, footB }: {
  i: number; label: string; glyph: ReactNode; value: ReactNode; unit: string; sub: ReactNode; subClass?: string; visual: ReactNode; foot: string; footB: ReactNode;
}) {
  return (
    <motion.article className="metric" {...enter(i)} whileHover={{ y: -2 }}>
      <div className="label">{label} <span>{glyph}</span></div>
      <div className="metricvalue"><b>{value}</b><em>{unit}</em><small className={subClass}>{sub}</small></div>
      <div className="metric-visual">{visual}</div>
      <div className="metricfoot">{foot} <b>{footB}</b></div>
    </motion.article>
  );
}

function ComputeChart({ range, data }: { range: RangeKey; data: HistorySeries | null }) {
  const [hover, setHover] = useState<number | null>(null);
  const span = { "1h": 3600e3, "6h": 21600e3, "24h": 86400e3 }[range];
  const now = data?.t.length ? data.t[data.t.length - 1] : Date.now();
  const x = (t: number) => 32 + ((t - (now - span)) / span) * 578;
  const path = (a: number[]) => (data ? a.map((v, i) => `${x(data.t[i]).toFixed(1)},${(130 - v * 1.2).toFixed(1)}`).join(" ") : "");
  const gpu = path(data?.gpu ?? []);
  const lines = [0, 1, 2, 3, 4].map((i) => {
    const y = 10 + i * 30;
    return (
      <g key={i}>
        <line x1="32" y1={y} x2="610" y2={y} stroke="#2f343c" strokeDasharray="3 5" />
        <text x="0" y={y + 3} fill="#5f6b7c" fontSize="8">{100 - i * 25}</text>
      </g>
    );
  });
  const labels = [0, 1, 2, 3, 4].map((i) => (
    <text key={i} x={32 + i * 144.5} y="153" textAnchor={i === 4 ? "end" : "start"} fill="#5f6b7c" fontSize="8">
      {clock(new Date(now - span + (i * span) / 4)).slice(0, 5)}
    </text>
  ));
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!data?.t.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * 620;
    const t = now - span + ((vx - 32) / 578) * span;
    let best = 0;
    data.t.forEach((tt, i) => { if (Math.abs(tt - t) < Math.abs(data.t[best] - t)) best = i; });
    setHover(Math.abs(data.t[best] - t) < span / 30 ? best : null);
  };
  const hv = hover !== null && data && data.t[hover] !== undefined ? hover : null;
  return (
    <>
      <div className="chartlegend">
        <span><i style={{ background: GPU_C }} />GPU</span>
        <span><i style={{ background: CPU_C }} />CPU</span>
        {hv !== null && data ? (
          <span className="chartreadout">{clock(new Date(data.t[hv]))} · GPU {data.gpu[hv].toFixed(0)}% · CPU {data.cpu[hv].toFixed(0)}%</span>
        ) : (
          <span className="chartnote">Utilization (%)</span>
        )}
      </div>
      <div id="chart">
        <svg viewBox="0 0 620 160" preserveAspectRatio="none" role="img" aria-label={`GPU and CPU utilization over ${range}`} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          <defs>
            <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
              <stop stopColor={GPU_C} stopOpacity=".16" />
              <stop offset="1" stopColor={GPU_C} stopOpacity="0" />
            </linearGradient>
          </defs>
          {lines}
          {data && data.t.length > 1 && (
            <>
              <polygon points={`${x(data.t[0])},130 ${gpu} ${x(data.t[data.t.length - 1])},130`} fill="url(#fade)" />
              <polyline points={gpu} fill="none" stroke={GPU_C} strokeWidth="1.8" />
              <polyline points={path(data.cpu)} fill="none" stroke={CPU_C} strokeWidth="1.5" />
            </>
          )}
          {hv !== null && data && (
            <g className="crosshair">
              <line x1={x(data.t[hv])} x2={x(data.t[hv])} y1="10" y2="130" stroke="#8f99a8" />
              <circle cx={x(data.t[hv])} cy={130 - data.gpu[hv] * 1.2} r="3" fill={GPU_C} />
              <circle cx={x(data.t[hv])} cy={130 - data.cpu[hv] * 1.2} r="3" fill={CPU_C} />
            </g>
          )}
          {labels}
        </svg>
        {(!data || data.t.length < 2) && <div className="empty" style={{ marginTop: -110, textAlign: "center", position: "relative" }}>Collecting history… the chart fills in as the server samples.</div>}
      </div>
    </>
  );
}

function containerPort(c: Container) {
  const m = c.ports.match(/:(\d+)->/);
  return m ? Number(m[1]) : null;
}

/* ------------------------------------------------------------- the page */
export default function Dashboard() {
  const { snap, online, paused, setPaused, gpuH, cpuH, latest } = useLive();
  const [range, setRange] = useState<RangeKey>("1h");
  const [filter, setFilter] = useState<"all" | "running" | "stopped">("all");
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [active, setActive] = useState("overview");
  const [toast, setToast] = useState("");
  const hist = useHistory(range);
  const { checks, alerts } = useDerived(snap);
  const events = useEvents(snap, alerts);
  const dlg = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (drawer && !d.open) d.showModal();
    if (!drawer && d.open) d.close();
  }, [drawer]);

  useEffect(() => {
    const ids = ["overview", "compute", "memory", "workloads", "applications", "health"];
    const obs = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && setActive(e.target.id)), { rootMargin: "-30% 0px -60% 0px" });
    ids.forEach((id) => { const el = document.getElementById(id); if (el) obs.observe(el); });
    return () => obs.disconnect();
  }, [snap === null]);

  const flash = (t: string) => { setToast(t); setTimeout(() => setToast(""), 2500); };
  const exportSnap = () => {
    const s = latest.current;
    if (!s) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(s, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${s.host.hostname}-snapshot-${new Date().toISOString().slice(0, 19)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    flash("Snapshot exported");
  };

  const s = snap;
  const memPct = s ? (s.mem.used / s.mem.total) * 100 : 0;
  const disk = s?.disks[0];
  const diskPct = disk ? (disk.used / disk.size) * 100 : 0;
  const running = s?.containers.filter((c) => c.state === "running") ?? [];
  const visible = s?.containers.filter((c) => filter === "all" || (filter === "running" ? c.state === "running" : c.state !== "running")) ?? [];
  const apps = useMemo(() => {
    const seen = new Set<number>();
    return running.flatMap((c) => { const p = containerPort(c); if (!p || seen.has(p)) return []; seen.add(p); return [{ c, port: p }]; }).slice(0, 6);
  }, [running]);
  const healthy = checks.filter((c) => c.ok).length;
  const checkIcons: LucideIcon[] = [Thermometer, Thermometer, MemoryStick, ArrowLeftRight, HardDrive, ContainerIcon];
  const allOk = healthy === checks.length;
  const nav: [string, LucideIcon, string, number?][] = [
    ["overview", LayoutDashboard, "Overview"], ["compute", Cpu, "Compute"], ["memory", MemoryStick, "Memory & storage"],
    ["workloads", ContainerIcon, "Containers", s?.containers.length], ["applications", AppWindow, "Applications"], ["health", HeartPulse, "System health"],
  ];
  const coreModel = s?.cpu.model.split(" + ") ?? [];

  const dockerBytes = s?.dockerDisk ?? 0;
  const sysBytes = disk ? Math.max(0, disk.used - dockerBytes) : 0;

  return (
    <>
      <aside>
        <a className="brand" href="#overview" aria-label="Overview"><span className="logo"><Asterisk size={30} strokeWidth={2.4} aria-hidden /></span><span className="brand-word">SPARK</span><span className="brand-dot">.</span></a>
        <div className="workspace">OPERATIONS WORKSPACE</div>
        <nav>
          {nav.map(([id, Glyph, label, n]) => (
            <a key={id} href={`#${id}`} aria-label={label} className={active === id ? "active" : ""} onClick={() => setActive(id)}>
              <Ic i={Glyph} size={17} /> <span>{label}</span>{n !== undefined && <small>{n}</small>}{id === "health" && <i style={allOk ? undefined : { background: "#ec9a3c" }} />}
            </a>
          ))}
        </nav>
        <div className="side-bottom">
          <div className="demo-card"><span className="demo-dot" /> <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>Live environment</span><p>Real telemetry streamed<br />from this host.</p>
            <button onClick={() => setPaused(!paused)}>{paused ? "Resume updates" : "Pause updates"}</button></div>
          <div className="profile"><b>SS</b><div>Saurav Singh<small>Workspace administrator</small></div></div>
        </div>
      </aside>

      <main>
        <header>
          <div className="crumb">Workspace <span>/</span> <strong>{s?.host.hostname ?? "…"}</strong></div>
          <div className="header-right">
            <span className="demo-badge">LIVE</span>
            <span className="connection"><i style={online ? undefined : { background: "#e76a6e" }} /> {online ? "Telemetry connected" : "Reconnecting…"}</span>
          </div>
        </header>

        <div className="content">
          <section id="overview" className="heading">
            <div>
              <div className="eyebrow">COMPUTE OPERATIONS / NODE 01</div>
              <h1>Operations overview</h1>
              <p>Observe resources. Trace workloads. Resolve incidents.</p>
            </div>
            <div className="actions">
              <button onClick={() => setPaused(!paused)}><span className="btn-ic">{paused ? <Ic i={Play} size={13} /> : <Ic i={Pause} size={13} />}{paused ? "Resume" : "Pause"}</span></button>
              <button onClick={exportSnap}><span className="btn-ic"><Ic i={Download} size={13} />Export snapshot</span></button>
            </div>
          </section>

          {!s ? (
            <div style={{ display: "grid", placeItems: "center", padding: "120px 0" }}>
              <motion.div style={{ width: 36, height: 36, borderRadius: "50%", border: "2px solid #2f343c", borderTopColor: "#4c90f0" }} animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.9, ease: "linear" }} />
            </div>
          ) : (
            <>
              <motion.div className="nodebar" {...enter(0)}>
                <div><span className="nodeicon"><Ic i={Server} size={18} /></span><strong>{s.host.hostname}</strong><span className="tag">{s.gpu?.name ?? "No GPU"}</span><span className="muted">{s.host.os} · {archLabel(s.host.arch)}</span></div>
                <div>
                  <span className={`good ${allOk ? "" : "warn"}`}><i /> <span>{allOk ? "System healthy" : `${checks.length - healthy} warning${checks.length - healthy > 1 ? "s" : ""}`}</span></span>
                  <span className="sep">|</span><span className="muted">Uptime <b>{fmtUptime(s.host.uptime)}</b></span>
                </div>
              </motion.div>

              <motion.div className="ops-strip" {...enter(1)}>
                <span><span className="signal">●</span> NODE <b>{s.host.hostname.toUpperCase()}</b></span>
                <span>TELEMETRY <b>{paused ? "PAUSED" : "LIVE / 1s"}</b></span>
                <span>ACTIVE ALERTS <b style={alerts.length ? { color: "#ec9a3c" } : undefined}>{String(alerts.length).padStart(2, "0")}</b></span>
                <span>ARCH <b>{archLabel(s.host.arch)} / {(s.gpu?.name ?? "").replace("NVIDIA ", "")}</b></span>
              </motion.div>

              <section className="metrics">
                <Metric i={2} label="GPU utilization" glyph={<Ic i={Gpu} />} value={<AnimatedNumber value={s.gpu?.util ?? 0} />} unit="%" sub={(s.gpu?.util ?? 0) > 5 ? "● Active" : "Idle"} subClass={(s.gpu?.util ?? 0) > 5 ? "good" : ""}
                  visual={<Spark data={gpuH} color={GPU_C} />} foot={`${s.gpu?.power != null ? s.gpu.power.toFixed(0) + " W · " : ""}${s.gpu?.clock ?? "–"} MHz`} footB={s.gpu?.temp != null ? `${s.gpu.temp.toFixed(0)}°C` : "–"} />
                <Metric i={3} label="CPU utilization" glyph={<Ic i={Cpu} />} value={<AnimatedNumber value={s.cpu.total} />} unit="%" sub={`${s.cpu.cores.length} cores`}
                  visual={<Spark data={cpuH} color={CPU_C} />} foot={`Load ${s.host.load.map((l) => l.toFixed(1)).join(" ")}`} footB={s.cpu.temp != null ? `${s.cpu.temp.toFixed(0)}°C` : "–"} />
                <Metric i={4} label="Unified memory" glyph={<Ic i={MemoryStick} />} value={<AnimatedNumber value={Number(fmtParts(s.mem.used)[0])} decimals={1} />} unit={fmtParts(s.mem.used)[1]} sub={`/ ${fmtBytes(s.mem.total, 0)}`}
                  visual={<Meter value={memPct} color={MEM_C} />} foot="Shared CPU + GPU memory" footB={`${fmtBytes(s.mem.total - s.mem.used)} free`} />
                <Metric i={5} label="Storage used" glyph={<Ic i={HardDrive} />} value={disk ? fmtParts(disk.used, 2)[0] : "–"} unit={disk ? fmtParts(disk.used, 2)[1] : ""} sub={disk ? `/ ${fmtBytes(disk.size, 1)}` : ""}
                  visual={<Meter value={diskPct} color={DISK_C} />} foot={disk ? `${disk.fs.toUpperCase()} · ${disk.mount}` : "No disk"} footB={disk ? `${fmtBytes(disk.size - disk.used, 2)} free` : ""} />
              </section>

              <div className="main-grid">
                <motion.section id="compute" className="panel chart-panel" {...enter(6)}>
                  <div className="panel-head">
                    <h2>Compute activity</h2>
                    <div className="ranges">{(["1h", "6h", "24h"] as RangeKey[]).map((r) => <button key={r} className={range === r ? "selected" : ""} onClick={() => setRange(r)}>{r}</button>)}</div>
                  </div>
                  <ComputeChart range={range} data={hist} />
                  <div className="chart-toolbar">
                    <span className="muted">Select a workload to investigate resource usage</span>
                    <button className="inspection-link" onClick={() => setDrawer({ kind: "gpu" })}>Inspect GPU workload <Ic i={ArrowUpRight} size={13} /></button>
                  </div>
                  <div className="core-heading"><h3>CPU core utilization</h3><span>{coreModel.length ? coreModel.map((m, i) => <span key={i}>{i > 0 && <i> / </i>}{m}</span>) : s.cpu.model}</span></div>
                  <div className="cores">
                    {s.cpu.cores.map((v, i) => (
                      <div key={i} className="core" title={`Core ${i} · ${v.toFixed(0)}% utilization`} style={{ background: `rgba(76,144,240,${v / 250 + 0.03})` }}>
                        C{String(i).padStart(2, "0")}<b>{v.toFixed(0)}%</b>
                      </div>
                    ))}
                  </div>
                  <div className="corelegend"><span>Per-core load · hover for details</span><span>Low <i /> High</span></div>
                </motion.section>

                <motion.section className="panel hardware" {...enter(7)}>
                  <div className="panel-head"><h2>Your workstation</h2><span className="tinybadge">{online ? "ONLINE" : "OFFLINE"}</span></div>
                  <div className="hardware-image">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/hardware.png" alt="Altos GB10 workstation" />
                    <div className="hotspots">
                      {(["GPU", "CPU", "Memory", "Storage"] as const).map((w) => {
                        const I = { GPU: Gpu, CPU: Cpu, Memory: MemoryStick, Storage: HardDrive }[w];
                        return <button key={w} onClick={() => setDrawer({ kind: "hw", which: w })}><Ic i={I} size={11} />{w === "Memory" ? "MEMORY" : w === "Storage" ? "NVMe" : w}</button>;
                      })}
                    </div>
                    <span className="hardware-pin">● GB10 SUPERCHIP</span>
                  </div>
                  <div className="hardware-title">
                    <div><span className="eyebrow">ALTOS BRAINSPHERE</span><h2>GB10 F1</h2></div>
                    <button aria-label="View hardware specifications" onClick={() => setDrawer({ kind: "specs" })}><Ic i={ArrowUpRight} size={16} /></button>
                  </div>
                  <div className="specgrid">
                    <div>ARCHITECTURE<b>Grace Blackwell</b></div>
                    <div>CPU CORES<b>{s.cpu.cores.length} · Arm</b></div>
                    <div>MEMORY<b>128 GB LPDDR5x</b></div>
                    <div>DRIVER<b>{s.gpu?.driver ?? "–"}</b></div>
                  </div>
                  <div className="concept">Reference-based render · <a href="https://www.altoscomputing.com/en-IN/products/detail/GB10-F1" target="_blank" rel="noreferrer">Hardware specifications</a></div>
                </motion.section>
              </div>

              <div className="lower-grid">
                <motion.section id="workloads" className="panel" {...enter(8)}>
                  <div className="panel-head">
                    <h2>Docker containers <span className="count">{s.containers.length}</span></h2>
                    <div className="filters">{(["all", "running", "stopped"] as const).map((f) => <button key={f} className={filter === f ? "selected" : ""} onClick={() => setFilter(f)}>{f[0].toUpperCase() + f.slice(1)}</button>)}</div>
                  </div>
                  <div className="tablewrap" style={{ maxHeight: 420, overflowY: "auto" }}>
                    <table>
                      <thead><tr><th>CONTAINER</th><th>STATUS</th><th>CPU</th><th>MEMORY</th><th /></tr></thead>
                      <tbody>
                        <AnimatePresence initial={false}>
                          {visible.map((c) => {
                            const up = c.state === "running";
                            return (
                              <motion.tr key={c.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
                                <td><span className="cube"><Ic i={ContainerIcon} size={14} /></span>{c.name}</td>
                                <td><span className={`status ${up ? "" : "stopped"} ${c.state === "restarting" ? "warn" : ""}`}>● {c.state[0].toUpperCase() + c.state.slice(1)}</span></td>
                                <td>{up && c.cpu !== null ? `${c.cpu.toFixed(1)}%` : "–"}</td>
                                <td>{up && c.memUsed !== null ? fmtBytes(c.memUsed) : "–"}</td>
                                <td><button aria-label={`Inspect ${c.name}`} onClick={() => setDrawer({ kind: "container", id: c.id })}><Ic i={ArrowUpRight} size={14} /></button></td>
                              </motion.tr>
                            );
                          })}
                        </AnimatePresence>
                      </tbody>
                    </table>
                    {s.dockerError && <div className="empty" style={{ color: "#e76a6e" }}>Docker error: {s.dockerError}</div>}
                    {!s.dockerError && visible.length === 0 && <div className="empty">No containers match this filter.</div>}
                  </div>
                </motion.section>

                <motion.section id="health" className="panel" {...enter(9)}>
                  <div className="panel-head"><h2>System health</h2><span className={`good ${allOk ? "" : "warn"}`}>{healthy}/{checks.length} checks passed</span></div>
                  <div className="health-summary">
                    <span style={allOk ? undefined : { color: "#ec9a3c", borderColor: "#ec9a3c", background: "#ec9a3c26" }}>{allOk ? <Ic i={CircleCheck} size={20} /> : <Ic i={TriangleAlert} size={20} />}</span>
                    <div>
                      <h3>{allOk ? "Everything looks good" : alerts[0]}</h3>
                      <p>{allOk ? "Your workstation is operating normally." : `${checks.length - healthy} check${checks.length - healthy > 1 ? "s need" : " needs"} attention.`}</p>
                    </div>
                  </div>
                  <div id="healthrows">
                    {checks.map((c, i) => (
                      <div className="healthrow" key={c.label}>
                        <span className="hr-label"><Ic i={checkIcons[i]} size={14} />{c.label}</span>
                        <b style={c.ok ? undefined : { color: "#ec9a3c" }}>{c.value} <span className="hr-state" style={{ color: c.ok ? "#72ca9b" : "#ec9a3c" }}>{c.ok ? <Ic i={CircleCheck} size={14} /> : <Ic i={TriangleAlert} size={14} />}</span></b>
                      </div>
                    ))}
                  </div>
                </motion.section>
              </div>

              <div className="lower-grid bottom-grid">
                <motion.section id="applications" className="panel" {...enter(10)}>
                  <div className="panel-head"><h2>Applications</h2><span className="muted">{apps.length} service{apps.length === 1 ? "" : "s"} with published ports</span></div>
                  {apps.length === 0 ? <div className="empty">No running container publishes a port.</div> : (
                    <div className="appgrid">
                      {apps.map(({ c, port }, i) => {
                        const ok = !/unhealthy|restarting/i.test(c.status);
                        return (
                          <motion.a key={c.id} className="app" href={`http://${typeof window !== "undefined" ? window.location.hostname : "localhost"}:${port}`} target="_blank" rel="noreferrer"
                            initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.05 * i }} whileHover={{ y: -2 }}>
                            <span className={`appicon ${["orange", "green", "blue"][i % 3]}`}><Ic i={appIcon(c)} size={16} /></span>
                            <h3>{c.name} <Ic i={ArrowUpRight} size={12} /></h3>
                            <p>{c.image.split("/").pop()}</p>
                            <small className={ok ? "good" : "warn"}>● {ok ? "Running" : "Needs attention"} <span>:{port}</span></small>
                          </motion.a>
                        );
                      })}
                    </div>
                  )}
                </motion.section>

                <motion.section className="panel" {...enter(11)}>
                  <div className="panel-head"><h2>Storage breakdown</h2><span className="muted">{disk?.device ?? "–"}</span></div>
                  {disk ? (
                    <>
                      <div className="storagebar">
                        <motion.i animate={{ width: `${(dockerBytes / disk.size) * 100}%` }} style={{ background: "#4c90f0" }} transition={{ type: "spring", stiffness: 60, damping: 18 }} />
                        <motion.i animate={{ width: `${(sysBytes / disk.size) * 100}%` }} style={{ background: "#a082e0" }} transition={{ type: "spring", stiffness: 60, damping: 18 }} />
                      </div>
                      <div className="storagelegend">
                        <span><i style={{ background: "#4c90f0" }} />Docker (images, containers, volumes) <b>{s.dockerDisk != null ? fmtBytes(dockerBytes) : "calculating…"}</b></span>
                        <span><i style={{ background: "#a082e0" }} />{s.dockerDisk != null ? "System & data" : "Used (breakdown pending)"} <b>{fmtBytes(sysBytes)}</b></span>
                        <span><i style={{ background: "#383e47" }} />Available <b>{fmtBytes(disk.size - disk.used)}</b></span>
                        <span><i style={{ background: "#5f6b7c" }} />Total <b>{fmtBytes(disk.size)}</b></span>
                      </div>
                    </>
                  ) : <div className="empty">Reading disks…</div>}
                </motion.section>
              </div>

              <motion.section className="panel timeline" {...enter(12)}>
                <div className="panel-head"><h2>Event timeline</h2><span className="muted">Live operational events · this session</span></div>
                <div className="events">
                  <AnimatePresence initial={false}>
                    {events.map((e) => (
                      <motion.div key={e.id} layout className={`event ${e.warn ? "warn" : ""}`} initial={{ opacity: 0, x: -14 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ type: "spring", stiffness: 220, damping: 26 }}>
                        <time>{e.time}</time><span className="ev-ic"><Ic i={eventIcon[e.type] ?? Activity} size={13} /></span><span>{e.message}</span><small>{e.type}</small>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              </motion.section>

              <footer>
                <span><i className="demo-dot" /> {paused ? "Updates paused" : "Live telemetry · refreshes every second"}</span>
                <span>Updated {clock(new Date(s.ts))}</span>
                <span>SPARK CONSOLE <b>v2.0</b></span>
              </footer>
            </>
          )}
        </div>
      </main>

      <dialog ref={dlg} onClose={() => setDrawer(null)} onClick={(e) => e.target === dlg.current && setDrawer(null)}>
        <button id="close" aria-label="Close" onClick={() => setDrawer(null)}><Ic i={X} size={16} /></button>
        {s && <DrawerBody drawer={drawer} s={s} />}
      </dialog>
      <div id="toast" className={toast ? "show" : ""} role="status">{toast}</div>
    </>
  );
}

/* ---------------------------------------------------------------- drawer */
function Stats({ items }: { items: [string, ReactNode][] }) {
  return <div className="inspector-stats">{items.map(([k, v]) => <div key={k}>{k}<b>{v}</b></div>)}</div>;
}

function DrawerBody({ drawer, s }: { drawer: Drawer; s: Snapshot }) {
  if (!drawer) return null;
  if (drawer.kind === "container") {
    const c = s.containers.find((x) => x.id === drawer.id);
    if (!c) return <p>This container no longer exists.</p>;
    const up = c.state === "running";
    return (
      <>
        <div className="eyebrow">WORKLOAD INSPECTOR / DOCKER</div>
        <h2>{c.name}</h2>
        <span className={`status ${up ? "" : "stopped"}`}>● {c.state}</span>
        <Stats items={[["CPU UTILIZATION", up && c.cpu !== null ? `${c.cpu.toFixed(1)}%` : "–"], ["MEMORY", up && c.memUsed !== null ? fmtBytes(c.memUsed) : "–"], ["MEM LIMIT", c.memLimit ? fmtBytes(c.memLimit, 0) : "–"], ["MEM %", c.memPct !== null ? `${c.memPct.toFixed(1)}%` : "–"]]} />
        <h3>DETAILS</h3>
        <div className="drawer-list">
          <div><small>IMAGE</small><span style={{ overflowWrap: "anywhere", textAlign: "right" }}>{c.image}</span></div>
          <div><small>STATUS</small><span>{c.status}</span></div>
          <div><small>CONTAINER ID</small><span>{c.id}</span></div>
          <div><small>NETWORK I/O</small><span>{c.netIO ?? "–"}</span></div>
          <div><small>BLOCK I/O</small><span>{c.blockIO ?? "–"}</span></div>
          <div><small>PORTS</small><span style={{ overflowWrap: "anywhere", textAlign: "right" }}>{c.ports || "Not exposed"}</span></div>
        </div>
        <p>Read-only view. Manage containers with the Docker CLI.</p>
      </>
    );
  }
  if (drawer.kind === "gpu") {
    const g = s.gpu;
    return (
      <>
        <div className="eyebrow">WORKLOAD INSPECTOR / GPU</div>
        <h2>{g?.name ?? "GPU unavailable"}</h2>
        {g && <Stats items={[["UTILIZATION", `${g.util}%`], ["TEMPERATURE", g.temp != null ? `${g.temp}°C` : "–"], ["POWER", g.power != null ? `${g.power.toFixed(0)} W` : "–"], ["SM CLOCK", g.clock != null ? `${g.clock} MHz` : "–"]]} />}
        <h3>COMPUTE PROCESSES ({s.gpuProcs.length})</h3>
        <div className="drawer-list">
          {s.gpuProcs.length === 0 && <div><span>No compute processes</span></div>}
          {s.gpuProcs.map((p) => <div key={p.pid}><span>{p.name}<br /><small>pid {p.pid}</small></span><span>{fmtBytes(p.memBytes)}</span></div>)}
        </div>
        <p>GPU memory on this chip is unified with system RAM, so per-process figures are an estimate summed from the driver. Total: {fmtBytes(s.gpuProcs.reduce((a, p) => a + p.memBytes, 0))}.</p>
      </>
    );
  }
  if (drawer.kind === "hw") {
    const w = drawer.which;
    const disk = s.disks[0];
    const top = s.procs.slice(0, 5);
    const body = {
      GPU: { t: "NVIDIA GB10 / GPU", st: [["UTILIZATION", `${s.gpu?.util ?? 0}%`], ["TEMPERATURE", s.gpu?.temp != null ? `${s.gpu.temp}°C` : "–"]] as [string, ReactNode][], note: "Inference and training acceleration on the Grace Blackwell GPU." },
      CPU: { t: `${s.cpu.cores.length}-core Arm / CPU`, st: [["UTILIZATION", `${s.cpu.total.toFixed(1)}%`], ["TEMPERATURE", s.cpu.temp != null ? `${s.cpu.temp.toFixed(0)}°C` : "–"]] as [string, ReactNode][], note: s.cpu.model },
      Memory: { t: "Unified memory", st: [["USED", fmtBytes(s.mem.used)], ["TOTAL", fmtBytes(s.mem.total)]] as [string, ReactNode][], note: "One coherent LPDDR5x pool shared by CPU and GPU. GPU allocations are part of the used figure, not additional to it." },
      Storage: { t: "NVMe storage", st: [["USED", disk ? fmtBytes(disk.used, 2) : "–"], ["FREE", disk ? fmtBytes(disk.size - disk.used, 2) : "–"]] as [string, ReactNode][], note: disk ? `${disk.device} mounted at ${disk.mount} (${disk.fs})` : "" },
    }[w];
    return (
      <>
        <div className="eyebrow">HARDWARE INSPECTOR / {w.toUpperCase()}</div>
        <h2>{body.t}</h2>
        <Stats items={body.st} />
        <p>{body.note}</p>
        {(w === "CPU" || w === "Memory") && (
          <>
            <h3>TOP PROCESSES</h3>
            <div className="drawer-list">
              {top.map((p) => <div key={p.pid}><span>{p.name}<br /><small>pid {p.pid}</small></span><span>{w === "CPU" ? `${p.cpu.toFixed(0)}%` : fmtBytes(p.memBytes)}</span></div>)}
            </div>
          </>
        )}
      </>
    );
  }
  return (
    <>
      <div className="eyebrow">ALTOS BRAINSPHERE / GB10 F1</div>
      <h2>Compact. Capable. Connected.</h2>
      <p>NVIDIA GB10 Grace Blackwell<br />{s.cpu.cores.length} Arm CPU cores ({s.cpu.model})<br />128 GB LPDDR5x unified memory<br />Driver {s.gpu?.driver ?? "–"} · {s.host.os}</p>
      <p>CPU and GPU share one coherent memory pool, so GPU memory is not added to total RAM.</p>
      <a href="https://www.altoscomputing.com/en-IN/products/detail/GB10-F1" target="_blank" rel="noreferrer">View official Altos specifications</a>
    </>
  );
}

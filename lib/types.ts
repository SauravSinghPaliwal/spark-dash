export interface GpuInfo {
  name: string;
  driver: string;
  util: number; // %
  memUsed: number; // bytes (sum of process usage on unified-memory GPUs)
  memTotal: number; // bytes
  unifiedMemory: boolean;
  temp: number | null;
  power: number | null; // W
  powerLimit: number | null;
  clock: number | null; // MHz
  maxClock: number | null;
}

export interface GpuProc {
  pid: number;
  name: string;
  memBytes: number;
}

export interface Disk {
  mount: string;
  device: string;
  fs: string;
  size: number;
  used: number;
}

export interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  cpu: number | null;
  memUsed: number | null;
  memLimit: number | null;
  memPct: number | null;
  netIO: string | null;
  blockIO: string | null;
}

export interface HostProc {
  pid: number;
  name: string;
  cpu: number; // % of one core
  memBytes: number;
}

export interface ModelService {
  id: string;
  engine: string; // vLLM, Ollama, llama.cpp, Python...
  kind: "llm" | "other";
  title: string; // model name or script
  pid: number;
  procs: number;
  user: string;
  cmd: string;
  ports: number[];
  cpu: number; // % of one core
  memBytes: number;
  gpuMem: number;
  uptime: number; // seconds
  models: string[]; // models reported by the server API
  api: "up" | "down" | "none";
}

export interface Snapshot {
  ts: number;
  host: { hostname: string; os: string; uptime: number; load: [number, number, number]; kernel: string; arch: string };
  cpu: { model: string; total: number; cores: number[]; temp: number | null };
  mem: { total: number; used: number; free: number; swapTotal: number; swapUsed: number };
  disks: Disk[];
  gpu: GpuInfo | null;
  gpuProcs: GpuProc[];
  containers: Container[];
  dockerError: string | null;
  dockerDisk: number | null; // bytes used by images, containers and volumes
  procs: HostProc[];
  services: ModelService[];
}

export type RangeKey = "1h" | "6h" | "24h";
export interface HistorySeries { t: number[]; gpu: number[]; cpu: number[]; mem: number[] }

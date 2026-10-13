// Cost math that doesn't touch AWS, so it can be unit-tested. Real spend comes from Cost Explorer (server/billing.ts);
// these list-price estimates answer "what does this cost to run?" instantly and for free — for a service that is about
// to be created, or an environment whose account has no Cost Explorer access.
//
// Prices are us-east-1 on-demand list prices (Linux, no Savings Plans / Reserved / Spot). Other regions are usually
// within ±15 %; `console.config.json` → `pricing` can override the Fargate rates and apply a regional multiplier.

export const HOURS_PER_MONTH = 730; // AWS's own convention for monthly estimates

export interface Rates {
  fargateVcpuHour: number; // x86; ARM (Graviton) is 20 % cheaper
  fargateGbHour: number;
  multiplier: number; // applied to every estimate, e.g. 1.05 for a pricier region
}

export const DEFAULT_RATES: Rates = { fargateVcpuHour: 0.04048, fargateGbHour: 0.004445, multiplier: 1 };

// ECS task sizes: cpu in units (1024 = 1 vCPU), memory in MiB.
export function fargateHourly(cpuUnits: number, memMiB: number, arm = false, r: Rates = DEFAULT_RATES): number {
  const perVcpu = arm ? r.fargateVcpuHour * 0.8 : r.fargateVcpuHour;
  const perGb = arm ? r.fargateGbHour * 0.8 : r.fargateGbHour;
  return ((cpuUnits / 1024) * perVcpu + (memMiB / 1024) * perGb) * r.multiplier;
}

// Price of the "large" size per family; other sizes scale linearly (xlarge = 2 × large, micro = large / 8, …).
const EC2_LARGE: Record<string, number> = {
  t3: 0.0832, t3a: 0.0752, t4g: 0.0672, m5: 0.096, m5a: 0.086, m6i: 0.096, m6a: 0.0864, m6g: 0.077, m7i: 0.1008, m7g: 0.0816,
  c5: 0.085, c5a: 0.077, c6i: 0.085, c6a: 0.0765, c6g: 0.068, c7i: 0.08925, c7g: 0.0725, r5: 0.126, r6i: 0.126, r6g: 0.1008, r7g: 0.1071,
};
const RDS_LARGE: Record<string, number> = {
  "db.t3": 0.145, "db.t4g": 0.129, "db.m5": 0.178, "db.m6i": 0.178, "db.m6g": 0.159, "db.m7g": 0.168, "db.r5": 0.25, "db.r6i": 0.25, "db.r6g": 0.225, "db.r7g": 0.239,
};
const SIZE: Record<string, number> = { nano: 1 / 16, micro: 1 / 8, small: 1 / 4, medium: 1 / 2, large: 1, xlarge: 2, "2xlarge": 4, "4xlarge": 8, "8xlarge": 16, "12xlarge": 24, "16xlarge": 32, "24xlarge": 48 };

function sized(table: Record<string, number>, type: string): number | undefined {
  const i = type.lastIndexOf(".");
  const base = table[type.slice(0, i)];
  const mult = SIZE[type.slice(i + 1)];
  return base !== undefined && mult !== undefined ? base * mult : undefined;
}

// undefined = not in the table; callers show "no estimate" rather than a made-up number.
export const ec2Hourly = (instanceType: string, r: Rates = DEFAULT_RATES) => {
  const p = sized(EC2_LARGE, instanceType);
  return p === undefined ? undefined : p * r.multiplier;
};

// PostgreSQL single-AZ list price; Multi-AZ doubles it. Storage and I/O are not included.
export const rdsHourly = (instanceClass: string, multiAz = false, r: Rates = DEFAULT_RATES) => {
  const p = sized(RDS_LARGE, instanceClass);
  return p === undefined ? undefined : p * (multiAz ? 2 : 1) * r.multiplier;
};

// Redis OSS / Memcached node price; Valkey nodes list 20 % lower. t-family caches stop at medium (large is the
// scaling base only).
const CACHE_LARGE: Record<string, number> = {
  "cache.t3": 0.136, "cache.t4g": 0.128, "cache.m5": 0.156, "cache.m6g": 0.149, "cache.m7g": 0.158, "cache.r5": 0.216, "cache.r6g": 0.206, "cache.r7g": 0.219,
};

export const cacheHourly = (nodeType: string, engine = "redis", r: Rates = DEFAULT_RATES) => {
  const p = sized(CACHE_LARGE, nodeType);
  return p === undefined ? undefined : p * (engine === "valkey" ? 0.8 : 1) * r.multiplier;
};

export const monthly = (hourly: number) => hourly * HOURS_PER_MONTH;

export const usd = (n: number) => (Math.abs(n) >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`);

// console.config.json → pricing. Only positive numbers override a default.
export function ratesFrom(p?: Partial<Rates>): Rates {
  const pos = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
  return { fargateVcpuHour: pos(p?.fargateVcpuHour, DEFAULT_RATES.fargateVcpuHour), fargateGbHour: pos(p?.fargateGbHour, DEFAULT_RATES.fargateGbHour), multiplier: pos(p?.multiplier, DEFAULT_RATES.multiplier) };
}

// ---------- run-rate estimate of what is running now ----------
// Structural inputs (a subset of RawService / RawBox / RawDb / RawCache) so this stays pure and testable.

export interface EstService {
  name: string;
  label?: string;
  launchType: "EC2" | "FARGATE" | "UNKNOWN";
  launchTypes?: string[]; // from the task definition's requiresCompatibilities
  running: number;
  cpu?: string; // task-level units, e.g. "512"
  memory?: string; // task-level MiB, e.g. "1024"
  arch?: string; // "arm64" for Graviton task definitions
}
export interface EstHost { id: string; name: string; type: string; state: string }
export interface EstDb { id: string; instanceClass: string; multiAz: boolean; status: string; engine: string }
export interface EstCache { id: string; nodeType?: string; nodes: number; engine: string; status: string }

export interface RunItem {
  kind: "service" | "host" | "database" | "cache";
  id: string;
  name: string;
  detail: string; // "2 × 1 vCPU · 2 GB · ARM"
  monthly: number | null; // null = no list price for this size (never guessed)
  note?: string; // "counted with its EC2 host", "stopped", …
}

export interface RunEstimate {
  monthly: number; // sum of priced items
  items: RunItem[];
  unpriced: string[]; // names of items that have no estimate
}

const vcpu = (units: number) => `${+(units / 1024).toFixed(2)} vCPU`;
const gb = (mib: number) => `${+(mib / 1024).toFixed(2)} GB`;
const num = (v?: string) => (v && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : undefined);
// Fargate task sizes may be written "1 vCPU" / "2 GB" in a task definition; ECS returns them normalised, but be lenient.
function units(v: string | undefined, kind: "cpu" | "mem"): number | undefined {
  const n = num(v);
  if (n !== undefined) return n;
  const m = (kind === "cpu" ? /^([\d.]+)\s*vcpu$/i : /^([\d.]+)\s*gb$/i).exec(v?.trim() ?? "");
  return m ? Number(m[1]) * 1024 : undefined;
}
const onFargate = (s: EstService) => s.launchType === "FARGATE" || (s.launchType === "UNKNOWN" && (s.launchTypes ?? []).includes("FARGATE"));
const STOPPED_DB = new Set(["stopped", "stopping"]);

// Fargate tasks are priced by task size × running count. Services on EC2 cost what their hosts cost, so they are
// listed with a note and no amount (adding both would count the instance twice).
export function estimateRunRate(input: { services: EstService[]; hosts: EstHost[]; databases: EstDb[]; caches: EstCache[] }, r: Rates = DEFAULT_RATES): RunEstimate {
  const items: RunItem[] = [];
  for (const s of input.services) {
    const name = s.label ?? s.name;
    if (!onFargate(s)) {
      items.push({ kind: "service", id: s.name, name, detail: `${s.running} task${s.running === 1 ? "" : "s"} · EC2`, monthly: null, note: "counted with its EC2 host" });
      continue;
    }
    const cpu = units(s.cpu, "cpu"), mem = units(s.memory, "mem");
    const arm = s.arch === "arm64";
    const size = cpu !== undefined && mem !== undefined ? `${vcpu(cpu)} · ${gb(mem)}` : "task size unknown";
    const detail = `${s.running} × ${size} · Fargate${arm ? " ARM" : ""}`;
    if (cpu === undefined || mem === undefined) items.push({ kind: "service", id: s.name, name, detail, monthly: null, note: "no task-level cpu/memory" });
    else items.push({ kind: "service", id: s.name, name, detail, monthly: monthly(fargateHourly(cpu, mem, arm, r) * Math.max(0, s.running)), note: s.running ? undefined : "scaled to zero" });
  }
  for (const h of input.hosts) {
    const p = ec2Hourly(h.type, r);
    const running = h.state === "running" || h.state === "pending";
    items.push({ kind: "host", id: h.id, name: h.name, detail: `${h.type} · EC2`, monthly: !running ? 0 : p === undefined ? null : monthly(p), note: running ? undefined : `${h.state} — EBS volumes still billed` });
  }
  for (const d of input.databases) {
    const p = rdsHourly(d.instanceClass, d.multiAz, r);
    const stopped = STOPPED_DB.has(d.status);
    const detail = `${d.instanceClass}${d.multiAz ? " · Multi-AZ" : ""} · ${d.engine}`;
    items.push({ kind: "database", id: d.id, name: d.id, detail, monthly: stopped ? 0 : p === undefined ? null : monthly(p), note: stopped ? "stopped — storage still billed, AWS restarts it after 7 days" : undefined });
  }
  for (const c of input.caches) {
    const p = c.nodeType ? cacheHourly(c.nodeType, c.engine, r) : undefined;
    const n = Math.max(1, c.nodes);
    items.push({ kind: "cache", id: c.id, name: c.id, detail: `${n} × ${c.nodeType ?? "unknown node"} · ${c.engine}`, monthly: p === undefined ? null : monthly(p * n) });
  }
  return {
    monthly: items.reduce((a, x) => a + (x.monthly ?? 0), 0),
    items,
    unpriced: items.filter((x) => x.monthly === null && !x.note?.startsWith("counted with")).map((x) => x.name),
  };
}

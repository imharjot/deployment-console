// Costs: actual AWS spend (Cost Explorer) and the free list-price estimate of what is running.
// Cost Explorer bills every request ($0.01) and answers from us-east-1 whatever AWS_REGION says. So the console takes
// one *snapshot* — a fixed set of 4 requests (daily by service, month by env/service tag, forecast, anomalies; more
// only if a result pages) — at most once per `costs.cacheHours` (6 h), only when someone opens the page or asks
// through the API, and keeps it in memory AND in the console DB (settings key `costs:snapshot`) so restarts and other
// instances don't pay again. A manual refresh is limited to one per 5 minutes across all users and is audited.
// Read-only towards AWS. Everything behind this needs the `costs` permission (checked by the routes and operations).
import "server-only";
import { estimateRunRate, leftovers, ratesFrom, type Leftovers } from "../costs.ts";
import { idName } from "../inventory/assign.ts";
import {
  SERVICE_TAG, SPLIT_COST_TAG, buildSpend, classifyCeError, fixFor, isoDay, windowOf, type CeErrorCode, type CostsView, type Day, type EnvRef, type Part,
  type RawAnomaly, type RunRateEnv, type RunRateView, type SpendSnapshot, type SpendUnavailable, type SpendView,
} from "../spend.ts";
import { writeAudit } from "./audit.ts";
import { cached } from "./cache.ts";
import { getDb } from "./db.ts";
import { consoleConfig, inventory, listEnvs, servicesOf } from "./discovery.ts";
import { HttpError, errText } from "./errors.ts";
import { getInventory } from "./inventory.ts";
import { homeRegion, sourceKind } from "./sources.ts";

// ---------- the source ----------

export interface CostQuery {
  start: Day; // inclusive
  end: Day; // exclusive
  granularity: "DAILY" | "MONTHLY";
  groupBy: { type: "DIMENSION" | "TAG"; key: string }[]; // at most two (a Cost Explorer limit)
}

// One result group, normalised: USD, tag values without their "key$" prefix ("" = resource without the tag).
export interface CostRow {
  start: Day;
  keys: string[];
  amount: number;
  estimated: boolean;
}

// A third narrow door to the outside, beside Cloud and Ci (sources.ts), with its own real and mock implementation.
export interface Billing {
  kind: "aws" | "mock";
  costAndUsage(q: CostQuery): Promise<CostRow[]>; // GetCostAndUsage, all pages (UnblendedCost, credits and refunds excluded)
  forecast(start: Day, end: Day): Promise<number | null>; // GetCostForecast; null = AWS has too little history yet
  anomalies(start: Day, end: Day): Promise<RawAnomaly[]>; // GetAnomalies (Cost Anomaly Detection)
  requests(): number; // billed requests this process has made
}

// On globalThis like getCloud(): routes and instrumentation are bundled separately but must share one snapshot.
const g = globalThis as { __consoleBilling?: Promise<Billing>; __consoleCosts?: Stored; __consoleCostsInflight?: Promise<Stored> };

export function getBilling(): Promise<Billing> {
  g.__consoleBilling ??= sourceKind() === "aws" ? import("./billing-aws.ts").then((m) => m.awsBilling()) : import("./billing-mock.ts").then((m) => m.mockBilling());
  return g.__consoleBilling;
}

// ---------- settings ----------

const KEY = "costs:snapshot";
const RETRY_MS = 15 * 60_000; // after a failed snapshot, page loads wait this long before paying for another try
const REFRESH_GAP_MS = 5 * 60_000; // manual refreshes, across all users and instances
export const BASE_REQUESTS = 4;

function settings() {
  const { config } = consoleConfig();
  return {
    tagKey: config.costs?.tagKey ?? SPLIT_COST_TAG,
    spikePercent: config.costs?.spikePercent ?? 30,
    cacheHours: config.costs?.cacheHours ?? 6,
    rates: ratesFrom(config.pricing, homeRegion()),
    customRates: Object.keys(config.pricing ?? {}).length > 0,
  };
}

// ---------- snapshot: take, store, reuse ----------

interface Stored {
  snapshot?: SpendSnapshot;
  error?: { at: number; code: CeErrorCode; reason: string; source: "aws" | "mock" };
}

const describe = (e: unknown) => ({ code: classifyCeError((e as Error)?.name, (e as Error)?.message), reason: errText(e) });

async function part<T extends object>(fn: () => Promise<T>): Promise<Part<T>> {
  try {
    return { status: "ok", ...(await fn()) };
  } catch (e) {
    return { status: "unavailable", ...describe(e) };
  }
}

async function takeSnapshot(b: Billing, tagKey: string): Promise<SpendSnapshot> {
  const w = windowOf(isoDay(Date.now()));
  const before = b.requests();
  // The daily query carries the headline numbers; if it fails the snapshot fails. The other three degrade alone.
  const rows = await b.costAndUsage({ start: w.dailyFrom, end: w.tomorrow, granularity: "DAILY", groupBy: [{ type: "DIMENSION", key: "SERVICE" }] });
  const byServiceTag = tagKey === SERVICE_TAG;
  const [tags, forecast, anomalies] = await Promise.all([
    part(async () => {
      const groupBy: CostQuery["groupBy"] = byServiceTag ? [{ type: "TAG", key: tagKey }] : [{ type: "TAG", key: tagKey }, { type: "TAG", key: SERVICE_TAG }];
      const r = await b.costAndUsage({ start: w.month, end: w.tomorrow, granularity: "MONTHLY", groupBy });
      return { rows: r.map((x) => ({ tag: x.keys[0] ?? "", service: (byServiceTag ? x.keys[0] : x.keys[1]) ?? "", amount: x.amount })) };
    }),
    part(async () => ({ amount: await b.forecast(w.today, w.nextMonth) })),
    part(async () => ({ items: await b.anomalies(w.anomaliesFrom, w.today) })),
  ]);
  const daily: SpendSnapshot["daily"] = {};
  for (const r of rows) {
    const day = (daily[r.start] ??= {});
    const svc = r.keys[0] || "Other";
    day[svc] = (day[svc] ?? 0) + r.amount;
  }
  return {
    v: 1, fetchedAt: Date.now(), today: w.today, source: b.kind, requests: b.requests() - before, estimated: rows.some((r) => r.estimated),
    daily, tagKey, tags, forecast, anomalies,
  };
}

// The DB copy survives restarts and is shared by instances on one Postgres. A DB problem never breaks the page:
// the worst case is an extra snapshot.
async function load(): Promise<Stored> {
  try {
    const row = await (await getDb()).get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [KEY]);
    const v = row ? (JSON.parse(row.value) as Stored) : {};
    return { snapshot: v.snapshot?.v === 1 ? v.snapshot : undefined, error: v.error };
  } catch (e) {
    console.error(JSON.stringify({ level: 40, msg: "costs: could not read the stored snapshot", err: errText(e) }));
    return g.__consoleCosts ?? {};
  }
}

async function save(s: Stored) {
  try {
    await (await getDb()).run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [KEY, JSON.stringify(s)]);
  } catch (e) {
    console.error(JSON.stringify({ level: 40, msg: "costs: could not store the snapshot", err: errText(e) }));
  }
}

const lastAttempt = (s: Stored) => Math.max(s.snapshot?.fetchedAt ?? 0, s.error?.at ?? 0);

// Fresh = a snapshot of this source and tag key inside the TTL, or a recent failure (don't pay to fail again).
function isFresh(s: Stored, kind: Billing["kind"], tagKey: string, ttlMs: number, now = Date.now()) {
  const snap = s.snapshot && s.snapshot.source === kind && s.snapshot.tagKey === tagKey && now - s.snapshot.fetchedAt < ttlMs;
  const failed = s.error && s.error.source === kind && now - s.error.at < RETRY_MS && s.error.at > (s.snapshot?.fetchedAt ?? 0);
  return !!(snap || failed);
}

async function ensure(force: boolean): Promise<Stored> {
  const { tagKey, cacheHours } = settings();
  const b = await getBilling();
  const ttl = cacheHours * 3600_000;
  let s = g.__consoleCosts;
  if (!s || !isFresh(s, b.kind, tagKey, ttl)) s = g.__consoleCosts = await load(); // another process may have paid already
  if (!force && isFresh(s, b.kind, tagKey, ttl)) return s;
  const prev = s;
  // One snapshot at a time: concurrent page loads and refreshes share it.
  g.__consoleCostsInflight ??= (async () => {
    let next: Stored;
    try {
      next = { snapshot: await takeSnapshot(b, tagKey) };
    } catch (e) {
      next = { snapshot: prev.snapshot, error: { at: Date.now(), ...describe(e), source: b.kind } };
      console.error(JSON.stringify({ level: 40, msg: "costs: Cost Explorer snapshot failed", err: next.error!.reason }));
    }
    await save(next);
    return (g.__consoleCosts = next);
  })().finally(() => {
    g.__consoleCostsInflight = undefined;
  });
  return g.__consoleCostsInflight;
}

// ---------- views ----------

async function envContext(): Promise<{ envs: EnvRef[]; names: Record<string, string> }> {
  try {
    const [envs, inv] = await Promise.all([listEnvs(), inventory()]);
    const names: Record<string, string> = {};
    for (const [id, c] of inv.catalogs) for (const [svc, m] of c.meta) names[`${id}/${svc}`] = m.name;
    return { envs: envs.map((e) => ({ id: e.id, label: e.label, cluster: e.cluster, protected: e.protected })), names };
  } catch {
    return { envs: [], names: {} }; // discovery down: tags still show, as raw cluster names
  }
}

async function actualView(s: Stored, kind: Billing["kind"]): Promise<SpendView | SpendUnavailable> {
  const st = settings();
  const snap = s.snapshot?.source === kind ? s.snapshot : undefined;
  if (!snap) {
    const e = s.error ?? { at: Date.now(), code: "error" as const, reason: "no snapshot yet", source: kind };
    return { status: "unavailable", source: kind, code: e.code, reason: e.reason, fix: fixFor(e.code, "costs"), at: e.at };
  }
  const view = buildSpend(snap, { ...(await envContext()), spikePercent: st.spikePercent, ttlMs: st.cacheHours * 3600_000 });
  if (s.error && s.error.at > snap.fetchedAt) view.warning = `The last refresh failed (${s.error.reason}); these numbers are from the snapshot before it.`;
  return view;
}

// Free and instant: what is running now × list prices. Recomputed at most every 30 s from discovery's caches.
export async function runRate(): Promise<RunRateView> {
  const { rates, customRates } = settings();
  return (await cached(`costs:estimate:${JSON.stringify(rates)}`, 30_000, () => buildRunRate(customRates))).value;
}

async function buildRunRate(customRates: boolean): Promise<RunRateView> {
  const pricing = consoleConfig().config.pricing;
  const errors: string[] = [];
  const [envs, inv, view] = await Promise.all([listEnvs(), inventory(), getInventory().catch((err) => void errors.push(`inventory: ${errText(err)}`))]);
  errors.unshift(...inv.errors);
  const out: RunRateEnv[] = [];
  for (const e of envs) {
    const rates = ratesFrom(pricing, e.region);
    const c = inv.catalogs.get(e.id);
    const services = await servicesOf(e.cluster, e.region).catch((err) => (errors.push(`${e.id} services: ${errText(err)}`), []));
    const est = estimateRunRate(
      {
        // Hidden services still cost money, so they are counted too.
        services: services.map((s) => ({
          name: s.name, label: c?.meta.get(s.name)?.name, launchType: s.launchType, launchTypes: s.taskDef?.launchTypes, running: s.running,
          cpu: s.taskDef?.cpu ?? s.tasks.find((x) => x.cpu)?.cpu, memory: s.taskDef?.memory ?? s.tasks.find((x) => x.memory)?.memory, arch: s.taskDef?.arch,
        })),
        hosts: c?.hosts ?? [],
        databases: c?.databases ?? [],
        caches: c?.caches ?? [],
      },
      rates,
    );
    out.push({ env: e.id, label: e.label, protected: e.protected, regions: [rates.region], ...est });
  }
  // The inventory adds what the ECS environments leave out (costs.ts leftovers); without it, discovery's own.
  const rest: Leftovers[] = view
    ? leftovers(view.resources.map((r) => ({ ...r, id: idName(r) })), new Set(out.flatMap((x) => x.items.map((i) => `${i.kind}:${i.id}`))))
    : [{ env: "", region: homeRegion(), hosts: [], ...inv.unassigned }];
  for (const g of rest) {
    const rates = ratesFrom(pricing, g.region);
    const est = estimateRunRate({ services: [], ...g }, rates);
    if (!est.items.length) continue;
    const to = out.find((o) => o.env === g.env);
    if (to) {
      Object.assign(to, {
        monthly: to.monthly + est.monthly, items: [...to.items, ...est.items], unpriced: [...to.unpriced, ...est.unpriced],
        regions: [...new Set([...to.regions, rates.region])],
      });
    } else {
      const meta = view?.envs.find((v) => v.id === g.env);
      const label = g.env ? (meta?.label ?? g.env) : "Not in an environment";
      out.push({ env: g.env, label, protected: meta?.protected ?? false, regions: [rates.region], ...est });
    }
  }
  return { at: Date.now(), monthly: out.reduce((a, x) => a + x.monthly, 0), rates: settings().rates, customRates, envs: out, errors };
}

export async function costsView(): Promise<CostsView> {
  const st = settings();
  const b = await getBilling();
  // Discovery failing (say, no ECS permission) empties the estimate but must not hide actual spend.
  const [s, estimate] = await Promise.all([
    ensure(false),
    runRate().catch((e): RunRateView => ({ at: Date.now(), monthly: 0, rates: st.rates, customRates: st.customRates, envs: [], errors: [errText(e)] })),
  ]);
  return {
    actual: await actualView(s, b.kind),
    estimate,
    refresh: { allowedAt: lastAttempt(s) + REFRESH_GAP_MS, cacheHours: st.cacheHours, requestsPerSnapshot: s.snapshot?.requests || BASE_REQUESTS },
    settings: { tagKey: st.tagKey, spikePercent: st.spikePercent },
  };
}

// The actual-spend half only (agent operations don't need the estimate computed).
export async function spendView(): Promise<SpendView | SpendUnavailable> {
  const b = await getBilling();
  return actualView(await ensure(false), b.kind);
}

// When the next manual refresh is allowed, and roughly what it costs.
export async function refreshInfo() {
  const s = await load();
  return { allowedAt: lastAttempt(s) + REFRESH_GAP_MS, requests: s.snapshot?.requests || BASE_REQUESTS };
}

// Manual refresh. Spends real money (a few cents), so it's rate-limited globally and written to the audit log.
export async function refreshCosts(actor: string, ip?: string): Promise<CostsView> {
  const { allowedAt } = await refreshInfo();
  const wait = allowedAt - Date.now();
  if (wait > 0) throw new HttpError(429, `Cost Explorer was queried less than 5 minutes ago — each query is billed. Try again in ${Math.ceil(wait / 60_000)} min.`, wait);
  const base = { env: "", target: "cost-explorer", action: "costs.refresh", user: actor, ip };
  await writeAudit({ ...base, at: Date.now(), phase: "intent", params: {} }); // fail closed: no audit row, no spend
  const s = await ensure(true);
  const failed = s.error && s.error.at >= (s.snapshot?.fetchedAt ?? 0);
  await writeAudit({ ...base, at: Date.now(), phase: "result", params: { requests: failed ? undefined : s.snapshot?.requests }, result: failed ? "error" : "ok", detail: failed ? s.error!.reason : undefined });
  return costsView();
}

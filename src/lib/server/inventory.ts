// The cloud map's server: runs every enabled provider (./providers) in every region it covers, merges what they
// report, infers edges, assigns environments, marks idle resources and serves one graph — GET /api/inventory, the
// detail, actions and coverage routes, and the cloud.* agent operations all read it from here.
//
// How a build runs (scheduling is pure, in ../inventory/schedule.ts):
// - Runs are providers × regions by scope, keyed `${id}@${region}`: regional providers once per console region, global
//   ones once (in their homeRegion), the ECS side once in home. With one region that is exactly one run per provider.
// - At most 12 runs at a time. Each run has 25 s from when it starts; its discover() runs inside withCallSignal(), so
//   the deadline also cancels the AWS calls it makes through `Cloud`. Concurrency is bounded per AWS service × region
//   where each call is sent (limitedClient), never by a slot held around a provider. A provider hands its base list to
//   ctx.checkpoint() before enriching: when the deadline cuts it short, that list is shown, marked partial (R18).
// - Two phases, each single-flight: home and global runs first (that view is served), then the other regions merge in
//   within 120 s; until they do, the view lists them in partial.pendingRegions.
// - Runs stay fresh for the provider's ttlMs (2 min by default); an ok run that found nothing is reused for 30 min.
//   `?refresh=1` re-runs everything, at most once per 20 s. After an action only the affected provider runs again.
// - Outcomes per run: AccessDenied → "denied" with the IAM action AWS named; a region that isn't enabled or a service
//   not offered there → "skipped"; other failures → "error". A denied or failed run keeps that run's last good result
//   for 30 min, and says so; enabled() false or excluded in console.config.json → "disabled". ProviderStatus stays one
//   row per provider, with a row per region in `regions`.
// - What the map believes exists is reconciled per run (../inventory/vanish.ts): a resource a complete run no longer
//   lists stays one more cycle, marked "not seen since … — confirming", and goes after the second complete run without
//   it; a partial or capped run never removes anything.
// - Every finished ok run is persisted (./inventory-store.ts). After a restart the persisted map is served at once,
//   each provider marked "from <time> — refreshing", while the first build runs.
// - Activity metrics (idle marks) are read within an hourly budget (CONSOLE_ACTIVITY_BUDGET, default 5,000 metrics):
//   once an hour per series, once a day for support resources (network, security, observability, delivery), never for
//   hidden or generic rows. A series that shows use and couldn't be read means "not enough evidence", never idle (R20).
// - "allowed" edges come from the security-group provider's rules (CC-19: groups are read once per build);
//   Cloud.securityGroups() only for groups its run in that region didn't list (none after a complete ok run).
// The result is cached on globalThis (Next bundles routes and the instrumentation separately); a read after 2 min
// serves the cached graph and refreshes in the background. GET /api/inventory sends hidden and generic rows slim, with
// a weak ETag (304 when unchanged).
//
// Trust boundary: Mention.refs (environment values, connection strings) exist only inside a build — infer() matches
// them and they're dropped (the persisted copy is sealed). The view carries resources (props, tags, endpoints —
// names, never values), edges with evidence (variable names, rule ids) and provider statuses. Props that look like URLs
// with credentials are masked as a last line of defence.
import "server-only";
import type { Freshness } from "../freshness.ts";
import { protectionOf, type Protection } from "../inventory/action-rules.ts";
import { assignEnvs, type EnvEntry, type KnownEnv } from "../inventory/assign.ts";
import { activityBudgetOf, estMonthlyUsd, idleDaysOf, idleEvidenceOf, metricsLastHour, takeTokens, type ActivitySeries, type Bucket } from "../inventory/idle.ts";
import { infer, scrubProps, type SgRule } from "../inventory/infer.ts";
import { propagate } from "../inventory/propagate.ts";
import {
  aggregate, attempt, classifyError, completeness, covered, isFresh, orderRegions, planRuns, resourceRegion, runKey, slots, truncatedBy, unreadableTypes, type PlannedRun, type RunOutcome, type Slots,
} from "../inventory/schedule.ts";
import { categoryOf, isSupport, type Edge, type InventoryCompleteness, type InventoryView, type ProviderResult, type ProviderStatus, type RegionStatus, type Resource, type ResourceDetail } from "../inventory/types.ts";
import { contributed, coverageFreshness, etagOf, isSlimRow, knownOf, reconcile, shortHash, slimRow, unresolvedOf, type Known, type Unresolved } from "../inventory/vanish.ts";
import { outsideCallSignal, withCallSignal } from "./aws-limiter.ts";
import { invalidate } from "./cache.ts";
import { generation } from "./connection-state.ts";
import { consoleConfig, inventory, listEnvs } from "./discovery.ts";
import { HttpError, errText } from "./errors.ts";
import { loadRuns, saveRun } from "./inventory-store.ts";
import { noteCounts } from "./notes.ts";
import { activityData, callerAccount, type ActivityQuery } from "./providers/ecs.ts";
import { PROVIDERS, providerById } from "./providers/index.ts";
import { ACCT } from "./providers/mock-names.ts";
import { deniedAction, type Provider, type ProviderContext } from "./providers/types.ts";
import { consoleRegions } from "./regions.ts";
import { getCloud, homeRegion, sourceKind } from "./sources.ts";

const TTL = 120_000; // a built view, and a run whose provider sets no ttlMs
const FORCE_EVERY = 20_000;
const DEADLINE = 25_000; // per run, from when it starts
const PHASE2_DEADLINE = 120_000; // the other regions merge within this, or wait for the next build
const DETAIL_DEADLINE = 15_000;
const RUN_CONCURRENCY = 12;
const CAP = 2000;
const KEEP_FAILED = 30 * 60_000;
const RESTORE_MAX_AGE = 7 * 86_400_000; // persisted runs older than this aren't served after a restart
const RESTORE_ENVS_WAIT = 3_000; // after a restart: how long the persisted map waits for the environment list…
const RESTORE_SG_WAIT = 3_000; // …and for security-group rules
const STALE_AFTER = 5 * 60_000; // the coverage view calls a map older than this stale
const ACTIVITY_TTL = 3_600_000; // an activity series is asked again after an hour…
const SUPPORT_ACTIVITY_TTL = 24 * 3_600_000; // …a support resource's after a day (CC-10)
const SG_PROVIDER = "security-group";
const EMPTY: ProviderResult = { resources: [], links: [], mentions: [] };
const VERSION = 3; // bump when State changes shape: a hot reload then starts from a fresh state

// ---------- shared state ----------

interface Run {
  key: string; // `${id}@${region}`
  id: string;
  region: string;
  result: ProviderResult; // what this run read (or, from: "older", the run it fell back to)
  known?: Known; // what the map believes this provider × region has, after reconciling with the runs before
  status: RegionStatus;
  notes: string[];
  at: number; // when its data was read (older than the run when it shows a previous result)
  startedAt: number;
  ranAt: number; // when it finished (freshness)
  rerun?: boolean; // run again on the next build (an action changed something, or it came from the DB)
  from?: "older" | "persisted"; // its data isn't this run's: a previous run's (it failed) or the DB's (restart)
  truncated?: boolean; // it hit the per-type cap
  scp?: boolean; // denied by a service control policy: per region, not a permission the console's role lacks
}

interface Plan {
  gen: number; // the AWS connection's generation it was made for: its runs and views are dropped once that is over
  home: string;
  regions: string[]; // home first
  mock: boolean;
  account?: string;
  runs: PlannedRun[];
  excluded: Map<string, string>; // provider id → why console.config.json turns it off
  notes: string[];
}

export interface VanishingRow {
  key: string;
  name: string;
  provider: string;
  region: string;
  lastSeen: number;
}

interface Built {
  view: InventoryView;
  byKey: Map<string, Resource>;
  sources: Map<string, string[]>; // key → every provider that reported it (detail() falls back along this list)
  activity: Map<string, ActivitySeries[]>;
  vanishing: VanishingRow[];
  unresolved: { total: number; list: Unresolved[] };
  slim?: Resource[]; // the resources as GET /api/inventory sends them (made on first request)
  at: number;
  gen: number; // its plan's (publish() keeps only the current connection's)
}

interface ActivityEntry {
  at: number; // when it was last asked (or claimed)
  points?: [number, number][]; // undefined: not answered
  ttl: number;
}

interface State {
  version: number;
  runs: Map<string, Run>;
  built?: Built;
  inflight?: Promise<Built>; // phase 1 (home + global) of the current build
  phase2?: { promise: Promise<void>; regions: string[] };
  restore?: Promise<Built | undefined>; // once per process: the persisted map, served while the first build runs
  forcedAt: number;
  dirty: boolean;
  invalidatedAt: Map<string, number>; // provider id → when an action last changed what it reads
  activity: Map<string, ActivityEntry>;
  budget?: Bucket; // CloudWatch metrics this hour (CC-10)
  account?: { id?: string; at: number };
  lastCompleteAt?: number;
  slots: Slots;
}

const g = globalThis as { __consoleInventory?: State };
function state(): State {
  const old = g.__consoleInventory;
  if (old?.version === VERSION) return old;
  // First use, or an older shape after a hot reload: start over, keeping what costs money to fetch again.
  return (g.__consoleInventory = {
    version: VERSION, runs: new Map(), forcedAt: 0, dirty: false, invalidatedAt: new Map(),
    activity: old?.activity instanceof Map ? old.activity : new Map(), budget: old?.budget, account: old?.account, slots: slots(RUN_CONCURRENCY),
  });
}

const timeout = (what: string, ms: number) => Object.assign(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`), { name: "TimeoutError" });
const log = (msg: string) => (e: unknown) => console.error(JSON.stringify({ level: 40, msg, err: errText(e) }));
const hhmm = (at: number) => new Date(at).toISOString().slice(11, 16);

function contextFor(base: { region: string; regions: string[]; home: string; accountId?: string; mock: boolean }, signal: AbortSignal, notes: string[], checkpoint?: (r: ProviderResult) => void): ProviderContext {
  const late = () => Promise.reject(timeout("discovery", DEADLINE));
  return {
    ...base,
    cap: CAP,
    signal,
    // A deadline guard, not a slot: concurrency is bounded per AWS service × region where each call is sent
    // (limitedClient), so nothing here can hold a slot while it waits (R19). Calls queued after the deadline never start.
    limit: <T,>(fn: () => Promise<T>) => (signal.aborted ? (late() as Promise<T>) : Promise.resolve().then(fn)),
    note: (msg) => {
      if (!signal.aborted && notes.length < 20 && !notes.includes(msg)) notes.push(String(msg).slice(0, 300));
    },
    ...(checkpoint ? { checkpoint } : {}),
  };
}

const normalise = (r: Partial<ProviderResult> | undefined): ProviderResult => ({
  resources: Array.isArray(r?.resources) ? [...r.resources] : [], links: Array.isArray(r?.links) ? [...r.links] : [], mentions: Array.isArray(r?.mentions) ? [...r.mentions] : [],
  ...(Array.isArray(r?.sgRules) ? { sgRules: [...r.sgRules] } : {}),
});

// ---------- the plan: which runs, where ----------

async function regionsNow(): Promise<{ home: string; regions: string[]; problems: string[] }> {
  try {
    const r = await consoleRegions();
    return { home: r.home, regions: orderRegions(r.regions, r.home), problems: r.problems ?? [] };
  } catch (e) {
    log("inventory: console regions unavailable — reading the home region only")(e);
    const home = homeRegion();
    return { home, regions: [home], problems: [`regions: ${errText(e)} — reading ${home} only`] };
  }
}

async function accountId(mock: boolean): Promise<string | undefined> {
  if (mock) return ACCT;
  const s = state();
  if (s.account && Date.now() - s.account.at < (s.account.id ? 24 : 1) * 3_600_000) return s.account.id;
  try {
    s.account = { id: await callerAccount(), at: Date.now() };
  } catch (e) {
    log("sts:GetCallerIdentity failed")(e);
    s.account = { id: undefined, at: Date.now() };
  }
  return s.account.id;
}

async function makePlan(): Promise<Plan> {
  const gen = generation();
  const mock = sourceKind() === "mock";
  const { home, regions, problems } = await regionsNow();
  const notes: string[] = [...problems];
  // console.config.json inventory.providers: run only `include` (when set), never `exclude`.
  const cfg = consoleConfig().config.inventory?.providers;
  const excluded = new Map<string, string>();
  for (const p of PROVIDERS) {
    if (cfg?.exclude?.includes(p.id)) excluded.set(p.id, "turned off in console.config.json (inventory.providers.exclude)");
    else if (cfg?.include && !cfg.include.includes(p.id)) excluded.set(p.id, "not listed in console.config.json (inventory.providers.include)");
  }
  const unknown = [...(cfg?.include ?? []), ...(cfg?.exclude ?? [])].filter((id) => !providerById(id));
  if (unknown.length) notes.push(`inventory.providers: no provider called ${unknown.map((x) => `"${x}"`).join(", ")} (Settings → AWS permissions lists the ids)`);
  return { gen, home, regions, mock, account: await accountId(mock), runs: planRuns(PROVIDERS, regions, home, mock), excluded, notes };
}

// ---------- one run ----------

async function runOne(p: Provider, pr: PlannedRun, plan: Plan, previous?: Run): Promise<Run> {
  const startedAt = Date.now();
  const where = plan.regions.length > 1 || pr.region !== plan.home ? ` in ${pr.region}` : "";
  const run = (o: Omit<Run, "key" | "id" | "region" | "startedAt" | "ranAt" | "at" | "status" | "notes"> & { status: Partial<RegionStatus>; notes?: string[]; at?: number }): Run => {
    const ranAt = Date.now();
    return {
      ...o, key: pr.key, id: p.id, region: pr.region, startedAt, ranAt, at: o.at ?? startedAt, notes: o.notes ?? [],
      status: { region: pr.region, state: "ok", count: o.result.resources.length, at: startedAt, ...o.status },
    };
  };
  const off = plan.excluded.get(p.id);
  if (off) return run({ result: EMPTY, status: { state: "disabled", error: off } });
  let enabled: { ok: true } | { ok: false; why: string };
  try {
    enabled = p.enabled?.() ?? { ok: true };
  } catch (e) {
    enabled = { ok: false, why: errText(e) };
  }
  if (!enabled.ok) return run({ result: EMPTY, status: { state: "disabled", error: enabled.why } });

  const notes: string[] = [];
  const a = await attempt<ProviderResult>({
    what: p.label,
    deadlineMs: DEADLINE,
    within: withCallSignal,
    run: (signal, checkpoint) => p.discover(contextFor({ region: pr.region, regions: plan.regions, home: plan.home, accountId: plan.account, mock: plan.mock }, signal, notes, (r) => checkpoint(normalise(r)))),
  });
  if (a.kind === "done") {
    const result = normalise(a.result);
    return run({ result, status: { ms: a.ms }, notes, truncated: truncatedBy(result, notes, CAP) });
  }
  // R18: the deadline cut it short after it listed: show the list, marked partial — not nothing, not an old copy.
  if (a.kind === "partial") {
    const why = `${p.label}${where}: timed out after ${DEADLINE / 1000} s — showing what it listed before the cut`;
    return run({ result: a.result, status: { ms: a.ms, partial: true, error: why }, notes: [...notes, why], truncated: truncatedBy(a.result, notes, CAP) });
  }
  const { error: e, ms } = a;
  const kind = classifyError(e, { home: pr.region === plan.home, listedBefore: !!previous?.result.resources.length });
  if (kind === "skipped") return run({ result: EMPTY, status: { state: "skipped", error: `not available in ${pr.region}: ${errText(e).slice(0, 160)}`, ms } });
  const scp = kind === "denied" && /service control polic/i.test(String((e as Error)?.message));
  if (kind === "error") console.error(JSON.stringify({ level: 40, msg: "inventory provider failed", provider: p.id, region: pr.region, err: errText(e) }));
  // A run that failed or was refused never removes what its provider listed before: that stays for 30 min, with its
  // time. (A region a service control policy closes outside home is a fact about the region, like "not offered".)
  const keep = !(scp && pr.region !== plan.home) && previous && previous.result.resources.length && startedAt - previous.at < KEEP_FAILED ? previous : undefined;
  const since = keep ? ` — showing what it found at ${hhmm(keep.at)} UTC` : "";
  const kept = { result: keep?.result ?? EMPTY, notes, at: keep?.at, ...(keep ? { from: "older" as const } : {}) };
  if (kind === "denied") return run({ ...kept, status: { state: "denied", missing: [deniedAction(e) ?? "(unknown action)"], error: `${errText(e)}${since}`, ms }, scp });
  return run({ ...kept, status: { state: "error", error: `${errText(e)}${since}`, ms } });
}

// What the map believes the run's provider × region has, given the run before it (vanish.ts).
function knownAfter(prev: Run | undefined, r: Run): Known {
  if (r.from === "older") return prev ? knownOfRun(prev) : knownOfRun(r); // nothing changes while the provider fails
  if (r.from === "persisted" || r.status.state !== "ok") return knownOfRun(r); // disabled, skipped, or failed with nothing to show
  return reconcile(prev ? knownOfRun(prev) : undefined, { ...r.result, at: r.at, complete: !r.status.partial && !r.truncated });
}
const knownOfRun = (r: Run): Known => r.known ?? knownOf({ ...r.result, at: r.at });

const fresh = (r: Run | undefined, p: Provider, now: number, force: boolean) =>
  isFresh(r && { state: r.status.state, count: r.result.resources.length, partial: r.status.partial, ranAt: r.ranAt, rerun: r.rerun }, p.ttlMs, now, force);

function persist(r: Run, account: string | undefined) {
  if (r.from || r.status.state !== "ok") return;
  void saveRun({ provider: r.id, region: r.region, at: r.at, account, status: r.status, result: r.result });
}

// Runs whatever in `list` isn't fresh, at most RUN_CONCURRENCY at a time. With a deadline, runs that haven't started
// when it fires are left for the next build (keeping what they had).
async function runAll(list: PlannedRun[], plan: Plan, force: boolean, deadline?: AbortSignal): Promise<void> {
  const s = state();
  const now = Date.now();
  await Promise.all(
    list.map(async (pr) => {
      const p = providerById(pr.id);
      if (!p) return;
      const prev = s.runs.get(pr.key);
      if (fresh(prev, p, now, force)) return;
      let r: Run;
      try {
        r = await s.slots(() => runOne(p, pr, plan, prev), deadline);
      } catch (e) {
        if (prev) return; // not started in time: keep what it has (it isn't fresh, so the next build runs it)
        const at = Date.now();
        r = { key: pr.key, id: p.id, region: pr.region, result: EMPTY, notes: [], at, startedAt: at, ranAt: at, rerun: true, status: { region: pr.region, state: "error", count: 0, at, error: `not read yet: ${errText(e)}` } };
      }
      if (plan.gen !== generation()) return; // read for an AWS connection that has since been switched away from
      r.known = knownAfter(s.runs.get(pr.key) ?? prev, r);
      if ((s.invalidatedAt.get(p.id) ?? 0) > r.startedAt) r.rerun = true; // an action changed it while it ran
      s.runs.set(pr.key, r);
      persist(r, plan.account);
    }),
  );
}

// ---------- assembling the view ----------

// One row per provider (schedule.ts aggregate): with one region exactly what its run said.
function providerStatus(p: Provider, runs: Run[], plan: Plan): ProviderStatus {
  let off = plan.excluded.get(p.id);
  if (!runs.length && !off)
    try {
      const e = p.enabled?.();
      if (e && !e.ok) off = e.why;
    } catch (err) {
      off = errText(err);
    }
  return aggregate(p, runs, { home: plan.home, regions: plan.regions, off });
}

// Inbound rules for "allowed" edges, per region: a group id only means something in its own region. CC-19: the
// security-group provider's rules (groups are then read once per build). Its rules are used whenever its run there has
// any (infer() prefers them over this read anyway); Cloud.securityGroups() is asked only for the groups that run didn't
// list — all of them where it has no rules, none after a complete ok run (a group it doesn't list isn't there), and the
// missing ones after a run that was capped, cut short, failed (an older result) or restored from the DB.
async function sgRules(results: ProviderResult[], plan: Plan, notes: string[], waitMs = DEADLINE): Promise<Record<string, SgRule[]>> {
  const s = state();
  const byRegion = new Map<string, Set<string>>();
  for (const r of results.flatMap((x) => x.resources)) {
    if (!r?.securityGroups?.length) continue;
    const region = resourceRegion(r, plan.home);
    const set = byRegion.get(region) ?? byRegion.set(region, new Set()).get(region)!;
    for (const id of r.securityGroups) set.add(id);
  }
  const rules: Record<string, SgRule[]> = {};
  await Promise.all(
    [...byRegion].map(async ([region, ids]) => {
      const sg = s.runs.get(runKey(SG_PROVIDER, region));
      const read = sg?.result.sgRules;
      let ask = [...ids];
      if (sg && read) {
        for (const x of read)
          if (ids.has(x.groupId)) rules[x.groupId] = x.inbound.map((i) => ({ fromPort: i.fromPort, toPort: i.toPort, groups: [...(i.groups ?? [])], cidrs: i.cidrs, prefixLists: i.prefixLists }));
        const complete = sg.status.state === "ok" && !sg.from && !sg.status.partial && !sg.truncated;
        ask = complete ? [] : ask.filter((id) => !rules[id]);
      }
      if (!ask.length) return;
      try {
        const cloud = await getCloud(region);
        for (const x of await withCallSignal(AbortSignal.timeout(waitMs), () => cloud.securityGroups(ask))) rules[x.id] = x.inbound;
      } catch (e) {
        const missing = deniedAction(e);
        notes.push(`security groups${byRegion.size > 1 || region !== plan.home ? ` in ${region}` : ""}: ${missing ? `the console's role can't read them (${missing})` : errText(e)} — no "allowed" edges`);
      }
    }),
  );
  return rules;
}

// No activity metrics for rows that are never drawn (hidden, generic) or that are only being confirmed gone.
const noActivity = (r: Resource) => isSlimRow(r) || r.facts?.vanishing === true;

// Activity series per resource for idle marks and the panel's charts (CC-10, R20). Every declared series is returned:
// with points when CloudWatch answered within its TTL, without when it wasn't read (failed, denied, not asked yet
// because the hourly budget is spent) — idle.ts treats a missing required series as insufficient evidence.
async function activityFor(resources: Resource[], home: string, days: number, notes: string[]): Promise<Map<string, ActivitySeries[]>> {
  const s = state();
  const now = Date.now();
  const perHour = activityBudgetOf(process.env.CONSOLE_ACTIVITY_BUDGET);
  // 0 turns activity metrics off: idle marks then rest on what providers report (lastActivityAt, stopped since).
  if (perHour === 0) return new Map();
  type Spec = { key: string; label: string; required?: boolean; q: ActivityQuery; id: string; ttl: number; rank: number };
  const specs: Spec[] = [];
  for (const r of resources) {
    if (noActivity(r)) continue;
    const p = providerById(r.provider);
    if (!p?.activity) continue;
    let list: ReturnType<NonNullable<Provider["activity"]>> = [];
    try {
      list = p.activity(r) ?? [];
    } catch {
      continue;
    }
    const support = isSupport(categoryOf(r));
    for (const a of list) {
      // A resource's metrics live in its own region (CloudFront and Route 53 name us-east-1 themselves).
      const q: ActivityQuery = { region: a.region ?? resourceRegion(r, home), namespace: a.namespace, metric: a.metric, dims: a.dims, stat: a.stat };
      // Over budget, what shows use goes first, then the map's main columns, then support resources.
      specs.push({ key: r.key, label: a.label, required: a.required, q, id: JSON.stringify([q.region, q.namespace, q.metric, q.dims, q.stat, days]), ttl: support ? SUPPORT_ACTIVITY_TTL : ACTIVITY_TTL, rank: a.required ? 0 : support ? 2 : 1 });
    }
  }
  const byId = new Map<string, Spec>();
  for (const x of specs) {
    const have = byId.get(x.id);
    if (!have || x.rank < have.rank || x.ttl < have.ttl) byId.set(x.id, have ? { ...x, rank: Math.min(x.rank, have.rank), ttl: Math.min(x.ttl, have.ttl) } : x);
  }
  const due = [...byId.values()].filter((x) => now - (s.activity.get(x.id)?.at ?? 0) > x.ttl).sort((a, b) => a.rank - b.rank);
  const { bucket, granted } = takeTokens(s.budget, due.length, now, perHour);
  s.budget = bucket;
  const ask = due.slice(0, granted);
  if (granted < due.length)
    notes.push(`activity metrics: ${(due.length - granted).toLocaleString("en-US")} of ${due.length.toLocaleString("en-US")} wait for the hourly budget (${perHour.toLocaleString("en-US")} metrics an hour, CONSOLE_ACTIVITY_BUDGET) — idle marks wait for them`);
  if (ask.length) {
    // Claimed before the await: phase 2 can assemble while a phase-1 build does, and GetMetricData is billed per metric —
    // a concurrent assemble keeps the previous points instead of asking again.
    for (const x of ask) s.activity.set(x.id, { at: now, points: s.activity.get(x.id)?.points, ttl: x.ttl });
    // The CloudWatch clients are limited per region where they send; no extra slot is held here.
    const qs = ask.map((x) => x.q);
    const { data, failed, error } = await activityData(qs, days, (fn) => fn()).catch((e: unknown) => ({ data: new Map<number, [number, number][]>(), failed: qs.map((_, i) => i), error: e }));
    // Answered and failed queries alike wait their TTL before being asked again: no re-billing, no hammering.
    ask.forEach((x, i) => s.activity.set(x.id, { at: now, points: data.get(i), ttl: x.ttl }));
    if (failed.length) {
      const missing = deniedAction(error);
      notes.push(`activity metrics: ${failed.length} of ${qs.length} unavailable (${missing ? `the console's role can't read them: ${missing}` : errText(error)}) — resources that depend on them aren't marked idle`);
    }
  }
  for (const [id, v] of s.activity) if (now - v.at > 2 * (v.ttl ?? ACTIVITY_TTL)) s.activity.delete(id);
  const out = new Map<string, ActivitySeries[]>();
  for (const x of specs) {
    const points = s.activity.get(x.id)?.points;
    out.set(x.key, [...(out.get(x.key) ?? []), { label: x.label, ...(points ? { points } : {}), ...(x.required ? { required: true } : {}) }]);
  }
  return out;
}

const knownEnvs = async (waitMs?: number): Promise<KnownEnv[]> => {
  const list = listEnvs().catch(() => []);
  const envs = waitMs ? await Promise.race([list, new Promise<[]>((r) => setTimeout(() => r([]), waitMs).unref?.())]) : await list;
  return envs.map((e) => ({ id: e.id, label: e.label, protected: e.protected, source: e.source === "config" ? "config" : "ecs" }));
};

// The view from whatever runs the plan has now. `quick` (the persisted map after a restart) skips activity metrics and
// waits for the environment list only briefly.
async function assemble(plan: Plan, pending: string[], quick = false): Promise<Built> {
  const s = state();
  const now = Date.now();
  const runs = plan.runs.map((pr) => s.runs.get(pr.key)).filter((r): r is Run => !!r);
  // Each run contributes what the map believes it has, plus what it is confirming gone — unless another run still
  // lists that resource.
  const knowns = runs.map(knownOfRun);
  const listed = new Set(knowns.flatMap((k) => k.resources.map((r) => r?.key)));
  const results: ProviderResult[] = runs.map((r, i) => ({
    resources: contributed(knowns[i], listed), links: knowns[i].links, mentions: knowns[i].mentions, ...(r.result.sgRules ? { sgRules: r.result.sgRules } : {}),
  }));
  const vanishing = new Map<string, VanishingRow>();
  runs.forEach((r, i) => {
    for (const v of knowns[i].vanishing)
      if (!listed.has(v.resource.key)) vanishing.set(v.resource.key, { key: v.resource.key, name: v.resource.name, provider: r.id, region: resourceRegion(v.resource, plan.home), lastSeen: v.lastSeen });
  });
  const notes = [...plan.notes, ...runs.flatMap((r) => r.notes)];
  const sources = new Map<string, string[]>();
  results.forEach((x, i) => {
    for (const r of x.resources) if (r?.key) sources.set(r.key, [...new Set([...(sources.get(r.key) ?? []), runs[i].id])]);
  });
  // A region a service control policy closes (outside home) is a fact about that region, like a service not offered
  // there: it doesn't make the map incomplete (aggregate() lists it in the provider's notes).
  const outcomes: RunOutcome[] = runs.map((r) => ({
    id: r.id, region: r.region, state: r.scp && r.region !== plan.home ? "skipped" : r.status.state, covers: providerById(r.id)?.covers, partial: r.status.partial,
    truncated: r.truncated, stale: !!r.from, missing: r.scp && r.region !== plan.home ? undefined : r.status.missing,
  }));

  const rules = await sgRules(results, plan, notes, quick ? RESTORE_SG_WAIT : DEADLINE);
  const inferred = infer({
    results, rules, providerOf: (i) => runs[i].id, home: plan.home, covered: covered(outcomes), accountId: plan.account, regions: plan.regions,
    unreadable: unreadableTypes(outcomes),
  });
  notes.push(...inferred.notes);
  const propagated = propagate({ resources: inferred.resources, edges: inferred.edges, home: plan.home, now, accountId: plan.account });
  notes.push(...propagated.notes);
  const assigned = assignEnvs(propagated.resources, propagated.edges, await knownEnvs(quick ? RESTORE_ENVS_WAIT : undefined));
  const days = idleDaysOf(consoleConfig().config.inventory?.idleDays);
  // The simulated account's metrics are invented curves; its providers report lastActivityAt instead.
  const activity = plan.mock || quick ? new Map<string, ActivitySeries[]>() : await activityFor(assigned.resources, plan.home, days, notes);
  const final = assigned.resources.map((r) => {
    if (r.facts?.vanishing === true) return scrubProps(r);
    const e = idleEvidenceOf(r, { now, windowDays: days, activity: activity.get(r.key) });
    let out = e.idle ? { ...r, idle: e.idle } : r;
    // R20: metrics are declared, but what shows use couldn't be read — say so rather than guess.
    if (e.evidence === "insufficient") out = { ...out, facts: { ...(out.facts ?? {}), idleEvidence: "insufficient" } };
    return scrubProps(out);
  });
  const byProvider = new Map<string, Run[]>();
  for (const r of runs) byProvider.set(r.id, [...(byProvider.get(r.id) ?? []), r]);
  const providers = PROVIDERS.map((p) => providerStatus(p, byProvider.get(p.id) ?? [], plan));
  const unresolved = unresolvedOf(final);
  const c = completeness(outcomes, { resources: final, generatedAt: now, pendingRegions: pending, lastCompleteAt: s.lastCompleteAt, unresolvedRefs: unresolved.total });
  if (!quick) s.lastCompleteAt = c.lastCompleteAt;
  const spent = metricsLastHour(s.budget, now);
  const view: InventoryView = {
    region: plan.home, accountId: plan.account, generatedAt: now, resources: final, edges: propagated.edges, envs: assigned.envs, providers,
    ...(notes.length ? { truncated: [...new Set(notes)] } : {}),
    regions: plan.regions, homeRegion: plan.home,
    ...(Object.keys(inferred.hiddenTypes).length ? { hiddenTypes: inferred.hiddenTypes } : {}),
    ...(pending.length ? { partial: { pendingRegions: pending } } : {}),
    completeness: c,
    activity: { metricsLastHour: spent, estMonthlyUsd: estMonthlyUsd(spent) },
  };
  return { view, byKey: new Map(final.map((r) => [r.key, r])), sources, activity, vanishing: [...vanishing.values()], unresolved, at: now, gen: plan.gen };
}

// A newer view never loses to an older one finishing later (phase 2 publishes on its own), and a view of an AWS
// connection that has since been switched away from is handed to whoever waited for it but never kept.
function publish(b: Built): Built {
  const s = state();
  if (b.gen !== generation()) return b;
  if (!s.built || b.at >= s.built.at) s.built = b;
  return s.built;
}

// ---------- a build: phase 1 (home + global), then the other regions ----------

// Phase-2 regions still being read for the first time.
const pendingOf = (plan: Plan): string[] => {
  const s = state();
  if (!s.phase2) return [];
  return [...new Set(plan.runs.filter((r) => r.phase === 2 && !s.runs.has(r.key)).map((r) => r.region))];
};

function startPhase2(plan: Plan, force: boolean) {
  const s = state();
  if (s.phase2) return; // single-flight: a refresh during phase 2 reuses the one in flight
  const now = Date.now();
  const due = plan.runs.filter((r) => r.phase === 2 && !fresh(s.runs.get(r.key), providerById(r.id)!, now, force));
  if (!due.length) return;
  const promise: Promise<void> = runAll(due, plan, force, AbortSignal.timeout(PHASE2_DEADLINE))
    .then(async () => {
      s.phase2 = undefined;
      publish(await assemble(plan, []));
    })
    .catch(log("inventory: other regions failed"))
    .finally(() => {
      if (s.phase2?.promise === promise) s.phase2 = undefined;
    });
  s.phase2 = { promise, regions: [...new Set(due.map((r) => r.region))] };
}

async function build(force: boolean): Promise<Built> {
  if (force) {
    invalidate("discovery:envs");
    invalidate("discovery:inventory");
  }
  const plan = await makePlan();
  // The ECS-side providers share one discovery pass (cached). Start it here, outside every run's call signal: started
  // inside the ecs run, it would carry that run's deadline, and when the deadline fired every joiner (elb, rds,
  // elasticache, the sampler) would fail with it and nothing would be cached — on a large account, every build.
  void inventory().catch(() => undefined);
  await runAll(plan.runs.filter((r) => r.phase === 1), plan, force);
  startPhase2(plan, force);
  return publish(await assemble(plan, pendingOf(plan)));
}

function rebuild(force: boolean): Promise<Built> {
  const s = state();
  if (s.inflight) return s.inflight;
  s.dirty = false; // an action while this build runs marks it dirty again
  // Shared by every reader, so never under the call signal of the one that started it (a detail panel's deadline).
  const p = outsideCallSignal(() => build(force)).finally(() => {
    s.inflight = undefined;
  });
  s.inflight = p;
  return p;
}

// After a restart: the persisted runs, labelled stale ("from 14:02 UTC — refreshing"), so the map isn't empty while the
// first build runs. Once per process; undefined when nothing usable was persisted.
function restoreOnce(): Promise<Built | undefined> {
  const s = state();
  s.restore ??= outsideCallSignal(async () => {
    const plan = await makePlan();
    // Only runs the plan still has, of providers config doesn't turn off, read from this same account (a data dir
    // reused from the demo never shows Acme on a real account).
    const wanted = new Set(plan.runs.filter((r) => !plan.excluded.has(r.id)).map((r) => r.key));
    const stored = (await loadRuns(wanted, RESTORE_MAX_AGE)).filter((x) => x.account === plan.account);
    if (!stored.length) return undefined;
    for (const x of stored) {
      const key = `${x.provider}@${x.region}`;
      if (s.runs.has(key)) continue; // a build already got further
      s.runs.set(key, {
        key, id: x.provider, region: x.region, result: x.result, notes: [], at: x.at, startedAt: 0, ranAt: 0, rerun: true, from: "persisted",
        status: { ...x.status, region: x.region, state: "error", count: x.result.resources.length, at: x.at, error: `from ${hhmm(x.at)} UTC — refreshing` },
      });
    }
    const b = await assemble(plan, [], true);
    b.at = 0; // already due: the next read starts (or joins) the real build
    if (!s.built) s.built = b;
    return s.built;
  }).catch((e) => {
    log("inventory: restoring the persisted map failed")(e);
    return undefined;
  });
  return s.restore;
}

async function current(opts: { refresh?: boolean } = {}): Promise<Built> {
  const s = state();
  const now = Date.now();
  if (opts.refresh && now - s.forcedAt >= FORCE_EVERY) {
    s.forcedAt = now;
    return rebuild(true);
  }
  if (s.built && !s.dirty) {
    if (now - s.built.at >= TTL) rebuild(false).catch(log("inventory refresh failed"));
    return s.built;
  }
  if (!s.built && !s.inflight) {
    const restored = await restoreOnce();
    if (restored && !s.dirty) {
      rebuild(false).catch(log("inventory refresh failed"));
      return restored;
    }
  }
  return rebuild(false); // nothing yet, or an action just changed something: wait for the fresh graph
}

// ---------- public ----------

// The full view (agent operations, tests). `refresh` forces a full re-discovery (at most once per 20 s).
export async function getInventory(opts: { refresh?: boolean } = {}): Promise<InventoryView> {
  const b = await current(opts);
  const counts = await noteCounts().catch(() => ({}) as Record<string, number>);
  return { ...b.view, resources: b.view.resources.map((r) => (counts[r.key] ? { ...r, notes: counts[r.key] } : r)) };
}

// GET /api/inventory: hidden and generic rows slim (CC-17), and a weak ETag for this build, its phase and the note
// counts merged in (F51) — the route answers If-None-Match with 304 before `view()` is ever built.
export async function inventoryPayload(opts: { refresh?: boolean } = {}): Promise<{ etag: string; view: () => InventoryView }> {
  const b = await current(opts);
  const counts = await noteCounts().catch(() => ({}) as Record<string, number>);
  const sig = Object.keys(counts).sort().map((k) => `${k}=${counts[k]}`).join("|");
  const etag = etagOf(b.view.generatedAt, !!b.view.partial, sig ? shortHash(sig) : undefined);
  return {
    etag,
    view: () => {
      b.slim ??= b.view.resources.map(slimRow);
      return { ...b.view, resources: b.slim.map((r) => (counts[r.key] ? { ...r, notes: counts[r.key] } : r)) };
    },
  };
}

export interface InventoryCoverage {
  generatedAt: number;
  regions: string[];
  homeRegion?: string;
  completeness: InventoryCompleteness;
  providers: ProviderStatus[];
  pendingRegions: string[];
  stale: string[]; // provider@region served from an older or persisted run
  unresolved: Unresolved[]; // at most 200
  unresolvedTotal: number;
  vanishing: VanishingRow[]; // resources pending deletion confirmation
  activity: { metricsLastHour: number; estMonthlyUsd: number; budgetPerHour: number };
  notes: string[];
  freshness: Freshness;
}

// GET /api/inventory/coverage: what the map knows and doesn't (REVIEW reconciliation view). The route adds AWS call stats.
export async function inventoryCoverage(): Promise<InventoryCoverage> {
  const b = await current();
  const v = b.view;
  const c = v.completeness ?? { providers: { ok: 0, denied: 0, error: 0, skipped: 0, disabled: 0, partial: 0 }, cappedTypes: [], deniedActions: [], staleProviders: [], unresolvedRefs: 0, enrichmentSkipped: 0 };
  const pendingRegions = v.partial?.pendingRegions ?? [];
  const perHour = activityBudgetOf(process.env.CONSOLE_ACTIVITY_BUDGET);
  return {
    generatedAt: v.generatedAt,
    regions: v.regions ?? [v.region],
    ...(v.homeRegion ? { homeRegion: v.homeRegion } : {}),
    completeness: c,
    providers: v.providers,
    pendingRegions,
    stale: c.staleProviders,
    unresolved: b.unresolved.list,
    unresolvedTotal: b.unresolved.total,
    vanishing: b.vanishing,
    activity: { ...(v.activity ?? { metricsLastHour: 0, estMonthlyUsd: 0 }), budgetPerHour: perHour },
    notes: v.truncated ?? [],
    freshness: coverageFreshness({ generatedAt: v.generatedAt, completeness: v.completeness, pendingRegions, vanishing: b.vanishing.length }, STALE_AFTER),
  };
}

export async function findResource(key: string): Promise<{ resource: Resource; sources: string[]; envs: EnvEntry[] } | undefined> {
  const b = await current();
  const resource = b.byKey.get(key);
  return resource ? { resource, sources: b.sources.get(key) ?? [resource.provider], envs: b.view.envs } : undefined;
}

export async function resourceEdges(key: string): Promise<Edge[]> {
  return (await current()).view.edges.filter((e) => e.from === key || e.to === key);
}

export async function inventoryEnvs(): Promise<EnvEntry[]> {
  return (await current()).view.envs;
}

// Without triggering discovery: what the last build found (undefined before the first one).
export const cachedInventoryEnvs = (): EnvEntry[] | undefined => state().built?.view.envs;
export const cachedInventory = (): InventoryView | undefined => state().built?.view;

// Protected when its tags weren't read (R01: fail closed), when any hint about the resource names a protected
// environment (assign.ts sets protectedBy), when it is tagged console:protected=true, or — unless
// inventory.unassignedProtected is false — when nothing placed it in an environment at all: an unknown resource gets the
// careful rules, not the easy ones. Rules in ../inventory/action-rules.ts.
export const resourceProtection = (r: Resource, envs: EnvEntry[]): Protection => protectionOf(r, envs, consoleConfig().config.inventory?.unassignedProtected !== false);
export const resourceProtected = (r: Resource, envs: EnvEntry[]) => resourceProtection(r, envs).protected;

// After a change: those providers run again (in every region) on the next read, which waits for the fresh graph.
export function invalidateProvider(...ids: string[]) {
  const s = state();
  const now = Date.now();
  for (const id of ids) s.invalidatedAt.set(id, now);
  for (const run of s.runs.values()) if (ids.includes(run.id)) run.rerun = true;
  s.dirty = true;
}

// R01, for a provider without a live tag read: run that provider again now, in the run that covers `region`, and
// return the resource with this key as the fresh run read it. A complete fresh run replaces the stored one.
export async function rediscover(providerId: string, key: string, region: string): Promise<{ resource?: Resource; state: ProviderStatus["state"]; partial: boolean; why?: string }> {
  const p = providerById(providerId);
  if (!p) return { state: "error", partial: false, why: `no provider "${providerId}"` };
  const plan = await makePlan();
  const pr = plan.runs.find((r) => r.id === providerId && r.region === region) ?? plan.runs.find((r) => r.id === providerId);
  if (!pr) return { state: "disabled", partial: false, why: `${p.label} doesn't run in ${region}` };
  const s = state();
  const prev = s.runs.get(pr.key);
  const r = await outsideCallSignal(() => runOne(p, pr, plan, prev));
  if (plan.gen !== generation()) return { state: "error", partial: false, why: "the AWS connection changed while it was read" };
  const read = r.status.state === "ok" && !r.from;
  if (read) {
    r.known = knownAfter(s.runs.get(pr.key) ?? prev, r);
    s.runs.set(pr.key, r);
    persist(r, plan.account);
  }
  return {
    resource: read ? r.result.resources.find((x) => x?.key === key) : undefined,
    state: r.status.state,
    partial: !!r.status.partial,
    ...(r.status.error ? { why: r.status.error } : {}),
  };
}

// What a slim row left out, for its panel: the props and facts the map didn't carry.
function slimSections(r: Resource): ResourceDetail["sections"] {
  const out: ResourceDetail["sections"] = [];
  if (r.props.length) out.push({ title: "Properties", rows: r.props });
  const facts = Object.entries(r.facts ?? {}).filter(([k]) => k !== "vanishing" && k !== "lastSeen");
  if (facts.length) out.push({ title: "Facts", rows: facts.map(([label, v]) => ({ label, value: Array.isArray(v) ? v.join(", ") : String(v) })) });
  return out;
}

// GET /api/inventory/detail: the provider's detail() (the first of the providers that reported the key that has one),
// in the resource's own region, plus the activity series behind the idle mark when the provider shows no metrics of its
// own. `page` browses inside a resource (S3 prefixes); the provider returns the next token in detail.page. F15: an
// external host has nothing to load, and only the provider that owns the resource can fail the request — another
// provider's failure is noted and skipped.
export async function resourceDetail(key: string, page?: { prefix?: string; token?: string }): Promise<ResourceDetail> {
  const found = await findResource(key);
  if (!found) throw new HttpError(404, "no such resource on the map — it may be gone; refresh the map");
  const { resource: r, sources } = found;
  if (r.kind === "external") return { key, sections: [] };
  const series = state().built?.activity.get(key)?.filter((x) => x.points);
  const metrics = series?.length ? series.map((x, i) => ({ id: `activity${i}`, label: x.label, points: x.points! })) : undefined;
  const extra = isSlimRow(r) ? slimSections(r) : [];
  const mock = sourceKind() === "mock";
  const { home, regions } = await regionsNow();
  const region = resourceRegion(r, home);
  const account = await accountId(mock);
  const skipped: string[] = [];
  for (const id of [...new Set([r.provider, ...sources])]) {
    const p = providerById(id);
    const detail = p?.detail;
    if (!p || !detail) continue;
    const a = await attempt<ResourceDetail>({
      what: p.label, deadlineMs: DETAIL_DEADLINE, within: withCallSignal,
      run: (signal) => detail(r, contextFor({ region, regions, home, accountId: account, mock }, signal, []), page),
    });
    if (a.kind === "failed") {
      const missing = deniedAction(a.error);
      const owner = id === r.provider;
      if (missing && owner) return { key, sections: [...extra, { title: "Details", note: `The console's role can't read these details (${missing}).` }], ...(metrics ? { metrics } : {}) };
      if (owner) throw new HttpError(502, `${p.label}: ${errText(a.error)}`);
      skipped.push(missing ? `${p.label}: the console's role can't read them (${missing})` : `${p.label}: ${errText(a.error)}`);
      continue;
    }
    const d = a.result;
    return { ...d, key, sections: [...extra, ...(d.sections ?? [])], ...(d.metrics ?? metrics ? { metrics: d.metrics ?? metrics } : {}) };
  }
  const note = skipped.length ? [{ title: "Details", note: `Couldn't load more details — ${skipped.join("; ")}` }] : [];
  return { key, sections: [...extra, ...note], ...(metrics ? { metrics } : {}) };
}

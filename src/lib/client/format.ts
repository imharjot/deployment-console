// Formatting and small view rules for the UI. Pure (no React, no browser APIs at import time), so node --test checks
// them (src/lib/chart-scale.test.ts) and the server could reuse them.
import { isStale, type Freshness } from "../freshness.ts";
import type { EnvOverview, OperationNote, ReleaseStep, ReleaseView, ResourceView, RevisionView, State, UptimeView } from "../types.ts";

// "just now" for the first minute, then whole minutes, hours and days: the label changes at most once a minute.
export function ago(ms: number | string | undefined, now = Date.now()) {
  if (!ms) return "—";
  const t = typeof ms === "string" ? Date.parse(ms) : ms;
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// When ago(ms) next reads differently: the age's next whole minute, hour or day.
export function agoChangesAt(ms: number | string | undefined, now: number): number | undefined {
  const t = typeof ms === "string" ? Date.parse(ms) : ms;
  if (!t || !Number.isFinite(t)) return undefined;
  const age = Math.max(0, now - t);
  const unit = age < 3_600_000 ? 60_000 : age < 86_400_000 ? 3_600_000 : 86_400_000;
  return t + (Math.floor(age / unit) + 1) * unit;
}

export function duration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "2-digit" });
const zoneFmt = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" });

// Log lines: the viewer's local time with milliseconds (the log header names the zone).
export function clock(ms: number) {
  const d = new Date(ms);
  return `${timeFmt.format(d)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

// The viewer's time-zone abbreviation at that moment ("IST", "GMT+1", "UTC"), so a local time is never unlabelled
// next to the UTC times the server writes (F71).
export function zone(ms: number = Date.now()): string {
  return zoneFmt.formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value ?? "";
}

// "Oct 05 14:02:11 IST" — local time, always with its zone (F71).
export function stamp(ms: number | string | undefined) {
  if (!ms) return "—";
  const d = new Date(typeof ms === "string" ? Date.parse(ms) : ms);
  if (Number.isNaN(d.getTime())) return "—";
  const z = zone(d.getTime());
  return `${dateFmt.format(d)} ${timeFmt.format(d)}${z ? ` ${z}` : ""}`;
}

export const shortSha = (s?: string) => (s ? s.slice(0, 7) : "—");
export const repoName = (r: string) => r.split("/").pop() ?? r;

// ---------- freshness of what is on screen (R21) ----------

// What a view shows when it keeps data from an earlier load: the server's own freshness when it sends one, else the
// time this browser last loaded it; a failed refresh adds its error. undefined = nothing to say (no data yet: the
// page shows its loading or error state instead).
export function keptFreshness(o: { data: unknown; error: unknown; base?: Freshness; loadedAt?: number; source: string; staleAfterMs: number }): Freshness | undefined {
  if (o.data === undefined || o.data === null) return undefined;
  const msg = o.error ? (o.error instanceof Error ? o.error.message : String(o.error)) || "request failed" : undefined;
  if (!msg) return o.base;
  const b: Freshness = o.base ?? { observedAt: o.loadedAt, staleAfterMs: o.staleAfterMs, source: o.source, completeness: "complete" };
  return { ...b, error: b.error ? `${b.error}; ${msg}` : msg };
}

const STATE_KEYS: State[] = ["UP", "DEGRADED", "DOWN", "DEPLOYING", "STOPPED", "BOX_STOPPED", "UNKNOWN"];

// The server's freshness as this browser should judge it. Data reaches the browser some seconds after it was read (a
// cached overview, the sampler's cadence), and the browser then keeps it until its next poll: counting that delay
// against staleAfterMs would flip a healthy view to unknown between polls. So the deadline moves by the delivery
// delay — at most one staleAfterMs, so data that was already old when it arrived still counts as stale.
export function clientFreshness(f: Freshness | undefined, receivedAt: number | undefined): Freshness | undefined {
  if (!f || !f.observedAt || !receivedAt || receivedAt <= f.observedAt) return f;
  return { ...f, staleAfterMs: f.staleAfterMs + Math.min(receivedAt - f.observedAt, f.staleAfterMs) };
}

// The overview to draw at `now` (R21): stale data, or data of unknown age, shows UNKNOWN — never the last good state.
// The whole view goes unknown when its freshness is stale; a single tile when its own fetchedAt is too old. `next` is
// the earliest moment something turns stale, for a timer (undefined: decide at once — the clock isn't known yet).
// `receivedAt` is when this browser got the data (see clientFreshness). Returns the same object when nothing is
// stale, so memoised cards don't re-render.
export function effectiveOverview(o: EnvOverview, now: number, receivedAt?: number): { o: EnvOverview; stale: boolean; next?: number } {
  const f = clientFreshness(o.freshness, receivedAt);
  if (!f) return { o, stale: false };
  if (!now) return { o, stale: false };
  const overall = isStale(f, now);
  let next: number | undefined;
  const watch = (fr: Freshness) => {
    const d = (fr.observedAt ?? 0) + fr.staleAfterMs;
    if (fr.observedAt && d >= now && (next === undefined || d < next)) next = d + 1;
  };
  const staleKeys = new Set<string>();
  const mark = (r: ResourceView): ResourceView => {
    const fr: Freshness = overall ? f : { ...f, observedAt: r.fetchedAt ?? f.observedAt };
    if (!isStale(fr, now)) {
      watch(fr);
      return r;
    }
    staleKeys.add(r.key);
    // No "(n s ago)" here: this text is computed once, when the tile turns stale; the banner keeps the age current.
    const at = fr.observedAt ? new Date(fr.observedAt).toISOString().slice(11, 16) : undefined;
    return { ...r, state: "UNKNOWN", reasons: [at ? `data stale — last read ${at} UTC` : "data age unknown"] };
  };
  const services = o.services.map(mark);
  const infra = o.infra.map(mark);
  if (!staleKeys.size) return { o, stale: false, next };
  const summary = Object.fromEntries(STATE_KEYS.map((s) => [s, 0])) as Record<State, number>;
  for (const r of [...services, ...infra]) summary[r.state] += 1;
  const nodes = o.topology.nodes.map((n) => (n.state && (overall || (n.resourceKey && staleKeys.has(n.resourceKey))) ? { ...n, state: "UNKNOWN" as State } : n));
  return { o: { ...o, services, infra, summary, topology: { ...o.topology, nodes } }, stale: overall, next };
}

// ---------- services ----------

// "1/5 running · 4 pending" while a service runs fewer tasks than it wants (R11); undefined when it is full.
export function capacityText(c: ResourceView["capacity"]): string | undefined {
  if (!c || !(c.desired > 0) || c.running >= c.desired) return undefined;
  return `${c.running}/${c.desired} running${c.pending > 0 ? ` · ${c.pending} pending` : ""}`;
}

// The uptime chip: "healthy 100% · last 23m". It is the console's view of the service's operational state over the
// time it watched, not customer availability (F39).
export function uptimeLabel(u: Pick<UptimeView, "pct" | "coveredMs">): string {
  if (u.pct === null) return "collecting…";
  const m = Math.round(u.coveredMs / 60_000);
  return `healthy ${u.pct}% · last ${m < 120 ? `${m}m` : `${Math.round(m / 60)}h`}`;
}

// An ECS change's verification as the overview reports it (services[].operations). Read defensively: an older server
// or a cached payload may lack the field or carry odd entries.
export type OpNote = OperationNote;
export function opsOf(r: unknown): OpNote[] {
  const ops = (r as { operations?: unknown } | null)?.operations;
  return Array.isArray(ops) ? ops.filter((x): x is OpNote => !!x && typeof x === "object" && typeof (x as OpNote).id === "string" && typeof (x as OpNote).verification === "string") : [];
}

// "AWS accepted" is not done (REVIEW): what a toast or chip says about a change AWS took.
export function verificationText(n: Pick<OpNote, "verification" | "detail">): { text: string; tone: "accent" | "ok" | "bad" | "warn" } {
  switch (n.verification) {
    case "verified":
      return { text: "verified", tone: "ok" };
    case "failed":
      return { text: n.detail?.trim() || "did not stabilise", tone: "bad" };
    case "unknown":
      return { text: "outcome unknown — check the resource before retrying", tone: "warn" };
    default:
      return { text: "AWS accepted — verifying", tone: "accent" };
  }
}

// Whether a revision can be switched to, and what the dialog must say first (R24, F68, F07).
export function revisionGuard(
  r: Pick<ResourceView, "readOnly" | "state" | "actions">,
  v: RevisionView & { mutableTagWhy?: string },
): { disabled: boolean; why?: string; warnings: string[] } {
  const sw = r.actions.find((a) => a.name === "switch");
  const why = r.readOnly
    ? (sw?.why ?? "read-only")
    : v.live
      ? "live now"
      : v.imageCheck === "missing"
        ? (v.imageCheckWhy ?? "an image of this revision is no longer in the registry")
        : v.imageCheck === undefined && !v.imagePresent
          ? "image expired from ECR"
          : r.state === "DEPLOYING"
            ? "rollout in progress"
            : sw && !sw.enabled && sw.why
              ? sw.why
              : undefined;
  const warnings: string[] = [];
  if (v.imageCheck === "unknown") warnings.push(`Couldn't confirm the image still exists${v.imageCheckWhy ? ` (${v.imageCheckWhy})` : ""}. If it's gone, the new tasks won't start and the circuit breaker rolls back.`);
  if (v.mutableTag) warnings.push(v.mutableTagWhy ?? `The image tag ${v.tag} can move: switching may not restore the image this revision originally ran.`);
  if (sw?.warning) warnings.push(sw.warning);
  return { disabled: !!why, why, warnings };
}

// ---------- releases (F08) ----------

export type HopKind = "sync" | "waiting" | "ahead" | "diverged" | "unknown";
export interface Hop {
  kind: HopKind;
  ahead: number;
  behind: number;
  text: string;
  warning?: string;
}

// One step of the promotion chain, from → to. "In sync" only when both run the same commit, or the comparison says
// 0 ahead and 0 behind; without a comparison it is unknown, never in sync.
export function hopOf(step: Pick<ReleaseStep, "aheadBy" | "behindBy">, fromSha: string | undefined, toSha: string | undefined, toLabel: string): Hop {
  const ahead = step.aheadBy ?? -1;
  const behind = step.behindBy ?? -1;
  if (fromSha && toSha && fromSha === toSha) return { kind: "sync", ahead: 0, behind: 0, text: "in sync" };
  if (ahead === 0 && behind === 0) return { kind: "sync", ahead: 0, behind: 0, text: "in sync" };
  if (ahead > 0 && behind > 0)
    return { kind: "diverged", ahead, behind, text: `diverged: ${ahead} ahead / ${behind} behind`, warning: `Promoting drops ${behind} commit${behind === 1 ? "" : "s"} that only ${toLabel} has.` };
  if (ahead > 0) return { kind: "waiting", ahead, behind: Math.max(0, behind), text: `${ahead} waiting` };
  if (behind > 0) return { kind: "ahead", ahead: 0, behind, text: `${toLabel} is ${behind} ahead (hotfix/rollback?)` };
  return { kind: "unknown", ahead: Math.max(0, ahead), behind: Math.max(0, behind), text: "unknown" };
}

// A service needs attention when any step has commits waiting or the next environment is ahead of it.
export const needsPromotion = (r: Pick<ReleaseView, "steps">) => r.steps.some((s) => (s.aheadBy ?? 0) > 0 || (s.behindBy ?? 0) > 0);

// The page headline: "in sync" only when there is a chain to compare (2+ stages) and every step is known and equal.
export function releasesHeadline(rs: ReleaseView[]): { tone: "ok" | "warn" | "muted"; text: string } | undefined {
  const chains = rs.filter((r) => r.stages.length >= 2);
  if (!chains.length) return rs.length ? { tone: "muted", text: "Each service runs in one environment only — nothing to promote." } : undefined;
  const pending = chains.filter(needsPromotion).length;
  if (pending) return { tone: "warn", text: `${pending} service${pending === 1 ? "" : "s"} with changes waiting or out of step.` };
  const unknown = chains.some((r) => r.steps.some((s, i) => hopOf(s, r.stages[i]?.sha, r.stages[i + 1]?.sha, "").kind === "unknown"));
  return unknown ? { tone: "muted", text: "Some steps couldn't be compared." } : { tone: "ok", text: "Every environment is in sync." };
}

// ---------- regions ----------

// Environments grouped by region, the home region first, then the others by name; order inside a group is kept.
export function groupByRegion<E extends { region?: string }>(list: E[], home?: string): { region: string; items: E[] }[] {
  const m = new Map<string, E[]>();
  for (const e of list) {
    const r = e.region ?? home ?? "";
    m.set(r, [...(m.get(r) ?? []), e]);
  }
  return [...m.entries()].sort(([a], [b]) => Number(b === home) - Number(a === home) || a.localeCompare(b)).map(([region, items]) => ({ region, items }));
}

// Where an audit entry's change happened: its own region, else (rows written before entries carried one) its
// environment's, else the home region. An entry without an environment (settings, users) has none.
export function auditRegion(e: { env?: string; region?: string }, envs: { id: string; region?: string }[] | undefined, home?: string): string | undefined {
  if (e.region) return e.region;
  if (!e.env) return undefined;
  return envs?.find((x) => x.id === e.env)?.region ?? home;
}

// ---------- saved views ----------

// The link a saved view opens: a same-origin page and its query string. The server checks both when a view is saved;
// a row that fails here is dropped, never navigated to ("//host" and "/\host" are other sites to a browser).
const SAFE_PATH = /^\/(?![/\\])[^\s\\]*$/;
export function savedViewHref(p: { path?: unknown; search?: unknown } | null | undefined): string | undefined {
  if (!p || typeof p.path !== "string" || p.path.length > 300 || !SAFE_PATH.test(p.path) || p.path.startsWith("/api/")) return undefined;
  const search = p.search ?? "";
  if (typeof search !== "string" || (search !== "" && !search.startsWith("?")) || /\s/.test(search)) return undefined;
  return `${p.path}${search}`;
}

// ---------- automation ----------

export type TokenFilter = "active" | "expired" | "revoked" | "all";
export function tokenCounts(list: { status: string }[]): Record<TokenFilter, number> {
  const c = { active: 0, expired: 0, revoked: 0, all: list.length };
  for (const t of list) if (t.status === "active" || t.status === "expired" || t.status === "revoked") c[t.status] += 1;
  return c;
}
export const filterTokens = <T extends { status: string }>(list: T[], f: TokenFilter) => (f === "all" ? list : list.filter((t) => t.status === f));

const humanize = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();

// An operation's result in one line ("revision: 124 · restarted: true"), for tables and toasts; raw JSON stays behind
// a disclosure (F45). Undefined when there is nothing simple to say.
export function summarizeResult(result: unknown): string | undefined {
  if (result === null || result === undefined) return undefined;
  if (typeof result !== "object") return String(result);
  if (Array.isArray(result)) return `${result.length} item${result.length === 1 ? "" : "s"}`;
  const parts = Object.entries(result as Record<string, unknown>)
    .filter(([k, v]) => v !== null && v !== undefined && k !== "url" && k !== "ok" && (typeof v !== "object" || Array.isArray(v)))
    .slice(0, 3)
    .map(([k, v]) => `${humanize(k)}: ${Array.isArray(v) ? `${v.length} item${v.length === 1 ? "" : "s"}` : String(v)}`);
  return parts.length ? parts.join(" · ") : undefined;
}

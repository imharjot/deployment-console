// The six workflow templates (master plan §6 C7 item 2, AGENT_ARCHITECTURE §7) and the reports their notify steps
// write. Pure: templateDraft() returns an editable draft (src/lib/agents/workflows.ts) with its built-in policy from
// DEFAULT_POLICIES; buildReport() turns a run's results into the text a person reads.
//
// - incident-investigator: propose mode, read tools; a model run gives ranked hypotheses citing evidence ids (E1, …)
//   and at most one proposed typed action, which waits for a person.
// - approved-remediation: investigate → propose one restart, scale or rollback → a person's exact-plan grant →
//   execute → verify healthy → escalate when it isn't; cooldown and maximum attempts per resource from the limits.
// - nonproduction-schedule: deterministic, no model. An explicit selector of non-production services, resolved and
//   previewed when published and again at every run (an addition pauses the run for review); protected, shared,
//   autoscaled and console services are excluded. services.stop remembers the desired count, services.start restores
//   it; then each is verified. Bounded-act only for the keys listed when it was published.
// - daily-digest: deterministic reads (audit, issues, CI, costs, pending approvals) and an optional model summary,
//   delivered to the run's result or the integrations.
// - cost-review: spend, the run rate and idle resources (only those whose idle evidence is sufficient), explained with
//   a confidence; observe only, never a deletion.
// - config-drift: variables.compare (same / different / missing per name and environment — never values or digests);
//   a difference becomes a task for a person in the Variables editor, never a variables.update.
import { DEFAULT_POLICIES, type TemplateName } from "./policy.ts";
import { DEFAULT_LIMITS, lookup, type Progress, type ReportKind, type WorkflowDraft, type WorkflowNode, type WorkflowTrigger } from "./workflows.ts";

export const TEMPLATES: readonly { name: TemplateName; title: string; description: string; model: "required" | "optional" | "none" }[] = [
  { name: "incident-investigator", title: "Incident investigator", description: "Investigates a degraded resource: ranked hypotheses citing evidence, and at most one proposed action a person approves.", model: "required" },
  { name: "approved-remediation", title: "Approved remediation", description: "Investigates, proposes one restart, scale or rollback, runs it once a person approves the exact plan, verifies it healthy and escalates when it isn't.", model: "required" },
  { name: "nonproduction-schedule", title: "Non-production schedule", description: "Stops listed non-production services in the evening and starts them in the morning with the task counts they had. No model.", model: "none" },
  { name: "daily-digest", title: "Daily digest", description: "Changes, problems, CI failures, spend and pending approvals of the last day, in one report.", model: "optional" },
  { name: "cost-review", title: "Cost review", description: "Spend, run rate and idle resources with how sure each finding is. Reads only; never deletes anything.", model: "optional" },
  { name: "config-drift", title: "Configuration drift", description: "Compares variable names, sources and value equality across environments; differences become tasks for a person in the Variables editor.", model: "none" },
];

export interface TemplateOptions {
  name?: string;
  envs?: string[]; // environments the template watches or acts in
  services?: string[]; // nonproduction-schedule: only these services
  tz?: string; // schedules' time zone (default UTC)
  connectionId?: string; // pays for model steps
  notify?: "run" | "integrations";
}

const svc = { env: "{{target.env}}", service: "{{target.service}}" };

const INVESTIGATE =
  "Investigate {{trigger.resourceKey}}. Read its status, recent events, revisions, logs and metrics, and what it depends on. " +
  "Give up to three ranked hypotheses for what is wrong, each citing the evidence ids (E1, E2, …) it rests on and how confident you are. ";

function base(name: TemplateName, o: TemplateOptions, d: Omit<WorkflowDraft, "format" | "name" | "template" | "policy" | "limits" | "inputs"> & Partial<Pick<WorkflowDraft, "limits" | "inputs">>): WorkflowDraft {
  const t = TEMPLATES.find((x) => x.name === name)!;
  const policy = structuredClone(DEFAULT_POLICIES[name]);
  return { format: 1, name: o.name ?? t.title, description: t.description, template: name, inputs: [], ...d, limits: d.limits ?? { ...DEFAULT_LIMITS }, policy };
}

const ESCALATE = "steps.verify.result.ok == false or (steps.verify.state == 'skipped' and steps.remediate.result.health != 'verified')";

const eventTrigger = (envs: string[] | undefined): WorkflowTrigger[] =>
  envs?.length ? [{ type: "event", source: "state", selector: { envs: [...envs], states: ["DOWN", "DEGRADED"] } }] : [];

export function templateDraft(name: TemplateName, o: TemplateOptions = {}): WorkflowDraft {
  const tz = o.tz ?? "UTC";
  const conn = o.connectionId ?? "";
  switch (name) {
    case "incident-investigator":
      return base(name, o, {
        triggers: [{ type: "manual" }, ...eventTrigger(o.envs)],
        connectionId: conn,
        limits: { maxConcurrentRuns: 2, cooldownSeconds: 600, maxAttempts: 6, attemptWindowSeconds: 86_400 },
        steps: [
          {
            id: "investigate",
            kind: "model",
            title: "Investigate and propose",
            resource: "{{trigger.resourceKey}}",
            goal: INVESTIGATE + "Then propose at most one typed action (services.restart, services.switch or services.scale) with its exact input — a person decides — or say that no action is warranted.",
          },
          { id: "report", kind: "notify", to: o.notify ?? "run", report: "text", message: "Investigation of {{trigger.resourceKey}}: {{steps.investigate.result.summary}}" },
        ],
      });
    case "approved-remediation":
      return base(name, o, {
        triggers: [{ type: "manual" }, ...eventTrigger(o.envs)],
        connectionId: conn,
        limits: { maxConcurrentRuns: 1, cooldownSeconds: 1_800, maxAttempts: 3, attemptWindowSeconds: 86_400 },
        steps: [
          {
            id: "remediate",
            kind: "model",
            title: "Investigate and propose one fix",
            resource: "{{trigger.resourceKey}}",
            goal: INVESTIGATE + "Then propose exactly one restart, scale or rollback (services.restart, services.scale or services.switch) that addresses the most likely cause. A person approves the exact plan before it runs.",
          },
          {
            id: "verify",
            kind: "verify",
            title: "Verify it is healthy",
            when: "steps.remediate.result.changed and trigger.service",
            op: "services.get",
            input: { env: "{{trigger.env}}", service: "{{trigger.service}}" },
            expect: "result.state == 'UP' and result.running >= result.desired",
            timeoutSeconds: 900,
            intervalSeconds: 30,
            optional: true,
          },
          // Without a service to check (an alarm, a manual run on another resource), the agent run's own verification
          // of its change decides; nothing changed (declined, rejected, expired) escalates too: the problem is still there.
          { id: "escalate", kind: "notify", title: "Escalate", when: ESCALATE, to: "integrations", report: "remediation" },
          { id: "report", kind: "notify", title: "Report", when: `not (${ESCALATE})`, to: o.notify ?? "run", report: "remediation" },
        ],
      });
    case "nonproduction-schedule": {
      const read = (id: string, title: string, when: string, expect: string): WorkflowNode => ({
        id, kind: "verify", title, forEach: "targets", when, op: "services.get", input: { ...svc }, expect, timeoutSeconds: 900, intervalSeconds: 15, optional: true,
      });
      return base(name, o, {
        inputs: [{ name: "action", type: "string", title: "Stop or start", enum: ["stop", "start"], required: true }],
        triggers: [
          { type: "schedule", cron: "0 19 * * 1-5", tz, inputs: { action: "stop" } },
          { type: "schedule", cron: "0 8 * * 1-5", tz, inputs: { action: "start" } },
          { type: "manual" },
        ],
        targets: { envs: o.envs?.length ? [...o.envs] : ["staging"], ...(o.services?.length ? { services: [...o.services] } : {}) },
        connectionId: "",
        limits: { maxConcurrentRuns: 1, cooldownSeconds: 0, maxAttempts: 24, attemptWindowSeconds: 86_400 },
        steps: [
          { id: "before", kind: "tool", title: "Read each service", forEach: "targets", op: "services.get", input: { ...svc } },
          {
            id: "stop", kind: "tool", title: "Stop (the desired count is remembered)", forEach: "targets", when: "inputs.action == 'stop' and steps.before.result.desired > 0",
            op: "services.stop", input: { ...svc, confirm: "yes", reason: "non-production schedule" },
          },
          {
            id: "start", kind: "tool", title: "Start with the remembered count", forEach: "targets", when: "inputs.action == 'start' and steps.before.result.desired == 0",
            op: "services.start", input: { ...svc, confirm: "yes", reason: "non-production schedule" },
          },
          read("stopped", "Verify stopped", "steps.stop.state == 'succeeded'", "result.desired == 0 and result.running == 0"),
          read("started", "Verify started", "steps.start.state == 'succeeded'", "result.desired >= 1 and result.running >= result.desired"),
          { id: "report", kind: "notify", to: o.notify ?? "run", report: "text", message: "Non-production schedule ({{inputs.action}}) finished for {{targets.length}} service(s)." },
        ],
      });
    }
    case "daily-digest":
      return base(name, o, {
        triggers: [{ type: "schedule", cron: "0 8 * * *", tz }, { type: "manual" }],
        connectionId: conn,
        steps: [
          { id: "audit", kind: "tool", title: "Changes", op: "audit.recent", input: { limit: 100 }, optional: true },
          { id: "issues", kind: "tool", title: "Problems", op: "issues.list", input: {}, optional: true },
          { id: "ci", kind: "tool", title: "CI runs", op: "ci.runs", input: {}, optional: true },
          { id: "costs", kind: "tool", title: "Spend", op: "costs.summary", input: {}, optional: true },
          { id: "approvals", kind: "tool", title: "Pending approvals", op: "approvals.list", input: { status: "pending" }, optional: true },
          ...(conn
            ? [{ id: "summary", kind: "model", title: "Summary", goal: "Summarise the last day of this console for an on-call engineer in five bullet points: changes, problems, CI failures, spend and pending approvals. Cite evidence ids." } as WorkflowNode]
            : []),
          { id: "report", kind: "notify", to: o.notify ?? "run", report: "digest" },
        ],
      });
    case "cost-review":
      return base(name, o, {
        triggers: [{ type: "schedule", cron: "0 9 * * 1", tz }, { type: "manual" }],
        connectionId: conn,
        steps: [
          { id: "costs", kind: "tool", title: "Spend", op: "costs.summary", input: {}, optional: true },
          { id: "estimate", kind: "tool", title: "Run rate", op: "costs.estimate", input: {}, optional: true },
          { id: "map", kind: "tool", title: "Idle resources", op: "cloud.map", input: {}, optional: true },
          ...(conn
            ? [{ id: "explain", kind: "model", title: "Explain", goal: "Explain the biggest cost opportunities in this account with a confidence for each, citing evidence ids. Never suggest deleting a resource only because it is marked idle." } as WorkflowNode]
            : []),
          { id: "report", kind: "notify", to: o.notify ?? "run", report: "cost-review" },
        ],
      });
    case "config-drift":
      return base(name, o, {
        inputs: [{ name: "envs", type: "list", title: "Environments to compare (the first is the reference)", required: true, default: o.envs?.length ? [...o.envs] : ["staging", "production"] }],
        triggers: [{ type: "schedule", cron: "0 7 * * *", tz }, { type: "manual" }],
        connectionId: "",
        steps: [
          { id: "compare", kind: "tool", title: "Compare variables", op: "variables.compare", input: { envs: "{{inputs.envs}}" } },
          { id: "report", kind: "notify", to: o.notify ?? "run", report: "config-drift" },
        ],
      });
  }
}

// ---------- reports ----------

export interface Report {
  headline: string;
  text: string;
  sections: { title: string; lines: string[] }[];
  tasks?: { title: string; link: string; names: string[] }[]; // for a person (config drift: the Variables editor)
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const s = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));
const money = (v: unknown) => (typeof v === "number" ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "?");

function stepOf(p: Progress, id: string): { ok: boolean; result: unknown; why?: string; ran: boolean } {
  const e = p[id];
  if (!e) return { ok: false, result: undefined, ran: false, why: "not run" };
  const r = rec(e.result);
  if (e.state !== "succeeded") return { ok: false, result: undefined, ran: e.state !== "skipped", why: e.error ?? e.state };
  if (typeof r.error === "string" && r.failed === true) return { ok: false, result: undefined, ran: true, why: r.error };
  return { ok: true, result: e.result, ran: true };
}

function finish(headline: string, sections: Report["sections"], tasks?: Report["tasks"]): Report {
  const text = [headline, ...sections.flatMap((x) => [``, `${x.title}`, ...x.lines.map((l) => `- ${l}`)])].join("\n");
  return { headline: headline.slice(0, 280), text: text.slice(0, 20_000), sections, ...(tasks?.length ? { tasks } : {}) };
}

// `pendingTotal`: every request waiting for a person on this console (a count only) — an agent's approvals.list shows
// just its own run's, so the workflow's server side counts them.
function digest(p: Progress, now: number, pendingTotal?: number): Report {
  const since = now - 86_400_000;
  const sections: Report["sections"] = [];
  const unread = (title: string, why?: string) => sections.push({ title, lines: [`couldn't be read: ${why ?? "unknown"}`] });
  const audit = stepOf(p, "audit");
  let changes = 0;
  if (audit.ok) {
    const rows = arr(audit.result).map(rec).filter((r) => Date.parse(s(r.at)) >= since && r.phase !== "intent");
    changes = rows.length;
    sections.push({ title: `Changes (${rows.length})`, lines: rows.slice(0, 15).map((r) => `${s(r.at).slice(11, 16)} ${s(r.action)} ${s(r.target)}${r.env ? ` in ${s(r.env)}` : ""} by ${s(r.user)}${r.result && r.result !== "ok" ? ` (${s(r.result)})` : ""}`) });
  } else unread("Changes", audit.why);
  const issues = stepOf(p, "issues");
  let problems = 0;
  if (issues.ok) {
    const rows = arr(issues.result).map(rec);
    problems = rows.length;
    sections.push({ title: `Problems now (${rows.length})`, lines: rows.slice(0, 15).map((r) => `${s(r.state)} ${s(r.name)} in ${s(r.env)}: ${arr(r.reasons).map(s).slice(0, 2).join("; ")}`) });
  } else unread("Problems", issues.why);
  const ci = stepOf(p, "ci");
  let failures = 0;
  if (ci.ok) {
    const rows = arr(ci.result).map(rec).filter((r) => r.conclusion === "failure" && Date.parse(s(r.createdAt)) >= since);
    failures = rows.length;
    sections.push({ title: `CI failures (${rows.length})`, lines: rows.slice(0, 10).map((r) => `${s(r.repo)} ${s(r.workflow)} on ${s(r.branch)}: ${s(r.title)}`) });
  } else unread("CI failures", ci.why);
  const costs = stepOf(p, "costs");
  let spend = "";
  if (costs.ok) {
    const c = rec(costs.result);
    if (c.available === false) sections.push({ title: "Spend", lines: [`Cost Explorer unavailable: ${s(c.reason)}`] });
    else {
      spend = `${money(c.monthToDate)} month to date`;
      const f = rec(c.forecastMonthEnd);
      sections.push({ title: "Spend", lines: [`${money(c.monthToDate)} month to date${f.usd !== undefined ? `, forecast ${money(f.usd)}` : ""}`, ...arr(c.anomalies).map(rec).slice(0, 5).map((a) => `anomaly: ${s(a.service)} ${money(a.impactUsd)}`)] });
    }
  } else unread("Spend", costs.why);
  const appr = stepOf(p, "approvals");
  let pending = 0;
  if (appr.ok || pendingTotal !== undefined) {
    const rows = appr.ok ? arr(appr.result).map(rec).filter((r) => r.status === "pending") : [];
    pending = Math.max(rows.length, pendingTotal ?? 0);
    const more = pending - rows.length;
    sections.push({
      title: `Pending approvals (${pending})`,
      lines: [...rows.slice(0, 10).map((r) => `${s(r.title)}${r.env ? ` in ${s(r.env)}` : ""}: ${s(rec(r.plan).summary)}`), ...(more > 0 ? [`${more} request(s) waiting in Automation → Approvals`] : [])],
    });
  } else unread("Pending approvals", appr.why);
  const summary = stepOf(p, "summary");
  if (summary.ok && typeof rec(summary.result).summary === "string") sections.unshift({ title: "Summary", lines: [s(rec(summary.result).summary)] });
  return finish(`Daily digest: ${changes} change(s), ${problems} problem(s), ${failures} CI failure(s)${spend ? `, ${spend}` : ""}, ${pending} pending approval(s)`, sections);
}

// Confidence of an idle finding: how long it has been idle, and whether the map read everything.
export function idleConfidence(sinceIso: string | null, now: number, mapComplete: boolean): "high" | "medium" | "low" {
  const since = sinceIso ? Date.parse(sinceIso) : NaN;
  if (!mapComplete) return "low";
  if (Number.isFinite(since) && now - since >= 7 * 86_400_000) return "high";
  return "medium";
}

function costReview(p: Progress, now: number): Report {
  const sections: Report["sections"] = [];
  const costs = stepOf(p, "costs");
  if (costs.ok) {
    const c = rec(costs.result);
    if (c.available === false) sections.push({ title: "Spend", lines: [`Cost Explorer unavailable: ${s(c.reason)} — the run rate below is a list-price estimate`] });
    else
      sections.push({
        title: "Spend",
        lines: [`${money(c.monthToDate)} month to date, last month ${money(c.lastMonth)}`, ...arr(c.topServices).map(rec).slice(0, 5).map((x) => `${s(x.service)}: ${money(x.usd)}`), ...arr(c.spikes).map(rec).slice(0, 5).map((x) => `spike: ${s(x.service)} +${s(x.pct)}% (≈ ${money(x.extraMonthlyUsd)}/month)`)],
      });
  } else sections.push({ title: "Spend", lines: [`couldn't be read: ${costs.why ?? "unknown"}`] });
  const est = stepOf(p, "estimate");
  if (est.ok) {
    // costs.estimate: { monthlyTotal, environments: [{ env, label, monthly, items }], incomplete? }
    const e = rec(est.result);
    sections.push({
      title: "Run rate (list price)",
      lines: [
        ...(typeof e.monthlyTotal === "number" ? [`${money(e.monthlyTotal)} per month in total`] : []),
        ...arr(e.environments).map(rec).slice(0, 10).map((x) => `${s(x.label || x.env)}: ${money(x.monthly)} per month`),
        ...(arr(e.incomplete).length ? [`incomplete: ${arr(e.incomplete).length} read(s) failed, so the total is low`] : []),
      ],
    });
  }
  const map = stepOf(p, "map");
  let idleCount = 0;
  if (map.ok) {
    const m = rec(map.result);
    const failed = arr(m.providers).map(rec).filter((x) => x.state !== "ok");
    const complete = !failed.length && !!m.lastCompleteAt;
    // The map only marks a resource idle when its evidence is sufficient (unreadable metrics are never "idle").
    const idle = arr(m.idle).map(rec);
    idleCount = idle.length;
    sections.push({
      title: `Idle resources (${idle.length})`,
      lines: [
        ...idle.slice(0, 20).map((r) => `${s(r.name)} (${s(r.kind)}${r.env ? `, ${s(r.env)}` : ""}): ${s(r.why)} — confidence ${idleConfidence(typeof r.since === "string" ? r.since : null, now, complete)}`),
        ...(failed.length ? [`${failed.length} discovery provider(s) couldn't read everything (${failed.map((x) => s(x.id)).slice(0, 5).join(", ")}): resources there aren't judged, so confidence is low`] : []),
        "Idle means no activity over the idle window, not unused: check with the owners before stopping anything. This review never deletes.",
      ],
    });
  } else sections.push({ title: "Idle resources", lines: [`couldn't be read: ${map.why ?? "unknown"}`] });
  const ex = stepOf(p, "explain");
  if (ex.ok && typeof rec(ex.result).summary === "string") sections.unshift({ title: "Explanation", lines: [s(rec(ex.result).summary)] });
  return finish(`Cost review: ${costs.ok && rec(costs.result).available !== false ? `${money(rec(costs.result).monthToDate)} month to date, ` : ""}${idleCount} idle resource(s)`, sections);
}

// Config drift: what differs, with a task for a person in the Variables editor (never an executable change).
function configDrift(p: Progress): Report {
  const cmp = stepOf(p, "compare");
  if (!cmp.ok) return finish("Configuration drift: the comparison couldn't run", [{ title: "Comparison", lines: [`couldn't be read: ${cmp.why ?? "unknown"}`] }]);
  const r = rec(cmp.result);
  const envs = arr(r.envs).map(s);
  const sections: Report["sections"] = [];
  const tasks: NonNullable<Report["tasks"]> = [];
  let drift = 0;
  for (const svc of arr(r.services).map(rec)) {
    const name = s(svc.service);
    const vars = arr(svc.variables).map(rec).filter((v) => v.status !== "same");
    const unreadable = arr(svc.unreadable).map(rec);
    if (!vars.length && !unreadable.length) continue;
    drift += vars.length;
    sections.push({
      title: `${name}`,
      lines: [
        ...vars.slice(0, 30).map((v) => {
          const by = rec(v.envs);
          return `${s(v.name)}: ${envs.map((e) => `${e} ${s(by[e])}`).join(", ")}${v.sourceDiffers ? " (stored differently)" : ""}`;
        }),
        ...unreadable.map((u) => `${s(u.env)}: couldn't be compared (${s(u.why)})`),
      ],
    });
    for (const e of envs.slice(1)) {
      const names = vars.filter((v) => ["different", "missing"].includes(s(rec(v.envs)[e]))).map((v) => s(v.name));
      if (names.length) tasks.push({ title: `Review ${names.length} variable(s) of ${name} in ${e}`, link: `/?env=${encodeURIComponent(e)}&r=service:${encodeURIComponent(name)}&tab=variables`, names: names.slice(0, 50) });
    }
  }
  return finish(
    drift ? `Configuration drift: ${drift} variable(s) differ from ${envs[0] ?? "the reference"} — fixes are for a person in the Variables editor` : `Configuration drift: no differences from ${envs[0] ?? "the reference"}`,
    sections,
    tasks,
  );
}

function remediation(p: Progress): Report {
  const m = rec(p.remediate?.result);
  const v = rec(p.verify?.result);
  const skipped = p.verify?.state === "skipped";
  const healthy = v.ok === true || (skipped && m.health === "verified");
  const health = v.ok === true ? "verified healthy" : skipped ? (m.health === "verified" ? "verified healthy by the agent run" : m.changed ? "not verified" : "no change was made") : "not healthy";
  const lines = [
    `investigation run ${s(m.runId)}: ${s(m.state) || "not run"}`,
    ...(typeof m.summary === "string" && m.summary ? [m.summary.slice(0, 2_000)] : []),
    ...arr(m.operations).map(rec).map((o) => `${s(o.action)} on ${s(o.target)}: ${s(o.state)}${o.verify ? `, ${s(o.verify)}` : ""}`),
    ...(v.ok !== undefined ? [`verification: ${v.ok ? "healthy" : `not healthy after ${s(v.polls)} check(s)`}`] : []),
  ];
  return finish(`Remediation: ${health}${healthy ? "" : " — a person should look"}`, [{ title: "What happened", lines }]);
}

// The report a notify step writes. `message` is a rendered template (text reports).
export function buildReport(kind: ReportKind, p: Progress, o: { now: number; message?: string; pendingApprovals?: number }): Report {
  switch (kind) {
    case "digest":
      return digest(p, o.now, o.pendingApprovals);
    case "cost-review":
      return costReview(p, o.now);
    case "config-drift":
      return configDrift(p);
    case "remediation":
      return remediation(p);
    case "text":
      return finish(o.message ?? "Workflow finished", []);
  }
}

// A notify message rendered leniently: a value that isn't there reads "(none)" instead of failing the report.
export function renderMessage(template: string, ctx: unknown): string {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, src: string) => {
    const path = src.split(".").map((x: string) => (/^\d+$/.test(x) ? Number(x) : x));
    const v = lookup(ctx, path);
    return v === undefined || v === null ? "(none)" : typeof v === "string" ? v : JSON.stringify(v);
  }).slice(0, 4_000);
}

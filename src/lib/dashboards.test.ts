import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { tokenRoute } from "./automation.ts";
import {
  TEMPLATES, WIDGETS, WIDGET_TYPES, WORKSPACE_LIMITS, applyPatch, canEdit, canEditSaved, canView, canViewSaved, currentFailures, filterActivity, homeTarget,
  incidentWidgets, isDeployOrRollback, overviewLink, logsHref, makeWidget, moveWidget, neededRole, neighbourhood, newWidgetId, normaliseLayout, parseDashboardCreate,
  parseDashboardPatch, parsePin, parsePrefsPatch, parseSavedInput, parseSavedPatch, pinHref, regionMatches, snapSize, storeLayout, templateDoc, textSegments,
  sampledFreshness, unhealthyServices, validateDashboard, widgetConfigProblems, widgetFreshness, widgetProblems, type Widget,
} from "./dashboards.ts";
import { freshnessHeadline } from "./freshness.ts";

const w = (over: Partial<Widget> & Pick<Widget, "type">): Widget => ({ id: `${over.type}-1`, config: {}, ...WIDGETS[over.type].size, ...over });
const doc = (widgets: unknown[] = [], over: Record<string, unknown> = {}) => ({ name: "Mine", visibility: "private", minRole: "viewer", widgets, ...over });

// ---------- catalogue ----------

test("catalogue: every type has a closed object schema, allowed sizes that include its default, and valid defaults", () => {
  assert.equal(WIDGET_TYPES.length, 13);
  for (const t of WIDGET_TYPES) {
    const s = WIDGETS[t];
    assert.equal(s.type, t);
    assert.equal(s.schema.type, "object", t);
    assert.equal(s.schema.additionalProperties, false, t);
    assert.ok(s.widths.includes(s.size.w) && s.heights.includes(s.size.h), t);
    assert.ok(s.widths.every((x) => [3, 4, 6, 8, 12].includes(x)) && s.heights.every((x) => [1, 2, 3].includes(x)), t);
  }
  assert.equal(WIDGETS.costs.needs, "operator");
});

test("widget configs: each type's schema and its own rule", () => {
  const ok: [keyof typeof WIDGETS, Record<string, unknown>][] = [
    ["env-status", {}],
    ["env-status", { envs: ["staging", "production"] }],
    ["service-status", { env: "production", service: "api" }],
    ["metric-chart", { env: "production", key: "service:api", metric: "cpu", minutes: 10080 }],
    ["alarms", { env: "production", region: "eu-west-1" }],
    ["map-neighbourhood", { key: "arn:aws:lambda:us-east-1:123456789012:function:orders", hops: 2 }],
    ["pinned", {}],
    ["log-query", { savedId: "abc-123" }],
    ["log-query", { env: "staging", services: ["api", "worker"], query: "level:error", minutes: 60 }],
    ["costs", {}],
    ["activity", { kind: "deploys", hours: 6 }],
    ["activity", { env: "staging", kind: "all" }],
    ["approvals", { status: "pending" }],
    ["issues", {}],
    ["ci-failures", { repo: "acme/billing" }],
    ["text", { markdownLite: "Runbook: [wiki](https://wiki.example/runbook)" }],
  ];
  for (const [t, c] of ok) assert.deepEqual(widgetConfigProblems(t, c), [], `${t} ${JSON.stringify(c)}`);
  const bad: [keyof typeof WIDGETS, unknown, RegExp][] = [
    ["service-status", { env: "production" }, /config\.service: required/],
    ["service-status", { env: "Prod!", service: "api" }, /config\.env: does not match/],
    ["metric-chart", { env: "production", key: "service:api", metric: "cpu", minutes: 30 }, /config\.minutes: must be one of 60, 360, 1440, 10080/],
    ["map-neighbourhood", { key: "x", hops: 3 }, /config\.hops/],
    ["alarms", { region: "mars-1" }, /config\.region/],
    ["log-query", {}, /needs savedId, or env and query/],
    ["log-query", { savedId: "a", env: "staging", query: "x" }, /not both/],
    ["log-query", { env: "staging", query: "a\nb" }, /config\.query/],
    ["activity", {}, /config\.kind: required/],
    ["activity", { kind: "deploys", hours: 5 }, /config\.hours/],
    ["approvals", { status: "approved" }, /config\.status/],
    ["ci-failures", { repo: "not a repo" }, /config\.repo/],
    ["text", { markdownLite: "" }, /config\.markdownLite/],
    ["text", { markdownLite: "x".repeat(4001) }, /at most 4000/],
    ["pinned", { extra: 1 }, /config\.extra: unknown field/],
    ["costs", [], /config: must be an object/],
  ];
  for (const [t, c, re] of bad) assert.match(widgetConfigProblems(t, c).join(" | "), re, `${t} ${JSON.stringify(c)}`);
});

test("widgets: own properties only — inherited names and unknown fields are refused, sizes per type", () => {
  assert.deepEqual(widgetProblems(w({ type: "issues" })), []);
  const proto = JSON.parse('{"id":"a","type":"issues","config":{"__proto__":{"x":1}},"w":6,"h":2,"__proto__":{"y":2}}');
  const p = widgetProblems(proto).join(" | ");
  assert.match(p, /widget\.__proto__: unknown field/);
  assert.match(p, /widget\.config\.__proto__: unknown field/);
  // A type name inherited from Object.prototype is not a widget type.
  assert.match(widgetProblems({ id: "a", type: "constructor", config: {}, w: 6, h: 2 }).join(), /type: must be one of/);
  assert.match(widgetProblems({ id: "a", type: "toString", config: {}, w: 6, h: 2 }).join(), /type: must be one of/);
  assert.match(widgetProblems(w({ type: "costs", w: 12 })).join(), /w: Costs is 3, 4, 6 columns wide/);
  assert.match(widgetProblems(w({ type: "map-neighbourhood", h: 1 })).join(), /h: Map neighbourhood is 2, 3 rows tall/);
  assert.match(widgetProblems(w({ type: "issues", id: "has space" })).join(), /id: letters/);
  assert.match(widgetProblems(w({ type: "issues", title: "x".repeat(61) })).join(), /title: text of at most 60/);
  assert.deepEqual(widgetProblems("nope"), ["widget: must be an object"]);
});

// ---------- dashboards ----------

test("validateDashboard: name ≤ 80, ≤ 24 widgets with unique ids, ≤ 64 KB, own fields only", () => {
  const v = validateDashboard(doc([w({ type: "issues" })], { name: "  Platform  ", description: " On call " }));
  assert.ok(v.ok);
  assert.equal(v.value.name, "Platform");
  assert.equal(v.value.description, "On call");
  assert.equal(validateDashboard(doc([], { name: "x".repeat(80) })).ok, true);
  const long = validateDashboard(doc([], { name: "x".repeat(81) }));
  assert.ok(!long.ok && /name: at most 80/.test(long.error));
  assert.ok(!validateDashboard(doc([], { name: "  " })).ok);
  assert.ok(!validateDashboard(doc([], { name: "a\nb" })).ok);
  const many = Array.from({ length: 25 }, (_, i) => w({ type: "issues", id: `i-${i}` }));
  const tooMany = validateDashboard(doc(many));
  assert.ok(!tooMany.ok && tooMany.problems.includes("widgets: at most 24"));
  assert.ok(validateDashboard(doc(many.slice(0, 24))).ok);
  const dup = validateDashboard(doc([w({ type: "issues", id: "a" }), w({ type: "alarms", id: "a" })]));
  assert.ok(!dup.ok && /"a" is used twice/.test(dup.problems.join()));
  // 24 text widgets of 4,000 characters each are ~96 KB: over the 64 KB cap even though each widget is valid.
  const big = Array.from({ length: 24 }, (_, i) => w({ type: "text", id: `t-${i}`, config: { markdownLite: "é".repeat(2000) } }));
  const heavy = validateDashboard(doc(big));
  assert.ok(!heavy.ok && /at most 64 KB/.test(heavy.error), heavy.ok ? "" : heavy.error);
  const extra = validateDashboard({ ...doc(), owner: "me" });
  assert.ok(!extra.ok && extra.problems.includes("owner: unknown field"));
  const proto = validateDashboard(JSON.parse('{"name":"x","widgets":[],"__proto__":{"visibility":"team"}}'));
  assert.ok(!proto.ok && proto.problems.includes("__proto__: unknown field"));
  assert.ok(!validateDashboard(doc([], { visibility: "public" })).ok);
  assert.ok(!validateDashboard(doc([], { minRole: "root" })).ok);
  assert.ok(!validateDashboard([]).ok);
  // Defaults: private, every role.
  const d = validateDashboard({ name: "x" });
  assert.ok(d.ok && d.value.visibility === "private" && d.value.minRole === "viewer" && d.value.widgets.length === 0);
});

test("create: a template without widgets starts from the template's; unknown templates are refused", () => {
  const c = parseDashboardCreate({ name: "Ours", template: "team-overview" });
  assert.ok(c.ok);
  assert.equal(c.value.template, "team-overview");
  assert.deepEqual(c.value.widgets.map((x) => x.type), ["env-status", "issues", "approvals", "activity", "costs"]);
  const own = parseDashboardCreate({ name: "Ours", template: "incident", widgets: [w({ type: "text", config: { markdownLite: "hi" } })] });
  assert.ok(own.ok && own.value.widgets.length === 1);
  assert.ok(!parseDashboardCreate({ name: "x", template: "constructor" }).ok);
  assert.ok(!parseDashboardCreate({ name: "x", version: 3 }).ok);
});

test("patch: needs the edited version; the merged result is validated whole; null clears the description", () => {
  assert.ok(!parseDashboardPatch({ name: "x" }).ok);
  assert.ok(!parseDashboardPatch({ version: 0 }).ok);
  assert.ok(!parseDashboardPatch({ version: 1.5 }).ok);
  assert.ok(!parseDashboardPatch({ version: 1, owner: "x" }).ok);
  const cur = { name: "A", description: "d", visibility: "private" as const, minRole: "viewer" as const, widgets: [w({ type: "issues" })] };
  const p = parseDashboardPatch({ version: 3, visibility: "team", minRole: "operator", description: null });
  assert.ok(p.ok);
  const next = applyPatch(cur, p.value);
  assert.ok(next.ok);
  assert.deepEqual([next.value.visibility, next.value.minRole, next.value.description, next.value.widgets.length], ["team", "operator", undefined, 1]);
  const bad = parseDashboardPatch({ version: 3, widgets: Array.from({ length: 30 }, (_, i) => w({ type: "issues", id: `x${i}` })) });
  assert.ok(bad.ok);
  assert.ok(!applyPatch(cur, bad.value).ok);
});

test("normaliseLayout: order from the layout, sizes snapped, junk dropped, missing widgets appended, at most 24", () => {
  const widgets = [
    { id: "a", type: "issues", config: {} },
    { id: "b", type: "costs", config: {} },
    { id: "c", type: "no-such-type", config: {} },
    { id: "a", type: "alarms", config: {} }, // duplicate id
    { id: "d", type: "text", config: { markdownLite: "x" }, title: "  Note " },
    "garbage",
  ];
  const layout = { cols: 12, items: [{ id: "b", w: 12, h: 3 }, { id: "zz", w: 6, h: 1 }, { id: "a", w: 5, h: 2 }] };
  const out = normaliseLayout(widgets, layout);
  assert.deepEqual(out.map((x) => [x.id, x.type, x.w, x.h]), [["b", "costs", 6, 2], ["a", "issues", 4, 2], ["d", "text", 4, 1]]);
  assert.equal(out[2].title, "Note");
  assert.deepEqual(normaliseLayout(null, null), []);
  assert.equal(normaliseLayout(Array.from({ length: 40 }, (_, i) => ({ id: `w${i}`, type: "issues", config: {} })), {}).length, 24);
  // storeLayout is its inverse.
  const ws = [w({ type: "issues", id: "x", w: 8, h: 3 }), w({ type: "text", id: "y", title: "T", config: { markdownLite: "z" } })];
  const s = storeLayout(ws);
  assert.deepEqual(normaliseLayout(JSON.parse(JSON.stringify(s.widgets)), JSON.parse(JSON.stringify(s.layout))), ws);
  assert.deepEqual(snapSize("costs", 12, 3), { w: 6, h: 2 });
  assert.deepEqual(snapSize("issues", "big", undefined), WIDGETS.issues.size);
});

test("editing helpers: new ids, default widgets, moving", () => {
  assert.equal(newWidgetId("issues", ["issues-1", "issues-2"]), "issues-3");
  assert.equal(newWidgetId("issues", ["issues-2"]), "issues-1");
  const m = makeWidget("metric-chart", [], { env: "staging", key: "service:api" });
  assert.deepEqual(m, { id: "metric-chart-1", type: "metric-chart", config: { metric: "cpu", minutes: 360, env: "staging", key: "service:api" }, w: 6, h: 2 });
  assert.deepEqual(makeWidget("costs", [], {}, { w: 12, h: 3 }).w, 6);
  const list = [w({ type: "issues", id: "a" }), w({ type: "issues", id: "b" }), w({ type: "issues", id: "c" })];
  assert.deepEqual(moveWidget(list, "b", -1).map((x) => x.id), ["b", "a", "c"]);
  assert.deepEqual(moveWidget(list, "c", 1).map((x) => x.id), ["a", "b", "c"]);
  assert.equal(moveWidget(list, "zz", 1), list);
});

// ---------- RBAC ----------

test("canView / canEdit: owner always; team needs the minimum role; admins edit team dashboards only", () => {
  const alice = { id: "alice", role: "developer" as const };
  const bob = { id: "bob", role: "viewer" as const };
  const dave = { id: "dave", role: "operator" as const };
  const carol = { id: "carol", role: "admin" as const };
  const priv = { ownerId: "alice", visibility: "private" as const, minRole: "viewer" as const };
  const team = { ownerId: "alice", visibility: "team" as const, minRole: "developer" as const };
  assert.deepEqual([alice, bob, dave, carol].map((u) => canView(u, priv)), [true, false, false, false]);
  assert.deepEqual([alice, bob, dave, carol].map((u) => canEdit(u, priv)), [true, false, false, false]);
  assert.deepEqual([alice, bob, dave, carol].map((u) => canView(u, team)), [true, false, true, true]);
  assert.deepEqual([alice, bob, dave, carol].map((u) => canEdit(u, team)), [true, false, false, true]);
  // A viewer-owned dashboard is still its owner's to edit; a missing min role means everyone.
  assert.equal(canEdit(bob, { ownerId: "bob", visibility: "team", minRole: "admin" }), true);
  assert.equal(canView(bob, { ownerId: "x", visibility: "team", minRole: null }), true);
  assert.equal(canEdit(bob, { ownerId: "x", visibility: "team", minRole: null }), false);
  // Saved items: shared with the team = everyone signed in; admins may change shared ones.
  const item = { ownerId: "alice", visibility: "team" as const };
  assert.deepEqual([canViewSaved(bob, item), canEditSaved(bob, item), canEditSaved(carol, item), canEditSaved(carol, { ...item, visibility: "private" })], [true, false, true, false]);
  assert.equal(canViewSaved(carol, { ...item, visibility: "private" }), false);
});

test("API tokens never reach the workspace routes (they are not in tokenRoute)", () => {
  for (const [m, p] of [
    ["GET", "/api/dashboards"], ["POST", "/api/dashboards"], ["GET", "/api/dashboards/abc"], ["PATCH", "/api/dashboards/abc"], ["DELETE", "/api/dashboards/abc"],
    ["POST", "/api/dashboards/abc/duplicate"], ["GET", "/api/pins"], ["POST", "/api/pins"], ["DELETE", "/api/pins"], ["GET", "/api/saved"], ["POST", "/api/saved"],
    ["PATCH", "/api/saved/abc"], ["DELETE", "/api/saved/abc"], ["GET", "/api/me/prefs"], ["PATCH", "/api/me/prefs"],
  ])
    assert.equal(tokenRoute(m, p).ok, false, `${m} ${p}`);
  assert.equal(tokenRoute("GET", "/api/me").ok, true); // the one /api/me route tokens may read
});

// ---------- templates ----------

test("templates: Team overview and Incident; the Incident board charts each unhealthy service (worst first, at most 4)", () => {
  assert.deepEqual(TEMPLATES.map((t) => t.id), ["team-overview", "incident"]);
  for (const t of TEMPLATES) assert.ok(validateDashboard(doc(t.widgets)).ok, t.id);
  const base = incidentWidgets();
  assert.deepEqual(base.map((x) => x.type), ["issues", "alarms", "ci-failures", "activity", "approvals"]);
  assert.deepEqual(base.find((x) => x.type === "activity")!.config, { kind: "deploys", hours: 6 });
  const issues = [
    { env: "production", key: "service:api", kind: "service", name: "API", state: "DEGRADED" },
    { env: "production", key: "database:pg", kind: "database", state: "DOWN" },
    { env: "staging", key: "service:worker", kind: "service", name: "Worker", state: "DOWN" },
    { env: "staging", key: "service:jobs", kind: "service", state: "UNKNOWN" },
    ...Array.from({ length: 6 }, (_, i) => ({ env: "production", key: `service:s${i}`, kind: "service", state: "DEGRADED" })),
  ];
  assert.deepEqual(unhealthyServices(issues).map((i) => i.key), ["service:worker", "service:api", "service:s0", "service:s1"]);
  const live = incidentWidgets(issues);
  const charts = live.filter((x) => x.type === "metric-chart");
  assert.equal(charts.length, WORKSPACE_LIMITS.incidentCharts);
  assert.deepEqual(charts[0].config, { env: "staging", key: "service:worker", metric: "cpu", minutes: 360 });
  assert.equal(charts[0].title, "Worker · CPU (staging)");
  assert.deepEqual(charts.map((c) => c.w), [6, 6, 6, 6]);
  assert.deepEqual(incidentWidgets(issues.slice(0, 1)).filter((x) => x.type === "metric-chart").map((c) => c.w), [12]); // an odd last chart fills its row
  assert.ok(validateDashboard(doc(live)).ok);
  assert.equal(templateDoc("incident", issues).widgets.length, live.length);
});

// ---------- home page and prefs ----------

test("home: overview, incident or a dashboard; anything else is the Overview", () => {
  assert.deepEqual(homeTarget("incident"), { kind: "incident" });
  assert.deepEqual(homeTarget("dashboard:abc-1"), { kind: "dashboard", id: "abc-1" });
  for (const v of [undefined, "", "overview", "dashboard:", "dashboard:../x", "something", 3]) assert.deepEqual(homeTarget(v), { kind: "overview" }, String(v));
  // Links into the Overview open it whatever the home page is: a resource panel, an environment (the issues list's
  // whole-environment rows link to /?env=<id>), or ?view=overview.
  const q = (s: string) => overviewLink(new URLSearchParams(s));
  assert.deepEqual(["?r=service:api", "?env=staging", "?env=staging&r=service:api", "?view=overview", "", "?view=x", "?region=eu-west-1"].map(q), [true, true, true, true, false, false, false]);
});

test("prefs: allow-listed keys and values; null removes", () => {
  const ok = parsePrefsPatch({ home: "dashboard:abc", region: "eu-west-1", "dashboards.lastOpened": "abc" });
  assert.ok(ok.ok);
  const clear = parsePrefsPatch({ home: null, region: "" });
  assert.ok(clear.ok && clear.value.home === null && clear.value.region === null);
  assert.ok(parsePrefsPatch({ home: "incident", region: "all" }).ok);
  for (const bad of [{ theme: "dark" }, { home: "https://evil.example" }, { home: "dashboard:a/b" }, { region: "moon" }, { "dashboards.lastOpened": "../x" }, { home: 1 }, []])
    assert.ok(!parsePrefsPatch(bad).ok, JSON.stringify(bad));
  assert.ok(!parsePrefsPatch(JSON.parse('{"__proto__":{"home":"incident"}}')).ok);
});

// ---------- pins and saved items ----------

test("pins: the PinButton shape; where a pin opens", () => {
  const p = parsePin({ rkey: "service:api", name: " API ", kind: "service", env: "production", region: "us-east-1" });
  assert.ok(p.ok);
  assert.deepEqual(p.value, { rkey: "service:api", name: "API", kind: "service", env: "production", region: "us-east-1" });
  assert.ok(parsePin({ rkey: "arn:aws:cloudfront::123456789012:distribution/E1", name: "cdn", kind: "cloudfront", region: "global" }).ok);
  for (const bad of [{ rkey: "", name: "x", kind: "k" }, { rkey: "a", name: "", kind: "k" }, { rkey: "a\u0000", name: "x", kind: "k" }, { rkey: "a", name: "x", kind: "k", env: "Prod" }, { rkey: "a", name: "x", kind: "k", owner: "me" }])
    assert.ok(!parsePin(bad).ok, JSON.stringify(bad));
  assert.equal(pinHref({ rkey: "service:api", env: "production" }), "/?env=production&r=service%3Aapi");
  assert.equal(pinHref({ rkey: "arn:aws:sqs:us-east-1:123456789012:orders" }), "/map?r=arn%3Aaws%3Asqs%3Aus-east-1%3A123456789012%3Aorders");
  assert.equal(pinHref({ rkey: "service:api" }), "/map?r=service%3Aapi");
});

test("saved items: views are console paths, log queries one-line queries; own fields only", () => {
  const v = parseSavedInput({ kind: "view", name: "Prod logs", payload: { path: "/logs", search: "?env=production&service=api" } });
  assert.ok(v.ok && v.value.visibility === "private");
  const q = parseSavedInput({ kind: "log-query", name: "Errors", visibility: "team", payload: { env: "staging", services: ["api", "api"], query: "level:error", minutes: 60 } });
  assert.ok(q.ok);
  assert.deepEqual(q.value.payload, { env: "staging", services: ["api"], query: "level:error", minutes: 60 });
  for (const [path, why] of [["//evil.example/x", "protocol-relative"], ["/\\evil.example", "backslash"], ["https://evil.example", "absolute"], ["/api/costs", "API"], ["logs", "relative"], ["/a b", "space"]])
    assert.ok(!parseSavedInput({ kind: "view", name: "x", payload: { path, search: "" } }).ok, why);
  assert.ok(!parseSavedInput({ kind: "view", name: "x", payload: { path: "/logs", search: "env=x" } }).ok);
  assert.ok(!parseSavedInput({ kind: "log-query", name: "x", payload: { query: "a\nb", minutes: 60 } }).ok);
  // The Logs page saves its current env, which is "" before one is chosen: that is "no environment", not an error.
  const noEnv = parseSavedInput({ kind: "log-query", name: "x", payload: { env: "", query: "a", minutes: 60 } });
  assert.ok(noEnv.ok && !("env" in noEnv.value.payload));
  assert.ok(!parseSavedInput({ kind: "log-query", name: "x", payload: { env: "Prod!", query: "a", minutes: 60 } }).ok);
  assert.ok(!parseSavedInput({ kind: "log-query", name: "x", payload: { query: "a", minutes: 0 } }).ok);
  assert.ok(!parseSavedInput({ kind: "log-query", name: "x", payload: { query: "a", minutes: 60, extra: 1 } }).ok);
  assert.ok(!parseSavedInput({ kind: "note", name: "x", payload: {} }).ok);
  assert.ok(!parseSavedInput({ kind: "view", name: "x", payload: { path: "/logs", search: `?q=${"x".repeat(9000)}` } }).ok);
  const patch = parseSavedPatch("log-query", { visibility: "team", payload: { query: "x", minutes: 15 } });
  assert.ok(patch.ok && patch.value.visibility === "team");
  assert.ok(!parseSavedPatch("view", { kind: "log-query" }).ok);
  assert.equal(logsHref({ env: "staging", services: ["api", "worker"], query: "level:error", minutes: 60 }), "/logs?env=staging&service=api%2Cworker&q=level%3Aerror&minutes=60");
  assert.equal(logsHref({ query: "" }), "/logs");
});

// ---------- widget helpers ----------

test("text widget: plain text with safe links only", () => {
  const segs = textSegments("See [the runbook](https://wiki.example/rb) or https://status.example.\n[home](/dashboards) [bad](javascript:alert(1)) [proto](//evil.example)");
  assert.deepEqual(segs[0], [{ text: "See " }, { text: "the runbook", href: "https://wiki.example/rb" }, { text: " or " }, { text: "https://status.example", href: "https://status.example" }, { text: "." }]);
  assert.deepEqual(segs[1].filter((s) => s.href).map((s) => s.href), ["/dashboards"]);
  assert.ok(segs[1].some((s) => s.text.includes("javascript:alert(1)") && !s.href));
  assert.ok(segs[1].some((s) => s.text === "[proto](//evil.example)" && !s.href));
  assert.deepEqual(textSegments(""), [[{ text: "" }]]);
});

test("map neighbourhood: one or two hops in either direction, capped", () => {
  const edges = [
    { from: "cdn", to: "alb", kind: "route" },
    { from: "alb", to: "api", kind: "route", label: "/api/*" },
    { from: "api", to: "db", kind: "connects" },
    { from: "worker", to: "db", kind: "connects" },
    { from: "other", to: "island", kind: "connects" },
  ];
  const one = neighbourhood(edges, "api", 1);
  assert.deepEqual(one.nodes.map((n) => [n.key, n.depth]), [["api", 0], ["alb", 1], ["db", 1]]);
  assert.equal(one.nodes.find((n) => n.key === "alb")!.via, "route · /api/*");
  assert.deepEqual(one.edges.map((e) => `${e.from}>${e.to}`), ["alb>api", "api>db"]);
  const two = neighbourhood(edges, "api", 2);
  assert.deepEqual(two.nodes.map((n) => n.key).sort(), ["alb", "api", "cdn", "db", "worker"]);
  assert.equal(neighbourhood(edges, "api", 2, 3).nodes.length, 3);
  assert.deepEqual(neighbourhood(edges, "nowhere", 2).nodes, [{ key: "nowhere", depth: 0 }]);
});

test("CI failures: the latest run per workflow and branch, kept only when it failed", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  const run = (id: number, workflow: string, branch: string, conclusion: string | null, at: string, status = "completed") => ({ id, repo: "acme/api", workflow, branch, status, conclusion, createdAt: at });
  const runs = [
    run(1, "CI", "main", "failure", "2026-10-05T10:00:00Z"),
    run(2, "CI", "main", "success", "2026-10-05T11:00:00Z"), // fixed since
    run(3, "deploy", "main", "failure", "2026-10-05T09:00:00Z"),
    run(4, "deploy", "main", null, "2026-10-05T11:30:00Z", "in_progress"), // running: the failure still stands
    run(5, "CI", "feature", "timed_out", "2026-10-05T08:00:00Z"),
    run(6, "nightly", "main", "failure", "2026-09-01T08:00:00Z"), // too old
  ];
  assert.deepEqual(currentFailures(runs, now).map((r) => r.id), [3, 5]);
});

test("activity: deploys and rollbacks within the window", () => {
  const now = 10 * 3_600_000;
  const items = [
    { at: now - 1_000, kind: "deploy", title: "Deploy success" },
    { at: now - 2_000, kind: "ci", title: "CI failure" },
    { at: now - 3_000, kind: "action", title: "services.switch ok", detail: "revision 41" },
    { at: now - 4_000, kind: "ecs", title: "ECS problem", detail: "deployment failed: rolling back to 40" },
    { at: now - 5_000, kind: "ecs", title: "ECS", detail: "has reached a steady state" },
    { at: now - 6_000, kind: "ecs", title: "ECS", detail: "(deployment ecs-svc/1234567890123456789) deployment completed." },
    { at: now - 6_500, kind: "ecs", title: "ECS", detail: "has started 1 tasks: (task 0123456789abcdef0123456789abcdef)." },
    { at: now - 7 * 3_600_000, kind: "deploy", title: "Deploy success" },
  ];
  assert.deepEqual(items.map(isDeployOrRollback), [true, false, true, true, false, true, false, true]);
  assert.equal(filterActivity(items, { kind: "deploys", hours: 6 }, now).length, 4);
  assert.equal(filterActivity(items, { kind: "all", hours: 6 }, now).length, 7);
  assert.equal(filterActivity(items, { kind: "all" }, now).length, 8);
});

test("needs <role> from a 403, and the region filter", () => {
  assert.equal(neededRole("your role (viewer) can't do this — needs operator"), "operator");
  assert.equal(neededRole("only an admin"), undefined);
  assert.equal(neededRole(undefined), undefined);
  assert.deepEqual([regionMatches("all", "eu-west-1"), regionMatches("eu-west-1", "eu-west-1"), regionMatches("eu-west-1", "us-east-1"), regionMatches("eu-west-1", "global"), regionMatches("eu-west-1", undefined)], [true, true, false, true, true]);
});

test("R21: a widget's freshness comes from its own data; a failed refresh keeps the data and says so", () => {
  const now = 1_000_000;
  assert.equal(widgetFreshness({ staleAfterMs: 60_000, source: "x" }), undefined);
  const fresh = widgetFreshness({ at: now - 5_000, staleAfterMs: 60_000, source: "issues" })!;
  assert.equal(freshnessHeadline(fresh, now), undefined); // quiet: nothing to say
  const failed = widgetFreshness({ at: now - 5_000, error: "HTTP 502", failedAt: now - 1_000, staleAfterMs: 60_000, source: "issues" })!;
  assert.equal(freshnessHeadline(failed, now), "Last refresh failed");
  assert.equal(freshnessHeadline(widgetFreshness({ at: now - 120_000, error: "HTTP 502", staleAfterMs: 60_000, source: "issues" })!, now), "Showing stale data — refresh failing");
  // The API's own freshness wins over load time (an overview the sampler stopped refreshing is stale however recently fetched).
  const server = { observedAt: now - 600_000, staleAfterMs: 30_000, source: "simulated ECS", completeness: "complete" as const };
  assert.equal(freshnessHeadline(widgetFreshness({ at: now, server, staleAfterMs: 60_000, source: "overview" })!, now), "Showing stale data");
  const envs = sampledFreshness([{ id: "staging", sampledAt: now - 10_000 }, { id: "production", sampledAt: now - 20_000, stale: true }], 90_000)!;
  assert.deepEqual([envs.observedAt, envs.completeness, envs.notes], [now - 20_000, "partial", ["production not sampled recently"]]);
  assert.equal(sampledFreshness([{ id: "a" }], 90_000)!.observedAt, undefined); // never sampled: age unknown
  assert.equal(sampledFreshness([], 90_000), undefined);
});

// ---------- the stores, end to end on SQLite ----------
// src/lib/server/dashboards.ts and workspace.ts import "server-only", which only resolves under the react-server
// condition, so this runs in a child process against an in-memory database.
const scenario = String.raw`
const at = (f) => new URL(f, ${JSON.stringify(new URL("./server/", import.meta.url).href)}).href;
const D = await import(at("dashboards.ts"));
const Wk = await import(at("workspace.ts"));
const { getDb } = await import(at("db.ts"));
const db = await getDb();
const now = Date.now();
for (const [id, role] of [["alice", "developer"], ["bob", "viewer"], ["carol", "admin"], ["dave", "operator"]])
  await db.run("INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)", [id, id + "@acme.example", null, role, now]);
const u = (id, role) => ({ id, email: id + "@acme.example", role });
const alice = u("alice", "developer"), bob = u("bob", "viewer"), carol = u("carol", "admin"), dave = u("dave", "operator");
const err = async (p) => { try { await p; return null; } catch (e) { return { status: e.status, code: e.code, msg: e.message, version: e.current?.version, problems: e.problems }; } };
const audits = async () => (await db.all("SELECT action, phase FROM audit ORDER BY rowid")).map((r) => r.action + ":" + r.phase);
const out = {};

const d = await D.createDashboard(alice, { name: "Platform", template: "team-overview" }, { ip: "10.0.0.1" });
out.created = { v: d.version, vis: d.visibility, n: d.widgets.length, mine: d.mine, canEdit: d.canEdit, owner: d.owner.email, template: d.template };
out.privateHidden = await Promise.all([bob, carol, dave].map((x) => err(D.getDashboard(x, d.id)).then((e) => e?.status)));
out.listBob = (await D.listDashboards(bob)).dashboards.length;
out.auditAfterPrivate = await audits();

const shared = await D.updateDashboard(alice, d.id, { version: 1, visibility: "team", minRole: "developer" }, {});
out.shared = { v: shared.version, vis: shared.visibility, min: shared.minRole };
out.auditAfterShare = await audits();
out.viewerSees = await err(D.getDashboard(bob, d.id)).then((e) => e?.status);
const asDave = await D.getDashboard(dave, d.id);
out.dave = { canEdit: asDave.canEdit, mine: asDave.mine };
out.daveEdit = await err(D.updateDashboard(dave, d.id, { version: 2, name: "Mine now" }));
out.daveDelete = await err(D.deleteDashboard(dave, d.id));
out.carolEdit = (await D.updateDashboard(carol, d.id, { version: 2, name: "Platform (admin)" })).version;
out.stale = await err(D.updateDashboard(alice, d.id, { version: 2, name: "Lost update" }));
out.nameNow = (await D.getDashboard(alice, d.id)).name;
out.badPatch = await err(D.updateDashboard(alice, d.id, { version: 3, widgets: [{ id: "x", type: "costs", config: {}, w: 12, h: 9 }] }));
out.renameNoAudit = (await D.updateDashboard(alice, d.id, { version: 3, name: "Platform" })).version;
out.auditCount = (await audits()).length;

const copy = await D.duplicateDashboard(dave, d.id, {});
out.copy = { name: copy.name, vis: copy.visibility, mine: copy.mine, owner: copy.owner.id, n: copy.widgets.length, v: copy.version };
out.listDave = (await D.listDashboards(dave)).dashboards.map((x) => [x.name, x.mine, x.canEdit, x.widgetCount]).sort();

// The home page may point only at a dashboard the person can see.
out.homeBob = await err(Wk.setPrefs(bob, { home: "dashboard:" + d.id }));
out.homeDave = await Wk.setPrefs(dave, { home: "dashboard:" + d.id, region: "eu-west-1" });
out.prefsBad = await err(Wk.setPrefs(dave, { theme: "dark" }));
out.prefsClear = await Wk.setPrefs(dave, { region: null });
await db.run("INSERT INTO user_prefs (user_id, key, value, updated_at) VALUES ('dave', 'legacy', 'x', 1)");
out.prefsFiltered = await Wk.getPrefs(dave);

// Deleting the shared dashboard (an admin) clears preferences that pointed at it, and is audited.
out.carolDelete = await D.deleteDashboard(carol, d.id, { ip: "10.0.0.3" });
out.homeAfterDelete = await Wk.getPrefs(dave);
out.auditTail = (await audits()).slice(-2);

// Limits: 50 dashboards per person.
for (let i = (await D.listDashboards(bob)).dashboards.filter((x) => x.mine).length; i < 50; i++) await D.createDashboard(bob, { name: "b" + i });
out.limit = await err(D.createDashboard(bob, { name: "one too many" }));

// Pins: upsert, newest first, 200 per person, unpin twice.
await Wk.addPin(alice, { rkey: "service:api", name: "API", kind: "service", env: "staging" });
await new Promise((r) => setTimeout(r, 5));
await Wk.addPin(alice, { rkey: "arn:aws:sqs:us-east-1:123456789012:orders", name: "orders", kind: "sqs", region: "us-east-1" });
await Wk.addPin(alice, { rkey: "service:api", name: "API (renamed)", kind: "service", env: "staging" });
out.pins = (await Wk.listPins(alice)).map((p) => p.rkey + "=" + p.name);
out.pinsBob = (await Wk.listPins(bob)).length;
for (let i = 0; i < 198; i++) await Wk.addPin(alice, { rkey: "k" + i, name: "n", kind: "k" });
out.pinLimit = await err(Wk.addPin(alice, { rkey: "one-more", name: "n", kind: "k" }));
out.pinRepin = (await Wk.addPin(alice, { rkey: "k1", name: "again", kind: "k" })).name;
out.unpin = [await Wk.removePin(alice, "k1"), await Wk.removePin(alice, "k1")].map((r) => r.removed);

// Saved items: private and team, who may change them, sharing audited.
const mineQ = await Wk.createSaved(alice, { kind: "log-query", name: "Errors", payload: { env: "staging", query: "level:error", minutes: 60 } }, {});
const teamV = await Wk.createSaved(alice, { kind: "view", name: "Prod logs", payload: { path: "/logs", search: "?env=production" }, visibility: "team" }, {});
out.savedBob = (await Wk.listSaved(bob)).map((s) => [s.name, s.mine, s.canEdit]);
out.savedBobQueries = (await Wk.listSaved(bob, "log-query")).length;
out.savedBadKind = await err(Wk.listSaved(bob, "note"));
out.savedBobPrivate = await err(Wk.getSaved(bob, mineQ.id));
out.savedBobEdit = await err(Wk.updateSaved(bob, teamV.id, { name: "mine" }));
out.savedCarolEdit = (await Wk.updateSaved(carol, teamV.id, { name: "Production logs" })).name;
// An admin who makes someone's shared item (or dashboard) private gets the result back, then loses sight of it.
const tmp = await Wk.createSaved(alice, { kind: "view", name: "tmp", payload: { path: "/", search: "" }, visibility: "team" });
out.adminHides = (await Wk.updateSaved(carol, tmp.id, { visibility: "private" })).visibility;
out.adminHidden = await err(Wk.getSaved(carol, tmp.id)).then((e) => e?.status);
await Wk.deleteSaved(alice, tmp.id);
const td = await D.createDashboard(alice, { name: "tmp", visibility: "team" });
out.adminHidesDash = (await D.updateDashboard(carol, td.id, { version: 1, visibility: "private" })).visibility;
out.adminHiddenDash = await err(D.getDashboard(carol, td.id)).then((e) => e?.status);
await D.deleteDashboard(alice, td.id);
out.savedShare = (await Wk.updateSaved(alice, mineQ.id, { visibility: "team" })).visibility;
out.savedUnshareDelete = (await Wk.deleteSaved(alice, teamV.id)).id === teamV.id;
const auditOf = async (id) => (await db.all("SELECT action, phase FROM audit WHERE params LIKE ? ORDER BY rowid", ["%" + id + "%"])).map((r) => r.action + ":" + r.phase);
out.savedAudit = { mine: await auditOf(mineQ.id), team: await auditOf(teamV.id) };
for (let i = (await Wk.listSaved(dave)).filter((s) => s.mine).length; i < 200; i++) await Wk.createSaved(dave, { kind: "view", name: "v" + i, payload: { path: "/", search: "" } });
out.savedLimit = await err(Wk.createSaved(dave, { kind: "view", name: "x", payload: { path: "/", search: "" } }));
out.auditActors = [...new Set((await db.all("SELECT actor FROM audit")).map((r) => r.actor))].sort();
console.log(JSON.stringify(out));
process.exit(0);
`;

const env = { ...process.env, CONSOLE_SOURCE: "mock", CONSOLE_SQLITE_PATH: ":memory:", DATABASE_URL: "", CONSOLE_CONFIG: "", NODE_NO_WARNINGS: "1" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const o = JSON.parse(execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", scenario], { encoding: "utf8", env, timeout: 120_000 }).trim().split("\n").pop()!) as Record<string, any>;

test("store: a new private dashboard is its owner's alone — invisible even to admins, never audited", () => {
  assert.deepEqual(o.created, { v: 1, vis: "private", n: 5, mine: true, canEdit: true, owner: "alice@acme.example", template: "team-overview" });
  assert.deepEqual(o.privateHidden, [404, 404, 404]);
  assert.equal(o.listBob, 0);
  assert.deepEqual(o.auditAfterPrivate, []);
});

test("store: sharing with the team is audited (intent then result); the minimum role decides who sees it", () => {
  assert.deepEqual(o.shared, { v: 2, vis: "team", min: "developer" });
  assert.deepEqual(o.auditAfterShare, ["dashboard.share:intent", "dashboard.share:result"]);
  assert.equal(o.viewerSees, 404);
  assert.deepEqual(o.dave, { canEdit: false, mine: false });
});

test("store: a team member who isn't the owner can't edit or delete; an admin can", () => {
  assert.equal(o.daveEdit.status, 403);
  assert.equal(o.daveDelete.status, 403);
  assert.equal(o.carolEdit, 3);
});

test("store: a stale version is refused with 409 and the current version — never a lost update", () => {
  assert.equal(o.stale.status, 409);
  assert.equal(o.stale.code, "version_conflict");
  assert.equal(o.stale.version, 3);
  assert.equal(o.nameNow, "Platform (admin)");
  assert.equal(o.badPatch.status, 400);
  assert.ok(o.badPatch.problems.some((p: string) => /widgets\[0\]\.(w|h)/.test(p)));
  assert.equal(o.renameNoAudit, 4);
  assert.equal(o.auditCount, 2); // renames and the admin's edit aren't audited; only sharing
});

test("store: duplicate makes a private copy owned by the caller", () => {
  assert.deepEqual(o.copy, { name: "Copy of Platform", vis: "private", mine: true, owner: "dave", n: 5, v: 1 });
  assert.deepEqual(o.listDave, [["Copy of Platform", true, true, 5], ["Platform", false, false, 5]]);
});

test("store: prefs are allow-listed, a home dashboard must be visible, deleting it clears the preference", () => {
  assert.equal(o.homeBob.status, 400);
  assert.deepEqual(o.homeDave, { home: `dashboard:${o.carolDelete.id}`, region: "eu-west-1" });
  assert.equal(o.prefsBad.status, 400);
  assert.deepEqual(o.prefsClear, { home: `dashboard:${o.carolDelete.id}` });
  assert.deepEqual(o.prefsFiltered, { home: `dashboard:${o.carolDelete.id}` });
  assert.deepEqual(o.homeAfterDelete, {});
  assert.deepEqual(o.auditTail, ["dashboard.delete:intent", "dashboard.delete:result"]);
});

test("store: 50 dashboards, 200 pins and 200 saved items per person", () => {
  assert.equal(o.limit.status, 409);
  assert.match(o.limit.msg, /50 dashboards/);
  assert.equal(o.pinLimit.status, 409);
  assert.equal(o.pinRepin, "again"); // re-pinning at the limit updates in place
  assert.equal(o.savedLimit.status, 409);
});

test("store: pins are personal, upserted and newest first; unpinning twice is fine", () => {
  assert.deepEqual(o.pins, ["arn:aws:sqs:us-east-1:123456789012:orders=orders", "service:api=API (renamed)"]);
  assert.equal(o.pinsBob, 0);
  assert.deepEqual(o.unpin, [true, false]);
});

test("store: saved items — team ones visible to all, changed by owner or admin, sharing audited", () => {
  assert.deepEqual(o.savedBob, [["Prod logs", false, false]]);
  assert.equal(o.savedBobQueries, 0);
  assert.equal(o.savedBadKind.status, 400);
  assert.equal(o.savedBobPrivate.status, 404);
  assert.equal(o.savedBobEdit.status, 403);
  assert.equal(o.savedCarolEdit, "Production logs");
  assert.deepEqual([o.adminHides, o.adminHidden, o.adminHidesDash, o.adminHiddenDash], ["private", 404, "private", 404]);
  assert.equal(o.savedShare, "team");
  assert.equal(o.savedUnshareDelete, true);
  assert.deepEqual(o.savedAudit, {
    mine: ["saved.share:intent", "saved.share:result"], // private → team
    team: ["saved.share:intent", "saved.share:result", "saved.delete:intent", "saved.delete:result"], // created shared, renamed by an admin (not audited), deleted
  });
  assert.deepEqual(o.auditActors, ["alice@acme.example", "carol@acme.example"]);
});

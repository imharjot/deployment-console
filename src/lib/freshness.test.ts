import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ago, combineFreshness, describeFreshness, effectiveState, isQuiet, isStale, type Freshness } from "./freshness.ts";

const NOW = Date.UTC(2026, 9, 5, 14, 5, 0); // 14:05 UTC
const f = (o: Partial<Freshness> = {}): Freshness => ({ observedAt: NOW - 3 * 60_000, staleAfterMs: 5 * 60_000, source: "sampler", completeness: "complete", ...o });

test("stale boundary: exactly staleAfterMs old is fresh, one ms more is stale", () => {
  assert.equal(isStale(f({ observedAt: NOW - 5 * 60_000 }), NOW), false);
  assert.equal(isStale(f({ observedAt: NOW - 5 * 60_000 - 1 }), NOW), true);
  assert.equal(isStale(f(), NOW), false);
});

test("unknown age is stale, and stale or unknown-age state becomes unknown", () => {
  assert.equal(isStale(f({ observedAt: undefined }), NOW), true);
  assert.equal(isStale(f({ observedAt: 0 }), NOW), true);
  assert.equal(isStale(f({ observedAt: Number.NaN }), NOW), true);
  assert.equal(effectiveState("UP", f({ observedAt: undefined }), "UNKNOWN", NOW), "UNKNOWN");
  assert.equal(effectiveState("UP", f({ observedAt: NOW - 6 * 60_000 }), "UNKNOWN", NOW), "UNKNOWN");
  assert.equal(effectiveState("UP", f(), "UNKNOWN", NOW), "UP");
  assert.equal(effectiveState("ok", undefined, "unknown", NOW), "ok", "no freshness model attached: unchanged");
});

test("describeFreshness: time in UTC, age, completeness and failures", () => {
  assert.equal(describeFreshness(f(), NOW), "as of 14:02 UTC (3 min ago)");
  assert.equal(describeFreshness(f({ completeness: "partial", notes: ["2 sources denied"] }), NOW), "as of 14:02 UTC (3 min ago) · partial: 2 sources denied");
  assert.equal(describeFreshness(f({ observedAt: NOW - 20 * 60_000 }), NOW), "stale — as of 13:45 UTC (20 min ago)");
  assert.equal(describeFreshness(f({ observedAt: undefined, completeness: "unknown" }), NOW), "age unknown · completeness unknown");
  assert.equal(
    describeFreshness(f({ error: "ThrottlingException: Rate exceeded", refreshFailedAt: NOW - 30_000 }), NOW),
    "as of 14:02 UTC (3 min ago) · last refresh failed 30 s ago: ThrottlingException: Rate exceeded",
  );
  // Another day carries the date.
  assert.equal(describeFreshness(f({ observedAt: NOW - 26 * 3600_000, staleAfterMs: 7 * 24 * 3600_000 }), NOW), "as of 2026-10-04 12:05 UTC (26 h ago)");
});

test("ago", () => {
  assert.equal(ago(2_000), "just now");
  assert.equal(ago(42_000), "42 s ago");
  assert.equal(ago(7 * 60_000), "7 min ago");
  assert.equal(ago(5 * 3600_000), "5 h ago");
  assert.equal(ago(3 * 24 * 3600_000), "3 d ago");
  assert.equal(ago(-5), "just now");
});

test("isQuiet: only fresh, complete and without a failed refresh", () => {
  assert.equal(isQuiet(f(), NOW), true);
  assert.equal(isQuiet(f({ completeness: "partial" }), NOW), false);
  assert.equal(isQuiet(f({ error: "x" }), NOW), false);
  assert.equal(isQuiet(f({ observedAt: undefined }), NOW), false);
});

test("combineFreshness: partial + denied → partial, oldest age, all notes and errors kept", () => {
  const inv = f({ source: "inventory", observedAt: NOW - 60_000, completeness: "partial", notes: ["eu-west-1 pending"] });
  const denied = f({ source: "cloudwatch", observedAt: NOW - 4 * 60_000, staleAfterMs: 10 * 60_000, notes: ["2 sources denied"], error: "AccessDenied" });
  const c = combineFreshness([inv, denied]);
  assert.equal(c.completeness, "partial");
  assert.equal(c.source, "inventory, cloudwatch");
  assert.equal(c.observedAt, NOW - 4 * 60_000);
  assert.deepEqual(c.notes, ["eu-west-1 pending", "2 sources denied"]);
  assert.equal(c.error, "AccessDenied");
  assert.equal(describeFreshness(c, NOW), "as of 14:01 UTC (4 min ago) · partial: eu-west-1 pending, 2 sources denied · last refresh failed: AccessDenied");
});

test("combineFreshness: stale as soon as any part is stale (earliest deadline wins)", () => {
  // inventory: 1 min old, stale after 5 → deadline NOW+4m; cloudwatch: 4 min old, stale after 10 → deadline NOW+6m.
  const c = combineFreshness([f({ observedAt: NOW - 60_000 }), f({ observedAt: NOW - 4 * 60_000, staleAfterMs: 10 * 60_000 })]);
  assert.equal(isStale(c, NOW + 4 * 60_000), false);
  assert.equal(isStale(c, NOW + 4 * 60_000 + 1), true);
  // One part of unknown age makes the whole of unknown age.
  const u = combineFreshness([f(), f({ observedAt: undefined })]);
  assert.equal(u.observedAt, undefined);
  assert.equal(isStale(u, NOW), true);
  // Unknown completeness is the worst.
  assert.equal(combineFreshness([f({ completeness: "partial" }), f({ completeness: "unknown" })]).completeness, "unknown");
  assert.deepEqual(combineFreshness([]), { staleAfterMs: 0, source: "none", completeness: "unknown" });
  assert.equal(combineFreshness([f(), f()]).completeness, "complete");
});

test("freshnessHeadline: nothing when quiet; the worst problem first", async () => {
  const { freshnessHeadline } = await import("./freshness.ts");
  assert.equal(freshnessHeadline(f(), NOW), undefined);
  assert.equal(freshnessHeadline(f({ observedAt: undefined }), NOW), "Data age unknown");
  assert.equal(freshnessHeadline(f({ observedAt: NOW - 6 * 60_000 }), NOW), "Showing stale data");
  assert.equal(freshnessHeadline(f({ observedAt: NOW - 6 * 60_000, error: "x" }), NOW), "Showing stale data — refresh failing");
  assert.equal(freshnessHeadline(f({ error: "x" }), NOW), "Last refresh failed");
  assert.equal(freshnessHeadline(f({ completeness: "partial" }), NOW), "Partial data");
  assert.equal(freshnessHeadline(f({ completeness: "unknown" }), NOW), "Completeness unknown");
});

// The client contracts of this package (freshness banner, pin button, region filter) are .tsx, which Node can't load.
// A child process registers a small loader (TypeScript transpile for .tsx, "@/" and extensionless paths like Next)
// and renders them with react-dom/server.
const root = new URL("../../", import.meta.url);
const hooks = `
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from ${JSON.stringify(new URL("node_modules/typescript/lib/typescript.js", root).href)};
const SRC = ${JSON.stringify(new URL("src/", root).href)};
const file = (p) => existsSync(p) && !statSync(p).isDirectory();
export async function resolve(spec, ctx, next) {
  let target;
  if (spec.startsWith("@/")) target = new URL(spec.slice(2), SRC).href;
  else if ((spec.startsWith("./") || spec.startsWith("../")) && ctx.parentURL?.startsWith("file:")) target = new URL(spec, ctx.parentURL).href;
  else return next(spec, ctx);
  const p = fileURLToPath(target);
  if (file(p)) return { url: target, shortCircuit: true };
  for (const e of [".ts", ".tsx", "/index.ts", "/index.tsx"]) if (file(p + e)) return { url: pathToFileURL(p + e).href, shortCircuit: true };
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  if (!url.endsWith(".tsx")) return next(url, ctx);
  const source = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: fileURLToPath(url),
  }).outputText;
  return { format: "module", source, shortCircuit: true };
}`;
const register = `import { register } from "node:module"; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hooks)}`)});`;
const renderChild = (body: string) => {
  const out = execFileSync(process.execPath, ["--no-warnings", "--import", `data:text/javascript,${encodeURIComponent(register)}`, "--input-type=module", "-e", body], {
    encoding: "utf8",
    cwd: fileURLToPath(root),
    timeout: 60_000,
  });
  return JSON.parse(out.trim().split("\n").pop()!);
};

test("client contracts render: banner, stale badge, pin button, region helpers", () => {
  const src = (p: string) => JSON.stringify(new URL(`src/${p}`, root).href);
  const o = renderChild(`
const { createElement: h } = await import("react");
const { renderToString } = await import("react-dom/server");
const { SWRConfig } = await import("swr");
const { FreshnessBanner, StaleBadge } = await import(${src("components/freshness-banner.tsx")});
const pin = await import(${src("components/pin-button.tsx")});
const region = await import(${src("lib/client/region.tsx")});
const NOW = ${NOW};
const fresh = { observedAt: NOW - 60_000, staleAfterMs: 300_000, source: "sampler", completeness: "complete" };
const out = {};
const r = (el) => renderToString(el);
out.fresh = r(h(FreshnessBanner, { f: fresh, now: NOW }));
out.none = r(h(FreshnessBanner, { f: undefined, now: NOW }));
out.serverClock = r(h(FreshnessBanner, { f: { ...fresh, completeness: "partial" } }));
out.partial = r(h(FreshnessBanner, { f: { ...fresh, completeness: "partial", notes: ["2 sources denied"] }, now: NOW, onRetry: () => {} }));
out.compact = r(h(FreshnessBanner, { f: { ...fresh, observedAt: NOW - 600_000 }, now: NOW, compact: true }));
out.badgeFresh = r(h(StaleBadge, { f: fresh, now: NOW }));
out.badgeStale = r(h(StaleBadge, { f: { ...fresh, observedAt: undefined }, now: NOW }));
const withPins = (pins, el) => h(SWRConfig, { value: { provider: () => new Map(), fallback: { "/api/pins": pins } } }, el);
const props = { rkey: "ecs:service/acme-staging/api", name: "api", kind: "ecs-service", env: "staging" };
out.pinned = r(withPins({ pins: [{ ...props, createdAt: 1 }] }, h(pin.PinButton, props)));
out.unpinned = r(withPins({ pins: [] }, h(pin.PinButton, { ...props, size: "sm" })));
out.hidden = r(withPins(null, h(pin.PinButton, props)));
out.toggleOn = pin.togglePin({ pins: [{ rkey: "a", name: "a", kind: "k", createdAt: 1 }] }, { rkey: "b", name: "b", kind: "k" }, true, 5);
out.toggleOff = pin.togglePin(out.toggleOn, { rkey: "a", name: "a", kind: "k" }, false);
out.toggleTwice = pin.togglePin(out.toggleOn, { rkey: "b", name: "b", kind: "k" }, true, 6).pins.length;
const answer = (status, body) => async () => new Response(body === undefined ? "" : JSON.stringify(body), { status });
globalThis.fetch = answer(404); out.f404 = await pin.fetchPins("/api/pins");
globalThis.fetch = answer(401); out.f401 = await pin.fetchPins("/api/pins");
globalThis.fetch = answer(200, { pins: [{ rkey: "x", name: "x", kind: "k", createdAt: 1 }, null, { name: "no key" }] }); out.f200 = await pin.fetchPins("/api/pins");
globalThis.fetch = answer(200, { nope: 1 }); out.fShape = await pin.fetchPins("/api/pins");
globalThis.fetch = answer(500, { error: "x" }); out.f500 = await pin.fetchPins("/api/pins").then(() => "ok", (e) => e.message);
out.pick = [
  region.pickRegion("eu-west-1", null, ["ap-south-1", "eu-west-1"]),
  region.pickRegion("evil", "eu-west-1", ["ap-south-1", "eu-west-1"]),
  region.pickRegion(null, "gone-1", ["ap-south-1", "eu-west-1"]),
  region.pickRegion("eu-west-1", "eu-west-1", ["eu-west-1"]),
  region.pickRegion("all", "eu-west-1", ["ap-south-1", "eu-west-1"]),
];
out.labels = [region.regionLabel("all"), region.regionLabel("eu-west-1"), region.regionLabel("xx-new-9"), region.regionLabel("constructor")];
const Probe = () => { const f = region.useRegionFilter(); return h("i", null, JSON.stringify(f)); };
const withRegions = (v) => h(SWRConfig, { value: { provider: () => new Map(), fallback: { "/api/regions": v } } }, h(Probe));
out.oneRegion = r(withRegions({ home: "ap-south-1", regions: ["ap-south-1"], allEnabled: false }));
out.twoRegions = r(withRegions({ home: "ap-south-1", regions: ["ap-south-1", "eu-west-1"], allEnabled: false }));
console.log(JSON.stringify(out));`);
  const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
  assert.equal(o.fresh, "", "fresh and complete: nothing");
  assert.equal(o.none, "");
  assert.equal(o.serverClock, "", "the server's clock never decides (renders after hydration)");
  assert.match(o.partial, /role="status"/);
  assert.equal(text(o.partial), "Partial data · as of 14:04 UTC (1 min ago) · partial: 2 sources deniedRetry");
  assert.match(o.partial, /<button type="button"/);
  assert.match(o.compact, /role="status"[^>]*title="stale — as of 13:55 UTC \(10 min ago\)"/);
  assert.match(text(o.compact), /^Showing stale data/);
  assert.equal(o.badgeFresh, "");
  assert.match(text(o.badgeStale), /^age unknown/);
  assert.match(o.pinned, /aria-pressed="true"/);
  assert.match(o.pinned, /aria-label="Pin api"/, "a toggle keeps its name; aria-pressed carries the state");
  assert.match(o.pinned, /title="Unpin api"/);
  assert.match(o.pinned, /fill="currentColor"/);
  assert.match(o.unpinned, /aria-pressed="false"/);
  assert.match(o.unpinned, /aria-label="Pin api"/);
  assert.equal(o.hidden, "", "no pins API (404/401) → no star");
  assert.deepEqual(o.toggleOn.pins.map((p: { rkey: string }) => p.rkey), ["b", "a"]);
  assert.equal(o.toggleOn.pins[0].createdAt, 5);
  assert.deepEqual(o.toggleOff.pins.map((p: { rkey: string }) => p.rkey), ["b"]);
  assert.equal(o.toggleTwice, 2, "never pinned twice");
  assert.equal(o.f404, null);
  assert.equal(o.f401, null);
  assert.deepEqual(o.f200, { pins: [{ rkey: "x", name: "x", kind: "k", createdAt: 1 }] });
  assert.equal(o.fShape, null);
  assert.equal(o.f500, "HTTP 500");
  assert.deepEqual(o.pick, ["eu-west-1", "eu-west-1", "all", "all", "all"]);
  assert.deepEqual(o.labels, ["All regions", "eu-west-1 · Ireland", "xx-new-9", "constructor"]);
  assert.deepEqual(JSON.parse(text(o.oneRegion).replace(/&quot;/g, '"')), { region: "all", regions: ["ap-south-1"], multi: false });
  assert.deepEqual(JSON.parse(text(o.twoRegions).replace(/&quot;/g, '"')), { region: "all", regions: ["ap-south-1", "eu-west-1"], multi: true });
});

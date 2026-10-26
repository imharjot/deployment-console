import { test } from "node:test";
import assert from "node:assert/strict";
import { renderChild, srcUrl } from "../../lib/render-tsx.ts";

// Inside environment lanes the overview (mid) labels used to drop the environment's word: production's
// acme-production-pg and staging's acme-staging-pg both read "acme-pg". A chip shows the real name at every zoom.
test("map chips keep the real name in an environment lane, at every level of detail", () => {
  const o = renderChild(`
const { createElement: h } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { NodeChip } = await import(${srcUrl("components/map/chips.tsx")});
const handlers = { onActivate() {}, onKey() {}, onFocus() {}, onBlur() {}, onHover() {}, register() {} };
const chip = (name, env, lod) => {
  const key = "rds:" + name;
  const n = { id: key, key, type: "resource", kind: "rds", category: "data", lane: env, x: 0, y: 0, w: 216, h: 64, order: 0 };
  const r = { key, kind: "rds", provider: "rds", name, region: "us-east-1", env, tags: {}, health: "ok", props: [] };
  // lanes: the flag graph.tsx passed in environment lanes while labels were shortened there.
  return renderToStaticMarkup(h(NodeChip, { n, r, lod, hot: false, match: false, ctx: false, selected: false, showEnv: false, envLabel: env === "production" ? "Production" : "Staging", lanes: true, dupe: false, h: handlers }));
};
const text = (html) => html.replace(/<[^>]+>/g, "");
console.log(JSON.stringify({
  prodMid: text(chip("acme-production-pg", "production", "mid")),
  stagingMid: text(chip("acme-staging-pg", "staging", "mid")),
  prodFull: text(chip("acme-production-pg", "production", "full")),
}));`);
  assert.equal(o.prodMid, "acme-production-pg");
  assert.equal(o.stagingMid, "acme-staging-pg");
  assert.match(o.prodFull, /^acme-production-pg/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderChild, srcUrl } from "../../lib/render-tsx.ts";

// The shell polls /api/envs and /api/issues on every page. Widgets read them from the shell's cache entry (one request
// per poll) instead of their own ["dash", url] entry, which fetched each URL a second time in the same second.
test("useApi: the shell's polled URLs come from its entry, everything else from the widget's own", () => {
  const o = renderChild(`
const { createElement: h } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { SWRConfig, unstable_serialize } = await import("swr");
const { useApi } = await import(${srcUrl("components/dashboards/data.ts")});
const { SHELL_POLLED } = await import(${srcUrl("lib/client/env.tsx")});
const fallback = {
  "/api/envs": [{ id: "production" }],
  "/api/issues": [{ key: "api" }],
  [unstable_serialize(["dash", "/api/envs"])]: { value: "a second copy", at: 1 },
  [unstable_serialize(["dash", "/api/costs"])]: { value: { total: 1 }, at: 1 },
};
const Probe = ({ url }) => h("i", null, JSON.stringify(useApi(url, 15_000).data ?? null));
const read = (url) => renderToStaticMarkup(h(SWRConfig, { value: { provider: () => new Map(), fallback } }, h(Probe, { url }))).replace(/<\\/?i>/g, "").replace(/&quot;/g, '"');
const out = { envs: read("/api/envs"), issues: read("/api/issues"), costs: read("/api/costs") };
globalThis.fetch = async () => new Response(JSON.stringify({ not: "a list" }), { status: 200 });
out.shaped = await SHELL_POLLED["/api/envs"]("/api/envs").then(() => "accepted", (e) => e.status);
console.log(JSON.stringify(out));`);
  assert.equal(o.envs, '[{"id":"production"}]', "the shell's /api/envs entry");
  assert.equal(o.issues, '[{"key":"api"}]', "the shell's /api/issues entry");
  assert.equal(o.costs, '{"total":1}', "any other URL keeps the widget's own entry");
  assert.equal(o.shaped, 502, "a shared read uses the shell's fetcher, which refuses a body of the wrong shape");
});

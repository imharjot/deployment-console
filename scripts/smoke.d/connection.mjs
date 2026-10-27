// Settings → AWS connection on the simulated account: the page's API answers, a test of the simulated account passes
// without touching AWS, keys are never accepted, a save the console can't use changes nothing, and a write from a page
// loaded before a switch is refused. It never sends a save that could succeed: a switch to a real account in the middle
// of the suite would hand the rest of it real actions.
export default async function connectionSmoke({ get, post, call, check, BASE }) {
  const v = (await get("/api/connection")).json;
  check("connection: GET reports the simulated account and the profiles it can see", v?.source === "mock" && Array.isArray(v?.profiles), JSON.stringify(v?.from ?? v));
  const t = await post("/api/connection/test", { source: "mock" });
  check("connection: testing the simulated account passes without AWS", t.status === 200 && t.json?.ok === true && t.json?.identity?.account === "123456789012", JSON.stringify(t.json));
  const keys = await post("/api/connection/test", { source: "aws", signIn: { kind: "keys", accessKeyId: "AKIAIOSFODNN7EXAMPLE" } });
  check("connection: keys are never accepted", keys.status === 400, JSON.stringify(keys.json));
  const bad = await call("PUT", "/api/connection", { source: "aws", signIn: { kind: "profile", profile: "smoke-no-such-profile" } });
  check("connection: a save the console can't use is refused", bad.status === 400 || bad.status === 409, `${bad.status} ${JSON.stringify(bad.json)}`);
  check("connection: still the simulated account", (await get("/api/connection")).json?.source === "mock");

  // A page loaded before a switch sends the token GET /api/me gave it then: its write is refused (409) before the route
  // runs, so nothing changes; with the page's current token the same kind of write goes through.
  const token = (await get("/api/me")).json?.connection;
  check("connection: GET /api/me hands the page its connection token", typeof token === "string", JSON.stringify(token));
  const headers = (t) => ({ "content-type": "application/json", "x-console-csrf": "1", origin: BASE, "x-console-connection": t });
  const cluster = (await get("/api/envs")).json?.find?.((e) => e.id === "staging")?.cluster;
  const marker = `stale-page-${Date.now().toString(36)}`;
  const stale = await call("POST", "/api/notes", { key: `ecs:service/${cluster}/api`, body: `${marker} written from a page loaded before a switch`, env: "staging" }, headers(`${token}-before-a-switch`));
  check("connection: a write from a page loaded before a switch is refused", stale.status === 409 && stale.json?.code === "connection_changed", `${stale.status} ${JSON.stringify(stale.json)}`);
  const after = await get("/api/notes?env=staging");
  check("connection: ... and changed nothing", after.status === 200 && Array.isArray(after.json?.notes) && !JSON.stringify(after.json.notes).includes(marker));
  const current = await call("POST", "/api/connection/test", { source: "mock" }, headers(token));
  check("connection: with the page's current token a write goes through", current.status === 200 && current.json?.ok === true, `${current.status}`);
}

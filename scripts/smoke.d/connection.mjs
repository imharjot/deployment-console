// Settings → AWS connection on the simulated account: the page's API answers, a test of the simulated account passes
// without touching AWS, keys are never accepted, and a save the console can't use changes nothing. It never sends a
// save that could succeed: a switch to a real account in the middle of the suite would hand the rest of it real actions.
export default async function connectionSmoke({ get, post, call, check }) {
  const v = (await get("/api/connection")).json;
  check("connection: GET reports the simulated account and the profiles it can see", v?.source === "mock" && Array.isArray(v?.profiles), JSON.stringify(v?.from ?? v));
  const t = await post("/api/connection/test", { source: "mock" });
  check("connection: testing the simulated account passes without AWS", t.status === 200 && t.json?.ok === true && t.json?.identity?.account === "123456789012", JSON.stringify(t.json));
  const keys = await post("/api/connection/test", { source: "aws", signIn: { kind: "keys", accessKeyId: "AKIAIOSFODNN7EXAMPLE" } });
  check("connection: keys are never accepted", keys.status === 400, JSON.stringify(keys.json));
  const bad = await call("PUT", "/api/connection", { source: "aws", signIn: { kind: "profile", profile: "smoke-no-such-profile" } });
  check("connection: a save the console can't use is refused", bad.status === 400 || bad.status === 409, `${bad.status} ${JSON.stringify(bad.json)}`);
  check("connection: still the simulated account", (await get("/api/connection")).json?.source === "mock");
}

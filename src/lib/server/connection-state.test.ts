import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const mod = (f: string) => JSON.stringify(new URL(f, import.meta.url).href);

// One process, like a console: a switch (bumpGeneration) while a call, a cache fill and a Cloud of the previous
// connection are still around.
const scenario = `
const st = await import(${mod("./connection-state.ts")});
const { limitedClient } = await import(${mod("./aws-limiter.ts")});
const { cached } = await import(${mod("./cache.ts")});
const { getEventListeners } = await import("node:events");
const out = {};

// Like an SDK v3 client: config.serviceId, config.region as a provider, send(command, { abortSignal }).
const fake = (ms) => ({
  config: { serviceId: "ECS", region: async () => "us-east-1" },
  async send(command, options) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      options?.abortSignal?.addEventListener("abort", () => (clearTimeout(t), reject(options.abortSignal.reason)), { once: true });
    });
    return { $metadata: { attempts: 1 }, command };
  },
});

// A finished call leaves nothing on the connection's long-lived signal (one entry per call would leak).
const quick = limitedClient(fake(1), "ecs", "us-east-1");
await Promise.all(Array.from({ length: 50 }, () => quick.send("DescribeClusters")));
out.listenersAfterCalls = getEventListeners(st.connectionState().ctrl.signal, "abort").length;

globalThis.__consoleCloud = Promise.resolve("previous connection's Cloud");
globalThis.__consoleInventory = { version: 1 };
let resets = 0;
st.onConnectionChange("test", () => resets++);
st.onConnectionChange("test", () => resets++); // the other bundle's copy registers under the same name
st.onConnectionChange("broken", () => { throw new Error("a broken reset must not stop the others"); });

const client = limitedClient(fake(400), "ecs", "us-east-1");
const inflight = client.send("ListClusters").then(() => "answered", (e) => e.name);
let release;
const fill = cached("k", 60_000, () => new Promise((r) => (release = r)));
const cloud = st.retire({ kind: "aws", async clusters() { return ["old"]; } });
let made = 0;
const perGen = st.perGeneration(() => ++made);
perGen();
perGen();

console.error = () => {}; // the broken reset's log line
out.gen = st.bumpGeneration();
release("previous connection's value");
out.fill = (await fill).value;
out.afterFill = (await cached("k", 60_000, async () => "new connection's value")).value;
out.inflight = await inflight;
out.oldClient = await client.send("ListClusters").then(() => "sent", (e) => e.name);
out.newClient = await limitedClient(fake(1), "ecs", "us-east-1").send("ListClusters").then(() => "sent", (e) => e.name);
try {
  await cloud.clusters();
  out.oldCloud = "called";
} catch (e) {
  out.oldCloud = e.name + " " + e.status;
}
out.cloudKind = cloud.kind;
perGen();
out.made = made;
out.resets = resets;
out.dropped = !("__consoleCloud" in globalThis) && !("__consoleInventory" in globalThis);

// A read refused because the connection changed isn't remembered as a failure: the next caller asks again.
let calls = 0;
await cached("j", 60_000, async () => { calls++; throw Object.assign(new Error("changed"), { name: "ConnectionChangedError" }); }).catch(() => {});
out.retried = (await cached("j", 60_000, async () => (calls++, "ok"))).value + " after " + calls;
process.stdout.write(JSON.stringify(out));
`;

test("a connection switch retires the previous generation: its calls, cache fills, Clouds and per-generation values", () => {
  const out = JSON.parse(execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", scenario], { encoding: "utf8", timeout: 60_000, env: { ...process.env, CONSOLE_AWS_CONCURRENCY: "" } }));
  assert.equal(out.listenersAfterCalls, 0, "no listener stays on the switch signal once a call settles");
  assert.equal(out.gen, 1);
  assert.equal(out.fill, "previous connection's value", "whoever waited still gets the answer");
  assert.equal(out.afterFill, "new connection's value", "but it was never stored");
  assert.equal(out.inflight, "ConnectionChangedError", "a call in flight is aborted");
  assert.equal(out.oldClient, "ConnectionChangedError", "the previous connection's client refuses to send");
  assert.equal(out.newClient, "sent");
  assert.equal(out.oldCloud, "ConnectionChangedError 503");
  assert.equal(out.cloudKind, "aws", "plain properties still read");
  assert.equal(out.made, 2, "rebuilt once for the new generation");
  assert.equal(out.resets, 1, "one reset per module name, and a broken one doesn't stop the rest");
  assert.equal(out.dropped, true);
  assert.equal(out.retried, "ok after 2");
});

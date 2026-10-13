import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { invalidate } from "./cache.ts";

// Two copies of probes.ts, the way Next loads one for the sampler (instrumentation) and one for the routes.
const path = new URL("./probes.ts", import.meta.url).href;
const a = (await import(`${path}?a`)) as typeof import("./probes.ts");
const b = (await import(`${path}?b`)) as typeof import("./probes.ts");

async function server(statuses: number[]) {
  const hits: string[] = [];
  const srv = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(statuses.shift() ?? 200).end();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/healthz`;
  return { url, hits, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

test("F30: two module copies share one failure counter; a pass seen by either resets it", async () => {
  const s = await server([500, 200, 500]);
  try {
    const r1 = await a.probe(s.url);
    assert.deepEqual([r1.pass, r1.status, r1.consecutiveFailures], [false, 500, 1]);
    invalidate("probe:");
    const r2 = await b.probe(s.url);
    assert.deepEqual([r2.pass, r2.status, r2.consecutiveFailures], [true, 200, 0], "the other copy sees the same URL pass");
    invalidate("probe:");
    const r3 = await a.probe(s.url);
    // With a counter per module copy, `a` still remembered its own 1 and reported 2 (failing) here.
    assert.deepEqual([r3.pass, r3.status, r3.consecutiveFailures], [false, 500, 1], "the pass reset the shared count");
    assert.equal(s.hits.length, 3);
  } finally {
    invalidate("probe:");
    await s.close();
  }
});

test("F30: failures in either copy add up, and a count older than 60 s starts again", async (t) => {
  const s = await server([500, 500, 500]);
  try {
    assert.equal((await a.probe(s.url)).consecutiveFailures, 1);
    invalidate("probe:");
    assert.equal((await b.probe(s.url)).consecutiveFailures, 2, "the sampler's failure and a route's failure are consecutive");
    invalidate("probe:");
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 61_000 });
    assert.equal((await a.probe(s.url)).consecutiveFailures, 1, "stale count reset");
  } finally {
    t.mock.timers.reset();
    invalidate("probe:");
    await s.close();
  }
});

test("F33: health-check URLs are http(s) only, at most 2,048 characters, and never reach link-local addresses", async () => {
  const { probeUrlProblem, probe } = a;
  assert.equal(probeUrlProblem("https://api.staging.acme.dev/healthz"), null);
  assert.match(probeUrlProblem("file:///etc/passwd")!, /http\(s\)/);
  assert.match(probeUrlProblem("gopher://x/")!, /http\(s\)/);
  assert.match(probeUrlProblem("not a url")!, /not a valid URL/);
  assert.match(probeUrlProblem(`https://acme.dev/${"x".repeat(2_048)}`)!, /2048|2,048/);
  assert.match(probeUrlProblem("https://user:pw@acme.dev/")!, /credentials/);
  for (const url of ["http://169.254.169.254/latest/meta-data/", "http://[::ffff:a9fe:aa02]/v4/credentials", "http://[64:ff9b::169.254.169.254]/"]) {
    const r = await probe(url);
    assert.equal(r.pass, false, url);
    assert.match(r.error ?? "", /link-local/, url);
  }
  const bad = await probe("file:///etc/passwd");
  assert.deepEqual([bad.pass, bad.error], [false, "health-check URL must be http(s)"]);
  invalidate("probe:");
});

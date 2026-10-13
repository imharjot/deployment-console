import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, attempt, classifyError, completeness, covered, isFresh, orderRegions, planRuns, resourceRegion, scopeOf, slots, truncatedBy, unreadableTypes, type RunOutcome, type Schedulable } from "./schedule.ts";
import type { RegionStatus, Resource } from "./types.ts";

// The providers as they are registered today (wave A): the built ones declare no scope (fallback tables decide), the
// stubs declare theirs.
const TODAY: Schedulable[] = [
  { id: "ecs" }, { id: "elb" }, { id: "rds" }, { id: "elasticache" }, { id: "ecs-image" },
  { id: "ec2" }, { id: "asg" }, { id: "eks" }, { id: "apprunner" }, { id: "beanstalk" },
  { id: "lambda" }, { id: "sqs" }, { id: "sns" }, { id: "eventbridge" }, { id: "stepfunctions" }, { id: "kinesis" }, { id: "dynamodb" }, { id: "apigateway" },
  { id: "s3" }, { id: "cloudfront", global: true }, { id: "route53", global: true }, { id: "cloudflare", global: true },
  { id: "declared", global: true },
  { id: "vpc", scope: "regional" }, { id: "iam", scope: "global", homeRegion: "us-east-1" }, { id: "globalaccelerator", scope: "global", homeRegion: "us-west-2" },
  { id: "catchall", scope: "regional" },
];

test("scopes: declared scope wins, then the wave-A fallback tables, then global: true, else regional", () => {
  assert.equal(scopeOf({ id: "ecs" }), "home");
  assert.equal(scopeOf({ id: "declared", global: true }), "home");
  assert.equal(scopeOf({ id: "s3" }), "global");
  assert.equal(scopeOf({ id: "cloudfront", global: true }), "global");
  assert.equal(scopeOf({ id: "lambda" }), "regional");
  assert.equal(scopeOf({ id: "rds", scope: "regional" }), "regional", "wave B makes rds regional by declaring it");
  assert.equal(scopeOf({ id: "custom", global: true }), "global");
});

test("one region gives exactly today's run set: every provider once, in home (global ones in their homeRegion)", () => {
  for (const mock of [false, true]) {
    const runs = planRuns(TODAY, ["ap-south-1"], "ap-south-1", mock);
    assert.deepEqual(runs.map((r) => r.id), TODAY.map((p) => p.id), "one run per provider, in provider order");
    assert.ok(runs.every((r) => r.phase === 1), "nothing waits for a second phase");
    assert.deepEqual(
      runs.filter((r) => r.region !== "ap-south-1").map((r) => r.key),
      ["iam@us-east-1", "globalaccelerator@us-west-2"],
      "only global providers with their own homeRegion run elsewhere",
    );
  }
  // No regions configured at all is the same as [home].
  assert.deepEqual(planRuns(TODAY, [], "us-east-1", false), planRuns(TODAY, ["us-east-1"], "us-east-1", false));
});

test("several regions: regional per region (home first), home and global once; others are phase 2", () => {
  const runs = planRuns(TODAY, ["eu-west-1", "us-east-1", "eu-west-1"], "us-east-1", false);
  const keys = runs.map((r) => r.key);
  assert.ok(keys.includes("lambda@us-east-1") && keys.includes("lambda@eu-west-1"));
  assert.ok(keys.indexOf("lambda@us-east-1") < keys.indexOf("lambda@eu-west-1"), "home before the other regions");
  for (const id of ["ecs", "elb", "rds", "elasticache", "ecs-image", "declared", "s3", "cloudfront", "route53", "cloudflare", "iam", "globalaccelerator"])
    assert.equal(runs.filter((r) => r.id === id).length, 1, `${id} runs once`);
  assert.equal(runs.find((r) => r.id === "ecs")?.region, "us-east-1");
  assert.equal(runs.find((r) => r.id === "s3")?.region, "us-east-1");
  assert.equal(new Set(keys).size, keys.length, "run keys are unique");
  assert.deepEqual(runs.filter((r) => r.phase === 2).map((r) => r.region).filter((x, i, a) => a.indexOf(x) === i), ["eu-west-1"]);
  assert.ok(runs.filter((r) => r.region === "us-east-1").every((r) => r.phase === 1));
  assert.equal(runs.find((r) => r.key === "iam@us-east-1")?.phase, 1, "global runs are published with home");
});

test("mock mode: a regional provider leaves home only with multiRegionMock (no second copy of Acme)", () => {
  const providers: Schedulable[] = [{ id: "lambda" }, { id: "vpc", scope: "regional", multiRegionMock: true }, { id: "kms", scope: "regional", multiRegionMock: false }];
  assert.deepEqual(planRuns(providers, ["us-east-1", "eu-west-1"], "us-east-1", true).map((r) => r.key), ["lambda@us-east-1", "vpc@us-east-1", "vpc@eu-west-1", "kms@us-east-1"]);
  assert.deepEqual(planRuns(providers, ["us-east-1", "eu-west-1"], "us-east-1", false).map((r) => r.key), ["lambda@us-east-1", "lambda@eu-west-1", "vpc@us-east-1", "vpc@eu-west-1", "kms@us-east-1", "kms@eu-west-1"]);
});

test("orderRegions: home first, de-duplicated, empties dropped", () => {
  assert.deepEqual(orderRegions(["eu-west-1", "", "us-east-1", "eu-west-1"], "us-east-1"), ["us-east-1", "eu-west-1"]);
});

test("classifyError: denied, skipped (region not enabled / service not offered) or error", () => {
  const err = (name: string, message = "", extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { name, ...extra });
  assert.equal(classifyError(err("AccessDeniedException", "User: x is not authorized to perform: lambda:ListFunctions")), "denied");
  assert.equal(classifyError(err("AccessDeniedException", "... with an explicit deny in a service control policy")), "denied");
  assert.equal(classifyError(err("UnauthorizedOperation", "You are not authorized to perform this operation.")), "denied");
  assert.equal(classifyError(err("Error", "getaddrinfo ENOTFOUND apprunner.ap-east-1.amazonaws.com", { code: "ENOTFOUND" })), "skipped");
  assert.equal(classifyError(err("TypeError", "fetch failed", { cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND x" } })), "skipped");
  assert.equal(classifyError(err("UnknownEndpoint", "Inaccessible host")), "skipped");
  assert.equal(classifyError(err("InvalidRequestException", "This operation is not supported in this region")), "skipped");
  assert.equal(classifyError(err("OptInRequired", "You are not subscribed to this service")), "skipped");
  // Not-enabled opt-in regions answer with token errors; in the home region those are real credential problems.
  assert.equal(classifyError(err("UnrecognizedClientException", "The security token included in the request is invalid.")), "skipped");
  assert.equal(classifyError(err("InvalidClientTokenId", "The security token included in the request is invalid.")), "skipped");
  assert.equal(classifyError(err("InvalidClientTokenId", "The security token included in the request is invalid."), { home: true }), "error");
  // A provider × region that listed resources before can't have become "not offered": DNS or the network is down.
  // That's an error (the last good list is kept), never a skip that empties the map and calls it complete.
  assert.equal(classifyError(err("Error", "getaddrinfo ENOTFOUND lambda.eu-west-1.amazonaws.com", { code: "ENOTFOUND" }), { listedBefore: true }), "error");
  assert.equal(classifyError(err("UnrecognizedClientException", "The security token included in the request is invalid."), { listedBefore: true }), "error");
  assert.equal(classifyError(err("AccessDeniedException", "User: x is not authorized to perform: lambda:ListFunctions"), { listedBefore: true }), "denied");
  assert.equal(classifyError(err("ThrottlingException", "Rate exceeded")), "error");
  assert.equal(classifyError(err("TimeoutError", "discovery timed out after 25 s")), "error");
  assert.equal(classifyError(undefined), "error");
  assert.equal(classifyError("boom"), "error");
});

const run = (o: Partial<RunOutcome> & Pick<RunOutcome, "id" | "region">): RunOutcome => ({ state: "ok", ...o });

test("covered: types of runs that are ok, of this build, not cut short and not capped", () => {
  const set = covered([
    run({ id: "lambda", region: "us-east-1", covers: ["lambda:function"] }),
    run({ id: "lambda", region: "eu-west-1", covers: ["lambda:function"], state: "denied" }),
    run({ id: "sqs", region: "us-east-1", covers: ["sqs:queue"], partial: true }),
    run({ id: "sns", region: "us-east-1", covers: ["sns:topic"], truncated: true }),
    run({ id: "s3", region: "us-east-1", covers: ["s3:bucket"], stale: true }),
    run({ id: "elb", region: "us-east-1", covers: ["elasticloadbalancing:loadbalancer/app", "elasticloadbalancing:loadbalancer/net"] }),
    run({ id: "ecs", region: "us-east-1" }),
  ]);
  assert.deepEqual([...set].sort(), ["elasticloadbalancing:loadbalancer/app@us-east-1", "elasticloadbalancing:loadbalancer/net@us-east-1", "lambda:function@us-east-1"]);
});

test("unreadableTypes: the types of denied or failed runs, per region, with the refused actions", () => {
  assert.deepEqual(unreadableTypes([
    run({ id: "lambda", region: "us-east-1", covers: ["lambda:function"] }),
    run({ id: "lambda", region: "eu-west-1", covers: ["lambda:function"], state: "denied", missing: ["lambda:ListFunctions"] }),
    run({ id: "sqs", region: "us-east-1", covers: ["sqs:queue"], state: "error" }),
    run({ id: "sns", region: "eu-west-1", covers: ["sns:topic"], state: "skipped" }),
  ]), {
    "lambda:function@eu-west-1": "lambda couldn't read it (lambda:ListFunctions)",
    "sqs:queue@us-east-1": "sqs couldn't read it (error)",
  });
});

test("completeness: outcome counts, capped types, denied actions, stale runs, enrichment gaps and lastCompleteAt", () => {
  const runs = [
    run({ id: "lambda", region: "us-east-1", covers: ["lambda:function"], truncated: true }),
    run({ id: "lambda", region: "eu-west-1", state: "denied", missing: ["lambda:ListFunctions"] }),
    run({ id: "sqs", region: "us-east-1", partial: true }),
    run({ id: "apprunner", region: "eu-west-1", state: "skipped" }),
    run({ id: "cloudflare", region: "us-east-1", state: "disabled" }),
    run({ id: "logs", region: "eu-west-1", state: "error", stale: true }),
    run({ id: "ecs", region: "us-east-1" }),
  ];
  const c = completeness(runs, { resources: [{ enrichment: { tags: "ok", policy: "denied" } }, { enrichment: { tags: "capped" } }, {}], generatedAt: 2000, lastCompleteAt: 1000, unresolvedRefs: 3 });
  assert.deepEqual(c, {
    lastCompleteAt: 1000,
    providers: { ok: 1, denied: 1, error: 1, skipped: 1, disabled: 1, partial: 1 }, // lambda once: denied (its worst run)
    cappedTypes: ["lambda:function@us-east-1"],
    deniedActions: ["lambda:ListFunctions"],
    staleProviders: ["logs@eu-west-1"],
    unresolvedRefs: 3,
    enrichmentSkipped: 2,
  });
  // Every enabled run ok (skipped and disabled don't count against it): this build is the last complete one.
  const ok = completeness([run({ id: "ecs", region: "us-east-1" }), run({ id: "apprunner", region: "eu-west-1", state: "skipped" }), run({ id: "cloudflare", region: "us-east-1", state: "disabled" })], { resources: [], generatedAt: 5000, lastCompleteAt: 1000 });
  assert.equal(ok.lastCompleteAt, 5000);
  assert.equal(ok.unresolvedRefs, 0);
  // …unless regions are still pending.
  assert.equal(completeness([run({ id: "ecs", region: "us-east-1" })], { resources: [], generatedAt: 5000, pendingRegions: ["eu-west-1"] }).lastCompleteAt, undefined);
  // A capped run without covers is reported by provider.
  assert.deepEqual(completeness([run({ id: "ecs", region: "us-east-1", truncated: true })], { resources: [], generatedAt: 1 }).cappedTypes, ["ecs@us-east-1"]);
});

test("completeness counts providers, not runs: one row per provider at its worst run", () => {
  const regions = ["us-east-1", "eu-west-1", "ap-south-1"];
  const c = completeness(
    [
      ...regions.map((region) => run({ id: "vpc", region, state: "disabled" })), // a stub registered in every region
      ...regions.map((region) => run({ id: "kms", region, state: "denied", missing: ["kms:ListKeys"] })), // one missing permission
      run({ id: "lambda", region: "us-east-1" }), run({ id: "lambda", region: "eu-west-1", state: "skipped" }), run({ id: "lambda", region: "ap-south-1", partial: true }),
      run({ id: "apprunner", region: "us-east-1", state: "skipped" }), run({ id: "apprunner", region: "eu-west-1" }),
    ],
    { resources: [], generatedAt: 1 },
  );
  assert.deepEqual(c.providers, { ok: 1, denied: 1, error: 0, skipped: 0, disabled: 1, partial: 1 });
  assert.deepEqual(c.deniedActions, ["kms:ListKeys"]);
});

test("resourceRegion: key suffix or ARN region, else the resource's region, else home", () => {
  const home = "us-east-1";
  assert.equal(resourceRegion({ key: "ecs:service/acme-production/api@eu-west-1", region: "eu-west-1" }, home), "eu-west-1");
  assert.equal(resourceRegion({ key: "ecs:service/acme-production/api", region: "us-east-1" }, home), "us-east-1");
  assert.equal(resourceRegion({ key: "arn:aws:lambda:eu-west-1:123456789012:function:acme-orders", region: "eu-west-1" }, home), "eu-west-1");
  assert.equal(resourceRegion({ key: "arn:aws:lambda:eu-west-1:123456789012:function:acme-orders", region: "us-east-1" }, home), "eu-west-1", "the ARN wins over a wrong region field");
  assert.equal(resourceRegion({ key: "arn:aws:s3:::acme-production-assets-eu", region: "eu-west-1" }, home), "eu-west-1", "S3 ARNs have no region: the bucket's own");
  assert.equal(resourceRegion({ key: "ec2:i-0acme0eu000000001", region: "eu-west-1" }, home), "eu-west-1", "a region-less console key from a regional provider");
  assert.equal(resourceRegion({ key: "arn:aws:iam::123456789012:role/acme-api", region: "global" }, home), home);
  assert.equal(resourceRegion({ key: "external:stripe", region: "global" }, home), home);
  assert.equal(resourceRegion({ key: "cloudflare:zone/abc", region: "" }, home), home);
});

// ---------- running ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("slots: never more than n at a time, FIFO, and a waiter whose signal fires never starts", async () => {
  const run = slots(2);
  let active = 0, peak = 0;
  const started: number[] = [];
  const task = (i: number) => async () => {
    started.push(i);
    active++;
    peak = Math.max(peak, active);
    await sleep(15);
    active--;
    return i;
  };
  const ac = new AbortController();
  const all = [run(task(1)), run(task(2)), run(task(3)), run(task(4), ac.signal), run(task(5))];
  ac.abort();
  const out = await Promise.allSettled(all);
  assert.equal(peak, 2);
  assert.deepEqual(started, [1, 2, 3, 5], "4 gave up while queued and never started");
  assert.equal(out[3].status, "rejected");
  assert.deepEqual(out.filter((x) => x.status === "fulfilled").map((x) => (x as PromiseFulfilledResult<number>).value), [1, 2, 3, 5]);
  // A slot frees up after a failure too.
  await assert.rejects(run(async () => { throw new Error("boom"); }));
  assert.equal(await run(async () => 7), 7);
  // Already aborted: refused without queueing.
  await assert.rejects(run(task(9), AbortSignal.abort()), /out of time/);
});

test("attempt: a fast run is done; the signal it got is aborted once it ends", async () => {
  let seen: AbortSignal | undefined;
  const a = await attempt({ what: "Lambda", deadlineMs: 1000, run: async (signal) => { seen = signal; return "listed"; } });
  assert.equal(a.kind, "done");
  assert.equal(a.kind === "done" && a.result, "listed");
  assert.equal(seen?.aborted, true, "whatever it left queued can't start any more");
});

test("attempt (R18): the deadline returns the last checkpoint, marked partial — not nothing, not an older copy", async () => {
  const a = await attempt<string[]>({
    what: "Lambda", deadlineMs: 40,
    run: async (signal, checkpoint) => {
      checkpoint(["fn-a", "fn-b"]); // the base list, before enrichment
      await sleep(500); // enrichment that never finishes in time
      checkpoint(["late"]);
      return ["never"];
    },
  });
  assert.equal(a.kind, "partial");
  assert.deepEqual(a.kind === "partial" && a.result, ["fn-a", "fn-b"]);
  assert.ok(a.ms >= 35 && a.ms < 400, `returned at the deadline (${a.ms} ms)`);
});

test("attempt: no checkpoint before the deadline → a timed-out failure; a checkpoint after it is ignored", async () => {
  const a = await attempt({ what: "SQS", deadlineMs: 30, run: async () => { await sleep(300); return 1; } });
  assert.equal(a.kind, "failed");
  assert.equal(a.kind === "failed" && a.timedOut, true);
  assert.match(String(a.kind === "failed" && (a.error as Error).message), /SQS timed out after 0 s/);
  const b = await attempt<number>({
    what: "SQS", deadlineMs: 20,
    run: async (signal, checkpoint) => {
      await sleep(60);
      checkpoint(1); // too late: the run was already cut
      return 2;
    },
  });
  assert.equal(b.kind, "failed");
});

test("attempt: errors are failures (not timeouts); `within` sees the run's signal, aborted at the deadline (R19)", async () => {
  const denied = await attempt({ what: "SNS", deadlineMs: 1000, run: async () => { throw Object.assign(new Error("not authorized to perform: sns:ListTopics"), { name: "AccessDenied" }); } });
  assert.equal(denied.kind, "failed");
  assert.equal(denied.kind === "failed" && denied.timedOut, false);

  let inner: AbortSignal | undefined;
  const nested = await attempt({
    what: "ECS", deadlineMs: 30,
    within: (signal, fn) => {
      inner = signal; // what withCallSignal() hands to every AWS call made inside
      return fn();
    },
    run: (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted by the deadline")))),
  });
  assert.equal(nested.kind, "failed");
  assert.equal(inner?.aborted, true, "nested Cloud calls are cancelled at the deadline");
});

test("isFresh: provider ttl, failures retried within 2 min, empty ok runs kept 30 min, forced and invalidated never", () => {
  const now = 10_000_000;
  const ok = { state: "ok" as const, count: 3, ranAt: now - 60_000 };
  assert.equal(isFresh(ok, undefined, now), true, "default ttl 2 min");
  assert.equal(isFresh({ ...ok, ranAt: now - 130_000 }, undefined, now), false);
  assert.equal(isFresh({ ...ok, ranAt: now - 9 * 60_000 }, 10 * 60_000, now), true, "a provider's own ttlMs (CC-10)");
  assert.equal(isFresh({ ...ok, count: 0, ranAt: now - 20 * 60_000 }, undefined, now), true, "an empty ok run: 30 min");
  assert.equal(isFresh({ ...ok, count: 0, ranAt: now - 31 * 60_000 }, undefined, now), false);
  assert.equal(isFresh({ ...ok, count: 0, partial: true, ranAt: now - 5 * 60_000 }, undefined, now), false, "a cut-short empty run isn't evidence of nothing");
  assert.equal(isFresh({ state: "error", count: 0, ranAt: now - 3 * 60_000 }, 30 * 60_000, now), false, "failures: at most 2 min");
  assert.equal(isFresh({ state: "denied", count: 0, ranAt: now - 60_000 }, 30 * 60_000, now), true);
  assert.equal(isFresh(ok, undefined, now, true), false, "forced");
  assert.equal(isFresh({ ...ok, rerun: true }, undefined, now), false, "invalidated or restored");
  assert.equal(isFresh(undefined, undefined, now), false);
});

test("truncatedBy: a kind at the cap, or a 'showing the first' note", () => {
  const r = (n: number) => ({ resources: Array.from({ length: n }, (_, i) => ({ kind: "lambda", key: `k${i}` }) as unknown as Resource), links: [], mentions: [] });
  assert.equal(truncatedBy(r(3), [], 3), true);
  assert.equal(truncatedBy(r(2), [], 3), false);
  assert.equal(truncatedBy(r(2), ["sqs: showing the first 2,000 queues"], 3), true);
});

const st = (o: Partial<RegionStatus> & { region: string }): RegionStatus => ({ state: "ok", count: 0, at: 1000, ...o });

test("aggregate: one run in home is exactly that run's status (today's single-region rows)", () => {
  const o = { home: "us-east-1", regions: ["us-east-1"] };
  const p = { id: "lambda", label: "Lambda" };
  assert.deepEqual(aggregate(p, [{ region: "us-east-1", status: st({ region: "us-east-1", count: 9, ms: 120 }) }], o), { id: "lambda", label: "Lambda", count: 9, at: 1000, state: "ok", ms: 120 });
  assert.deepEqual(
    aggregate(p, [{ region: "us-east-1", status: st({ region: "us-east-1", state: "denied", missing: ["lambda:ListFunctions"], error: "AccessDenied", ms: 50 }) }], o),
    { id: "lambda", label: "Lambda", count: 0, at: 1000, state: "denied", error: "AccessDenied", missing: ["lambda:ListFunctions"], ms: 50 },
  );
  assert.deepEqual(
    aggregate({ id: "vpc", label: "VPC" }, [{ region: "us-east-1", status: st({ region: "us-east-1", state: "disabled", error: "not implemented yet" }) }], o),
    { id: "vpc", label: "VPC", count: 0, at: 1000, state: "disabled", error: "not implemented yet" },
    "a planned provider keeps the exact text the UI recognises",
  );
});

test("aggregate: several regions — worst wins, errors name their region, per-region rows, skipped and SCP regions are notes", () => {
  const o = { home: "us-east-1", regions: ["us-east-1", "eu-west-1", "ap-east-1"] };
  const p = { id: "lambda", label: "Lambda" };
  const home = { region: "us-east-1", status: st({ region: "us-east-1", count: 9, ms: 100 }) };
  const eu = { region: "eu-west-1", status: st({ region: "eu-west-1", count: 2, ms: 300 }) };
  const ap = { region: "ap-east-1", status: st({ region: "ap-east-1", state: "skipped", error: "not available in ap-east-1" }) };
  const ok = aggregate(p, [home, eu, ap], o);
  assert.equal(ok.state, "ok");
  assert.equal(ok.count, 11);
  assert.equal(ok.ms, 300);
  assert.deepEqual(ok.regions?.map((r) => `${r.region}:${r.state}`), ["us-east-1:ok", "eu-west-1:ok", "ap-east-1:skipped"]);
  assert.deepEqual(ok.notes, ["skipped in ap-east-1: not available in ap-east-1"]);

  const euErr = { region: "eu-west-1", status: st({ region: "eu-west-1", state: "error", error: "ThrottlingException" }) };
  const err = aggregate(p, [home, euErr, ap], o);
  assert.equal(err.state, "error");
  assert.equal(err.error, "eu-west-1: ThrottlingException");

  const scp = { region: "eu-west-1", scp: true, status: st({ region: "eu-west-1", state: "denied", missing: ["lambda:ListFunctions"], error: "explicit deny in a service control policy" }) };
  const closed = aggregate(p, [home, scp], o);
  assert.equal(closed.state, "ok", "an SCP closing a region isn't a permission the console's role lacks");
  assert.equal(closed.missing, undefined);
  assert.deepEqual(closed.notes, ["denied in eu-west-1 by a service control policy"]);

  const iam = { region: "eu-west-1", status: st({ region: "eu-west-1", state: "denied", missing: ["lambda:ListFunctions"], error: "AccessDenied" }) };
  const den = aggregate(p, [home, iam], o);
  assert.equal(den.state, "denied");
  assert.deepEqual(den.missing, ["lambda:ListFunctions"]);

  const partial = aggregate(p, [home, { region: "eu-west-1", status: st({ region: "eu-west-1", count: 4, partial: true, error: "Lambda in eu-west-1: timed out after 25 s — showing what it listed before the cut" }) }], o);
  assert.equal(partial.state, "ok");
  assert.equal(partial.partial, true);
  assert.match(partial.error ?? "", /showing what it listed/);

  assert.equal(aggregate(p, [ap], o).state, "skipped", "skipped everywhere it ran");
});

test("aggregate: no runs yet (restart, nothing persisted): off providers stay disabled, others say they're being read", () => {
  const o = { home: "us-east-1", regions: ["us-east-1"] };
  assert.deepEqual(aggregate({ id: "vpc", label: "VPC" }, [], { ...o, off: "not implemented yet" }), { id: "vpc", label: "VPC", count: 0, at: 0, state: "disabled", error: "not implemented yet" });
  assert.equal(aggregate({ id: "lambda", label: "Lambda" }, [], o).state, "skipped");
});

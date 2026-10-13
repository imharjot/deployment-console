// Every AWS SDK client the server builds goes through the SDK-call limiter (R19, master plan decision 12): a
// `new <X>Client(` (or `<X>Client.from(`, the DynamoDB document client) under src/lib/server/ must sit inside a
// limitedClient(…), perRegion(…) or regional(…) call in the same expression. The agents' model adapters (agents/inference/) are exempt: they use a connection's own credentials, not
// the console's role. This test reads the files as text and imports no @aws-sdk package (iam-policy.test.ts treats
// every SDK-importing file under src/lib/server/ as a caller).
// The second half exercises aws-limiter.ts itself through a fake client, in a child process (it imports "server-only").
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

const SERVER = new URL("./", import.meta.url);
const EXEMPT = ["agents/inference/"];
const WRAPPERS = new Set(["limitedClient", "perRegion", "regional"]);

// Comments and string contents blanked (same length), so brackets and "new XClient(" inside them don't count.
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g, (m) =>
    m.startsWith("/") ? m.replace(/[^\n]/g, " ") : m[0] + m.slice(1, -1).replace(/[^\n]/g, " ") + m.at(-1),
  );
}

// Walks outward from `at` through the enclosing brackets until the statement ends: wrapped when one of them is the
// argument list of limitedClient / perRegion / regional.
export function wrappedAt(src: string, at: number): boolean {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const ch = src[i];
    if (ch === ")" || ch === "]" || ch === "}") depth++;
    else if (ch === "(" || ch === "[" || ch === "{") {
      if (depth > 0) {
        depth--;
        continue;
      }
      if (ch === "(") {
        const callee = /([A-Za-z_$][\w$]*)\s*(?:<[^()]*>)?\s*$/.exec(src.slice(Math.max(0, i - 80), i))?.[1];
        if (callee && WRAPPERS.has(callee)) return true;
      }
    } else if (ch === ";" && depth === 0) return false;
  }
  return false;
}

export function unwrappedClients(file: string, src: string): string[] {
  const text = code(src);
  const out: string[] = [];
  for (const m of text.matchAll(/\bnew\s+([A-Z][A-Za-z0-9]*Client)\s*\(|\b([A-Z][A-Za-z0-9]*Client)\.from\s*\(/g)) {
    const what = m[1] ? `new ${m[1]}(…)` : `${m[2]}.from(…)`;
    if (!wrappedAt(text, m.index)) out.push(`${file}:${text.slice(0, m.index).split("\n").length} ${what} is not passed through limitedClient / perRegion / regional`);
  }
  return out;
}

test("the scanner tells wrapped from unwrapped clients", () => {
  const ok = [
    `const lambda = perRegion((region) => new LambdaClient(sdkConfig(region)));`,
    `const ec2 = regional((region) => { return new EC2Client(sdkConfig(region)); }, "ec2");`,
    `const cf = limitedClient(new CloudFrontClient({ region: "us-east-1", ...retry }), "cloudfront", "us-east-1");`,
    `if (!c) clients.set(r, (c = limitedClient(new S3Client({ region: r }), "s3", r)));`,
    `const k = { ecs: limitedClient(new ECSClient(cfg(region))), ecr: limitedClient(new ECRClient(cfg(region))) };`,
    `// const old = new ECSClient(cfg);\nconst s = "new ECSClient(";`,
    `const doc = limitedClient(DynamoDBDocumentClient.from(new DynamoDBClient({})), "dynamodb", region);`,
  ];
  for (const src of ok) assert.deepEqual(unwrappedClients("f.ts", src), [], src);
  const bad = [
    `const ecs = new ECSClient(cfg);`,
    `const c = new STSClient({ region });\nexport const sts = limitedClient(c);`,
    `const elb = () => (elbClient ??= new ElasticLoadBalancingV2Client({ region: REGION }));`,
    `perRegion((r) => r);\nconst x = new SQSClient({});`,
    `const doc = DynamoDBDocumentClient.from(dynamo(region));`,
  ];
  for (const src of bad) assert.equal(unwrappedClients("f.ts", src).length, 1, src);
  assert.match(unwrappedClients("a/b.ts", "\n\nconst ecs = new ECSClient(cfg);")[0], /^a\/b\.ts:3 new ECSClient/);
});

test("every SDK client under src/lib/server/ goes through the SDK-call limiter", async () => {
  const files = (await readdir(SERVER, { recursive: true }))
    .map((f) => f.split("\\").join("/"))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !EXEMPT.some((d) => f.startsWith(d)))
    .sort();
  const found: string[] = [];
  for (const f of files) {
    const src = await readFile(new URL(f, SERVER), "utf8");
    if (src.includes("Client(")) found.push(...unwrappedClients(`src/lib/server/${f}`, src));
  }
  assert.deepEqual(found, [], `unbounded AWS SDK clients:\n${found.join("\n")}`);
});

// ---------- aws-limiter.ts through a fake SDK client ----------

const scenario = `
const { limitedClient, withCallSignal, currentCallSignal, awsCallStats, serviceName } = await import(${JSON.stringify(new URL("./aws-limiter.ts", import.meta.url).href)});
const out = {};
let running = 0, peak = 0;
const pending = [];
// Like an SDK v3 client: config.serviceId, config.region as a provider, send(command, { abortSignal }).
function fake(serviceId, region, ms) {
  return {
    config: { serviceId, region: async () => region },
    async send(command, options) {
      running++; peak = Math.max(peak, running);
      try {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, ms);
          options?.abortSignal?.addEventListener("abort", () => (clearTimeout(t), reject(options.abortSignal.reason)), { once: true });
        });
        if (command === "throttle") throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException", $metadata: { attempts: 3 } });
        return { $metadata: { attempts: 1 }, command };
      } finally { running--; }
    },
  };
}
out.names = ["Elastic Load Balancing v2", "CloudWatch Logs", "Route 53", "ECS", "Resource Groups Tagging API", "SFN"].map(serviceName);

// Defaults from the client: service id → name, configured region; wrapping twice is a no-op.
const logs = fake("CloudWatch Logs", "eu-west-1", 30);
const same = limitedClient(logs);
out.idempotent = limitedClient(same, "other") === logs && limitedClient(logs).send === same.send;
await Promise.all(Array.from({ length: 6 }, () => logs.send("q")));
out.logsPeak = peak; // logs: 2 per region
peak = 0;

// withCallSignal: queued calls never start once the caller's signal fires; in-flight ones abort.
const iam = limitedClient(fake("IAM", "us-east-1", 40)); // iam: 1 at a time
const ac = new AbortController();
const started = [];
const inner = withCallSignal(ac.signal, async () => {
  out.sees = currentCallSignal() !== undefined;
  return Promise.allSettled([1, 2, 3].map((i) => iam.send({ i }).then((r) => (started.push(i), r))));
});
setTimeout(() => ac.abort(new DOMException("provider deadline", "TimeoutError")), 10);
out.cancelled = (await inner).map((r) => r.status === "fulfilled" ? "ok" : r.reason.name);
out.startedAfterAbort = started;
out.outside = currentCallSignal() === undefined;

// A throttled call: counted, its retries counted as attempts.
const ecs = limitedClient(fake("ECS", "us-east-1", 1));
await ecs.send("ok");
await ecs.send("throttle").catch(() => {});
out.stats = awsCallStats().map(({ p95Ms, ...s }) => ({ ...s, hasP95: p95Ms >= 0 }));
process.stdout.write(JSON.stringify(out));
`;

test("limitedClient: service and region from the client, idempotent, per-service caps, withCallSignal cancels, stats", () => {
  const out = JSON.parse(execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", scenario], { encoding: "utf8", timeout: 60_000, env: { ...process.env, CONSOLE_AWS_CONCURRENCY: "" } }));
  assert.deepEqual(out.names, ["elasticloadbalancing", "logs", "route53", "ecs", "tag", "states"]);
  assert.equal(out.idempotent, true);
  assert.equal(out.logsPeak, 2, "CloudWatch Logs gets 2 slots per region");
  assert.equal(out.sees, true);
  assert.equal(out.outside, true);
  // The first call was in flight (aborted by the signal); the other two were queued behind iam's single slot and never started.
  assert.deepEqual(out.cancelled, ["TimeoutError", "TimeoutError", "TimeoutError"]);
  assert.deepEqual(out.startedAfterAbort, []);
  const row = (service: string) => out.stats.find((s: { service: string }) => s.service === service);
  assert.deepEqual(row("logs"), { service: "logs", region: "eu-west-1", requests: 6, attempts: 6, throttled: 0, errors: 0, active: 0, queued: 0, hasP95: true });
  assert.deepEqual(row("iam"), { service: "iam", region: "us-east-1", requests: 1, attempts: 1, throttled: 0, errors: 1, active: 0, queued: 0, hasP95: true }, "only the in-flight call reached AWS");
  assert.deepEqual(row("ecs"), { service: "ecs", region: "us-east-1", requests: 2, attempts: 4, throttled: 1, errors: 1, active: 0, queued: 0, hasP95: true });
});

// What calls teach: capability.ts hears each call's action (from the command's schema) and remembers refusals and
// successes of the actions console writes need; a write aborted after it was sent is outcome unknown, a read is not;
// outsideCallSignal() runs shared work free of the caller's deadline.
const observed = `
const lim = await import(${JSON.stringify(new URL("./aws-limiter.ts", import.meta.url).href)});
const cap = await import(${JSON.stringify(new URL("./capability.ts", import.meta.url).href)});
const { isOutcomeUnknown } = await import(${JSON.stringify(new URL("./errors.ts", import.meta.url).href)});
const out = {};
// SDK v3 commands carry [kind, namespace, operation, …] in .schema; plain objects fall back to the class name.
const cmd = (op) => ({ schema: [9, "com.amazonaws.x", op], input: {} });
class UpdateServiceCommand { constructor() { this.input = {}; } }
out.ops = [lim.operationOf(cmd("UpdateService")), lim.operationOf(new UpdateServiceCommand()), lim.operationOf("x"), lim.operationOf({})];
const denied = (msg) => Object.assign(new Error(msg), { name: "AccessDeniedException" });
function fake(serviceId, behave) {
  return { config: { serviceId, region: "eu-west-1" }, async send(command, options) { return behave(command, options); } };
}
const ROLE = "User: arn:aws:sts::123456789012:assumed-role/acme-console/s is not authorized to perform:";
const ecs = lim.limitedClient(fake("ECS", (c) => {
  if (c.input.deny === "own") throw denied(ROLE + " ecs:UpdateService on resource: arn:aws:ecs:eu-west-1:123456789012:service/acme-production/api");
  if (c.input.deny === "pass") throw denied(ROLE + " iam:PassRole on resource: arn:aws:iam::123456789012:role/acme-task");
  return { $metadata: { attempts: 1 } };
}));
const lambda = lim.limitedClient(fake("Lambda", () => { throw denied(ROLE + " lambda:ListFunctions"); }));
const call = (op, input = {}) => ecs.send({ schema: [9, "com.amazonaws.ecs", op], input }).catch((e) => e);
await call("UpdateService", { deny: "own" });
out.afterDenied = cap.capability(["ecs:UpdateService"]);
await call("UpdateService");
out.afterSuccess = cap.capability(["ecs:UpdateService"]).state;
await call("CreateService", { deny: "pass" });
out.passRole = cap.capability(["iam:PassRole"]).state;
await lambda.send(cmd("ListFunctions")).catch(() => {});
out.readsKeptOut = !Object.hasOwn(cap.capabilityView().actions, "lambda:ListFunctions");

// Aborted after it was handed to the SDK: a write is outcome unknown, a read is not. The shared signal reason is never
// flagged itself (calls the signal stopped before they started share it).
const slow = lim.limitedClient(fake("RDS", (c, o) => new Promise((_, reject) => o.abortSignal.addEventListener("abort", () => reject(o.abortSignal.reason), { once: true }))));
const ac = new AbortController();
const write = slow.send(cmd("StopDBInstance"), { abortSignal: ac.signal }).catch((e) => e);
const read = slow.send(cmd("DescribeDBInstances"), { abortSignal: ac.signal }).catch((e) => e);
await new Promise((r) => setTimeout(r, 5));
const reason = new DOMException("deadline", "TimeoutError");
ac.abort(reason);
const [w, r] = await Promise.all([write, read]);
out.write = { name: w.name, unknown: isOutcomeUnknown(w) };
out.read = { name: r.name, unknown: isOutcomeUnknown(r) };
out.reasonUntouched = reason.afterSend === undefined;

// outsideCallSignal: no signal inside, the caller's comes back after.
const dl = AbortSignal.timeout(60_000);
out.outside = await lim.withCallSignal(dl, async () => {
  const inner = await lim.outsideCallSignal(async () => { await new Promise((r) => setTimeout(r, 1)); return lim.currentCallSignal() === undefined; });
  return inner && lim.currentCallSignal() === dl;
});

// An observer that throws never changes a call's outcome.
lim.observeCalls(() => { throw new Error("boom"); });
out.observerSafe = (await call("UpdateService")).$metadata?.attempts === 1;
process.stdout.write(JSON.stringify(out));
`;

test("limitedClient reports calls to capability.ts, flags writes aborted after sending, outsideCallSignal detaches", () => {
  const out = JSON.parse(execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", observed], { encoding: "utf8", timeout: 60_000, env: { ...process.env, CONSOLE_SOURCE: "aws", CONSOLE_AWS_CONCURRENCY: "" } }));
  assert.deepEqual(out.ops, ["UpdateService", "UpdateService", "", ""]);
  assert.equal(out.afterDenied.state, "denied");
  assert.match(out.afterDenied.why, /AWS refused it recently/);
  assert.equal(out.afterSuccess, "allowed", "a success clears the refusal");
  assert.equal(out.passRole, "denied", "the action the refusal names, not the call's own");
  assert.equal(out.readsKeptOut, true, "refused reads outside the console's writes aren't remembered");
  assert.deepEqual(out.write, { name: "TimeoutError", unknown: true });
  assert.deepEqual(out.read, { name: "TimeoutError", unknown: false });
  assert.equal(out.reasonUntouched, true);
  assert.equal(out.outside, true);
  assert.equal(out.observerSafe, true);
});

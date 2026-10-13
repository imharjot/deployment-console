import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { asanaProjectRequest, asanaTaskRequest } from "./asana.ts";
import { clickupListRequest, clickupTaskRequest } from "./clickup.ts";
import type { ConsoleEvent } from "./events.ts";
import { githubIssueRequest, githubRepoRequest } from "./github.ts";
import { apiError } from "./http.ts";
import { jiraIssueRequest, jiraProjectRequest } from "./jira.ts";
import { ISSUE_CREATE, linearIssueRequest, linearTeamRequest } from "./linear.ts";
import { PLUGINS } from "./registry.ts";
import { esc, slackMessage, slackRequest } from "./slack.ts";
import { sign, webhookRequest } from "./webhook.ts";

const ticket = { title: "  api is DOWN\n in staging  ", body: "Reasons:\n- health check failing\n\n```\nERR boom\n```" };
const body = (r: { body?: string }) => JSON.parse(r.body ?? "null");

const down: ConsoleEvent = {
  type: "service.down", at: Date.UTC(2026, 8, 26, 10, 0, 0), url: "https://console.example.com/?env=staging&r=service:api",
  env: "staging", envLabel: "Staging", protected: false, key: "service:api", name: "api <core>", state: "DOWN", previous: "UP", reasons: ["0/1 tasks running", "health check failing"],
};

test("registry: unique ids, every plugin can test, capabilities match methods", () => {
  assert.equal(new Set(PLUGINS.map((p) => p.id)).size, PLUGINS.length);
  for (const p of PLUGINS) {
    assert.equal(typeof p.test, "function", p.id);
    assert.equal(p.capabilities.includes("notify"), typeof p.notify === "function", `${p.id} notify`);
    assert.equal(p.capabilities.includes("tickets"), typeof p.createTicket === "function", `${p.id} tickets`);
    assert.equal(new Set(p.fields.map((f) => f.key)).size, p.fields.length, `${p.id} field keys`);
    // Anything that authenticates must be sealed at rest.
    for (const f of p.fields) if (/token$|^apiKey$|secret|webhook/i.test(f.key)) assert.equal(f.type, "secret", `${p.id}.${f.key}`);
  }
});

test("slack: compact Block Kit with escaped mrkdwn, fields, and an Open in console button", () => {
  const m = slackMessage(down);
  assert.equal(m.text, "api <core> is down in Staging");
  const [title, fields, context, actions] = m.blocks as { type: string; text?: { text: string }; fields?: { text: string }[]; elements?: { url?: string; text: { text: string }; style?: string }[] }[];
  assert.equal(title.type, "section");
  assert.equal(title.text!.text, ":red_circle: *api &lt;core&gt; is down in Staging*");
  assert.deepEqual(fields.fields!.map((f) => f.text), ["*Environment*\nStaging", "*Service*\napi &lt;core&gt;", "*State*\nUP → DOWN", "*Reason*\n0/1 tasks running; health check failing"]);
  assert.equal(context.type, "context");
  assert.equal(actions.type, "actions");
  assert.equal(actions.elements![0].text.text, "Open in console");
  assert.equal(actions.elements![0].url, down.url);
  assert.equal(actions.elements![0].style, "primary");

  const r = slackRequest("https://hooks.slack.com/services/T/B/X", down);
  assert.equal(r.method, "POST");
  assert.equal(r.url, "https://hooks.slack.com/services/T/B/X");
  assert.equal(r.headers["Content-Type"], "application/json");
  assert.deepEqual(body(r), JSON.parse(JSON.stringify(m)));
  assert.equal(esc("a & <b>"), "a &amp; &lt;b&gt;");
});

test("slack: events without a link or fields produce no empty blocks (invalid Block Kit)", () => {
  const m = slackMessage({ type: "test", at: 0, url: "", message: "hi" });
  const types = (m.blocks as { type: string }[]).map((b) => b.type);
  assert.deepEqual(types, ["section", "section", "context"]);
  const ci = slackMessage({ type: "ci.failed", at: 0, url: "https://c/ci", repo: "acme/api", branch: "main", workflow: "test", title: "fix", sha: "abcdef1234", actor: "me", runUrl: "https://github.com/acme/api/actions/runs/1" });
  const actions = (ci.blocks as { type: string; elements?: { url: string }[] }[]).find((b) => b.type === "actions")!;
  assert.deepEqual(actions.elements!.map((e) => e.url), ["https://c/ci", "https://github.com/acme/api/actions/runs/1"]);
});

test("webhook: body is the event JSON; signature is sha256=<hex HMAC of that exact body>", () => {
  const r = webhookRequest({ url: "https://example.com/hook", secret: "s3cret" }, down);
  assert.equal(r.method, "POST");
  assert.equal(r.url, "https://example.com/hook");
  assert.equal(r.headers["X-Console-Event"], "service.down");
  assert.equal(r.body, JSON.stringify(down));
  assert.equal(r.headers["X-Console-Signature"], `sha256=${createHmac("sha256", "s3cret").update(r.body!).digest("hex")}`);
  // Known vector: the HMAC-SHA256 example from Wikipedia's HMAC article.
  assert.equal(sign("key", "The quick brown fox jumps over the lazy dog"), "sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
  const unsigned = webhookRequest({ url: "https://example.com/hook", secret: "" }, down);
  assert.equal(unsigned.headers["X-Console-Signature"], undefined);
});

test("clickup: raw token auth, list path, markdown_content + tags", () => {
  const cfg = { token: "pk_1", listId: " 901 ", tags: "ops, console ," };
  const t = clickupTaskRequest(cfg, ticket, "http://mock");
  assert.equal(t.method, "POST");
  assert.equal(t.url, "http://mock/list/901/task");
  assert.equal(t.headers.Authorization, "pk_1");
  assert.deepEqual(body(t), { name: "api is DOWN in staging", description: ticket.body, markdown_content: ticket.body, tags: ["ops", "console"] });
  assert.equal(clickupTaskRequest({ ...cfg, tags: "" }, ticket).url, "https://api.clickup.com/api/v2/list/901/task");
  assert.equal(body(clickupTaskRequest({ ...cfg, tags: "" }, ticket)).tags, undefined);
  const g = clickupListRequest(cfg);
  assert.equal(g.method, "GET");
  assert.equal(g.url, "https://api.clickup.com/api/v2/list/901");
  assert.equal(g.body, undefined);
});

test("asana: bearer PAT, body wrapped in data, project + optional workspace", () => {
  const cfg = { token: "2/abc", projectGid: "12", workspaceGid: "" };
  const t = asanaTaskRequest(cfg, ticket, "http://mock");
  assert.equal(t.url, "http://mock/tasks?opt_fields=gid,permalink_url");
  assert.equal(t.headers.Authorization, "Bearer 2/abc");
  assert.deepEqual(body(t), { data: { name: "api is DOWN in staging", notes: ticket.body, projects: ["12"] } });
  assert.equal(body(asanaTaskRequest({ ...cfg, workspaceGid: "99" }, ticket)).data.workspace, "99");
  assert.equal(asanaProjectRequest(cfg).url, "https://app.asana.com/api/1.0/projects/12?opt_fields=name");
});

test("github: repo path, API version header, labels; token falls back to GITHUB_TOKEN", () => {
  const t = githubIssueRequest({ repo: "acme/api", token: "ghp_x", labels: "bug, ops" }, ticket, "http://mock");
  assert.equal(t.method, "POST");
  assert.equal(t.url, "http://mock/repos/acme/api/issues");
  assert.equal(t.headers.Authorization, "Bearer ghp_x");
  assert.equal(t.headers.Accept, "application/vnd.github+json");
  assert.equal(t.headers["X-GitHub-Api-Version"], "2022-11-28");
  assert.ok(t.headers["User-Agent"]);
  assert.deepEqual(body(t), { title: "api is DOWN in staging", body: ticket.body, labels: ["bug", "ops"] });
  const prev = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "env-token";
  try {
    assert.equal(githubRepoRequest({ repo: "acme/api", token: "", labels: "" }).headers.Authorization, "Bearer env-token");
    delete process.env.GITHUB_TOKEN;
    assert.throws(() => githubRepoRequest({ repo: "acme/api", token: "", labels: "" }), /no token/);
  } finally {
    if (prev === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prev;
  }
  assert.throws(() => githubIssueRequest({ repo: "../etc", token: "t", labels: "" }, ticket), /owner\/name/);
  assert.throws(() => githubIssueRequest({ repo: "acme/..", token: "t", labels: "" }, ticket), /owner\/name/);
  assert.equal(githubIssueRequest({ repo: "acme/.github", token: "t", labels: "" }, ticket).url, "https://api.github.com/repos/acme/.github/issues");
});

test("jira: basic auth email:token, v3 issue with ADF description, default issue type Bug", () => {
  const cfg = { siteUrl: "https://acme.atlassian.net/", email: "ops@acme.io", token: "tok", projectKey: "OPS", issueType: "" };
  const r = jiraIssueRequest(cfg, ticket);
  assert.equal(r.method, "POST");
  assert.equal(r.url, "https://acme.atlassian.net/rest/api/3/issue");
  assert.equal(r.headers.Authorization, `Basic ${Buffer.from("ops@acme.io:tok").toString("base64")}`);
  const f = body(r).fields;
  assert.deepEqual(f.project, { key: "OPS" });
  assert.equal(f.summary, "api is DOWN in staging");
  assert.deepEqual(f.issuetype, { name: "Bug" });
  assert.equal(f.description.type, "doc");
  assert.equal(f.description.version, 1);
  assert.deepEqual(f.description.content.map((n: { type: string }) => n.type), ["paragraph", "bulletList", "codeBlock"]);
  assert.equal(body(jiraIssueRequest({ ...cfg, issueType: "Task" }, ticket)).fields.issuetype.name, "Task");
  assert.equal(body(jiraIssueRequest(cfg, { title: "t", body: "  " })).fields.description, undefined);
  assert.equal(jiraProjectRequest(cfg).url, "https://acme.atlassian.net/rest/api/3/project/OPS");
});

test("linear: raw API key, GraphQL issueCreate with variables", () => {
  const cfg = { apiKey: "lin_api_x", teamId: "team-uuid" };
  const r = linearIssueRequest(cfg, ticket, "http://mock/graphql");
  assert.equal(r.method, "POST");
  assert.equal(r.url, "http://mock/graphql");
  assert.equal(r.headers.Authorization, "lin_api_x");
  assert.deepEqual(body(r), { query: ISSUE_CREATE, variables: { input: { teamId: "team-uuid", title: "api is DOWN in staging", description: ticket.body } } });
  assert.match(ISSUE_CREATE, /issue \{ id identifier url \}/);
  assert.equal(linearTeamRequest(cfg).url, "https://api.linear.app/graphql");
  assert.deepEqual(body(linearTeamRequest(cfg)).variables, { id: "team-uuid" });
});

test("apiError reads the common vendor error shapes", () => {
  assert.equal(apiError({ errorMessages: ["Project does not exist"], errors: {} }, ""), "Project does not exist");
  assert.equal(apiError({ errorMessages: [], errors: { summary: "required" } }, ""), "summary: required");
  assert.equal(apiError({ errors: [{ message: "Entity not found" }] }, ""), "Entity not found");
  assert.equal(apiError({ err: "Token invalid", ECODE: "OAUTH_025" }, ""), "Token invalid");
  assert.equal(apiError({ message: "Bad credentials" }, ""), "Bad credentials");
  assert.equal(apiError(null, "no_service"), "no_service");
});

test("outbound URLs: link-local (cloud metadata) addresses are blocked, private ones are not", async () => {
  const { blockedAddress, send } = await import("./http.ts");
  for (const ip of ["169.254.169.254", "169.254.170.2", "::ffff:169.254.169.254", "fe80::1", "fd00:ec2::254", "0.0.0.0", "::"]) assert.equal(blockedAddress(ip), true, ip);
  for (const ip of ["10.0.0.5", "192.168.1.10", "127.0.0.1", "::1", "8.8.8.8", "fd12::1"]) assert.equal(blockedAddress(ip), false, ip);
  assert.equal(blockedAddress("not-an-ip"), true, "anything that isn't an address fails closed");
  await assert.rejects(send("Test", { method: "GET", url: "http://169.254.169.254/latest/meta-data/", headers: {} }), /link-local/);
  await assert.rejects(send("Test", { method: "GET", url: "http://[fd00:ec2::254]/", headers: {} }), /link-local/);
  await assert.rejects(send("Test", { method: "GET", url: "file:///etc/passwd", headers: {} }), /http\(s\)/);
});

// REVIEW R09: new URL() turns "[::ffff:169.254.169.254]" into "[::ffff:a9fe:a9fe]", which the old "::ffff:" prefix test
// missed. Inputs are built exactly the way the guard sees them.
test("outbound URLs: IPv4-mapped, IPv4-compatible and NAT64 spellings of metadata addresses are blocked", async () => {
  const { blockedAddress, checkTarget, send } = await import("./http.ts");
  const urls = [
    "http://[::ffff:169.254.169.254]/latest/meta-data/",
    "http://[::ffff:a9fe:aa02]/v4/credentials", // 169.254.170.2, ECS task metadata, written in hex
    "http://[::169.254.169.254]/",
    "http://[64:ff9b::169.254.169.254]/",
    "http://[64:ff9b::a9fe:aa02]/",
    "http://[::ffff:0.0.0.0]/",
    "http://[0:0:0:0:0:ffff:a9fe:a9fe]/",
    "http://[::ffff:0:169.254.169.254]/", // IPv4-translated (SIIT)
    "http://2852039166/", // 169.254.169.254 as one decimal number
    "http://0xa9.0xfe.0xa9.0xfe/",
  ];
  for (const u of urls) {
    const host = new URL(u).hostname.replace(/^\[|\]$/g, "");
    assert.equal(blockedAddress(host), true, `${u} → ${host}`);
    await assert.rejects(checkTarget(u), /link-local/, u);
  }
  await assert.rejects(send("Test", { method: "GET", url: "http://[::ffff:169.254.169.254]/latest/meta-data/", headers: {} }), /link-local/);
  await assert.rejects(send("Test", { method: "GET", url: "http://[::ffff:a9fe:aa02]/v4/credentials", headers: {} }), /link-local/);
});

test("outbound URLs: private addresses are refused by safeFetch unless allowPrivate, in every spelling", async () => {
  const { checkTarget, privateAddress } = await import("./http.ts");
  for (const ip of ["10.0.0.5", "172.16.3.4", "192.168.1.10", "127.0.0.1", "100.64.0.1", "::1", "fd12::1", "fc00::1", "ff02::1", "::ffff:10.0.0.5", "::ffff:7f00:1", "64:ff9b::10.0.0.5", "::127.0.0.1"]) {
    assert.equal(privateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "64:ff9b::8.8.8.8"]) assert.equal(privateAddress(ip), false, ip);
  await assert.rejects(checkTarget("http://127.0.0.1:1/"), /private or loopback/);
  await assert.rejects(checkTarget("http://[::ffff:7f00:1]/"), /private or loopback/);
  assert.equal((await checkTarget("http://127.0.0.1:1/", { allowPrivate: true })).addresses[0].address, "127.0.0.1");
  // A name is refused when ANY of its addresses is: no "pick the good one" games.
  const mixed = async () => [{ address: "93.184.216.34", family: 4 as const }, { address: "169.254.169.254", family: 4 as const }];
  await assert.rejects(checkTarget("https://mixed.acme.example/", { resolve: mixed }), /link-local/);
});

// A tiny local server for the safeFetch tests: records every request it sees.
async function server(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void) {
  const { createServer } = await import("node:http");
  const seen: { url: string; host: string; auth?: string; method: string }[] = [];
  const srv = createServer((req, res) => {
    seen.push({ url: req.url ?? "", host: req.headers.host ?? "", auth: req.headers.authorization, method: req.method ?? "" });
    handler(req, res);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as import("node:net").AddressInfo).port;
  return { port, seen, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}

test("safeFetch pins the checked address: a rebinding resolver (allowed first, link-local second) never gets dialled", async () => {
  const { safeFetch, pinnedLookup } = await import("./http.ts");
  const s = await server((_req, res) => res.end("ok"));
  try {
    const answers = [[{ address: "127.0.0.1", family: 4 as const }], [{ address: "169.254.169.254", family: 4 as const }]];
    let calls = 0;
    const rebinding = async () => answers[Math.min(calls++, 1)];
    const res = await safeFetch(`http://rebind.acme.test:${s.port}/hook`, { method: "POST", body: "x" }, { allowPrivate: true, resolve: rebinding });
    assert.equal(await res.text(), "ok");
    assert.equal(calls, 1, "the name is resolved exactly once");
    assert.deepEqual(s.seen.map((r) => [r.url, r.host, r.method]), [["/hook", `rebind.acme.test:${s.port}`, "POST"]], "dialled the checked address, Host header kept");
    // A resolver that answers link-local first is refused before any connection.
    calls = 1;
    await assert.rejects(safeFetch(`http://rebind.acme.test:${s.port}/`, {}, { allowPrivate: true, resolve: rebinding }), /link-local/);
    assert.equal(s.seen.length, 1);
  } finally {
    await s.close();
  }
  // The socket's lookup answers with the pinned addresses whatever it is asked.
  const look = pinnedLookup([{ address: "203.0.113.7", family: 4 }, { address: "2001:db8::7", family: 6 }]);
  const one = await new Promise((r) => look("169.254.169.254.nip.io", { family: 0 }, (_e, a, f) => r([a, f])));
  assert.deepEqual(one, ["203.0.113.7", 4]);
  const all = await new Promise((r) => look("x", { all: true }, (_e, a) => r(a)));
  assert.deepEqual(all, [{ address: "203.0.113.7", family: 4 }, { address: "2001:db8::7", family: 6 }]);
  const v6 = await new Promise((r) => look("x", { family: 6 }, (_e, a) => r(a)));
  assert.equal(v6, "2001:db8::7");
});

test("safeFetch redirects: checked hop by hop, at most 3, credentials dropped across origins; manual and error modes", async () => {
  const { safeFetch } = await import("./http.ts");
  const s = await server((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/a") return res.writeHead(302, { location: "/b" }).end();
    if (u.pathname === "/meta") return res.writeHead(307, { location: "http://169.254.169.254/latest/meta-data/" }).end();
    if (u.pathname === "/mapped") return res.writeHead(301, { location: "http://[::ffff:a9fe:a9fe]/" }).end();
    if (u.pathname === "/loop") return res.writeHead(302, { location: "/loop" }).end();
    if (u.pathname === "/away") return res.writeHead(307, { location: `http://other.acme.test:${u.searchParams.get("p")}/b` }).end();
    res.end(`at ${u.pathname}`);
  });
  const local = async () => [{ address: "127.0.0.1", family: 4 as const }];
  const base = `http://127.0.0.1:${s.port}`;
  try {
    const r = await safeFetch(`${base}/a`, { headers: { Authorization: "Bearer t" } }, { allowPrivate: true });
    assert.equal(await r.text(), "at /b");
    assert.equal(s.seen[1].auth, "Bearer t", "same origin keeps credentials");
    await assert.rejects(safeFetch(`${base}/meta`, {}, { allowPrivate: true }), /link-local/);
    await assert.rejects(safeFetch(`${base}/mapped`, {}, { allowPrivate: true }), /link-local/);
    await assert.rejects(safeFetch(`${base}/loop`, {}, { allowPrivate: true }), /too many redirects/);
    assert.equal(s.seen.filter((x) => x.url === "/loop").length, 4, "the first request plus 3 hops");
    const before = s.seen.length;
    const away = await safeFetch(`${base}/away?p=${s.port}`, { method: "POST", body: "x", headers: { authorization: "Bearer t", cookie: "a=b" } }, { allowPrivate: true, resolve: local });
    assert.equal(await away.text(), "at /b");
    assert.deepEqual(s.seen.slice(before).map((x) => [x.host, x.auth, x.method]), [[`127.0.0.1:${s.port}`, "Bearer t", "POST"], [`other.acme.test:${s.port}`, undefined, "POST"]], "307 keeps the method; another origin gets no credentials");
    const manual = await safeFetch(`${base}/a`, { redirect: "manual" }, { allowPrivate: true });
    assert.equal(manual.status, 302);
    assert.equal(manual.headers.get("location"), "/b");
    await assert.rejects(safeFetch(`${base}/a`, { redirect: "error" }, { allowPrivate: true }), /redirect refused/);
    await assert.rejects(safeFetch(`${base}/a`), /private or loopback/, "safeFetch refuses private addresses by default");
  } finally {
    await s.close();
  }
});

test("safeFetch streams the body; send() reports a timeout after the request left as outcome unknown", async () => {
  const { safeFetch, send } = await import("./http.ts");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = await server((req, res) => {
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      void gate.then(() => res.end("data: two\n\n"));
      return;
    }
    if (req.url === "/hang") return; // never answers
    res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ message: "boom" }));
  });
  const base = `http://127.0.0.1:${s.port}`;
  try {
    const r = await safeFetch(`${base}/stream`, {}, { allowPrivate: true });
    const reader = r.body!.getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), "data: one\n\n", "the first event arrives before the server finishes");
    release();
    const rest = await reader.read();
    assert.equal(new TextDecoder().decode(rest.value), "data: two\n\n");

    const t = await send("Test", { method: "POST", url: `${base}/hang`, headers: {}, body: "{}" }, 200).then(() => new Error("resolved"), (e: Error) => e);
    assert.match(t.message, /^Test: timed out$/);
    assert.equal((t as { outcomeUnknown?: boolean }).outcomeUnknown, true);
    assert.equal(t.name, "Error", "a plain Error: the 502 text carries no class name");
    const failed = await send("Test", { method: "GET", url: `${base}/err`, headers: {} }).then(() => new Error("resolved"), (e: Error) => e);
    assert.match(failed.message, /HTTP 500 — boom/);
    assert.notEqual((failed as { outcomeUnknown?: boolean }).outcomeUnknown, true);
    const refused = await send("Test", { method: "GET", url: "http://127.0.0.1:1/", headers: {} }).then(() => new Error("resolved"), (e: Error) => e);
    assert.equal(refused.message, "Test: ECONNREFUSED", "no URL in the error");
  } finally {
    await s.close();
  }
});

test("safeFetch: the caller's deadline also bounds the DNS lookup; send(): a 2xx whose answer is cut off is outcome unknown", async () => {
  const { safeFetch, send } = await import("./http.ts");
  // A resolver that never answers (getaddrinfo can hang far past any deadline): the signal ends the wait.
  const hang = () => new Promise<never>(() => {});
  const t0 = Date.now();
  const slow = await safeFetch("https://slow-dns.acme.test/", { signal: AbortSignal.timeout(100) }, { resolve: hang }).then((): Error & { afterSend?: boolean } => new Error("resolved"), (e: Error & { afterSend?: boolean }) => e);
  assert.equal(slow.name, "TimeoutError");
  assert.notEqual(slow.afterSend, true, "nothing was sent: a plain failure");
  assert.ok(Date.now() - t0 < 2_000, "returned at the deadline");
  await assert.rejects(safeFetch("https://x.acme.test/", { signal: AbortSignal.abort() }, { resolve: hang }), { name: "AbortError" });

  const s = await server((_req, res) => {
    res.writeHead(201, { "content-type": "application/json", "content-length": "100" });
    res.write('{"key":"OPS-');
    setTimeout(() => res.destroy(), 20); // the connection drops mid-answer
  });
  try {
    const cut = await send("Jira", { method: "POST", url: `http://127.0.0.1:${s.port}/rest/api/3/issue`, headers: {}, body: "{}" }).then(() => new Error("resolved"), (e: Error) => e);
    assert.equal((cut as { outcomeUnknown?: boolean }).outcomeUnknown, true, "the tracker acted (201) but its answer is lost");
    assert.match(cut.message, /^Jira: the answer was cut off/);
    assert.doesNotMatch(cut.message, /127\.0\.0\.1|rest\/api/, "no URL in the error");
  } finally {
    await s.close();
  }
});

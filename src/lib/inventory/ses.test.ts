import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SES_LINKED_MAX, sesAccountNote, sesDetail, sesResult, type RawIdentity, type SesAccount, type SesConfigurationSet } from "./ses.ts";
import { simSes, simSesIdentityDetail } from "../server/providers/mock/ses.ts";

const R = "us-east-1";
const A = "123456789012";
const SENTINEL = "SENTINEL-ses-81d2aa";
const key = (identity: string) => `arn:aws:ses:${R}:${A}:identity/${identity}`;
const TOPIC = `arn:aws:sns:${R}:${A}:bounces`;
const BUS = `arn:aws:events:${R}:${A}:event-bus/default`;
const STREAM = `arn:aws:firehose:${R}:${A}:deliverystream/ses-events`;
const HEALTHY: SesAccount = { ProductionAccessEnabled: true, SendingEnabled: true, EnforcementStatus: "HEALTHY" };
const id = (name: string, o: Partial<RawIdentity> = {}): RawIdentity => ({ IdentityType: name.includes("@") ? "EMAIL_ADDRESS" : "DOMAIN", IdentityName: name, SendingEnabled: true, VerificationStatus: "SUCCESS", ...o });

// Golden: ListEmailIdentities entries, GetAccount and GetConfigurationSetEventDestinations. GetAccount's Details hold
// contact addresses and the use-case text; GetEmailIdentity's Policies hold documents — the sentinel proves neither is copied.
const IDENTITIES: RawIdentity[] = [
  id("shop.example"),
  id("noreply@shop.example"),
  id("pending.example", { VerificationStatus: "PENDING" }),
  id("not-started.example", { VerificationStatus: "NOT_STARTED" }),
  id("failed.example", { VerificationStatus: "FAILED" }),
  id("flaky.example", { VerificationStatus: "TEMPORARY_FAILURE" }),
  id("paused.example", { SendingEnabled: false }),
  id("dkim.example", { detail: { DkimAttributes: { Status: "FAILED" }, ConfigurationSetName: "marketing", Policies: { "allow-app": SENTINEL }, Tags: [{ Key: "Team", Value: "growth" }] } }),
];
const SETS: SesConfigurationSet[] = [
  { name: "transactional", state: "ok", destinations: [
    { Name: "bounces", Enabled: true, MatchingEventTypes: ["BOUNCE", "COMPLAINT"], SnsDestination: { TopicArn: TOPIC } },
    { Name: "off", Enabled: false, MatchingEventTypes: ["SEND"], EventBridgeDestination: { EventBusArn: BUS } },
    { Name: "metrics", Enabled: true, MatchingEventTypes: ["SEND"], CloudWatchDestination: {} },
  ] },
  { name: "marketing", state: "ok", destinations: [{ Name: "archive", Enabled: true, MatchingEventTypes: ["SEND", "DELIVERY", "OPEN", "CLICK", "BOUNCE"], KinesisFirehoseDestination: { DeliveryStreamArn: STREAM, IamRoleArn: `arn:aws:iam::${A}:role/ses-firehose` } }] },
];
const account = { ...HEALTHY, Details: { AdditionalContactEmailAddresses: [SENTINEL], UseCaseDescription: SENTINEL } } as SesAccount;
const result = (o: Partial<Parameters<typeof sesResult>[1]> = {}) => sesResult(IDENTITIES, { region: R, account: A, sesAccount: account, accountState: "ok", configurationSets: SETS, ...o });
const byId = (n: string, r = result()) => r.resources.find((x) => x.key === key(n))!;

test("SES: key from arnOf.sesIdentity; identities never in endpoints or aliases; the name isn't the bare domain", () => {
  const r = byId("shop.example");
  assert.equal(r.kind, "ses-identity");
  assert.equal(r.name, "shop.example · domain");
  assert.equal(byId("noreply@shop.example").name, "noreply@shop.example · email");
  for (const x of result().resources) assert.ok(x.endpoints === undefined && x.aliases === undefined);
  assert.equal(r.tagsUnread, true, "tags come with GetEmailIdentity only");
  assert.deepEqual(byId("dkim.example").tags, { Team: "growth" });
  assert.deepEqual(r.facts, { state: "SUCCESS" });
  assert.deepEqual(sesResult(IDENTITIES, { region: R }).resources, [], "no account id, no key");
});

test("SES: identity health — verified ok, pending / not started warn, failed / temporary failure error, DKIM failed and paused warn", () => {
  const h = (n: string, r = result()) => [byId(n, r).health, byId(n, r).healthReason];
  assert.deepEqual(h("shop.example"), ["ok", undefined]);
  assert.deepEqual(h("pending.example"), ["warning", "waiting for verification"]);
  assert.deepEqual(h("not-started.example"), ["warning", "verification not started"]);
  assert.deepEqual(h("failed.example"), ["error", "verification failed"]);
  assert.deepEqual(h("flaky.example"), ["error", "verification temporarily failing (DNS records not found)"]);
  assert.deepEqual(h("paused.example"), ["warning", "sending disabled for this identity"]);
  assert.deepEqual(h("dkim.example"), ["warning", "DKIM verification failed"]);
});

test("SES: the sandbox is a prop and one account note — not a warning; probation warns every identity; shutdown / paused error", () => {
  const sandbox = result({ sesAccount: { ProductionAccessEnabled: false, SendingEnabled: true, EnforcementStatus: "HEALTHY", SendQuota: { Max24HourSend: 200 } } });
  assert.ok(sandbox.resources.filter((r) => r.key !== key("pending.example") && r.key !== key("not-started.example") && r.key !== key("paused.example") && r.key !== key("dkim.example")).every((r) => r.health !== "warning"));
  assert.equal(byId("shop.example", sandbox).health, "ok");
  assert.equal(byId("shop.example", sandbox).props.find((p) => p.label === "Account")?.value, "sandbox (verified recipients only)");
  assert.equal(sesAccountNote({ ProductionAccessEnabled: false, SendQuota: { Max24HourSend: 200 } }, "ap-south-1"), "ses: the account is in the SES sandbox in ap-south-1 — it can send only to verified addresses, 200 messages a day; request production access to send to anyone");
  assert.equal(sesAccountNote(HEALTHY, R), undefined);
  const probation = result({ sesAccount: { ...HEALTHY, EnforcementStatus: "PROBATION" } });
  assert.ok(probation.resources.filter((r) => r.health !== "error").every((r) => r.health === "warning"));
  assert.equal(byId("shop.example", probation).healthReason, "SES account on probation (bounce or complaint rate too high)");
  assert.equal(byId("failed.example", probation).healthReason, "verification failed", "an identity error outranks probation");
  const shut = result({ sesAccount: { ...HEALTHY, EnforcementStatus: "SHUTDOWN" } });
  assert.ok(shut.resources.every((r) => r.health === "error"));
  assert.equal(byId("shop.example", result({ sesAccount: { ...HEALTHY, SendingEnabled: false } })).healthReason, "sending is paused for the SES account");
  const unread = result({ sesAccount: undefined, accountState: "denied" });
  assert.equal(byId("shop.example", unread).props.find((p) => p.label === "Account")?.value, "account state not read (denied)");
  assert.deepEqual(byId("shop.example", unread).enrichment, { account: "denied" });
});

test("SES: links to configuration-set destinations — 'allowed' from every set, or 'config' from the identity's own set; disabled and CloudWatch skipped", () => {
  const l = result().links;
  assert.deepEqual(l.filter((x) => x.from === key("shop.example")).map((x) => [x.to, x.kind, x.label, x.confidence]), [
    [TOPIC, "event", "bounce, complaint", "allowed"],
    [STREAM, "event", "send, delivery, open +2", "allowed"],
  ]);
  assert.deepEqual(l.filter((x) => x.from === key("dkim.example")).map((x) => [x.to, x.confidence]), [[STREAM, undefined]]);
  assert.ok(!l.some((x) => x.to === BUS));
  const many = sesResult(Array.from({ length: SES_LINKED_MAX + 5 }, (_, i) => id(`d${i}.example`)), { region: R, account: A, configurationSets: SETS });
  assert.equal(new Set(many.links.map((x) => x.from)).size, SES_LINKED_MAX);
});

test("SES: no sentinel (account contacts, policy documents) in resources or detail; detail shows the identity's set", () => {
  assert.ok(!JSON.stringify(result()).includes(SENTINEL));
  const d = sesDetail(key("dkim.example"), IDENTITIES[7], { sesAccount: account, configurationSets: SETS });
  assert.ok(!JSON.stringify(d).includes(SENTINEL));
  assert.equal(d.sections[0].rows?.find((p) => p.label === "Policies")?.value, "allow-app");
  assert.deepEqual(d.sections.map((s) => s.title), ["Identity", `Account (${R})`, "Event destinations (marketing)", "Tags"]);
});

test("SES: Acme mock — acme.example verified, events to the notifications topic; detail via GetEmailIdentity; us-east-1 only", () => {
  const sim = simSes(R);
  const r = sesResult(sim.identities, { region: R, account: A, sesAccount: sim.account, accountState: "ok", configurationSets: sim.configurationSets });
  assert.deepEqual(r.resources.map((x) => [x.name, x.health]), [["acme.example · domain", "ok"]]);
  assert.deepEqual(r.links.map((x) => [x.to, x.confidence]), [[`arn:aws:sns:${R}:${A}:acme-production-notifications`, "allowed"]]);
  const d = sesDetail(r.resources[0].key, { ...sim.identities[0], detail: simSesIdentityDetail("acme.example") }, { sesAccount: sim.account, configurationSets: sim.configurationSets });
  assert.equal(d.sections[0].rows?.find((p) => p.label === "Configuration set")?.value, "acme-transactional");
  assert.deepEqual(d.sections.map((s) => s.title), ["Identity", `Account (${R})`, "Event destinations (acme-transactional)", "Tags"]);
  assert.deepEqual(simSes("eu-west-1").identities, []);
});

// ---------- the provider's real-account path, with the SDK faked (server module: child process, react-server) ----------

// Runs `body` in a child process after replacing `send` on the named SDK clients' prototypes with `fakes` (a JS
// object literal: command name → async (input, n) => output, n = the call's index for that command). `provider(path)`
// imports a provider module; `ctx()` is a real-account ProviderContext that records notes and checkpoints.
function withFakeAws<T>(clients: Record<string, string>, fakes: string, body: string): T {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const base = new URL("../server/providers/", import.meta.url).href;
  const patch = Object.entries(clients).map(([pkg, cls]) => `(await import("@aws-sdk/${pkg}")).${cls}.prototype.send = send;`).join("\n");
  const code = `
    const calls = []; const counts = {}; const fakes = ${fakes};
    const send = async function (cmd) { const n = cmd.constructor.name; counts[n] = (counts[n] ?? 0) + 1; calls.push([n, cmd.input]);
      if (!Object.hasOwn(fakes, n)) throw new Error("unexpected " + n); return fakes[n](cmd.input, counts[n] - 1); };
    const denied = (action) => Object.assign(new Error("User: u is not authorized to perform: " + action + " on resource: x"), { name: "AccessDeniedException" });
    ${patch}
    const provider = (p) => import(new URL(p, ${JSON.stringify(base)}).href);
    const notes = [], checkpoints = [];
    const ctx = () => ({ region: "ap-south-1", accountId: "123456789012", mock: false, cap: 2000, signal: AbortSignal.timeout(20000), limit: (fn) => fn(), note: (m) => notes.push(m), checkpoint: (r) => checkpoints.push(r) });
    const out = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify({ ...out, calls, notes, checkpoints }), () => process.exit(0));`;
  const r = spawnSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", code], {
    cwd: root, encoding: "utf8", timeout: 60_000, env: { ...process.env, CONSOLE_SOURCE: "mock", CONSOLE_SQLITE_PATH: ":memory:" },
  });
  assert.equal(r.status, 0, `child failed:\n${r.stderr?.slice(-3000)}`);
  return JSON.parse(r.stdout) as T;
}

interface Run { resources: { name: string; health: string; tagsUnread?: boolean; props: { label: string; value: string }[] }[]; links: { from: string; to: string; confidence?: string }[]; calls: [string, Record<string, unknown>][]; notes: string[]; checkpoints: unknown[]; empty?: { resources: unknown[] }; emptyCalls?: string[] }

test("SES provider (faked AWS): no identities → one call and nothing else; else GetAccount (sandbox note), sets and destinations", () => {
  const out = withFakeAws<Run>(
    { "client-sesv2": "SESv2Client" },
    `{
      ListEmailIdentitiesCommand: async (input, n) => n === 0 ? { EmailIdentities: [] } : { EmailIdentities: [{ IdentityType: "DOMAIN", IdentityName: "shop.example", SendingEnabled: true, VerificationStatus: "SUCCESS" }] },
      GetEmailIdentityCommand: async (input) => ({ IdentityType: "DOMAIN", VerificationStatus: "SUCCESS", ConfigurationSetName: "tx", DkimAttributes: { Status: "SUCCESS" },
        Policies: { "send-only": "{\\"Statement\\": \\"${SENTINEL}\\"}" }, Tags: [{ Key: "Team", Value: "mail" }] }),
      GetAccountCommand: async () => ({ ProductionAccessEnabled: false, SendingEnabled: true, EnforcementStatus: "HEALTHY", SendQuota: { Max24HourSend: 200, MaxSendRate: 1 }, Details: { AdditionalContactEmailAddresses: ["${SENTINEL}"] } }),
      ListConfigurationSetsCommand: async () => ({ ConfigurationSets: ["tx", "locked"] }),
      GetConfigurationSetEventDestinationsCommand: async (input) => {
        if (input.ConfigurationSetName === "locked") throw denied("ses:GetConfigurationSetEventDestinations");
        return { EventDestinations: [{ Name: "b", Enabled: true, MatchingEventTypes: ["BOUNCE"], SnsDestination: { TopicArn: "arn:aws:sns:ap-south-1:123456789012:bounces" } }] };
      },
    }`,
    `const { sesProvider } = await provider("ses.ts");
     const empty = await sesProvider.discover(ctx()); const emptyCalls = calls.map((c) => c[0]);
     const r = await sesProvider.discover(ctx()); const before = calls.length;
     const detail = await sesProvider.detail(r.resources[0], ctx());
     return { ...r, empty, emptyCalls, detail, detailCalls: calls.splice(before).map((c) => [c[0], c[1].EmailIdentity ?? c[1].ConfigurationSetName ?? null]) };`,
  );
  const d = out as unknown as { detail: { sections: { title: string; rows?: { label: string; value: string }[] }[] }; detailCalls: [string, string | null][] };
  assert.deepEqual(d.detailCalls.sort(), [["GetAccountCommand", null], ["GetConfigurationSetEventDestinationsCommand", "tx"], ["GetEmailIdentityCommand", "shop.example"]]);
  assert.deepEqual(d.detail.sections.map((x) => x.title), ["Identity", "Account (ap-south-1)", "Event destinations (tx)", "Tags"]);
  assert.equal(d.detail.sections[0].rows?.find((x) => x.label === "Policies")?.value, "send-only");
  assert.ok(!JSON.stringify(d.detail).includes(SENTINEL));
  assert.deepEqual([out.emptyCalls, out.empty?.resources], [["ListEmailIdentitiesCommand"], []]);
  assert.deepEqual(out.calls.slice(1).map((c) => c[0]).sort(), ["GetAccountCommand", "GetConfigurationSetEventDestinationsCommand", "GetConfigurationSetEventDestinationsCommand", "ListConfigurationSetsCommand", "ListEmailIdentitiesCommand"]);
  assert.equal(out.calls[0][1].PageSize, 1000);
  assert.equal(out.checkpoints.length, 1);
  assert.deepEqual(out.resources.map((r) => [r.name, r.health, r.tagsUnread]), [["shop.example · domain", "ok", true]]);
  assert.equal(out.resources[0].props.find((p) => p.label === "Account")?.value, "sandbox (verified recipients only)");
  assert.deepEqual(out.links.map((l) => [l.to, l.confidence]), [["arn:aws:sns:ap-south-1:123456789012:bounces", "allowed"]]);
  assert.deepEqual(out.notes.sort(), [
    "ses event destinations skipped: ses:GetConfigurationSetEventDestinations denied",
    "ses: the account is in the SES sandbox in ap-south-1 — it can send only to verified addresses, 200 messages a day; request production access to send to anyone",
  ]);
  assert.ok(!JSON.stringify(out.resources).includes(SENTINEL));
});

test("SES provider (faked AWS): a panel opened on an identity deleted since discovery says so instead of failing", () => {
  const out = withFakeAws<{ detail: { sections: { note?: string }[] } }>(
    { "client-sesv2": "SESv2Client" },
    `{
      GetEmailIdentityCommand: async () => { throw Object.assign(new Error("Email identity acme.example does not exist."), { name: "NotFoundException" }); },
      GetAccountCommand: async () => ({ ProductionAccessEnabled: true, SendingEnabled: true, EnforcementStatus: "HEALTHY" }),
    }`,
    `const { sesProvider } = await provider("ses.ts");
     const detail = await sesProvider.detail({ key: "arn:aws:ses:ap-south-1:123456789012:identity/acme.example", kind: "ses-identity", provider: "ses", name: "acme.example · domain", region: "ap-south-1", tags: {}, health: "ok", props: [] }, ctx());
     return { detail };`,
  );
  assert.equal(out.detail.sections[0].note, "This identity no longer exists.");
});

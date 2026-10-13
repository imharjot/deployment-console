// Regenerates the Inventory* statements of infra/iam-policy.json and infra/iam-policy-readonly.json, and the generated
// table in docs/services.md, from the provider registry (src/lib/server/providers). Hand-written statements are kept,
// first. The rules live in src/lib/permissions.ts (shared with Settings → AWS permissions). Re-runnable; output sorted.
//
//   npm run iam:policy                          rewrite the files (only those that changed)
//   npm run iam:policy -- --check               exit 1 when a file is out of date
//   npm run iam:policy -- --json                print the declarations as JSON: IAM lists, kinds, scope, covers
//                                               (src/lib/iam-policy.test.ts reads them)
//   npm run iam:policy -- --print read|full [--providers lambda,sqs] [--out dir]
//                        [--regions a,b] [--set NAME=value …] [--principal arn]
//                                               print a policy (hand-written base included); --out writes it as parts
//                                               that each fit AWS's 6,144-character managed-policy quota. --regions:
//                                               more than one region turns REGION into "*" (kms:ViaService and the
//                                               console's own ARNs), one region fills it; --set fills a placeholder
//                                               (ACCOUNT_ID=123456789012); --principal names the identity the console
//                                               runs as in SimulateOwnPermissions (a role or an IAM user ARN)
//
// Node needs --conditions=react-server (set in package.json) to load the registry's server-only modules.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILES = { read: "infra/iam-policy-readonly.json", full: "infra/iam-policy.json" };
const DOCS = "docs/services.md";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const perms = await import("../src/lib/permissions.ts");
let PROVIDERS;
try {
  ({ PROVIDERS } = await import("../src/lib/server/providers/index.ts"));
} catch (e) {
  const hint = /server-only|Client Component/.test(String(e?.message)) ? " (run it with node --conditions=react-server, as `npm run iam:policy` does)" : "";
  console.error(`iam-policy: couldn't load the provider registry${hint}:\n${e?.stack ?? e}`);
  process.exit(2);
}
const decls = PROVIDERS.map(perms.declarationOf);

if (flag("--json")) {
  process.stdout.write(JSON.stringify({ providers: decls }, null, 2) + "\n");
  process.exit(0);
}

const load = async (file) => JSON.parse(await readFile(path.join(root, file), "utf8"));
const text = (doc) => JSON.stringify(doc, null, 2) + "\n";

// --regions, --set and --principal, applied in that order (an invalid value is an error, never silently skipped).
function customise(doc) {
  const fail = (why) => {
    console.error(`iam-policy: ${why}`);
    process.exit(2);
  };
  const values = {};
  const regions = value("--regions")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  for (const r of regions) if (!perms.validPlaceholder("REGION", r)) fail(`--regions: "${r}" isn't a region code`);
  if (new Set(regions).size === 1) values.REGION = regions[0];
  args.forEach((a, i) => {
    if (a !== "--set") return;
    const m = /^([A-Z_]+)=(.*)$/.exec(args[i + 1] ?? "");
    if (!m || !perms.PLACEHOLDERS.includes(m[1])) fail(`--set takes NAME=value, NAME one of ${perms.PLACEHOLDERS.join(", ")}`);
    if (!perms.validPlaceholder(m[1], m[2])) fail(`--set ${m[1]}: "${m[2]}" isn't valid there`);
    values[m[1]] = m[2];
  });
  let out = perms.fillPlaceholders(perms.forRegions(doc, regions), values);
  const principal = value("--principal");
  if (principal !== undefined) {
    if (!perms.validPrincipalArn(principal)) fail(`--principal: "${principal}" isn't an IAM role or user ARN`);
    out = perms.withPrincipal(out, principal);
  }
  return out;
}

if (value("--print")) {
  const mode = value("--print");
  if (mode !== "read" && mode !== "full") {
    console.error("iam-policy: --print takes read or full");
    process.exit(2);
  }
  const want = value("--providers")?.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = want?.filter((id) => !decls.some((d) => d.id === id)) ?? [];
  if (unknown.length) {
    console.error(`iam-policy: unknown provider(s): ${unknown.join(", ")} (known: ${decls.map((d) => d.id).join(", ")})`);
    process.exit(2);
  }
  const chosen = want ? decls.filter((d) => want.includes(d.id)) : decls;
  const built = perms.buildPolicy(chosen, mode, perms.baseStatements(await load(FILES[mode])));
  for (const s of built.skipped) console.error(`iam-policy: skipped ${s.action} (${s.provider}): ${s.why}`);
  const policy = customise(built.policy);
  const out = value("--out");
  if (!out) {
    process.stdout.write(text(policy));
    const size = perms.policySize(policy);
    if (size > perms.MANAGED_POLICY_LIMIT) console.error(`iam-policy: ${size} characters, over the ${perms.MANAGED_POLICY_LIMIT} managed-policy quota — use --out <dir> to split it`);
    process.exit(0);
  }
  const parts = perms.splitPolicy(policy);
  await mkdir(path.resolve(out), { recursive: true });
  for (const [i, part] of parts.entries()) {
    const file = path.resolve(out, `${perms.policyName(mode, i, parts.length)}.json`);
    await writeFile(file, text(part));
    console.log(file);
  }
  process.exit(0);
}

const check = flag("--check");
const stale = [];
for (const mode of ["read", "full"]) {
  const file = FILES[mode];
  const current = await load(file);
  const { policy, skipped } = perms.buildPolicy(decls, mode, perms.baseStatements(current));
  if (mode === "full") for (const s of skipped) console.warn(`iam-policy: skipped ${s.action} (${s.provider}): ${s.why}`);
  if (JSON.stringify(current) === JSON.stringify(policy)) continue;
  stale.push(file);
  if (!check) await writeFile(path.join(root, file), text(policy));
  const size = perms.policySize(policy);
  if (!check && size > perms.MANAGED_POLICY_LIMIT)
    console.warn(`iam-policy: ${file} is ${size} characters; AWS allows ${perms.MANAGED_POLICY_LIMIT} per managed policy — create it as parts (Settings → AWS permissions, or --print ${mode} --out <dir>)`);
}
const md = await readFile(path.join(root, DOCS), "utf8");
const nextMd = perms.withDocsSection(md, decls);
if (nextMd !== md) {
  stale.push(DOCS);
  if (!check) await writeFile(path.join(root, DOCS), nextMd);
}

const summary = `${decls.length} provider(s): ${decls.map((d) => d.id).join(", ") || "none registered"}`;
if (check) {
  if (stale.length) {
    console.error(`iam-policy: out of date: ${stale.join(", ")} — run npm run iam:policy`);
    process.exit(1);
  }
  console.log(`iam-policy: up to date (${summary})`);
} else {
  console.log(stale.length ? `iam-policy: wrote ${stale.join(", ")} (${summary})` : `iam-policy: nothing to change (${summary})`);
}

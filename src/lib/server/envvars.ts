// Environment variables of a service: list (names only), reveal (audited), and change.
// Plain values change by registering a new task-definition revision and deploying it; secret values are written to
// SSM / Secrets Manager and env files to S3, then the service restarts so new tasks read them.
// Values never appear in list responses, logs or the audit log.
//
// Shared backing objects (REVIEW R02, R05, F34): one SSM parameter, secret or env file can be read by several services,
// in several environments. Everything that reads or writes one goes by its strongest consumer — a protected consumer
// makes it protected, the console's own service makes it untouchable — and a save locks the service plus every
// object it writes (canonical keys, src/lib/mutation-keys.ts), combines the edits per object and writes each once,
// refusing when the object changed since it was read.
import "server-only";
import { createHmac } from "node:crypto";
import { CONSOLE_WRITES, VAR_REFERENCE_READS, VAR_REFERENCE_WRITES, combine, type VarReference } from "../capability-rules.ts";
import {
  MAX_VALUE, applyJsonKeys, backingOfFile, backingOfSecret, buildRefIndex, duplicateNames, editEnvFile, envFileVars, groupEdits, nameProblem,
  parseEnvFile, parseSecretRef, refLabel, sharingOf, summarize,
  type Consumer, type IndexInput, type RefIndex, type Sharing, type Summary, type VarChanges, type VarSource,
} from "../envvars.ts";
import { canonicalKey } from "../mutation-keys.ts";
import { can, roleFor, type User } from "../rbac.ts";
import type { CapState, EnvInfo } from "../types.ts";
import { cached, invalidate } from "./cache.ts";
import { capability } from "./capability.ts";
import { liveService, settle } from "./console.ts";
import { envInfo, inRegion, listEnvs, metaOf, selfOutsideEnvs, servicesOf, unreadRegions } from "./discovery.ts";
import { HttpError, errText } from "./errors.ts";
import { mutate, type MutationActor } from "./mutations.ts";
import { derivedKey } from "./secrets.ts";
import { cloudFor, getCloud, type Cloud, type ContainerEnv } from "./sources.ts";

// Another service that reads the same backing object, as the browser sees it.
export interface SharedWith {
  env: string;
  service: string;
  region: string;
  protected: boolean;
  self?: true; // the console's own service
}

export interface VarView {
  container: string;
  name: string;
  source: VarSource;
  ref?: string; // secret: parameter / secret name (never the value)
  file?: string; // env file: s3 object ARN
  sharedWith?: SharedWith[]; // other services reading the same parameter, secret or file
  lockedWhy?: string; // why this user can't reveal or change this one (a protected or console-owned consumer)
}

export interface VarsView {
  revision: string; // task definition ARN the list was read from — saves must name it
  containers: { name: string; main: boolean }[];
  vars: VarView[];
  files: { container: string; file: string; label: string; error?: string; sharedWith?: SharedWith[]; lockedWhy?: string }[];
  canReveal: boolean;
  revealWhy?: string; // why revealing is unavailable, or (with canReveal) what will fail
  canEdit: boolean;
  editWhy?: string; // why editing is unavailable, or (with canEdit) an AWS-permission warning
  why?: string; // = editWhy (older clients and the variables.list operation)
  capability?: "denied" | "probably-denied"; // the console's own AWS permissions for this (F06)
  protected: boolean; // saves follow the protected rules: the env is protected, or a protected service shares a reference
  envProtected: boolean;
  sharingUnknown?: string; // the shared-reference check is incomplete, so every reference counts as protected
}

const SOURCE_ORDER: Record<VarSource, number> = { plain: 0, file: 1, ssm: 2, secretsmanager: 2 };
const fileLabel = (arn: string) => arn.replace(/^arn:aws[\w-]*:s3:::/, "s3://");

// A secret referenced by ARN lives in the ARN's region (a task may read one from another region); a bare SSM parameter
// name, like an env file, is read in the env's region.
const secretRegion = (env: EnvInfo, valueFrom: string) => /^arn:aws[\w-]*:(?:ssm|secretsmanager):([a-z0-9-]+):/.exec(valueFrom)?.[1] ?? env.region;
const secretCloud = (env: EnvInfo, valueFrom: string): Promise<Cloud> => getCloud(secretRegion(env, valueFrom));

// ---------- the Cloud's env-file and secret-version calls ----------

// readEnvFile → { text, etag }, writeEnvFile(…, { ifMatch }) (S3 conditional write), secretVersion(valueFrom) (SSM
// Version / Secrets Manager VersionId of the whole document) and writeSecret(…, { ifVersion }): a write refuses with
// 409 when the object changed since this save read it. A source that still answers a bare string is read the same way.
type FileRead = { text: string; etag?: string };
async function readFileOf(cloud: Cloud, arn: string): Promise<FileRead> {
  const r = (await cloud.readEnvFile(arn)) as FileRead | string;
  return typeof r === "string" ? { text: r } : r;
}

// ---------- reading a service ----------

async function load(envId: string, service: string) {
  const env = await envInfo(envId);
  const live = await liveService(env, service);
  const arn = live.taskDef?.arn;
  if (!arn) throw new HttpError(409, "the service has no task definition yet");
  const cloud = await cloudFor(env);
  const [meta, containers] = await Promise.all([metaOf(env, live), cloud.containerEnv(arn)]);
  const main = live.taskDef?.main ?? containers[0]?.container;
  return { env, live, arn, meta, containers, main, cloud };
}

// Each env file once, however many containers list it.
async function readFiles(cloud: Cloud, containers: ContainerEnv[]) {
  const arns = [...new Set(containers.flatMap((c) => c.files))];
  const reads = await Promise.all(arns.map(async (file) => [file, await settle(readFileOf(cloud, file))] as const));
  return new Map(reads);
}
type Files = Awaited<ReturnType<typeof readFiles>>;

function currentVars(containers: ContainerEnv[], files: Files): VarView[] {
  const out: VarView[] = [];
  for (const c of containers) {
    for (const e of c.environment) out.push({ container: c.container, name: e.name, source: "plain" });
    for (const x of c.secrets) {
      const ref = parseSecretRef(x.valueFrom);
      out.push({ container: c.container, name: x.name, source: ref.kind, ref: refLabel(ref) });
    }
  }
  for (const c of containers)
    for (const file of c.files) {
      const r = files.get(file);
      if (r?.ok) for (const v of envFileVars(parseEnvFile(r.value.text))) out.push({ container: c.container, name: v.name, source: "file", file });
    }
  return out;
}

function editBlock(env: EnvInfo, user: User, self: boolean, inProgress: boolean): string | undefined {
  if (!can(user, "env", env.protected)) return `needs ${roleFor("env", env.protected)} role`;
  if (self) return "the console never changes its own service";
  if (inProgress) return "a rollout is in progress — wait for it to finish";
  return undefined;
}

// ---------- who else reads a backing object ----------

const INDEX_KEY = "vars:refs";

// Every live service's references, across every environment and region. Task definitions are immutable, so after the
// first build a refresh costs the ECS service listings (shared with the overview) and the new revisions only.
// Kept a minute (and served up to two more while a refresh runs) for lists and reveals; a save wants one at most
// `maxAgeMs` old (a service deployed since might read what it writes) and drops it afterwards.
async function refIndex(maxAgeMs = Infinity): Promise<RefIndex> {
  try {
    const read = () => cached(INDEX_KEY, 60_000, buildIndex, { staleMs: 120_000 });
    let r = await read();
    if (Date.now() - r.at > maxAgeMs) {
      invalidate(INDEX_KEY);
      r = await read();
    }
    return r.value;
  } catch (e) {
    return { byKey: new Map(), unknown: [`discovery failed: ${errText(e)}`] };
  }
}

async function buildIndex(): Promise<RefIndex> {
  const input: IndexInput = { services: [], unreadable: unreadRegions().map((r) => ({ what: `region ${r.region}: ${r.error}`, protected: "unknown" as const })) };
  const envs = await listEnvs();
  await Promise.all(
    envs.map(async (env) => {
      const services = await settle(servicesOf(env.cluster, env.region));
      if (!services.ok) {
        // Any service there could share a reference — the console's own included: unknown, whatever the env says.
        input.unreadable.push({ what: `${env.id}: ${services.error}`, protected: "unknown" });
        return;
      }
      const cloud = await cloudFor(env);
      await Promise.all(
        services.value.map(async (s) => {
          const arns = [...new Set([s.taskDef?.arn, ...s.deployments.filter((d) => d.status !== "INACTIVE").map((d) => d.taskDefinition)].filter((x): x is string => !!x))];
          const [meta, reads] = await Promise.all([settle(metaOf(env, s)), Promise.all(arns.map((a) => settle(cloud.containerEnv(a))))]);
          const failed = reads.find((r) => !r.ok);
          input.services.push({
            env: env.id, region: env.region, cluster: env.cluster, service: s.name, protected: env.protected,
            self: meta.ok ? meta.value.self : true, // can't tell → it might be the console
            containers: failed ? undefined : reads.flatMap((r) => (r.ok ? r.value : [])),
            why: failed && !failed.ok ? failed.error : undefined,
          });
        }),
      );
    }),
  );
  // The console's own cluster may be no environment at all (ignored, say): its services still read what they read.
  const own = await settle(selfOutsideEnvs());
  if (!own.ok) input.unreadable.push({ what: `the console's own service: ${own.error}`, protected: "unknown" });
  else if (own.value) {
    const { cluster, family, region } = own.value;
    const [services, cloud] = await Promise.all([settle(servicesOf(cluster, region)), getCloud(region)]);
    if (!services.ok) input.unreadable.push({ what: `the console's own cluster ${cluster}: ${services.error}`, protected: "unknown" });
    else
      await Promise.all(
        services.value
          .filter((s) => s.taskDef?.family === family || s.tags["console:self"] === "true")
          .map(async (s) => {
            const arns = [...new Set([s.taskDef?.arn, ...s.deployments.filter((d) => d.status !== "INACTIVE").map((d) => d.taskDefinition)].filter((x): x is string => !!x))];
            const reads = await Promise.all(arns.map((a) => settle(cloud.containerEnv(a))));
            const failed = reads.find((r) => !r.ok);
            input.services.push({
              env: cluster, region, cluster, service: s.name, protected: true, self: true,
              containers: failed ? undefined : reads.flatMap((r) => (r.ok ? r.value : [])),
              why: failed && !failed.ok ? failed.error : undefined,
            });
          }),
      );
  }
  return buildRefIndex(input);
}

const sharedView = (s: Sharing): SharedWith[] | undefined =>
  s.others.length ? s.others.map((c) => ({ env: c.env, service: c.service, region: c.region, protected: c.protected, ...(c.self ? { self: true as const } : {}) })) : undefined;
const consumerName = (c: Consumer) => `${c.env}/${c.service}`;

// Why this user may not reveal or change an object shared this way (undefined: they may, as far as sharing goes).
function sharedBlock(s: Sharing, user: User, unknownWhy: string): string | undefined {
  if (s.self) return `also used by the console's own service (${s.others.filter((c) => c.self).map(consumerName).join(", ")}) — the console never reads or changes its own secrets`;
  if (s.protected && !can(user, "env", true)) {
    const prot = s.others.filter((c) => c.protected).map(consumerName);
    return prot.length ? `shared with ${prot.join(", ")} (protected) — needs ${roleFor("env", true)} role` : `${unknownWhy} — needs ${roleFor("env", true)} role`;
  }
  return undefined;
}

const unknownText = (index: RefIndex) => `couldn't check which other services use it (${index.unknown.slice(0, 2).join("; ")}${index.unknown.length > 2 ? "; …" : ""})`;

// ---------- capability (F06) ----------

const kindOfSource = (s: VarSource): VarReference | undefined => (s === "file" ? "s3" : s === "plain" ? undefined : s);

function capabilities(vars: VarView[], files: { file: string }[]) {
  const kinds = [...new Set([...vars.map((v) => kindOfSource(v.source)), ...(files.length ? (["s3"] as const) : [])].filter((k): k is VarReference => !!k))];
  const ecs = capability(CONSOLE_WRITES["vars.edit"]);
  const refsWrite = capability(kinds.map((k) => VAR_REFERENCE_WRITES[k]));
  const reads = capability(kinds.map((k) => VAR_REFERENCE_READS[k]));
  const worst = combine([ecs.state, refsWrite.state, reads.state]);
  return {
    ecs, refsWrite, reads,
    capability: worst === "denied" || worst === "probably-denied" ? (worst as Extract<CapState, "denied" | "probably-denied">) : undefined,
  };
}

// ---------- list ----------

export async function listVars(envId: string, service: string, user: User): Promise<VarsView> {
  const { env, live, arn, meta, containers, main, cloud } = await load(envId, service);
  const [files, index] = await Promise.all([readFiles(cloud, containers), refIndex()]);
  const me = { env: env.id, service };
  const unknownWhy = unknownText(index);
  const secretRefs = new Map(containers.flatMap((c) => c.secrets.map((x) => [`${c.container} ${x.name}`, x.valueFrom] as const)));
  let sharedProtected = false;
  const share = (key: string) => {
    const s = sharingOf(key, index, me);
    if (s.protected || s.self) sharedProtected = true;
    return { sharedWith: sharedView(s), lockedWhy: sharedBlock(s, user, unknownWhy) };
  };
  const vars = currentVars(containers, files)
    .map((v): VarView => {
      if (v.source === "plain") return v;
      const key = v.source === "file" ? backingOfFile(v.file!).key : backingOfSecret(secretRefs.get(`${v.container} ${v.name}`) ?? "", env.region).key;
      const s = share(key);
      return { ...v, ...(s.sharedWith ? { sharedWith: s.sharedWith } : {}), ...(s.lockedWhy ? { lockedWhy: s.lockedWhy } : {}) };
    })
    .sort((a, b) => Number(b.container === main) - Number(a.container === main) || a.container.localeCompare(b.container) || SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || a.name.localeCompare(b.name));
  const fileViews = containers.flatMap((c) =>
    c.files.map((file) => {
      const r = files.get(file);
      const s = share(backingOfFile(file).key);
      return { container: c.container, file, label: fileLabel(file), error: r && !r.ok ? r.error : undefined, ...(s.sharedWith ? { sharedWith: s.sharedWith } : {}), ...(s.lockedWhy ? { lockedWhy: s.lockedWhy } : {}) };
    }),
  );

  const cap = capabilities(vars, fileViews);
  let editWhy = editBlock(env, user, meta.self, live.deployments.some((d) => d.rolloutState === "IN_PROGRESS"));
  const canEdit = !editWhy && cap.ecs.state !== "denied";
  if (!editWhy && cap.ecs.state === "denied") editWhy = cap.ecs.why;
  else if (!editWhy && (cap.ecs.state === "probably-denied" || cap.refsWrite.state === "denied" || cap.refsWrite.state === "probably-denied")) editWhy = cap.ecs.why ?? cap.refsWrite.why;

  const roleOk = can(user, "env", env.protected) && !meta.self;
  const hasPlain = vars.some((v) => v.source === "plain");
  const canReveal = roleOk && (cap.reads.state !== "denied" || hasPlain); // plain values need no reference reads
  const revealWhy = !roleOk
    ? meta.self ? "the console never reveals its own variables" : `needs ${roleFor("env", env.protected)} role`
    : cap.reads.state === "denied" || cap.reads.state === "probably-denied" ? `${cap.reads.why}${canReveal ? " — secret and env-file values may not be readable" : ""}` : undefined;

  return {
    revision: arn,
    containers: containers.map((c) => ({ name: c.container, main: c.container === main })),
    vars,
    files: fileViews,
    canReveal,
    ...(revealWhy ? { revealWhy } : {}),
    canEdit,
    ...(editWhy ? { editWhy, why: editWhy } : {}),
    ...(cap.capability ? { capability: cap.capability } : {}),
    protected: env.protected || sharedProtected,
    envProtected: env.protected,
    ...(index.unknown.length ? { sharingUnknown: unknownWhy } : {}),
  };
}

// Whether a save of this service's variables follows the protected rules: its environment is protected, or a protected
// (or console-owned) service reads one of its references, or that can't be told. Independent of who asks — the
// operations registry ORs it into the token gate and approvals (R02), so a direct 'act' token gets an approval rather
// than saveVars' refusal.
export async function varsProtected(envId: string, service: string): Promise<boolean> {
  return (await listVars(envId, service, { id: "", email: "", role: "viewer" })).protected;
}

// ---------- reveal ----------

// Values for every variable of the service. Each secret read can fail on its own (permissions, KMS); a reference that
// another service shares is withheld when that service's protection (or its being the console) says so.
// Reading secrets is itself worth a trail: who looked at which names, never what they saw. No trail, no values: the
// values leave only after the coordinator has committed the audit intent (it refuses with 503 when it can't). No
// resource is locked — a reveal changes nothing.
export async function revealVars(envId: string, service: string, user: User, ip: string | undefined) {
  const { env, arn, meta, containers, cloud } = await load(envId, service);
  if (!can(user, "env", env.protected)) throw new HttpError(403, `your role (${user.role}) can't read variable values — needs ${roleFor("env", env.protected)}`);
  // The console's own secrets (database URL, CONSOLE_SECRET_KEY, GitHub token) would hand whoever reads them the
  // console itself — every session, token and sealed secret. Nobody reads them through the console, admins included.
  if (meta.self) throw new HttpError(403, "the console never reveals its own variables");
  const index = await refIndex();
  const unknownWhy = unknownText(index);
  const blocked = (key: string) => sharedBlock(sharingOf(key, index, { env: env.id, service }), user, unknownWhy);
  type Revealed = VarView & { value?: string; error?: string };
  const r = await mutate(
    {
      action: "env.reveal", actor: actorOf(user, ip), env: { id: env.id, label: env.label, protected: env.protected, region: env.region }, target: service, keys: [],
      params: { revision: arn }, summarize: (x) => ({ revealed: (x as { values: Revealed[] }).values.filter((v) => v.value !== undefined).length }),
    },
    async (h) => {
      const values: Revealed[] = [];
      for (const c of containers) {
        for (const e of c.environment) values.push({ container: c.container, name: e.name, source: "plain", value: e.value });
        await Promise.all(
          c.secrets.map(async (x) => {
            const ref = parseSecretRef(x.valueFrom);
            const v: VarView = { container: c.container, name: x.name, source: ref.kind, ref: refLabel(ref) };
            const why = blocked(backingOfSecret(x.valueFrom, env.region).key);
            if (why) return void values.push({ ...v, error: why });
            const got = await settle(secretCloud(env, x.valueFrom).then((s) => s.readSecret(x.valueFrom)));
            values.push({ ...v, ...(got.ok ? { value: got.value } : { error: got.error }) });
          }),
        );
      }
      // Names of a withheld file are listed anyway (the list shows them too); only its values stay here.
      const files = await readFiles(cloud, containers);
      for (const c of containers)
        for (const file of c.files) {
          const why = blocked(backingOfFile(file).key);
          const got = files.get(file);
          if (got?.ok) for (const v of envFileVars(parseEnvFile(got.value.text))) values.push({ container: c.container, name: v.name, source: "file", file, ...(why ? { error: why } : { value: v.value }) });
        }
      await h.intent({ names: [...new Set(values.filter((v) => v.value !== undefined).map((v) => v.name))], withheld: [...new Set(values.filter((v) => v.value === undefined).map((v) => v.name))] });
      return { revision: arn, values };
    },
  );
  return r.result;
}

// ---------- change ----------

const isStrMap = (v: unknown): v is Record<string, string> => !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");
const isStrs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export function parseChangeBody(body: unknown): { revision: string; confirm: string; reason?: string; changes: VarChanges } {
  const b = (body ?? {}) as Record<string, unknown>;
  const own = (o: Record<string, unknown>, k: string) => (Object.hasOwn(o, k) ? o[k] : undefined);
  const c = (own(b, "changes") ?? {}) as Record<string, unknown>;
  const bad = (m: string) => new HttpError(400, m);
  const revision = own(b, "revision"), confirm = own(b, "confirm"), reason = own(b, "reason");
  if (typeof revision !== "string" || !revision) throw bad("revision is required (the task definition the edit started from)");
  if (typeof confirm !== "string") throw bad("confirm is required");
  if (reason !== undefined && (typeof reason !== "string" || reason.length > 500)) throw bad("reason must be a string ≤ 500 chars");
  const plain = (own(c, "plain") ?? []) as unknown[];
  const secrets = (own(c, "secrets") ?? []) as unknown[];
  const files = (own(c, "files") ?? []) as unknown[];
  if (![plain, secrets, files].every(Array.isArray)) throw bad("changes.plain, changes.secrets and changes.files must be lists");
  for (const p of plain as Record<string, unknown>[]) if (typeof p?.container !== "string" || !isStrMap(p.set ?? {}) || !isStrs(p.remove ?? [])) throw bad("changes.plain entries are { container, set: {NAME: value}, remove: [NAME] }");
  for (const x of secrets as Record<string, unknown>[]) if (typeof x?.container !== "string" || typeof x.name !== "string" || typeof x.value !== "string") throw bad("changes.secrets entries are { container, name, value }");
  for (const f of files as Record<string, unknown>[]) if (typeof f?.container !== "string" || typeof f.file !== "string" || !isStrMap(f.set ?? {}) || !isStrs(f.remove ?? [])) throw bad("changes.files entries are { container, file, set, remove }");
  // One entry per container (plain) and per file: two would each be planned and audited, but only one applied.
  // (Two containers editing one shared file are combined into one write later; conflicting edits are refused there.)
  const dupe = (keys: string[]) => keys.find((k, i) => keys.indexOf(k) !== i);
  const dp = dupe((plain as { container: string }[]).map((p) => p.container));
  if (dp) throw bad(`changes.plain has two entries for container "${dp}" — merge them into one`);
  const df = dupe((files as { container: string; file: string }[]).map((f) => `${f.container} ${f.file}`));
  if (df) throw bad(`changes.files has two entries for the same file — merge them into one`);
  const ds = dupe((secrets as { container: string; name: string }[]).map((x) => `${x.container} ${x.name}`));
  if (ds) throw bad(`changes.secrets sets the same secret twice — keep one`);
  return {
    revision,
    confirm,
    reason: typeof reason === "string" ? reason.trim() || undefined : undefined,
    changes: {
      plain: (plain as { container: string; set?: Record<string, string>; remove?: string[] }[]).map((p) => ({ container: p.container, set: { ...(p.set ?? {}) }, remove: [...(p.remove ?? [])] })),
      secrets: (secrets as VarChanges["secrets"]).map((x) => ({ container: x.container, name: x.name, value: x.value })),
      files: (files as { container: string; file: string; set?: Record<string, string>; remove?: string[] }[]).map((f) => ({ container: f.container, file: f.file, set: { ...(f.set ?? {}) }, remove: [...(f.remove ?? [])] })),
    },
  };
}

const actorOf = (user: User, ip: string | undefined): MutationActor => ({
  display: user.email,
  kind: / via token "|approving token "/.test(user.email) ? "token" : "person", // ops/index.ts writes the token into the display name
  userId: user.id,
  ip,
});

export async function saveVars(envId: string, service: string, body: unknown, user: User, ip: string | undefined) {
  const req = parseChangeBody(body);
  // Bad names are bad whatever the service is doing: report them before state conflicts (rollout, stale revision).
  for (const p of [...req.changes.plain, ...req.changes.files])
    for (const n of Object.keys(p.set)) {
      const problem = nameProblem(n);
      if (problem) throw new HttpError(400, problem);
    }
  const { env, live, arn, meta, containers, cloud } = await load(envId, service);
  const why = editBlock(env, user, meta.self, live.deployments.some((d) => d.rolloutState === "IN_PROGRESS"));
  if (why) throw new HttpError(why.startsWith("needs") ? 403 : 409, why);
  if (req.revision !== arn) throw new HttpError(409, "the service changed since you opened the editor — reload the variables and make your change again");

  // Validate everything before touching anything. The containers are those of req.revision, which never changes.
  const byName = new Map(containers.map((c) => [c.container, c]));
  const container = (name: string) => byName.get(name) ?? (() => { throw new HttpError(400, `no container "${name}" in this task definition`); })();
  const tooLong = (v: string, n: string) => {
    if (v.length > MAX_VALUE) throw new HttpError(400, `${n} is longer than ${MAX_VALUE} characters`);
  };
  const plainEdits: { container: string; environment: { name: string; value: string }[] }[] = [];
  for (const p of req.changes.plain) {
    const c = container(p.container);
    if (!Object.keys(p.set).length && !p.remove.length) continue; // an empty entry would register a revision for nothing
    for (const [n, v] of Object.entries(p.set)) tooLong(v, n);
    for (const n of p.remove) if (!c.environment.some((e) => e.name === n)) throw new HttpError(400, `${n} isn't a plain variable of ${p.container}`);
    const next = c.environment.filter((e) => !p.remove.includes(e.name)).map((e) => (Object.hasOwn(p.set, e.name) ? { name: e.name, value: p.set[e.name] } : e));
    for (const [n, v] of Object.entries(p.set)) if (!next.some((e) => e.name === n)) next.push({ name: n, value: v });
    const dup = duplicateNames(next, c.secrets);
    if (dup.length) throw new HttpError(400, `${dup.join(", ")} already exists as a secret in ${p.container} — a name can only be defined once`);
    plainEdits.push({ container: p.container, environment: next });
  }
  const secretEdits = req.changes.secrets.map((x) => {
    const ref = container(x.container).secrets.find((s) => s.name === x.name);
    if (!ref) throw new HttpError(400, `${x.name} isn't a secret of ${x.container}`);
    const pr = parseSecretRef(ref.valueFrom);
    if (pr.kind === "secretsmanager" && (pr.versionStage || pr.versionId))
      throw new HttpError(400, `${x.name} pins a secret version — a new value wouldn't reach the service; update the secret in AWS and the reference together`);
    if (!x.value) throw new HttpError(400, `a new value for ${x.name} can't be empty`);
    tooLong(x.value, x.name);
    return { ...x, valueFrom: ref.valueFrom };
  });
  for (const f of req.changes.files) {
    if (!container(f.container).files.includes(f.file)) throw new HttpError(400, `${fileLabel(f.file)} isn't an env file of ${f.container}`);
    for (const [n, v] of Object.entries(f.set)) {
      tooLong(v, n);
      // Env files are one variable per line: a line break in a value would smuggle in more variables (reserved names
      // included) that the plan and audit never show.
      if (/[\r\n]/.test(v)) throw new HttpError(400, `${n}: values in an env file can't contain line breaks`);
    }
  }
  // One write per backing object: edits through several containers (or variables) that land on the same parameter,
  // secret or file are combined; ones that disagree are refused (REVIEW R05).
  const writes = groupEdits(secretEdits, req.changes.files, env.region);
  if (writes.conflicts.length) throw new HttpError(409, `conflicting edits: ${writes.conflicts.join("; ")}`);
  if (!plainEdits.length && !writes.secrets.length && !writes.files.length) throw new HttpError(400, "nothing to change");

  // The strongest consumer of every object this save writes decides (REVIEW R02, F34).
  const index = await refIndex(10_000);
  const unknownWhy = unknownText(index);
  const sharing = [...writes.secrets.map((w) => [w.label, sharingOf(w.key, index, { env: env.id, service })] as const), ...writes.files.map((w) => [w.label, sharingOf(w.key, index, { env: env.id, service })] as const)];
  for (const [label, s] of sharing) {
    const block = sharedBlock(s, user, unknownWhy);
    if (block) throw new HttpError(403, `${label}: ${block}`);
  }
  const others = [...new Map(sharing.flatMap(([, s]) => s.others).map((c) => [`${c.region} ${c.cluster} ${c.service}`, c])).values()];
  const strict = env.protected || sharing.some(([, s]) => s.protected);
  // An "act" token changes an unprotected environment without asking anyone (gate() in src/lib/automation.ts); through a
  // shared reference that would reach a protected service's value without the approval its environment requires.
  // Approved requests run as `<person> approving token "…"` and pass.
  if (strict && !env.protected && / via token "/.test(user.email)) {
    const prot = sharing.filter(([, s]) => s.protected).map(([l]) => l);
    throw new HttpError(403, `${prot.join(", ")}: shared with a protected service (or the check is incomplete) — an API token can change it only through an approved request; use a token in "propose" mode`);
  }
  // The service name is the strong confirmation; it is also accepted where "yes" would do (a client that follows the
  // listing's `protected` asks for it whenever a shared reference is protected, even for a save that doesn't touch it).
  if (strict ? req.confirm !== service : req.confirm !== "yes" && req.confirm !== service) {
    const prot = sharing.filter(([, s]) => s.protected).map(([l]) => l);
    throw new HttpError(400, `confirmation text does not match (expected "${strict ? service : "yes"}")${!env.protected && prot.length ? ` — ${prot.join(", ")} ${prot.length === 1 ? "is" : "are"} shared with a protected service` : ""}`);
  }
  if (strict && (!req.reason || req.reason.length < 3)) throw new HttpError(400, env.protected ? "a reason is required on a protected environment" : "a reason is required: this changes a value a protected service reads");

  const keys = [
    canonicalKey({ ecsService: { region: env.region, cluster: env.cluster, service } }),
    ...writes.secrets.map((w) => w.key),
    ...writes.files.map((w) => w.key),
    ...others.map((c) => canonicalKey({ ecsService: { region: c.region, cluster: c.cluster, service: c.service } })),
  ];
  const alsoUsedBy = others.map(consumerName);
  let newRevision: string | undefined;
  try {
    const r = await mutate(
      {
        action: "env.update", actor: actorOf(user, ip), env: { id: env.id, label: env.label, protected: strict, region: env.region }, target: service, keys, reason: req.reason,
        params: { from: arn, objects: [...writes.secrets.map((w) => w.label), ...writes.files.map((w) => w.label)], alsoUsedBy },
      },
      async (h) => {
        // Under the lock: the service, the files and the secret versions as they are now.
        invalidate(`svc:${inRegion(env.cluster, env.region)}`);
        const now = await liveService(env, service);
        if (now.taskDef?.arn !== req.revision) throw new HttpError(409, "the service changed since you opened the editor — reload the variables and make your change again");
        if (now.deployments.some((d) => d.rolloutState === "IN_PROGRESS")) throw new HttpError(409, "a rollout is in progress — wait for it to finish");
        const fileState = await Promise.all(
          writes.files.map(async (w) => {
            const cur = await settle(readFileOf(cloud, w.file));
            if (!cur.ok) throw new HttpError(409, `can't read ${w.label}: ${cur.error}`);
            const names = new Set(envFileVars(parseEnvFile(cur.value.text)).map((v) => v.name));
            for (const n of w.remove) if (!names.has(n)) throw new HttpError(400, `${n} isn't in ${w.label}`);
            return { w, etag: cur.value.etag, before: cur.value.text, text: editEnvFile(cur.value.text, w.set, w.remove) };
          }),
        );
        const secretState = await Promise.all(
          writes.secrets.map(async (w) => {
            const valueFrom = w.kind === "ssm" ? w.valueFrom : w.secretId;
            const sc = await secretCloud(env, valueFrom);
            const version = await sc.secretVersion(valueFrom); // before the document, so a change in between is caught
            const value = w.kind === "ssm" ? w.value : w.whole ?? applyJsonKeys(await sc.readSecret(w.secretId), w.jsonKeys);
            return { w, sc, valueFrom, version, value };
          }),
        );
        const current = currentVars(containers, new Map(fileState.map((f) => [f.w.file, { ok: true as const, value: { text: f.before } }])));
        const plan: Summary[] = summarize({ plain: req.changes.plain, secrets: req.changes.secrets, files: writes.files.map((w) => ({ container: w.containers.join(", "), file: w.file, set: w.set, remove: w.remove })) }, current);
        if (!plan.length) throw new HttpError(400, "nothing to change");

        await h.intent({ plan });
        const applied: string[] = [];
        try {
          for (const s of secretState) {
            await s.sc.writeSecret(s.valueFrom, s.value, s.version ? { ifVersion: s.version } : undefined);
            applied.push(s.w.kind === "ssm" ? `parameter ${s.w.label}` : `secret ${s.w.label}`);
          }
          for (const f of fileState) {
            await cloud.writeEnvFile(f.w.file, f.text, f.etag ? { ifMatch: f.etag } : undefined);
            applied.push(f.w.label);
          }
          let requestId: string;
          if (plainEdits.length) {
            newRevision = await cloud.registerWithEnv(arn, plainEdits);
            applied.push(`revision ${newRevision.split(":").pop()}`);
            requestId = await cloud.updateService(env.cluster, service, { taskDefinition: newRevision });
          } else {
            // Secrets and env files are read when a task starts: restart so the new values take effect.
            requestId = await cloud.updateService(env.cluster, service, { force: true });
          }
          h.requestId(requestId);
          return { requestId, plan };
        } catch (e) {
          // Keep the error itself (its status, and whether AWS may have acted); say what already happened.
          if (applied.length && e instanceof Error) e.message = `${errText(e)} — already applied: ${applied.join(", ")}`;
          throw e;
        }
      },
    );
    return {
      ok: true, operationId: r.operationId, requestId: r.result.requestId, revision: newRevision, restarted: !plainEdits.length, plan: r.result.plan,
      ...(alsoUsedBy.length ? { alsoUsedBy } : {}),
    };
  } finally {
    invalidate(`svc:${inRegion(env.cluster, env.region)}`);
    invalidate(`events:${inRegion(env.cluster, env.region)}:${service}`);
    if (live.taskDef?.family) invalidate(`revs:${inRegion(live.taskDef.family, env.region)}`);
    invalidate(INDEX_KEY);
  }
}

// ---------- fingerprints (wave C config drift) ----------

// HMAC-SHA256 of each value under a key derived from CONSOLE_SECRET_KEY (label "var-fingerprint"): two equal values
// give equal fingerprints, and nothing else can be learned without the key. Server-only: never returned to a browser,
// an API token or a model — the config-drift operation compares them and reports same / different / missing.
// `fingerprint: null` = the value couldn't be read, or the console's own service shares it (the console's own service
// itself is refused outright).
export async function varFingerprints(envId: string, service: string): Promise<{ container: string; name: string; source: VarSource; ref?: string; fingerprint: string | null }[]> {
  const { env, meta, containers, cloud } = await load(envId, service);
  if (meta.self) throw new HttpError(403, "the console never reads its own variables");
  // A reference the console's own service shares is the console's secret too: not even read for a digest.
  const index = await refIndex();
  const ownSecret = (key: string) => sharingOf(key, index, { env: env.id, service }).self;
  const key = derivedKey("var-fingerprint");
  const fp = (v: string) => createHmac("sha256", key).update(v, "utf8").digest("base64url");
  const out: { container: string; name: string; source: VarSource; ref?: string; fingerprint: string | null }[] = [];
  for (const c of containers) {
    for (const e of c.environment) out.push({ container: c.container, name: e.name, source: "plain", fingerprint: fp(e.value) });
    await Promise.all(
      c.secrets.map(async (x) => {
        const ref = parseSecretRef(x.valueFrom);
        if (ownSecret(backingOfSecret(x.valueFrom, env.region).key)) return void out.push({ container: c.container, name: x.name, source: ref.kind, ref: refLabel(ref), fingerprint: null });
        const r = await settle(secretCloud(env, x.valueFrom).then((s) => s.readSecret(x.valueFrom)));
        out.push({ container: c.container, name: x.name, source: ref.kind, ref: refLabel(ref), fingerprint: r.ok ? fp(r.value) : null });
      }),
    );
  }
  const files = await readFiles(cloud, containers);
  for (const c of containers)
    for (const file of c.files) {
      const r = files.get(file);
      const own = ownSecret(backingOfFile(file).key);
      if (r?.ok) for (const v of envFileVars(parseEnvFile(r.value.text))) out.push({ container: c.container, name: v.name, source: "file", ref: fileLabel(file), fingerprint: own ? null : fp(v.value) });
    }
  return out.sort((a, b) => a.container.localeCompare(b.container) || a.name.localeCompare(b.name));
}


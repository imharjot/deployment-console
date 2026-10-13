// Versioned agent definitions (master plan §6 C7 item 3, §3.5): what an external agent token or a run is bound to —
// instructions, the allowed tools and policy, and model requirements — under a `config_hash` over all of it. Every
// save is a new immutable version; resolveDefinition() (auth/agent-tokens.ts) binds the newest unarchived one, and the
// six built-in templates (DEFAULT_POLICIES) are listed alongside as version 0. People only (the routes); every change
// is audited before it is written, and refused when the audit row can't be.
import "server-only";
import { createHash } from "node:crypto";
import { DEFAULT_POLICIES, HARD_DENY, isTemplateName, policyHash, policyProblems, type TemplateName } from "../../agents/policy.ts";
import type { AgentDefinitionRow } from "../../agents/records.ts";
import { TEMPLATES } from "../../agents/templates.ts";
import type { AgentPolicy } from "../../agents/types.ts";
import { canonicalJson } from "../../plan-hash.ts";
import { can, type User } from "../../rbac.ts";
import { auditOrFail } from "../auth/audit.ts";
import { getDb, newId } from "../db.ts";
import { HttpError } from "../errors.ts";

export interface ModelRequirements {
  provider?: string; // "anthropic", "openai", … — absent: any connection
  model?: string;
  capabilities?: string[]; // "tools", "streaming", …
}

export interface DefinitionItem {
  id: string;
  version: number;
  name: string;
  mode: AgentPolicy["mode"];
  tools: AgentPolicy["tools"];
  policyHash: string;
  configHash: string;
  createdAt: number;
  owner: string | null;
  instructions?: string;
  modelReq?: ModelRequirements;
  policy?: AgentPolicy;
  builtIn?: boolean;
  archivedAt?: number;
}

const MAX_INSTRUCTIONS = 20_000;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string) => (Object.hasOwn(o, k) ? o[k] : undefined);

export const configHash = (d: { name: string; instructions: string; policy: AgentPolicy; modelReq: ModelRequirements }) =>
  `sha256:${createHash("sha256").update(canonicalJson({ v: 1, ...d })).digest("hex")}`;

// A change an agent could never make whatever its policy says (variables.update, the administrative areas): listing
// it would only mislead whoever reads the definition.
const deniedTools = (p: AgentPolicy): string[] =>
  [...p.tools.propose, ...p.tools.act].filter((t) => HARD_DENY.ops.includes(t) || HARD_DENY.areas.includes(t.split(".")[0]));

interface Parsed {
  name: string;
  instructions: string;
  policy: AgentPolicy;
  modelReq: ModelRequirements;
}

// { name, instructions?, template?, policy?, modelReq? } → the definition's content. A template fills the policy when
// none is given; own properties only, unknown fields refused.
export function parseDefinition(b: unknown, prev?: Parsed): Parsed {
  if (!isObj(b)) throw new HttpError(400, "body must be a JSON object");
  const problems: string[] = [];
  for (const k of Object.keys(b)) if (!["name", "instructions", "template", "policy", "modelReq", "action"].includes(k)) problems.push(`unknown field ${k}`);
  const name = own(b, "name") ?? prev?.name;
  if (typeof name !== "string" || !name.trim() || name.length > 100) problems.push("name must be text (≤ 100 characters)");
  const instructions = own(b, "instructions") ?? prev?.instructions ?? "";
  if (typeof instructions !== "string" || instructions.length > MAX_INSTRUCTIONS) problems.push(`instructions must be text (≤ ${MAX_INSTRUCTIONS} characters)`);
  const template = own(b, "template");
  if (template !== undefined && !isTemplateName(template)) problems.push(`template must be one of ${Object.keys(DEFAULT_POLICIES).join(", ")}`);
  const policy = own(b, "policy") ?? (template ? structuredClone(DEFAULT_POLICIES[template as TemplateName]) : prev?.policy);
  if (policy === undefined) problems.push("a policy or a template is required");
  else {
    problems.push(...policyProblems(policy).map((x) => `policy: ${x}`));
    if (!problems.length) {
      const denied = deniedTools(policy as AgentPolicy);
      if (denied.length) problems.push(`policy: agents can never use ${denied.join(", ")}`);
    }
  }
  const m = own(b, "modelReq") ?? prev?.modelReq ?? {};
  if (!isObj(m)) problems.push("modelReq must be an object");
  else {
    for (const k of Object.keys(m)) if (!["provider", "model", "capabilities"].includes(k)) problems.push(`modelReq: unknown field ${k}`);
    for (const k of ["provider", "model"]) if (own(m, k) !== undefined && (typeof own(m, k) !== "string" || String(own(m, k)).length > 100)) problems.push(`modelReq.${k} must be text`);
    const caps = own(m, "capabilities");
    if (caps !== undefined && !(Array.isArray(caps) && caps.length <= 20 && caps.every((c) => typeof c === "string" && c.length <= 50))) problems.push("modelReq.capabilities must be a list of names");
  }
  if (problems.length) throw new HttpError(400, `invalid agent definition: ${problems.join("; ")}`);
  return { name: (name as string).trim(), instructions: instructions as string, policy: policy as AgentPolicy, modelReq: m as ModelRequirements };
}

const parseJson = <T>(s: string | null, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

function item(r: AgentDefinitionRow, full = false): DefinitionItem {
  const policy = parseJson<AgentPolicy | null>(r.policy, null);
  const empty: AgentPolicy["tools"] = { read: [], propose: [], act: [], deny: [] };
  return {
    id: r.id,
    version: Number(r.version),
    name: r.name,
    mode: policy?.mode ?? "observe",
    tools: policy?.tools ?? empty,
    policyHash: policy ? policyHash(policy) : "",
    configHash: r.config_hash,
    createdAt: Number(r.created_at),
    owner: r.owner_id,
    ...(r.archived_at ? { archivedAt: Number(r.archived_at) } : {}),
    ...(full ? { instructions: r.instructions ?? "", modelReq: parseJson<ModelRequirements>(r.model_req, {}), ...(policy ? { policy } : {}) } : {}),
  };
}

export function builtInDefinitions(full = false): DefinitionItem[] {
  return TEMPLATES.map((t) => {
    const policy = DEFAULT_POLICIES[t.name];
    return {
      id: t.name, version: 0, name: t.title, mode: policy.mode, tools: policy.tools, policyHash: policyHash(policy),
      configHash: configHash({ name: t.title, instructions: t.description, policy, modelReq: {} }), createdAt: 0, owner: null, builtIn: true,
      ...(full ? { instructions: t.description, modelReq: {}, policy } : {}),
    };
  });
}

// The newest version of every definition that isn't archived (archived ones with ?all), then the built-in templates.
export async function listDefinitions(o: { archived?: boolean } = {}): Promise<DefinitionItem[]> {
  const rows = await (await getDb()).all<AgentDefinitionRow>(
    `SELECT d.* FROM agent_definitions d WHERE d.version = (SELECT MAX(x.version) FROM agent_definitions x WHERE x.id = d.id)${o.archived ? "" : " AND d.archived_at IS NULL"} ORDER BY d.created_at DESC LIMIT 500`,
  );
  return [...rows.map((r) => item(r)), ...builtInDefinitions()];
}

export async function getDefinition(id: string): Promise<{ definition: DefinitionItem; versions: DefinitionItem[] }> {
  if (isTemplateName(id)) {
    const d = builtInDefinitions(true).find((x) => x.id === id)!;
    return { definition: d, versions: [d] };
  }
  const rows = await (await getDb()).all<AgentDefinitionRow>("SELECT * FROM agent_definitions WHERE id = ? ORDER BY version DESC LIMIT 100", [String(id).slice(0, 100)]);
  if (!rows.length) throw new HttpError(404, "no such agent definition");
  return { definition: item(rows[0], true), versions: rows.map((r) => item(r)) };
}

// Developers and up: a definition is a ceiling, and the person a token acts for still needs the role for each call.
function mayEdit(user: User) {
  if (!can(user, "act")) throw new HttpError(403, `your role (${user.role}) can't create agent definitions — needs developer`);
}

async function insert(id: string, version: number, user: User, p: Parsed, ip: string | undefined, action: "create" | "save"): Promise<DefinitionItem> {
  const now = Date.now();
  const hash = configHash(p);
  const db = await getDb();
  await db.tx(async (tx) => {
    await auditOrFail({ action: `agent_definition.${action}`, actor: user.email, target: p.name, ip, params: { id, version, mode: p.policy.mode, configHash: hash } });
    await tx.run(
      `INSERT INTO agent_definitions (id, version, owner_id, name, config_hash, instructions, tools, policy, model_req, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, version, user.id, p.name, hash, p.instructions, JSON.stringify(p.policy.tools), JSON.stringify(p.policy), JSON.stringify(p.modelReq), now],
    );
  });
  return (await getDefinition(id)).definition;
}

export async function createDefinition(user: User, body: unknown, ip?: string): Promise<DefinitionItem> {
  mayEdit(user);
  return insert(newId(), 1, user, parseDefinition(body), ip, "create");
}

// A save is a new version (earlier ones stay as they were: tokens bound to them keep their policy hash).
export async function saveDefinition(user: User, id: string, body: unknown, ip?: string): Promise<DefinitionItem> {
  mayEdit(user);
  if (isTemplateName(id)) throw new HttpError(409, "built-in templates can't be edited — create a definition from one");
  const cur = await (await getDb()).get<AgentDefinitionRow>("SELECT * FROM agent_definitions WHERE id = ? ORDER BY version DESC LIMIT 1", [id]);
  if (!cur) throw new HttpError(404, "no such agent definition");
  if (cur.archived_at) throw new HttpError(409, "this definition is archived");
  if (cur.owner_id !== user.id && !can(user, "admin")) throw new HttpError(403, "only its owner or an admin can change this definition");
  const prev: Parsed = {
    name: cur.name, instructions: cur.instructions ?? "", policy: parseJson<AgentPolicy>(cur.policy, DEFAULT_POLICIES["incident-investigator"]), modelReq: parseJson<ModelRequirements>(cur.model_req, {}),
  };
  const next = parseDefinition(body, prev);
  if (configHash(next) === cur.config_hash) return item(cur, true);
  return insert(id, Number(cur.version) + 1, user, next, ip, "save");
}

// Archived definitions mint no new tokens (resolveDefinition skips them); tokens already minted keep working until they
// expire or someone revokes them.
export async function archiveDefinition(user: User, id: string, ip?: string): Promise<DefinitionItem> {
  if (isTemplateName(id)) throw new HttpError(409, "built-in templates can't be archived");
  const db = await getDb();
  const cur = await db.get<AgentDefinitionRow>("SELECT * FROM agent_definitions WHERE id = ? ORDER BY version DESC LIMIT 1", [id]);
  if (!cur) throw new HttpError(404, "no such agent definition");
  if (cur.owner_id !== user.id && !can(user, "admin")) throw new HttpError(403, "only its owner or an admin can archive this definition");
  if (!cur.archived_at)
    await db.tx(async (tx) => {
      await auditOrFail({ action: "agent_definition.archive", actor: user.email, target: cur.name, ip, params: { id } });
      await tx.run("UPDATE agent_definitions SET archived_at = ? WHERE id = ? AND archived_at IS NULL", [Date.now(), id]);
    });
  return (await getDefinition(id)).definition;
}

// console.config.json — optional. Discovery works without it; the file only adds what AWS can't tell us
// (friendly names, repos, external systems, dependencies behind secrets) or overrides a guess.
import { healthcheckProblem } from "./discovery-rules.ts";
import { MAX_REGIONS, REGION_CODE } from "./regions.ts";
import type { EdgeKind } from "./types.ts";

export interface EnvOverride {
  cluster?: string; // ECS cluster name — or:
  host?: string; // EC2 instance id of a box that runs the env with docker compose (its apps are `workloads` with this env)
  label?: string;
  protected?: boolean;
  branch?: string;
  order?: number;
  databases?: string[]; // RDS instance ids that belong to this env
  caches?: string[]; // ElastiCache replication group / cluster ids
  routes?: { host: string; service: string; port?: number }[]; // ingress host → service, for envs without a load balancer
  region?: string; // pins the id to the cluster of this name in this region (multi-region: the same name can exist in two)
}

export interface Workload {
  name: string; // "Live Core"
  env?: string; // environment id ("staging")
  host?: string; // EC2 instance id it runs on
  platform?: string; // shown as-is: "docker compose", "Railway", "Kubernetes on-prem"
  healthcheck?: string; // URL probed live (HTTP 200 = up)
  url?: string; // where it answers (its hostname lets DNS records, CDNs and other apps' settings point at it)
  repo?: string; // "owner/name" on GitHub
  note?: string;
  uses?: string[]; // what it talks to: resource keys ("rds:acme-staging-pg"), names, hostnames, ARNs, or other workload ids
}

export interface ServiceOverride {
  name?: string;
  repo?: string; // "owner/name" on GitHub
  healthcheck?: string | Record<string, string>; // URL, or per env id
  migrations?: string[]; // repo paths; a rollback across a change here needs an acknowledgement
  infra?: boolean; // shown, but not app code (no CI, no releases)
  hidden?: boolean;
}

export interface ConsoleConfig {
  environments?: Record<string, EnvOverride>;
  discoverClusters?: boolean; // default true; false = only the clusters listed in `environments`
  ignoreClusters?: string[];
  services?: Record<string, ServiceOverride>;
  externals?: Record<string, { label: string; sub?: string; note?: string; side?: "source" | "destination" }>;
  connections?: { from: string; to: string; label?: string; kind?: EdgeKind; envs?: string[] }[];
  github?: { owner?: string };
  pricing?: { fargateVcpuHour?: number; fargateGbHour?: number; multiplier?: number }; // list-price estimates (Costs page)
  costs?: { tagKey?: string; spikePercent?: number; cacheHours?: number }; // Cost Explorer (Costs page)
  provisioning?: { enabled?: boolean; maxTasks?: number; maxHosts?: number; allowedInstanceTypes?: string[]; allowedImageRegistries?: string[] }; // Create & scale (docs/provisioning.md)
  inventory?: InventoryConfig; // cloud map (docs/cloud-map.md)
  ci?: { deployments?: CiDeployment[] }; // which workflows deploy where (R03)
  // Apps AWS can't see as services — containers run by docker compose on an EC2 box, or something on another
  // platform — so the cloud map can still show them, on their host, with a live health check (docs/cloud-map.md).
  workloads?: Record<string, Workload>;
}

export interface InventoryConfig {
  idleDays?: number;
  unassignedProtected?: boolean;
  // Regions the console reads, home first (CONSOLE_REGIONS wins): a list, or every region enabled in the account.
  regions?: string[] | "all-enabled";
  providers?: { include?: string[]; exclude?: string[] }; // provider ids to run only / never (Settings → AWS permissions shows ids)
  catchAll?: { config?: boolean; cloudControlTypes?: string[] }; // opt-in catch-all sources: AWS Config, Cloud Control types
}

// A workflow that deploys: re-running it is a deploy to `env`, whatever the workflow is called (R03).
export interface CiDeployment {
  repo: string; // "owner/name"
  workflow: string; // ".github/workflows/deploy.yml"
  env: string; // environment id it deploys to
  inputs?: Record<string, string>; // workflow_dispatch inputs that select this target, when one workflow deploys several envs
}

const KINDS = ["http", "sql", "cache", "stream", "api"];
const ENV_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strs = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");

const INSTANCE_ID = /^i-[0-9a-f]{8,17}$/;
const ENV_KEYS = ["cluster", "host", "label", "protected", "branch", "order", "databases", "caches", "routes", "region"];
// Keys each section understands, as console.config.schema.json lists them (src/lib/console-config.test.ts keeps the two
// equal). A key outside them is reported, never silently ignored: a misspelt "maxTask" or "hiden" would otherwise
// quietly fall back to the default.
export const SECTION_KEYS = {
  services: ["name", "repo", "healthcheck", "migrations", "infra", "hidden"],
  pricing: ["fargateVcpuHour", "fargateGbHour", "multiplier"],
  costs: ["tagKey", "spikePercent", "cacheHours"],
  provisioning: ["enabled", "maxTasks", "maxHosts", "allowedInstanceTypes", "allowedImageRegistries"],
  workloads: ["name", "env", "host", "platform", "healthcheck", "url", "repo", "note", "uses"],
} as const;
const reportUnknown = (v: Record<string, unknown>, known: readonly string[], at: string, errors: string[]) => {
  for (const k of Object.keys(v)) if (!known.includes(k)) errors.push(`unknown key "${at}.${k}"`);
};

// Lenient: keeps every valid part, reports every invalid one (shown under Settings → Environments). A wrongly typed
// value is never applied — a "protected": "yes" that silently meant nothing would leave production unprotected.
export function parseConfig(raw: unknown): { config: ConsoleConfig; errors: string[] } {
  const errors: string[] = [];
  const config: ConsoleConfig = {};
  if (raw === undefined || raw === null) return { config, errors };
  if (!isObj(raw)) return { config, errors: ["config must be a JSON object"] };
  const known = new Set(["$schema", "environments", "discoverClusters", "ignoreClusters", "services", "externals", "connections", "github", "pricing", "costs", "provisioning", "inventory", "workloads", "ci"]);
  for (const k of Object.keys(raw)) if (!known.has(k)) errors.push(`unknown key "${k}"`);

  if (raw.environments !== undefined) {
    if (!isObj(raw.environments)) errors.push("environments must be an object keyed by env id");
    else {
      config.environments = {};
      for (const [id, v] of Object.entries(raw.environments)) {
        if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) errors.push(`environments.${id}: id must be lowercase letters, digits and dashes`);
        else if (!isObj(v) || (typeof v.cluster === "string" && v.cluster.trim() ? 1 : 0) + (v.host !== undefined ? 1 : 0) !== 1)
          errors.push(`environments.${id}: one of "cluster" (ECS cluster name) or "host" (EC2 instance id of a docker compose box) is required`);
        else if (v.host !== undefined && (typeof v.host !== "string" || !INSTANCE_ID.test(v.host))) errors.push(`environments.${id}.host must be an EC2 instance id (i-…)`);
        else {
          const e: EnvOverride = typeof v.host === "string" ? { host: v.host } : { cluster: v.cluster as string };
          const at = `environments.${id}`;
          for (const k of Object.keys(v)) if (!ENV_KEYS.includes(k)) errors.push(`unknown key "${at}.${k}"`);
          if (typeof v.label === "string" && v.label.trim()) e.label = v.label;
          else if (v.label !== undefined) errors.push(`${at}.label must be a non-empty string`);
          if (typeof v.protected === "boolean") e.protected = v.protected;
          else if (v.protected !== undefined) errors.push(`${at}.protected must be true or false`);
          if (typeof v.branch === "string" && v.branch.trim()) e.branch = v.branch;
          else if (v.branch !== undefined) errors.push(`${at}.branch must be a branch name`);
          if (typeof v.order === "number" && Number.isFinite(v.order)) e.order = v.order;
          else if (v.order !== undefined) errors.push(`${at}.order must be a number`);
          if (v.databases !== undefined) {
            if (strs(v.databases)) e.databases = v.databases as string[];
            else errors.push(`environments.${id}.databases must be a list of ids`);
          }
          if (v.caches !== undefined) {
            if (strs(v.caches)) e.caches = v.caches as string[];
            else errors.push(`environments.${id}.caches must be a list of ids`);
          }
          if (v.routes !== undefined) {
            const ok = Array.isArray(v.routes) && v.routes.every((r) => isObj(r) && typeof r.host === "string" && typeof r.service === "string");
            if (ok) e.routes = v.routes as EnvOverride["routes"];
            else errors.push(`environments.${id}.routes must be [{ host, service, port? }]`);
          }
          if (typeof v.region === "string" && REGION_CODE.test(v.region)) e.region = v.region;
          else if (v.region !== undefined) errors.push(`environments.${id}.region must be an AWS region code (e.g. eu-west-1)`);
          config.environments[id] = e;
        }
      }
    }
  }
  if (raw.discoverClusters !== undefined) {
    if (typeof raw.discoverClusters === "boolean") config.discoverClusters = raw.discoverClusters;
    else errors.push("discoverClusters must be true or false");
  }
  if (raw.ignoreClusters !== undefined) {
    if (strs(raw.ignoreClusters)) config.ignoreClusters = raw.ignoreClusters as string[];
    else errors.push("ignoreClusters must be a list of cluster names");
  }

  if (raw.services !== undefined) {
    if (!isObj(raw.services)) errors.push("services must be an object keyed by ECS service name");
    else {
      config.services = {};
      for (const [name, v] of Object.entries(raw.services)) {
        // JSON.parse makes "__proto__" an own key; assigning it would replace the map's prototype instead.
        if (name === "__proto__") {
          errors.push(`services.${name}: not a service name`);
          continue;
        }
        if (!isObj(v)) {
          errors.push(`services.${name} must be an object`);
          continue;
        }
        reportUnknown(v, SECTION_KEYS.services, `services.${name}`, errors);
        const s: ServiceOverride = {};
        if (v.repo !== undefined) {
          if (typeof v.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(v.repo)) s.repo = v.repo;
          else errors.push(`services.${name}.repo must look like "owner/name"`);
        }
        // Probed by the console: http(s) only, at most 2,048 characters (F33).
        const url = (x: unknown) => typeof x === "string" && !healthcheckProblem(x);
        if (url(v.healthcheck) || (isObj(v.healthcheck) && Object.values(v.healthcheck).every(url))) s.healthcheck = v.healthcheck as ServiceOverride["healthcheck"];
        else if (v.healthcheck !== undefined) errors.push(`services.${name}.healthcheck must be an http(s) URL or { envId: URL }`);
        if (v.migrations !== undefined) {
          if (strs(v.migrations)) s.migrations = v.migrations as string[];
          else errors.push(`services.${name}.migrations must be a list of paths`);
        }
        if (typeof v.name === "string") s.name = v.name;
        else if (v.name !== undefined) errors.push(`services.${name}.name must be a string`);
        if (typeof v.infra === "boolean") s.infra = v.infra;
        else if (v.infra !== undefined) errors.push(`services.${name}.infra must be true or false`);
        if (typeof v.hidden === "boolean") s.hidden = v.hidden;
        else if (v.hidden !== undefined) errors.push(`services.${name}.hidden must be true or false`);
        config.services[name] = s;
      }
    }
  }

  if (raw.externals !== undefined) {
    if (!isObj(raw.externals)) errors.push("externals must be an object keyed by id");
    else {
      config.externals = {};
      for (const [id, v] of Object.entries(raw.externals)) {
        if (id === "__proto__") errors.push(`externals.${id}: not an id`);
        else if (!isObj(v) || typeof v.label !== "string") errors.push(`externals.${id}: "label" is required`);
        else {
          if (v.side !== undefined && v.side !== "source" && v.side !== "destination") errors.push(`externals.${id}.side must be "source" or "destination"`);
          config.externals[id] = { label: v.label, sub: typeof v.sub === "string" ? v.sub : undefined, note: typeof v.note === "string" ? v.note : undefined, side: v.side === "destination" ? "destination" : v.side === "source" ? "source" : undefined };
        }
      }
    }
  }

  if (raw.connections !== undefined) {
    if (!Array.isArray(raw.connections)) errors.push("connections must be a list");
    else {
      config.connections = [];
      raw.connections.forEach((c, i) => {
        if (!isObj(c) || typeof c.from !== "string" || typeof c.to !== "string") return errors.push(`connections[${i}]: "from" and "to" are required`);
        if (c.kind !== undefined && !KINDS.includes(c.kind as string)) return errors.push(`connections[${i}].kind must be one of ${KINDS.join(", ")}`);
        if (c.envs !== undefined && !strs(c.envs)) return errors.push(`connections[${i}].envs must be a list of environment ids`);
        config.connections!.push({ from: c.from, to: c.to, label: typeof c.label === "string" ? c.label : undefined, kind: c.kind as EdgeKind | undefined, envs: strs(c.envs) ? (c.envs as string[]) : undefined });
      });
    }
  }
  if (raw.github !== undefined) {
    if (isObj(raw.github) && (raw.github.owner === undefined || (typeof raw.github.owner === "string" && /^[\w.-]+$/.test(raw.github.owner)))) {
      if (typeof raw.github.owner === "string") config.github = { owner: raw.github.owner };
    } else errors.push('github must be { owner: "<GitHub user or organisation>" }');
  }

  if (raw.pricing !== undefined) {
    if (!isObj(raw.pricing)) errors.push("pricing must be an object");
    else {
      reportUnknown(raw.pricing, SECTION_KEYS.pricing, "pricing", errors);
      const p: NonNullable<ConsoleConfig["pricing"]> = {};
      for (const k of ["fargateVcpuHour", "fargateGbHour", "multiplier"] as const) {
        const v = raw.pricing[k];
        if (typeof v === "number" && Number.isFinite(v) && v > 0) p[k] = v;
        else if (v !== undefined) errors.push(`pricing.${k} must be a positive number`);
      }
      config.pricing = p;
    }
  }
  if (raw.costs !== undefined) {
    if (!isObj(raw.costs)) errors.push("costs must be an object");
    else {
      const c = raw.costs, o: NonNullable<ConsoleConfig["costs"]> = {};
      reportUnknown(c, SECTION_KEYS.costs, "costs", errors);
      if (typeof c.tagKey === "string" && c.tagKey.trim() && c.tagKey.length <= 128) o.tagKey = c.tagKey.trim();
      else if (c.tagKey !== undefined) errors.push("costs.tagKey must be a cost allocation tag key");
      if (typeof c.spikePercent === "number" && c.spikePercent >= 1 && c.spikePercent <= 1000) o.spikePercent = c.spikePercent;
      else if (c.spikePercent !== undefined) errors.push("costs.spikePercent must be a number from 1 to 1000");
      // Every snapshot is a few billed Cost Explorer requests: at least an hour between them.
      if (typeof c.cacheHours === "number" && c.cacheHours >= 1 && c.cacheHours <= 168) o.cacheHours = c.cacheHours;
      else if (c.cacheHours !== undefined) errors.push("costs.cacheHours must be a number of hours from 1 to 168");
      config.costs = o;
    }
  }
  if (raw.provisioning !== undefined) {
    if (!isObj(raw.provisioning)) errors.push("provisioning must be an object");
    else {
      const v = raw.provisioning, o: NonNullable<ConsoleConfig["provisioning"]> = {};
      reportUnknown(v, SECTION_KEYS.provisioning, "provisioning", errors);
      const whole = (x: unknown, min: number, max: number) => typeof x === "number" && Number.isInteger(x) && x >= min && x <= max;
      if (typeof v.enabled === "boolean") o.enabled = v.enabled;
      else if (v.enabled !== undefined) errors.push("provisioning.enabled must be true or false");
      if (whole(v.maxTasks, 1, 1000)) o.maxTasks = v.maxTasks as number;
      else if (v.maxTasks !== undefined) errors.push("provisioning.maxTasks must be a whole number from 1 to 1000");
      if (whole(v.maxHosts, 0, 100)) o.maxHosts = v.maxHosts as number;
      else if (v.maxHosts !== undefined) errors.push("provisioning.maxHosts must be a whole number from 0 to 100");
      if (strs(v.allowedInstanceTypes) && (v.allowedInstanceTypes as string[]).every((t) => /^[a-z][a-z0-9-]*\.[a-z0-9]+$/.test(t))) o.allowedInstanceTypes = v.allowedInstanceTypes as string[];
      else if (v.allowedInstanceTypes !== undefined) errors.push("provisioning.allowedInstanceTypes must be a list of instance types (e.g. t3a.medium)");
      if (strs(v.allowedImageRegistries) && (v.allowedImageRegistries as string[]).every((r) => /^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._-]+)*\/?$/.test(r))) o.allowedImageRegistries = v.allowedImageRegistries as string[];
      else if (v.allowedImageRegistries !== undefined) errors.push("provisioning.allowedImageRegistries must be a list of registries (e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com or ghcr.io/acme)");
      config.provisioning = o;
    }
  }
  if (raw.workloads !== undefined) {
    if (!isObj(raw.workloads)) errors.push("workloads must be an object keyed by id");
    else {
      config.workloads = {};
      for (const [id, v] of Object.entries(raw.workloads)) {
        const at = `workloads.${id}`;
        if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) { errors.push(`${at}: ids are lower-case letters, digits and dashes`); continue; }
        if (!isObj(v) || typeof v.name !== "string" || !v.name.trim()) { errors.push(`${at}: "name" is required`); continue; }
        reportUnknown(v, SECTION_KEYS.workloads, at, errors);
        const w: Workload = { name: v.name.trim().slice(0, 100) };
        const url = (k: "healthcheck" | "url") => {
          if (v[k] === undefined) return;
          // A health check is probed (F33): the same rules as a service's.
          if (typeof v[k] === "string" && /^https?:\/\/[^\s]+$/.test(v[k] as string) && (k !== "healthcheck" || !healthcheckProblem(v[k] as string))) w[k] = v[k] as string;
          else errors.push(`${at}.${k} must be an http(s) URL${k === "healthcheck" ? " of at most 2,048 characters" : ""}`);
        };
        url("healthcheck");
        url("url");
        if (typeof v.env === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(v.env)) w.env = v.env;
        else if (v.env !== undefined) errors.push(`${at}.env must be an environment id`);
        if (typeof v.host === "string" && /^i-[0-9a-f]{8,17}$/.test(v.host)) w.host = v.host;
        else if (v.host !== undefined) errors.push(`${at}.host must be an EC2 instance id (i-…)`);
        if (typeof v.platform === "string") w.platform = v.platform.slice(0, 60);
        if (typeof v.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(v.repo)) w.repo = v.repo;
        else if (v.repo !== undefined) errors.push(`${at}.repo must look like "owner/name"`);
        if (typeof v.note === "string") w.note = v.note.slice(0, 500);
        if (strs(v.uses)) w.uses = (v.uses as string[]).slice(0, 50);
        else if (v.uses !== undefined) errors.push(`${at}.uses must be a list of references`);
        config.workloads[id] = w;
      }
    }
  }
  if (raw.inventory !== undefined) {
    if (!isObj(raw.inventory)) errors.push("inventory must be an object");
    else {
      const v = raw.inventory.idleDays;
      config.inventory = {};
      if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 365) config.inventory.idleDays = v;
      else if (v !== undefined) errors.push("inventory.idleDays must be a whole number of days from 1 to 365");
      const u = raw.inventory.unassignedProtected;
      if (typeof u === "boolean") config.inventory.unassignedProtected = u;
      else if (u !== undefined) errors.push("inventory.unassignedProtected must be true or false");
      parseInventory(raw.inventory, config.inventory, errors);
    }
  }
  if (raw.ci !== undefined) {
    if (!isObj(raw.ci)) errors.push("ci must be an object");
    else {
      config.ci = {};
      for (const k of Object.keys(raw.ci)) if (k !== "deployments") errors.push(`unknown key "ci.${k}"`);
      if (raw.ci.deployments !== undefined) config.ci.deployments = parseDeployments(raw.ci.deployments, errors);
    }
  }
  return { config, errors };
}

// Parse only: what the regions, providers and catch-all keys mean is decided where they are used (src/lib/regions.ts,
// the inventory and the catch-all provider). Provider ids can't be checked here (this module is pure) — the inventory
// notes ids it doesn't know.
function parseInventory(v: Record<string, unknown>, out: InventoryConfig, errors: string[]) {
  const known = new Set(["idleDays", "unassignedProtected", "regions", "providers", "catchAll"]);
  for (const k of Object.keys(v)) if (!known.has(k)) errors.push(`unknown key "inventory.${k}"`);
  if (v.regions === "all-enabled") out.regions = "all-enabled";
  else if (Array.isArray(v.regions)) {
    const good = [...new Set(v.regions.filter((r): r is string => typeof r === "string" && REGION_CODE.test(r)))];
    const bad = v.regions.filter((r) => typeof r !== "string" || !REGION_CODE.test(r));
    if (bad.length) errors.push(`inventory.regions: ${bad.slice(0, 3).map((r) => JSON.stringify(r)).join(", ")} ${bad.length === 1 ? "is not an AWS region code" : "are not AWS region codes"} (e.g. eu-west-1)`);
    if (good.length > MAX_REGIONS) errors.push(`inventory.regions: at most ${MAX_REGIONS} regions — the first ${MAX_REGIONS} are used`);
    if (good.length) out.regions = good.slice(0, MAX_REGIONS);
    else if (!bad.length) errors.push("inventory.regions must list at least one region, or be \"all-enabled\"");
  } else if (v.regions !== undefined) errors.push('inventory.regions must be a list of region codes or "all-enabled"');

  const ids = (x: unknown) => Array.isArray(x) && x.every((i) => typeof i === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(i));
  if (isObj(v.providers)) {
    const p: NonNullable<InventoryConfig["providers"]> = {};
    for (const k of Object.keys(v.providers)) if (k !== "include" && k !== "exclude") errors.push(`unknown key "inventory.providers.${k}"`);
    for (const k of ["include", "exclude"] as const) {
      const x = v.providers[k];
      if (ids(x)) p[k] = [...new Set(x as string[])];
      else if (x !== undefined) errors.push(`inventory.providers.${k} must be a list of provider ids (e.g. "lambda")`);
    }
    out.providers = p;
  } else if (v.providers !== undefined) errors.push("inventory.providers must be { include?, exclude? }");

  if (isObj(v.catchAll)) {
    const c: NonNullable<InventoryConfig["catchAll"]> = {};
    for (const k of Object.keys(v.catchAll)) if (k !== "config" && k !== "cloudControlTypes") errors.push(`unknown key "inventory.catchAll.${k}"`);
    if (typeof v.catchAll.config === "boolean") c.config = v.catchAll.config;
    else if (v.catchAll.config !== undefined) errors.push("inventory.catchAll.config must be true or false");
    const t = v.catchAll.cloudControlTypes;
    if (strs(t) && (t as string[]).every((x) => /^[A-Za-z0-9]+::[A-Za-z0-9]+::[A-Za-z0-9]+$/.test(x))) c.cloudControlTypes = [...new Set(t as string[])].slice(0, 100);
    else if (t !== undefined) errors.push("inventory.catchAll.cloudControlTypes must be a list of CloudFormation type names (e.g. AWS::Glue::Database)");
    out.catchAll = c;
  } else if (v.catchAll !== undefined) errors.push("inventory.catchAll must be { config?, cloudControlTypes? }");
}

function parseDeployments(v: unknown, errors: string[]): CiDeployment[] {
  if (!Array.isArray(v)) {
    errors.push("ci.deployments must be a list of { repo, workflow, env, inputs? }");
    return [];
  }
  const out: CiDeployment[] = [];
  v.forEach((d, i) => {
    const at = `ci.deployments[${i}]`;
    if (!isObj(d)) return errors.push(`${at} must be { repo, workflow, env, inputs? }`);
    if (typeof d.repo !== "string" || !REPO.test(d.repo)) return errors.push(`${at}.repo must look like "owner/name"`);
    // The workflow's path, as GitHub reports it on a run — a name is not an identity (anyone can rename "Deploy" to "CI").
    if (typeof d.workflow !== "string" || !/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(d.workflow)) return errors.push(`${at}.workflow must be the workflow file's path, e.g. ".github/workflows/deploy.yml"`);
    if (typeof d.env !== "string" || !ENV_ID.test(d.env)) return errors.push(`${at}.env must be an environment id`);
    const dep: CiDeployment = { repo: d.repo, workflow: d.workflow, env: d.env };
    if (d.inputs !== undefined) {
      if (isObj(d.inputs) && Object.entries(d.inputs).every(([k, x]) => /^[\w-]{1,100}$/.test(k) && typeof x === "string" && x.length <= 500)) dep.inputs = { ...(d.inputs as Record<string, string>) };
      else return errors.push(`${at}.inputs must map input names to strings`);
    }
    for (const k of Object.keys(d)) if (!["repo", "workflow", "env", "inputs"].includes(k)) errors.push(`unknown key "${at}.${k}"`);
    out.push(dep);
  });
  return out;
}

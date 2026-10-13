// Canonical identity for everything the console changes (REVIEW R04). Map actions, console actions, variable saves,
// provisioning, CI re-runs and agent steps all lock the same string for the same resource, whichever form it was
// named in: an inventory key ("ecs:service/c/s@eu-west-1"), an environment/service pair, an ARN with a Lambda
// qualifier or a Secrets Manager suffix, an SSM name or its ARN. The coordinator (src/lib/mutation-core.ts) takes
// these keys. Pure; over-merging two names into one key only serialises more, never less.
//
//   ecs-service:<region>/<cluster>/<service>     ecs-hosts:<region>/<cluster>      ec2:<region>/<id>
//   rds:<region>/<id>                            ssm:<region>/<name without leading slash or :version>
//   secret:<region>/<name without -XXXXXX suffix, JSON key, stage or version>
//   s3:<bucket>/<key>                            console:<x>                       ci:<owner/repo>/<workflow path>
//   arn:<partition>:<service>:<region>:<account>:<resource base (Lambda qualifier, logs ":*" stripped)>
//   elb:<region>/<name>, elasticache:<region>/<id> (inventory keys and the ARNs agree),
//   inv:<region>/<inventory key> (inventory kinds without an AWS id)

export type KeyRef =
  | { ecsService: { region: string; cluster: string; service: string } }
  | { ecsHosts: { region: string; cluster: string } }
  | { ec2: { region: string; id: string } }
  | { rds: { region: string; id: string } }
  | { ssm: { region: string; name: string } }
  | { secret: { region: string; id: string } }
  | { s3Object: { bucket: string; key: string } }
  | { arn: string }
  | { console: string }
  | { ci: { repo: string; workflow: string } };

export interface Arn {
  partition: string;
  service: string;
  region: string;
  account: string;
  resource: string;
}

export function parseArn(s: string): Arn | undefined {
  const m = /^arn:([^:]+):([^:]+):([^:]*):([^:]*):(.+)$/.exec(s.trim());
  return m ? { partition: m[1], service: m[2], region: m[3], account: m[4], resource: m[5] } : undefined;
}

// "arn:aws:ecs:r:a:cluster/name" or "cluster/name" → "name"; plain names pass through.
const lastPart = (s: string) => {
  const t = s.trim();
  return parseArn(t) ? t.slice(t.lastIndexOf("/") + 1) : t;
};

// Secrets Manager appends "-" and six random characters to every secret's full ARN.
const SECRET_SUFFIX = /-[A-Za-z0-9]{6}$/;
// "secret:name-AbCdEf:json-key:stage:version-id" (an ECS valueFrom) → "name"
const secretName = (resource: string) => resource.replace(/^secret:/, "").split(":")[0].replace(SECRET_SUFFIX, "");
// "parameter/app/db" → "app/db"; "/app/db:3" (a version or label selector) → "app/db"
const ssmName = (s: string) => s.replace(/^parameter\//, "").replace(/^\/+/, "").replace(/:[^/:]*$/, "");

const regionalArn = (a: Arn, resource: string) => `arn:${a.partition}:${a.service}:${a.region}:${a.account}:${resource}`;

function arnKey(raw: string): string {
  const s = raw.trim();
  const a = parseArn(s);
  if (!a) return `arn:${s}`;
  const r = a.resource;
  switch (a.service) {
    case "ecs": {
      const m = /^service\/([^/]+)\/([^/]+)$/.exec(r); // new-format service ARN (old format has no cluster)
      if (m) return `ecs-service:${a.region}/${m[1]}/${m[2]}`;
      break;
    }
    case "ec2": {
      const m = /^instance\/(i-[0-9a-f]+)$/.exec(r);
      if (m) return `ec2:${a.region}/${m[1]}`;
      break;
    }
    case "rds":
      if (r.startsWith("db:")) return `rds:${a.region}/${r.slice(3)}`;
      break;
    case "ssm":
      if (r.startsWith("parameter/")) return `ssm:${a.region}/${ssmName(r)}`;
      break;
    case "secretsmanager":
      if (r.startsWith("secret:")) return `secret:${a.region}/${secretName(r)}`;
      break;
    case "s3": {
      const slash = r.indexOf("/");
      if (slash > 0) return `s3:${r.slice(0, slash)}/${r.slice(slash + 1)}`;
      break;
    }
    case "lambda": {
      const m = /^function:([^:]+)(?::.+)?$/.exec(r); // a version or alias qualifier names the same function
      if (m) return regionalArn(a, `function:${m[1]}`);
      break;
    }
    case "logs":
      return regionalArn(a, r.replace(/:\*$/, ""));
    case "elasticloadbalancing": {
      // "loadbalancer/app|net|gwy/<name>/<id>" or classic "loadbalancer/<name>" → the map's elb key (a classic and an
      // ALB of the same name share it, which only serialises more). Listeners, rules and target groups keep their ARN.
      const m = /^loadbalancer\/(?:(?:app|net|gwy)\/([^/]+)\/[^/]+|([^/]+))$/.exec(r);
      if (m) return `elb:${a.region}/${m[1] ?? m[2]}`;
      break;
    }
    case "elasticache": {
      // A cache cluster, replication group or serverless cache, by id — the map's elasticache key.
      const m = /^(?:cluster|replicationgroup|serverlesscache):(.+)$/.exec(r);
      if (m) return `elasticache:${a.region}/${m[1]}`;
      break;
    }
  }
  return regionalArn(a, r);
}

export function canonicalKey(ref: KeyRef): string {
  if ("ecsService" in ref) {
    const { region, cluster, service } = ref.ecsService;
    return `ecs-service:${region}/${lastPart(cluster)}/${lastPart(service)}`;
  }
  if ("ecsHosts" in ref) return `ecs-hosts:${ref.ecsHosts.region}/${lastPart(ref.ecsHosts.cluster)}`;
  if ("ec2" in ref) return `ec2:${ref.ec2.region}/${lastPart(ref.ec2.id)}`;
  if ("rds" in ref) {
    const id = ref.rds.id.trim();
    const a = parseArn(id);
    return a ? arnKey(id) : `rds:${ref.rds.region}/${id}`;
  }
  if ("ssm" in ref) {
    const name = ref.ssm.name.trim();
    return parseArn(name) ? arnKey(name) : `ssm:${ref.ssm.region}/${ssmName(name)}`;
  }
  if ("secret" in ref) {
    const id = ref.secret.id.trim();
    // A full ARN always carries the random suffix; a bare name never does (and may legitimately end in "-abcdef").
    return parseArn(id) ? arnKey(id) : `secret:${ref.secret.region}/${id.split(":")[0]}`;
  }
  if ("s3Object" in ref) return `s3:${ref.s3Object.bucket}/${ref.s3Object.key}`;
  if ("arn" in ref) return arnKey(ref.arn);
  if ("console" in ref) return `console:${ref.console}`;
  const repo = ref.ci.repo.trim().toLowerCase(); // GitHub owner/repo names are case-insensitive
  return `ci:${repo}/${ref.ci.workflow.trim().replace(/^\.?\/+/, "")}`;
}

// "…@eu-west-1" — the region suffix inventory keys carry outside the home region.
const REGION_SUFFIX = /@([a-z]{2}(?:-[a-z]+)+-\d+)$/;

// The coordinator keys for an inventory resource key. `region` is the resource's region; a key's own "@region"
// suffix wins. ECS services land on the same key as an environment/service pair in that region.
export function keysForInventory(key: string, region: string, home: string): string[] {
  const at = REGION_SUFFIX.exec(key);
  const base = at ? key.slice(0, at.index) : key;
  const r = at?.[1] || (region && region !== "global" ? region : home);
  if (base.startsWith("arn:")) return [canonicalKey({ arn: base })];
  const svc = /^ecs:service\/([^/]+)\/([^/]+)$/.exec(base);
  if (svc) return [canonicalKey({ ecsService: { region: r, cluster: svc[1], service: svc[2] } })];
  const [kind, ...rest] = base.split(":");
  const id = rest.join(":");
  if (id) {
    if (kind === "ec2") return [canonicalKey({ ec2: { region: r, id } })];
    if (kind === "rds") return [canonicalKey({ rds: { region: r, id } })];
    if (kind === "elb" || kind === "elasticache") return [`${kind}:${r}/${id}`];
  }
  return [`inv:${r}/${base}`];
}

// The region a canonical key names, when it names one.
export function canonicalRegion(key: string): string | undefined {
  if (key.startsWith("arn:")) return parseArn(key)?.region || undefined;
  const m = /^(?:ecs-service|ecs-hosts|ec2|rds|ssm|secret|elb|elasticache|inv):([^/]+)\//.exec(key);
  return m?.[1];
}

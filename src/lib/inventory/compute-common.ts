// Small pure helpers shared by the compute providers' rules (compute-ec2.ts, compute-eks.ts, compute-paas.ts), and the
// support-edge references (roles, instance profiles, KMS keys, ECR repositories) the edge rules use too.
import { arnOf, partitionOf } from "./arn.ts";
import type { Mention, Prop, Resource } from "./types.ts";

export const uniq = <T,>(a: (T | undefined | null | "")[]): T[] => [...new Set(a.filter((x): x is T => x !== undefined && x !== null && x !== ""))];

// Props with a value only, so providers can list optional facts inline.
export const props = (...p: (Prop | false | "" | null | undefined)[]): Prop[] => p.filter((x): x is Prop => !!x && x.value !== "");
export const prop = (label: string, value: string | number | undefined | null, mono?: boolean): Prop | undefined =>
  value === undefined || value === null || value === "" ? undefined : { label, value: String(value), ...(mono ? { mono } : {}) };
export const propOf = (r: Pick<Resource, "props">, label: string) => r.props.find((p) => p.label === label)?.value;

export const day = (ts?: number) => (ts ? new Date(ts).toISOString().slice(0, 10) : undefined);

// ---------- support-edge references (roles, instance profiles, KMS keys, ECR repositories) ----------
// A full ARN stands as it is. A bare name or id becomes the ARN this account gives it, so the IAM, KMS and ECR
// providers' keys match; without the account it stays the name (resolved, if at all, through those providers' aliases).

// "alias/acme" / "mrk-…" / "1234abcd-…" in `region`; "alias/aws/s3" resolves to that region's AWS-managed key alias.
export function kmsRef(id: string | undefined, region: string, account?: string): string | undefined {
  const k = id?.trim();
  if (!k) return undefined;
  if (k.startsWith("arn:")) return k;
  if (!account || !region || region === "unknown" || region === "global") return undefined;
  return k.startsWith("alias/") ? arnOf.kmsAlias(region, account, k) : arnOf.kmsKey(region, account, k);
}

// A role or instance profile named in configuration: "name", "path/name" or its ARN.
const iamRef = (kind: "role" | "instance-profile", v: string | undefined, account?: string, region = "") => {
  const s = v?.trim();
  if (!s) return undefined;
  if (s.startsWith("arn:")) return s;
  if (!account) return s;
  const slash = s.lastIndexOf("/");
  const [path, name] = slash >= 0 ? [s.slice(0, slash + 1), s.slice(slash + 1)] : ["/", s];
  const partition = partitionOf(region);
  return kind === "role" ? arnOf.iamRole(account, name, path, partition) : arnOf.iamInstanceProfile(account, name, path, partition);
};
export const roleRef = (v: string | undefined, account?: string, region?: string) => iamRef("role", v, account, region);
export const profileRef = (v: string | undefined, account?: string, region?: string) => iamRef("instance-profile", v, account, region);

// "<account>.dkr.ecr.<region>.amazonaws.com/<repository>:<tag>" (or "@sha256:…") → the repository's ARN. Other
// registries (Docker Hub, ghcr.io, ECR Public) → undefined.
export function ecrRepoRef(image: string | undefined): string | undefined {
  const m = /^(\d{12})\.dkr\.ecr(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?\/([^:@]+)/.exec(image?.trim() ?? "");
  return m ? arnOf.ecrRepository(m[2], m[1], m[3]) : undefined;
}

// Plain environment values become one mention each, named by variable, never shown (Mention.refs stay server-side).
// References to secrets (valueFrom / secretKeyRef) aren't values and are skipped.
const MAX_VALUE = 2_048;
export function envMentions(from: string, vars: { name: string; value?: string }[]): Mention[] {
  return vars.filter((v) => v.name && v.value && v.value.length <= MAX_VALUE).map((v) => ({ from, refs: [v.value!], via: `env ${v.name}` }));
}

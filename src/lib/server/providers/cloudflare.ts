// Cloudflare provider (global, not AWS): zones (plan, status, name servers) and, for every A / AAAA / CNAME record, a
// link from the zone to what it points at — so "shop.example.com CNAME d123.cloudfront.net" (proxied or DNS-only)
// lands on the CloudFront distribution. Needs CLOUDFLARE_API_TOKEN (Zone:Read + DNS:Read; Cache Purge for the purge
// action), optionally CLOUDFLARE_ACCOUNT_ID to limit zones to one account. Calls go through the plugins' send() (no
// redirects, no link-local targets, errors never carry the request) and the token is never logged or returned.
// Cloudflare zones carry no tags the console reads: their protection comes from the environment they are placed in and
// console.config.json, so the live protection read before a purge answers "no tags" (R01).
import "server-only";
import { jsonReq, send } from "../../plugins/http.ts";
import { cfRecordLinks, cfZoneResource, purgeBody, type CloudflareApi, type PurgeBody, type PurgeInput, type RawCfRecord, type RawCfZone } from "../../inventory/edge-dns.ts";
import type { Link, ResourceDetail } from "../../inventory/types.ts";
import { sourceKind } from "../sources.ts";
import { errMsg, field, fmtTime, idOf, pool } from "./edge-util.ts";
import { mockCfPurges, mockCloudflare } from "./mock/cloudflare.ts";
import type { Provider, ProviderAction } from "./types.ts";

const BASE = "https://api.cloudflare.com/client/v4";
// send() keeps the first 100 KB of a response: pages stay well under it (a zone object is ~1.5 KB, a record ~0.5 KB).
const ZONES_PER_PAGE = 20;
const RECORDS_PER_PAGE = 100;
const PANEL_RECORDS = 500;

// ---- real source ----

const token = () => process.env.CLOUDFLARE_API_TOKEN?.trim() ?? "";
const safeId = (id: string) => {
  if (!/^[A-Za-z0-9]{1,64}$/.test(id)) throw new Error("cloudflare: invalid zone id");
  return id;
};

interface Envelope<T> {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: T;
  result_info?: { page?: number; total_pages?: number; total_count?: number };
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown, scope = "cloudflare:Zone:Read"): Promise<Envelope<T>> {
  let res;
  try {
    res = await send("cloudflare", jsonReq(method, `${BASE}${path}`, { Authorization: `Bearer ${token()}` }, body), 10_000);
  } catch (e) {
    // 401/403 → a permission problem the inventory reports as "denied" (with the token scope it needs).
    if (/HTTP 40[13]/.test(errMsg(e))) throw Object.assign(new Error(`Cloudflare token is not authorized to perform: ${scope}`), { name: "AccessDenied" });
    throw e;
  }
  const j = res.json as Envelope<T> | null;
  if (!j || typeof j !== "object") throw new Error("cloudflare: unreadable response (too large or not JSON)");
  if (j.success === false) throw new Error(`cloudflare: ${j.errors?.[0]?.message ?? "request failed"}`.slice(0, 200));
  return j;
}

interface CfZoneJson {
  id?: string; name?: string; status?: string; paused?: boolean; type?: string; name_servers?: string[];
  plan?: { name?: string }; account?: { id?: string; name?: string }; created_on?: string; modified_on?: string;
}
interface CfRecordJson { id?: string; name?: string; type?: string; content?: string; proxied?: boolean; ttl?: number }
const RECORD_BUDGET = 20_000; // DNS records read per discovery pass, across every zone
const time = (s?: string) => (s ? Date.parse(s) || undefined : undefined);

const realCloudflare: CloudflareApi = {
  async zones(cap) {
    const zones: RawCfZone[] = [];
    const acct = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
    let page = 1, pages = 1;
    do {
      const j = await call<CfZoneJson[]>("GET", `/zones?per_page=${ZONES_PER_PAGE}&page=${page}${acct ? `&account.id=${encodeURIComponent(acct)}` : ""}`);
      for (const z of j.result ?? []) {
        if (!z.id || !z.name) continue;
        zones.push({
          id: z.id, name: z.name, status: z.status ?? "unknown", paused: z.paused, plan: z.plan?.name, type: z.type, nameServers: z.name_servers ?? [],
          accountId: z.account?.id, accountName: z.account?.name, createdAt: time(z.created_on), modifiedAt: time(z.modified_on),
        });
      }
      pages = j.result_info?.total_pages ?? 1;
      page++;
    } while (page <= pages && zones.length < cap);
    return { zones: zones.slice(0, cap), truncated: zones.length > cap || page <= pages };
  },

  async records(zoneId, cap, signal) {
    const records: RawCfRecord[] = [];
    let page = 1, pages = 1;
    do {
      if (signal?.aborted) break; // past the discovery deadline: keep what we have, stop spending the API budget
      const j = await call<CfRecordJson[]>("GET", `/zones/${safeId(zoneId)}/dns_records?per_page=${RECORDS_PER_PAGE}&page=${page}`, undefined, "cloudflare:DNS:Read");
      for (const r of j.result ?? []) if (r.name && r.type) records.push({ id: r.id, name: r.name, type: r.type, content: r.content ?? "", proxied: r.proxied, ttl: r.ttl });
      pages = j.result_info?.total_pages ?? 1;
      page++;
    } while (page <= pages && records.length < cap);
    return { records: records.slice(0, cap), truncated: records.length > cap || page <= pages };
  },

  async purge(zoneId, body) {
    const j = await call<{ id?: string }>("POST", `/zones/${safeId(zoneId)}/purge_cache`, body, "cloudflare:Cache Purge");
    return { id: j.result?.id };
  },
};

const api = (mock: boolean): CloudflareApi => (mock ? mockCloudflare : realCloudflare);
const zoneIdOf = (key: string) => idOf(key); // "cloudflare:zone/<id>"

// ---- actions ----

const purge: ProviderAction<PurgeInput> = {
  id: "purge-cache",
  kind: "cloudflare-zone",
  title: "Purge cached files",
  summary: "Empties Cloudflare's cache for this zone — everything, some URLs or some hostnames — so the next requests go to the origins.",
  description: "Purges Cloudflare's cache for the zone: everything, or up to 30 URLs, or up to 30 hostnames (all inside the zone). Exactly one of everything / urls / hosts. Returns the purge id.",
  risk: "change",
  perm: "act",
  iam: ["cloudflare:Cache Purge"], // an API token permission, not IAM
  undo: "Nothing to undo — the cache refills from the origins as requests come in",
  verifies: "Cloudflare accepts the purge and returns its id (it takes effect within seconds)",
  retrySafe: true, // purging twice leaves the cache the same
  input: {
    type: "object",
    additionalProperties: false,
    properties: {
      everything: field({ type: "boolean", title: "Purge everything", description: "Purge every cached file in the zone." }),
      urls: field({ type: "array", title: "URLs", maxItems: 30, items: { type: "string", maxLength: 2048 }, description: "Full URLs, e.g. https://shop.example.com/index.html." }),
      hosts: field({ type: "array", title: "Hostnames", maxItems: 30, items: { type: "string", maxLength: 253 }, description: "Hostnames in the zone, e.g. shop.example.com." }),
    },
  },
  when: (r) => (r.health === "stopped" ? "the zone isn't active" : undefined),
  async plan(r, i) {
    const p = purgeBody(r.name, i);
    if ("error" in p) throw new Error(p.error);
    const changes = "files" in p.body ? p.body.files : "hosts" in p.body ? p.body.hosts : ["everything"];
    const warnings = "purge_everything" in p.body ? ["Every cached file is fetched from the origins again: expect a burst of origin traffic."] : [];
    return { summary: p.summary, changes, warnings };
  },
  async run(r, i, ctx) {
    const p = purgeBody(r.name, i);
    if ("error" in p) throw new Error(p.error);
    const out = await api(ctx.mock).purge(zoneIdOf(r.key), p.body as PurgeBody);
    return { zone: r.name, purgeId: out.id };
  },
};

export const cloudflare: Provider = {
  id: "cloudflare",
  label: "Cloudflare",
  global: true,
  scope: "global",
  kinds: ["cloudflare-zone"],
  covers: [], // not AWS: no Resource Explorer type
  // API token permissions, not IAM (the IAM policy generator must skip the "cloudflare:" prefix).
  read: ["cloudflare:Zone:Read", "cloudflare:DNS:Read"],
  write: ["cloudflare:Cache Purge"],

  enabled() {
    let mock = false;
    try {
      mock = sourceKind() === "mock";
    } catch {
      mock = false;
    }
    if (mock || token()) return { ok: true };
    return { ok: false, why: "set CLOUDFLARE_API_TOKEN (an API token with Zone:Read and DNS:Read) to map Cloudflare zones" };
  },

  async discover(ctx) {
    const a = api(ctx.mock);
    const { zones, truncated } = await a.zones(ctx.cap);
    if (truncated) ctx.note(`cloudflare: showing the first ${ctx.cap.toLocaleString("en-US")} zones`);
    ctx.checkpoint?.({ resources: zones.map(cfZoneResource), links: [], mentions: [] }); // R18: the zones, before their records
    const links: Link[] = [];
    let denied = false;
    // One budget for all zones per pass (like Route 53's), so a big account can't eat Cloudflare's shared rate limit.
    let budget = RECORD_BUDGET;
    await pool(zones, 4, async (z) => {
      if (ctx.signal.aborted || budget <= 0) return;
      try {
        const { records, truncated: more } = await a.records(z.id, Math.min(ctx.cap, budget), ctx.signal);
        budget -= records.length;
        if (more) ctx.note(`cloudflare: ${z.name}: links from the first ${ctx.cap.toLocaleString("en-US")} records only`);
        links.push(...cfRecordLinks(`cloudflare:zone/${z.id}`, records));
      } catch (e) {
        if ((e as Error).name === "AccessDenied") denied = true;
        else ctx.note(`cloudflare: couldn't read DNS records of ${z.name}: ${errMsg(e)}`);
      }
    });
    if (denied) ctx.note("cloudflare: the token can't read DNS records (needs Zone → DNS → Read) — no record links");
    if (budget <= 0) ctx.note(`cloudflare: stopped after ${RECORD_BUDGET.toLocaleString("en-US")} DNS records this pass`);
    return { resources: zones.map(cfZoneResource), links, mentions: [] };
  },

  async detail(r, ctx): Promise<ResourceDetail> {
    const recs = await api(ctx.mock).records(zoneIdOf(r.key), PANEL_RECORDS).catch((e: unknown) => new Error(errMsg(e)));
    const sections: ResourceDetail["sections"] = [];
    if (recs instanceof Error) sections.push({ title: "DNS records", note: `Couldn't list records: ${recs.message}` });
    else {
      sections.push({
        title: "DNS records",
        table: {
          columns: ["Name", "Type", "Content", "Proxy", "TTL"],
          rows: recs.records.map((x) => [x.name, x.type, x.content.slice(0, 300), x.proxied ? "proxied" : "DNS only", x.ttl === 1 ? "auto" : x.ttl !== undefined ? String(x.ttl) : ""]),
        },
        note: recs.truncated ? `First ${PANEL_RECORDS} records.` : undefined,
      });
    }
    if (ctx.mock) {
      const purges = mockCfPurges(zoneIdOf(r.key));
      if (purges.length) sections.push({ title: "Recent purges (simulated)", table: { columns: ["Id", "When", "What"], rows: purges.map((p) => [p.id, fmtTime(p.at), "files" in p.body ? p.body.files.join(", ") : "hosts" in p.body ? p.body.hosts.join(", ") : "everything"]) } });
    }
    return { key: r.key, sections };
  },

  // R01: nothing on a Cloudflare zone decides protection but its environment and the config (no tags to re-read).
  async authoritative() {
    return { tags: {} };
  },

  actions: [purge] as ProviderAction[],
};

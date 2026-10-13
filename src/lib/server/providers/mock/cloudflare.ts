// Simulated Cloudflare for the Acme demo account: the zone acme-shop.com, where shop.acme-shop.com is a proxied
// CNAME to the shop CloudFront distribution and status.acme-shop.com points at a hosted status page outside AWS.
// Cache purges are recorded on globalThis.
import type { CloudflareApi, PurgeBody, RawCfRecord, RawCfZone } from "../../../inventory/edge-dns.ts";
import { CLOUDFLARE, CLOUDFRONT } from "../mock-names.ts";

const Z = CLOUDFLARE.zone.name;
const T0 = Date.now();

export const MOCK_CF_ZONES: RawCfZone[] = [
  {
    id: CLOUDFLARE.zone.id, name: Z, status: "active", paused: false, plan: "Pro Website", type: "full",
    nameServers: ["ada.ns.cloudflare.com", "rob.ns.cloudflare.com"], accountId: "0acme0cloudflare0account0000000", accountName: "Acme",
    createdAt: T0 - 500 * 86_400_000, modifiedAt: T0 - 30 * 86_400_000,
  },
];

export const MOCK_CF_RECORDS: RawCfRecord[] = [
  { id: "r1", name: `shop.${Z}`, type: "CNAME", content: CLOUDFRONT.shop.domain, proxied: true, ttl: 1 },
  { id: "r2", name: `status.${Z}`, type: "CNAME", content: "acme.statuspage.io", proxied: false, ttl: 300 },
  { id: "r3", name: Z, type: "MX", content: "mx.acme-mail.example", ttl: 300 },
  { id: "r4", name: Z, type: "TXT", content: "v=spf1 -all", ttl: 300 },
  { id: "r5", name: `_dmarc.${Z}`, type: "TXT", content: "v=DMARC1; p=reject", ttl: 300 },
];

const g = globalThis as { __edgeMockCfPurges?: { zoneId: string; body: PurgeBody; at: number; id: string }[] };

export const mockCloudflare: CloudflareApi = {
  async zones(cap) {
    return { zones: MOCK_CF_ZONES.slice(0, cap), truncated: MOCK_CF_ZONES.length > cap };
  },
  async records(zoneId, cap) {
    const all = zoneId === CLOUDFLARE.zone.id ? MOCK_CF_RECORDS : [];
    return { records: all.slice(0, cap), truncated: all.length > cap };
  },
  async purge(zoneId, body) {
    if (zoneId !== CLOUDFLARE.zone.id) throw new Error("cloudflare: HTTP 404 — zone not found");
    const id = `purge-${Date.now().toString(36)}`;
    (g.__edgeMockCfPurges ??= []).unshift({ zoneId, body, at: Date.now(), id });
    g.__edgeMockCfPurges.length = Math.min(g.__edgeMockCfPurges.length, 20);
    return { id };
  },
};

export const mockCfPurges = (zoneId: string) => (g.__edgeMockCfPurges ?? []).filter((p) => p.zoneId === zoneId);

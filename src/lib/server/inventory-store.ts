// Persisted inventory runs (R18): the last finished result of every provider × region, in inventory_runs, so a restart
// serves the map it had — labelled stale while it refreshes — instead of an empty one. One row per (provider, region),
// overwritten in place; the encoding (gzip, sealed mentions, size caps) is pure in ../inventory/snapshot.ts.
//
// Best effort by design: a failed save or load is logged once and never fails a build. Rows of providers or regions
// no longer configured are simply not loaded.
import "server-only";
import { decodeSnapshot, encodeSnapshot } from "../inventory/snapshot.ts";
import type { ProviderResult, ProviderStatus } from "../inventory/types.ts";
import { getDb } from "./db.ts";
import { errText } from "./errors.ts";
import { seal, unseal } from "./secrets.ts";

// What of a run's status is kept (no ids or labels: the provider registry supplies those on load).
export type StoredStatus = Pick<ProviderStatus, "state" | "count" | "ms" | "missing" | "error" | "partial">;

export interface StoredRun {
  provider: string;
  region: string;
  at: number; // when its data was read
  account?: string; // the AWS account it was read from (the simulated one's id in the demo): another account's rows are never served
  status: StoredStatus;
  result: ProviderResult;
}

const g = globalThis as { __consoleInventoryStore?: { warned: Set<string> } };
const warnOnce = (what: string, e: unknown) => {
  const s = (g.__consoleInventoryStore ??= { warned: new Set() });
  if (s.warned.has(what)) return;
  s.warned.add(what);
  console.error(JSON.stringify({ level: 40, msg: `inventory snapshot ${what} failed`, err: errText(e) }));
};

export async function saveRun(run: StoredRun): Promise<boolean> {
  try {
    const e = encodeSnapshot(run.result, { seal });
    if ("refused" in e) {
      warnOnce(`save of ${run.provider}@${run.region}`, new Error(e.refused));
      return false;
    }
    const status: StoredStatus & { account?: string } = { state: run.status.state, count: run.status.count, ...pick(run.status), ...(run.account ? { account: run.account } : {}) };
    const db = await getDb();
    await db.run(
      `INSERT INTO inventory_runs (provider, region, at, status, result) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (provider, region) DO UPDATE SET at = excluded.at, status = excluded.status, result = excluded.result`,
      [run.provider, run.region, run.at, JSON.stringify(status), e.data],
    );
    return true;
  } catch (e) {
    warnOnce("save", e);
    return false;
  }
}

const pick = (s: StoredStatus): Partial<StoredStatus> => ({
  ...(typeof s.ms === "number" ? { ms: s.ms } : {}),
  ...(s.missing?.length ? { missing: s.missing.slice(0, 20) } : {}),
  ...(s.error ? { error: String(s.error).slice(0, 300) } : {}),
  ...(s.partial ? { partial: true } : {}),
});

const STATES = new Set(["ok", "denied", "error", "disabled", "skipped"]);

// Every stored run newer than maxAgeMs whose "provider@region" is wanted. Rows that don't decode are skipped.
export async function loadRuns(wanted: Set<string>, maxAgeMs: number, now = Date.now()): Promise<StoredRun[]> {
  let rows: { provider: string; region: string; at: number | string; status: string; result: string | null }[];
  try {
    rows = await (await getDb()).all("SELECT provider, region, at, status, result FROM inventory_runs WHERE at >= ?", [now - maxAgeMs]);
  } catch (e) {
    warnOnce("load", e);
    return [];
  }
  const out: StoredRun[] = [];
  for (const r of rows) {
    if (!wanted.has(`${r.provider}@${r.region}`) || !r.result) continue;
    try {
      const st = JSON.parse(r.status) as Partial<StoredStatus> & { account?: unknown };
      if (!st || !STATES.has(String(st.state))) continue;
      const result = decodeSnapshot(r.result, { unseal });
      out.push({
        provider: r.provider, region: r.region, at: Number(r.at), ...(typeof st.account === "string" ? { account: st.account } : {}),
        status: { state: st.state as StoredStatus["state"], count: typeof st.count === "number" ? st.count : result.resources.length, ...pick(st as StoredStatus) },
        result: { resources: result.resources, links: result.links, mentions: result.mentions },
      });
    } catch (e) {
      warnOnce(`load of ${r.provider}@${r.region}`, e);
    }
  }
  return out;
}

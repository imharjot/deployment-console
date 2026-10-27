// The regions this console reads (src/lib/regions.ts has the rules): CONSOLE_REGIONS, then console.config.json
// `inventory.regions`, then Settings → AWS connection's choice (a real account only), then the home region
// (homeRegion(): AWS_REGION or Settings' home, or us-east-1 for the simulated account).
// "all-enabled" asks the account once a day which regions it has enabled (ec2:DescribeRegions; the simulated account
// answers MOCK_REGIONS). Discovery, the inventory and GET /api/regions use it.
import "server-only";
import { parseRegions, resolveAllEnabled } from "../regions.ts";
import { connectionState } from "./connection-state.ts";
import { consoleConfig } from "./discovery.ts";
import { errText } from "./errors.ts";
import { getCloud, homeRegion, sourceKind } from "./sources.ts";

export interface ConsoleRegions {
  home: string;
  regions: string[]; // home first
  allEnabled: boolean;
  source: "env" | "config" | "settings" | "default";
  problems?: string[]; // invalid entries that were dropped, or why "all-enabled" fell back to the home region
}

const DAY = 24 * 3600_000;
const RETRY_MS = 5 * 60_000; // after a failed DescribeRegions, the home region alone until this long has passed

// The enabled-regions answer, kept on globalThis: the sampler and the routes are separate bundles.
const g = globalThis as { __consoleEnabledRegions?: { nextAt: number; regions?: string[]; error?: string; pending?: Promise<void> } };

async function enabledRegions(): Promise<{ regions?: string[]; error?: string }> {
  const e = (g.__consoleEnabledRegions ??= { nextAt: 0 });
  if (Date.now() >= e.nextAt && !e.pending) {
    e.pending = (async () => {
      try {
        const cloud = await getCloud();
        if (!cloud.enabledRegions) throw new Error("this source can't list enabled regions");
        Object.assign(e, { regions: await cloud.enabledRegions(), error: undefined, nextAt: Date.now() + DAY });
      } catch (err) {
        // Keep the last good answer, if any (otherwise the home region alone), and ask again in a few minutes.
        Object.assign(e, { error: errText(err), nextAt: Date.now() + RETRY_MS });
      } finally {
        e.pending = undefined;
      }
    })();
  }
  if (e.pending && !e.regions && !e.error) await e.pending;
  return { regions: e.regions, error: e.error };
}

export async function consoleRegions(): Promise<ConsoleRegions> {
  const env = process.env.CONSOLE_REGIONS;
  const config = consoleConfig().config.inventory?.regions;
  const configured = config === "all-enabled" || (Array.isArray(config) && config.length) ? config : undefined;
  const chosen = sourceKind() === "aws" ? connectionState().effective?.regions : undefined;
  const source = env?.trim() ? "env" : configured ? "config" : chosen ? "settings" : "default";
  const p = parseRegions(env, configured ?? chosen, homeRegion());
  const out: ConsoleRegions = { home: p.regions[0], regions: p.regions, allEnabled: p.allEnabled, source };
  const problems = [...p.problems];
  if (p.allEnabled) {
    const e = await enabledRegions();
    if (e.regions) {
      const r = resolveAllEnabled(out.home, e.regions);
      out.regions = r.regions;
      problems.push(...r.problems);
    }
    if (e.error) problems.push(`all-enabled: couldn't list the account's regions (${e.error})${e.regions ? " — using the last answer" : " — reading the home region only"}`);
  }
  if (problems.length) out.problems = problems;
  return out;
}

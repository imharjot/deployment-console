// Which AWS regions the console reads (pure; src/lib/server/regions.ts resolves them). Precedence: CONSOLE_REGIONS
// (a comma list, or "all-enabled"), then console.config.json `inventory.regions`, then the home region alone
// (AWS_REGION). The home region always comes first: discovery of ECS environments, the home-scoped providers and
// every "no region given" call run there.

export const REGION_CODE = /^[a-z]{2}(-gov)?-[a-z]+-\d$/; // "eu-west-1", "us-gov-west-1"
export const MAX_REGIONS = 30;
export const ALL_ENABLED = "all-enabled";

export interface ParsedRegions {
  regions: string[]; // home first, de-duplicated, at most MAX_REGIONS; with allEnabled, just [home] until resolved
  allEnabled: boolean; // "all-enabled": the server asks the account which regions are enabled (resolveAllEnabled)
  problems: string[]; // shown to operators; the bad entries are dropped
}

const tidy = (s: string) => s.trim().toLowerCase();

// Home first, then the rest in the order given; invalid codes and repeats dropped (each reported once), capped at 30.
function order(home: string, list: string[], what: string, problems: string[]): string[] {
  const out = [home];
  const bad: string[] = [];
  for (const raw of list) {
    const r = tidy(raw);
    if (!r) continue;
    if (!REGION_CODE.test(r)) bad.push(raw.trim());
    else if (!out.includes(r)) out.push(r);
  }
  if (bad.length) problems.push(`${what}: ${bad.slice(0, 3).map((b) => JSON.stringify(b)).join(", ")}${bad.length > 3 ? ` and ${bad.length - 3} more` : ""} ${bad.length === 1 ? "is not a region code" : "are not region codes"} (e.g. eu-west-1)`);
  if (out.length > MAX_REGIONS) problems.push(`${what}: at most ${MAX_REGIONS} regions — the first ${MAX_REGIONS} (home first) are used`);
  return out.slice(0, MAX_REGIONS);
}

export function parseRegions(env: string | undefined, config: string[] | "all-enabled" | undefined, home: string): ParsedRegions {
  const problems: string[] = [];
  const h = tidy(home);
  if (!REGION_CODE.test(h)) problems.push(`home region ${JSON.stringify(home)} (AWS_REGION) is not a region code`);
  const e = env?.trim();
  if (e) {
    if (tidy(e) === ALL_ENABLED) return { regions: [h], allEnabled: true, problems };
    return { regions: order(h, e.split(","), "CONSOLE_REGIONS", problems), allEnabled: false, problems };
  }
  if (config === ALL_ENABLED) return { regions: [h], allEnabled: true, problems };
  if (Array.isArray(config) && config.length) return { regions: order(h, config, "inventory.regions", problems), allEnabled: false, problems };
  return { regions: [h], allEnabled: false, problems };
}

// "all-enabled", once the account answered: home first, then the enabled regions in alphabetical order.
export function resolveAllEnabled(home: string, enabled: string[]): { regions: string[]; problems: string[] } {
  const problems: string[] = [];
  return { regions: order(tidy(home), [...enabled].sort(), "enabled regions", problems), problems };
}

// Environment ids stay unique across regions. Ids pinned in console.config.json stand, then the home region's; an env
// discovered in another region whose id is already taken becomes "<id>-<region>", labelled "<label> (<region>)"
// (eu-west-1's "acme-production" next to the home one → "production-eu-west-1", "Production (eu-west-1)"). So does a
// home env whose id a config entry already uses — a cluster or compose box pinned in any region (environments.<id>).
// `envs`: home region first, then the other regions in the console's order.
export function regionalIds<T extends { id: string; label: string; region: string; source: "discovered" | "config" }>(envs: T[], home: string): T[] {
  const config = new Set(envs.filter((e) => e.source === "config").map((e) => e.id));
  const keeps = (e: T) => e.source === "config" || (e.region === home && !config.has(e.id));
  // Every id that stands is reserved first, so a generated one can't take an id a later env keeps.
  const taken = new Set(envs.filter(keeps).map((e) => e.id));
  return envs.map((e) => {
    if (keeps(e)) return e;
    let id = e.id;
    let label = e.label;
    if (taken.has(id)) {
      id = `${e.id}-${e.region}`;
      label = `${e.label} (${e.region})`;
      for (let n = 2; taken.has(id); n++) id = `${e.id}-${e.region}-${n}`;
    }
    taken.add(id);
    return id === e.id ? e : { ...e, id, label };
  });
}

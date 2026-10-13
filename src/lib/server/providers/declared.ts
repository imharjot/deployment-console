// What console.config.json declares and AWS can't see (F15): `workloads` — apps that aren't services AWS knows, such as
// containers started by docker compose on an EC2 box, a cron job under systemd, an app on another platform — each a
// "workload" node on its host, linked to what it uses, with a live health check; and `externals` — systems outside
// AWS (a payment provider, a SaaS API) that the ECS topology connects to. Both are config, so they come from this
// provider ("Declared in config"), never from the ECS one: their detail panel has nothing to ask AWS.
// No AWS calls: the config file is the source (it is admin-controlled, so its URLs are trusted like any health URL).
import "server-only";
import { keys, type Link, type Prop, type Resource } from "../../inventory/types.ts";
import { consoleConfig } from "../discovery.ts";
import { probe } from "../probes.ts";
import type { Provider } from "./types.ts";

const hostOf = (url?: string) => {
  try {
    return url ? new URL(url).hostname : undefined;
  } catch {
    return undefined;
  }
};

const prop = (label: string, value: string | undefined): Prop[] => (value ? [{ label, value }] : []);

export const declaredProvider: Provider = {
  id: "declared",
  label: "Declared in config",
  scope: "home", // one config file, read once
  kinds: ["workload", "external"],
  covers: [],
  read: [],
  async discover(ctx) {
    const { config } = consoleConfig();
    const all = config.workloads ?? {};
    const resources: Resource[] = [];
    const links: Link[] = [];
    await Promise.all(
      Object.entries(all).map(async ([id, w]) => {
        const key = keys.workload(id);
        // The simulated account has no network to probe: show the URL, not a made-up result.
        const check = w.healthcheck && !ctx.mock ? await probe(w.healthcheck).catch(() => undefined) : undefined;
        const health: Resource["health"] = !w.healthcheck || !check ? "unknown" : check.pass ? "ok" : check.consecutiveFailures >= 2 ? "error" : "warning";
        const props: Prop[] = [
          { label: "Declared in", value: "console.config.json" },
          ...(w.platform ? [{ label: "Platform", value: w.platform }] : []),
          ...(w.host ? [{ label: "Host", value: w.host, mono: true }] : []),
          ...(w.healthcheck ? [{ label: "Health check", value: `${w.healthcheck}${check ? ` → ${check.status ?? check.error ?? "?"}${check.ms !== undefined ? ` in ${check.ms} ms` : ""}` : ""}`, mono: true }] : []),
          ...(w.url ? [{ label: "URL", value: w.url, mono: true }] : []),
          ...(w.repo ? [{ label: "Repository", value: w.repo, mono: true }] : []),
          ...(w.note ? [{ label: "Note", value: w.note }] : []),
        ];
        const endpoint = hostOf(w.url);
        resources.push({
          key, kind: "workload", provider: "declared", name: w.name, region: "global", tags: {}, props, health,
          healthReason: check && !check.pass ? `health check ${check.status ? `answered ${check.status}` : check.error ?? "failed"}` : undefined,
          envHint: w.env, endpoints: endpoint ? [endpoint] : undefined, aliases: [id],
        });
        if (w.host) links.push({ from: key, to: keys.ec2(w.host), kind: "uses", label: "runs on", evidence: "workloads." + id + ".host in console.config.json" });
        for (const ref of w.uses ?? []) {
          const to = Object.hasOwn(all, ref) ? keys.workload(ref) : ref; // another workload by id, else any resolvable reference
          links.push({ from: key, to, kind: "uses", evidence: `workloads.${id}.uses in console.config.json` });
        }
      }),
    );
    // Systems outside AWS (`externals`): the ECS topology's connections to them come from the ecs provider, by key.
    for (const [id, x] of Object.entries(config.externals ?? {}))
      resources.push({
        key: keys.external(id), kind: "external", provider: "declared", name: x.label, region: "global", tags: {}, health: "unknown",
        healthReason: "not monitored here",
        props: [...prop("Type", x.sub), ...prop("Note", x.note), ...prop("Declared in", "console.config.json")],
      });
    return { resources, links, mentions: [] };
  },
  // Nothing to read about a declared node beyond what the map already shows (F15: never a 502 from another provider).
  async detail(r) {
    return { key: r.key, sections: [] };
  },
};

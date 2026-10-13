// Wave-A foundations: the capability view, the planned (not yet built) providers in Settings → Permissions and on the
// map, the error body shape and the security headers from next.config.ts. Read-only; nothing is changed.
export default async function foundationsSmoke({ get, check, BASE }) {
  // Capability (audit C5): action names and states only. The demo answers "simulated", everything allowed.
  const cap = await get("/api/capability");
  const actions = Object.entries(cap.json?.actions ?? {});
  check("capability: what the console's AWS identity may change", cap.status === 200 && actions.length > 0 && Array.isArray(cap.json.denied) && typeof cap.json.checkedAt === "number", `${cap.json?.source}, ${actions.length} actions`);
  check("capability: action names and states only — no ARNs or account ids", !/arn:aws|\b\d{12}\b/.test(JSON.stringify(cap.json ?? {})));
  check("capability: every action state is a known value", actions.every(([, s]) => ["allowed", "probably-denied", "denied", "unknown"].includes(s)), [...new Set(actions.map(([, s]) => s))].join(" "));

  // Providers that are declared but not built yet: listed as planned, never counted as "not set up", never on the map.
  const perms = (await get("/api/permissions")).json?.providers ?? [];
  const planned = perms.filter((p) => p.planned);
  const built = perms.filter((p) => !p.planned);
  check("permissions: planned providers are marked and declare what they will cover", planned.length > 0 && planned.every((p) => p.enabled?.ok === false && p.kinds?.length > 0 && ["regional", "global", "home"].includes(p.scope) && Array.isArray(p.covers)), `${built.length} built, ${planned.length} planned`);
  check("permissions: built providers are never marked planned", built.length > 0 && built.every((p) => p.enabled?.why !== "not implemented yet"));
  const inv = (await get("/api/inventory")).json ?? {};
  const plannedIds = new Set(planned.map((p) => p.id));
  const states = inv.providers?.filter((p) => plannedIds.has(p.id)) ?? [];
  check("inventory: planned providers report disabled, not an error", states.length === planned.length && states.every((p) => p.state === "disabled" && p.count === 0), `${states.length} disabled`);
  check("inventory: no resource comes from a planned provider", !(inv.resources ?? []).some((r) => plannedIds.has(r.provider)));
  check("inventory: every built provider reports a state", (inv.providers ?? []).filter((p) => !plannedIds.has(p.id)).length === built.length);

  // Error bodies: a message (and a code where there is one), never the request id, a stack or a principal ARN.
  const nf = await get("/api/overview?env=dev");
  check("errors: JSON body with a message and nothing internal", nf.status === 404 && typeof nf.json?.error === "string" && !("requestId" in nf.json) && !("stack" in nf.json));

  // Security headers (next.config.ts). HSTS only when the console is reached over HTTPS or built for production.
  const h = (await fetch(BASE + "/api/healthz")).headers;
  check("headers: nosniff, no framing, same-origin referrer", h.get("x-content-type-options") === "nosniff" && h.get("x-frame-options") === "DENY" && h.get("referrer-policy") === "same-origin");
  const hsts = h.get("strict-transport-security");
  check("headers: HSTS, when sent, pins for a year", !hsts || /max-age=(\d+)/.exec(hsts)?.[1] >= 31536000, hsts ?? "not sent (plain-HTTP dev)");
}

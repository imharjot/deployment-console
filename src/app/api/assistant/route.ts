// The embedded assistant (master plan §3.5): POST { question, resourceKey?, connectionId? } → 201 { runId }, an
// incident-investigator run for you — "explain why this is unhealthy, show the evidence, prepare a safe action for
// review" — scoped to the resource and its neighbourhood on the cloud map. With the simulated account the connection
// defaults to the built-in scripted demo model; against a real account you name one (no default, no fallback). Follow
// the run with GET /api/agents/runs/<runId> or /api/events?run=<runId>. People only.
import { DEMO_CONNECTION_ID } from "@/lib/agents/connection-rules";
import { redact } from "@/lib/agents/redact";
import { HttpError } from "@/lib/server/errors";
import { handle, json, readJson } from "@/lib/server/http";
import { startRun } from "@/lib/server/agents/runner";
import { sourceKind } from "@/lib/server/sources";
import { personOf } from "@/lib/server/ops/caller";

const FIELDS = ["question", "resourceKey", "connectionId"];

export const POST = handle(async (req) => {
  const c = personOf(req);
  const b = await readJson(req, 16_000);
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "body must be a JSON object");
  for (const k of Object.keys(b)) if (!FIELDS.includes(k)) throw new HttpError(400, `unknown field ${k.slice(0, 40)}`);
  const own = (k: string) => (Object.hasOwn(b, k) ? (b as Record<string, unknown>)[k] : undefined);
  const question = own("question");
  if (question !== undefined && (typeof question !== "string" || question.length > 4_000)) throw new HttpError(400, "question must be a string of at most 4000 characters");
  const resourceKey = own("resourceKey");
  if (resourceKey !== undefined && (typeof resourceKey !== "string" || !resourceKey || resourceKey.length > 2_048)) throw new HttpError(400, "resourceKey must be a resource key");
  if (!(typeof question === "string" && question.trim()) && resourceKey === undefined) throw new HttpError(400, "ask a question, or name the resource to explain");
  // The composer refuses this too; a direct API call must not store a pasted secret as the run's title and goal.
  if (typeof question === "string" && redact(question).findings.length)
    throw Object.assign(new HttpError(400, "the question looks like it contains a secret; set it in the service's Variables tab instead"), { code: "secret_in_question" });
  let connectionId = own("connectionId");
  if (connectionId === undefined && sourceKind() === "mock") connectionId = DEMO_CONNECTION_ID;
  if (typeof connectionId !== "string" || !connectionId || connectionId.length > 100) throw new HttpError(400, "connectionId is required: pick a model connection (Automation → Connections)");
  const runId = await startRun({
    kind: "assistant", initiator: c.user, connectionId, template: "incident-investigator",
    ...(typeof question === "string" ? { goal: question } : {}), ...(resourceKey !== undefined ? { resourceKey } : {}),
  });
  return json({ runId }, 201);
});

// The embedded assistant's rules, pure so `node --test` can run them (master plan §6 C9): what to ask about a resource
// ("Explain this", "Why is this unhealthy?"), which model connection to ask with, the composer's refusal of text that
// looks like a secret (the same rules the server redacts with), the drawer's thread kept for the tab, why starting a
// run failed, and my runs for the /assistant history. A run itself is shown by the Automation UI's <RunView>.
//
// Server answers are read defensively (own properties, types checked), so an older or newer server never crashes the
// drawer.
import { DEMO_CONNECTION_ID } from "../../lib/agents/connection-rules.ts";
import { redact, type RedactionLabel } from "../../lib/agents/redact.ts";

// ---------- small readers ----------

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const own = (o: Obj, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d{1,16}$/.test(v)) return Number(v); // BIGINT columns can arrive as strings
  return undefined;
};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
// The first of several spellings (camelCase from the API, snake_case from a raw row).
const pick = (o: Obj, ...keys: string[]): unknown => {
  for (const k of keys) {
    const v = own(o, k);
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
};

// ---------- my runs (the /assistant history) ----------

// GET /api/agents/runs (§3.5): { runs: [...] } or a bare array; only well-formed items. The run itself is shown by
// the Automation UI's <RunView> (src/components/agents/run-view.tsx), which reads the detail route on its own.
export interface RunListItem {
  id: string;
  kind: string;
  title?: string;
  state: string;
  initiator?: string; // an email (or id), when the server names one
  connection?: { label?: string; payer?: string };
  createdAt?: number;
  updatedAt?: number;
  waitingFor?: string;
  resourceKey?: string;
}

const initiatorOf = (v: unknown): string | undefined => str(v) ?? str(pick(obj(v), "email", "id"));

export function normalizeRunList(raw: unknown): RunListItem[] {
  const items = Array.isArray(raw) ? raw : list(own(obj(raw), "runs"));
  return items
    .map((x): RunListItem | undefined => {
      const r = obj(x);
      const id = str(own(r, "id"));
      if (!id || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) return undefined; // it goes into URLs
      const c = obj(own(r, "connection"));
      return {
        id,
        kind: str(own(r, "kind")) ?? "assistant",
        title: str(own(r, "title")),
        state: str(own(r, "state")) ?? "unknown",
        initiator: initiatorOf(own(r, "initiator")),
        connection: Object.keys(c).length ? { label: str(own(c, "label")), payer: str(own(c, "payer")) } : undefined,
        createdAt: num(pick(r, "createdAt", "created_at")),
        updatedAt: num(pick(r, "updatedAt", "updated_at")),
        waitingFor: str(own(r, "waitingFor")),
        resourceKey: str(pick(r, "resourceKey", "resource_key")),
      };
    })
    .filter((r): r is RunListItem => !!r);
}

// My assistant runs, newest first. The list is "mine" for people and everyone's for admins (§3.5): an item whose
// initiator names someone else is left out; one that names nobody is kept (the server already scoped it).
export function myAssistantRuns(items: RunListItem[], me: { email?: string; id?: string } | undefined): RunListItem[] {
  const ids = [me?.email, me?.id].filter((x): x is string => !!x).map((x) => x.toLowerCase());
  const mine = (r: RunListItem) => !r.initiator || !ids.length || ids.includes(r.initiator.toLowerCase());
  return items.filter((r) => r.kind === "assistant" && mine(r)).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

// ---------- connections ----------

export interface ConnectionChoice {
  id: string;
  label: string;
  providerLabel?: string;
  payer?: string;
  usable: boolean;
  why?: string;
  builtIn?: boolean;
  status?: string;
}

export function normalizeConnections(raw: unknown): ConnectionChoice[] {
  return list(own(obj(raw), "connections"))
    .map((x): ConnectionChoice | undefined => {
      const c = obj(x);
      const id = str(own(c, "id"));
      if (!id) return undefined;
      const status = str(own(c, "status"));
      return {
        id,
        label: str(own(c, "label")) ?? id,
        providerLabel: str(own(c, "providerLabel")),
        payer: str(own(c, "payer")),
        // Usable only when the server says so and it is active (a revoked or signed-out one can't run).
        usable: own(c, "usable") === true && (status === undefined || status === "active"),
        why: str(own(c, "why")) ?? (status && status !== "active" ? status.replace(/_/g, " ") : undefined),
        builtIn: own(c, "builtIn") === true,
        status,
      };
    })
    .filter((c): c is ConnectionChoice => !!c);
}

export const DEMO_CONNECTION = DEMO_CONNECTION_ID;

// The connection to ask with: the last one used (if it is still usable), else the simulated account's demo model,
// else the first usable one. undefined = none usable.
export function pickConnection(all: ConnectionChoice[], remembered: string | null | undefined): ConnectionChoice | undefined {
  const usable = all.filter((c) => c.usable);
  return usable.find((c) => c.id === remembered) ?? usable.find((c) => c.id === DEMO_CONNECTION) ?? usable[0];
}

// ---------- what to ask about a resource ----------

export interface AskSubject {
  key?: string; // the inventory key (ecs:service/<cluster>/<service>, an ARN, …): the run's scope
  fallbackRef?: string; // a reference for the question when there is no inventory key (service:<id>)
  name: string;
  kind?: string; // "service", "SQS queue", …
  envLabel?: string;
  stateWord?: string; // "down", "degraded", "in an unknown state", "warning" …
}

// ECS overview states that aren't ok: a service down or degraded, or one the console can't read.
export const ecsUnhealthy = (state: string) => state === "DOWN" || state === "DEGRADED" || state === "UNKNOWN";
export const ecsStateWord = (state: string) => (state === "DOWN" ? "down" : state === "DEGRADED" ? "degraded" : state === "UNKNOWN" ? "in an unknown state" : state.toLowerCase().replace(/_/g, " "));
// Map health that isn't ok. "unknown" (no health signal for the kind) and "stopped" (on purpose) are not unhealthy.
export const mapUnhealthy = (health: string) => health === "error" || health === "warning";
export const mapStateWord = (health: string) => (health === "error" ? "failing" : health === "warning" ? "showing a warning" : health);

const where = (s: AskSubject) => (s.envLabel ? ` in ${s.envLabel}` : "");
const ref = (s: AskSubject) => ((s.key ?? s.fallbackRef) ? ` (${s.key ?? s.fallbackRef})` : "");
const what = (s: AskSubject) => (s.kind ? `the ${s.kind} ${s.name}` : s.name);

export function questionFor(mode: "explain" | "why", s: AskSubject): string {
  if (mode === "why") return `Why is ${what(s)}${where(s)} ${s.stateWord ?? "unhealthy"}? Show the evidence and prepare a safe action for review.${ref(s)}`;
  return `Explain ${what(s)}${where(s)}: what it is, what it is connected to, and whether anything needs attention.${ref(s)}`;
}

// ---------- the composer ----------

const SECRET_WORDS: Record<RedactionLabel, string> = {
  "private-key": "a private key",
  "pem-block": "a certificate or key block",
  "presigned-url": "a pre-signed URL",
  "url-password": "a URL with a password in it",
  "webhook-url": "a webhook URL",
  "authorization-header": "an Authorization header",
  cookie: "a cookie",
  "bearer-token": "a bearer token",
  "console-token": "a console API or agent token",
  jwt: "a JSON web token",
  "aws-access-key-id": "an AWS access key id",
  "aws-secret-access-key": "an AWS secret access key",
  "vendor-token": "an API token",
  "secret-value": "a password or secret value",
};

export const MAX_QUESTION = 2_000;

// Text that looks like a secret is never sent (master plan §6 C9 item 5): the same rules the server redacts with
// (src/lib/agents/redact.ts). Findings are labels only; the value is never echoed back.
export function checkQuestion(text: string): { ok: boolean; empty: boolean; tooLong: boolean; secrets: string[]; message?: string } {
  const t = text.trim();
  const secrets = t ? [...new Set(redact(t).findings.map((f) => SECRET_WORDS[f] ?? "a secret"))] : [];
  const tooLong = t.length > MAX_QUESTION;
  const message = secrets.length
    ? `This looks like it contains ${joinWords(secrets)}. Secrets never go to a model: remove it, and set the value in the service's Variables tab instead, where it is stored encrypted and every change is audited.`
    : tooLong
      ? `Keep the question under ${MAX_QUESTION.toLocaleString("en-US")} characters.`
      : undefined;
  return { ok: !!t && !secrets.length && !tooLong, empty: !t, tooLong, secrets, message };
}

const joinWords = (w: string[]) => (w.length < 2 ? (w[0] ?? "") : `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}`);

export const NOT_SENT = "(Not sent: it looked like it contained a secret.)";

// The question as the thread keeps it (on screen and in sessionStorage): text that looks like a secret is never kept,
// not even in a refused entry — only a note that it wasn't sent.
export const questionToKeep = (text: string): string => {
  const t = text.trim();
  return checkQuestion(t).secrets.length ? NOT_SENT : t.slice(0, MAX_QUESTION);
};

// ---------- the drawer's thread ----------

export interface ThreadEntry {
  key: string; // stable React key, also before the run id exists
  question: string;
  runId?: string;
  resourceKey?: string;
  resourceName?: string;
  at: number;
  error?: string; // starting it failed
  code?: string;
}

export const MAX_THREAD = 8;

// The thread kept for this browser tab (sessionStorage), so a reload reopens the same runs and resumes them. Anything
// malformed is dropped.
export function parseThread(raw: string | null | undefined): ThreadEntry[] {
  if (!raw) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  return list(v)
    .map((x): ThreadEntry | undefined => {
      const e = obj(x);
      const key = str(own(e, "key"));
      const question = str(own(e, "question"));
      const at = num(own(e, "at"));
      const runId = str(own(e, "runId"));
      if (!key || !question || at === undefined || (runId !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(runId))) return undefined;
      return { key, question: questionToKeep(question), runId, resourceKey: str(own(e, "resourceKey")), resourceName: str(own(e, "resourceName")), at, error: str(own(e, "error")), code: str(own(e, "code")) };
    })
    .filter((e): e is ThreadEntry => !!e)
    .slice(-MAX_THREAD);
}

// Why starting a run failed, in words a person can act on.
export function startError(status: number, message: string, code?: string): string {
  if (status === 404 && !code) return "The assistant isn't available on this console yet (no /api/assistant). Update the console, or ask in Automation.";
  if (status === 503 || code === "agents_disabled") return "Agents are turned off on this console. An admin can turn them on in Automation → Agents.";
  if (status === 423 || code === "emergency_stop") return `${message} (the emergency stop is on).`;
  if (status === 403) return `You can't start an assistant run: ${message}`;
  return message;
}

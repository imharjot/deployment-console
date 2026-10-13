// Notes as operations, so an agent can read what people wrote about a resource before touching it ("don't scale the
// worker down on Mondays: batch import") and leave its own. Same server functions as /api/notes, so validation, the
// caps and the audit (never the body) apply unchanged. Outputs are compact JSON for a model.
import type { Note } from "../../inventory/types.ts";
import { NOTE_LIMITS } from "../../notes.ts";
import { createNote, listNotes, searchNotes } from "../notes.ts";
import { defineOps, type JsonSchema } from "./types.ts";

const KEY: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: NOTE_LIMITS.key,
  description:
    "Resource key: the resource's ARN (arn:aws:lambda:…:function:orders, arn:aws:s3:::bucket, …) or a console key — ecs:service/<cluster>/<service> (cluster from envs.list, service id from envs.status), elb:<load balancer name>, rds:<db instance id>, elasticache:<cluster id>, ec2:<instance id>, eks:<cluster>/<namespace>/<kind>/<name>, external:<id>, cloudflare:<…>.",
};
const TAG: JsonSchema = { type: "string", maxLength: 33, description: "A tag: 1–32 lower-case letters, digits or dashes (e.g. traffic, incident, cost)." };
const ENV: JsonSchema = { type: "string", maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", description: "Environment id, e.g. \"production\"." };

const iso = (ms: number) => new Date(ms).toISOString();
// Searches return up to 200 notes; long bodies are cut there (notes.list returns them whole).
function view(n: Note, max = Infinity) {
  const long = n.body.length > max;
  return {
    id: n.id,
    key: n.key,
    ...(n.resourceName ? { resource: n.resourceName } : {}),
    ...(n.env ? { env: n.env } : {}),
    ...(n.pinned ? { pinned: true } : {}),
    tags: n.tags,
    author: n.author,
    created: iso(n.createdAt),
    ...(n.updatedAt > n.createdAt ? { edited: iso(n.updatedAt) } : {}),
    body: long ? `${n.body.slice(0, max)}…` : n.body,
    ...(long ? { truncated: true } : {}),
  };
}

interface AddInput {
  key: string;
  body: string;
  tags?: string[];
  pinned?: boolean;
  resourceName?: string;
  env?: string;
}

export const ops = defineOps([
  {
    name: "notes.list",
    title: "Read the notes on a resource",
    description:
      "Notes people (and agents) left on one resource: what was changed and why, special traffic it gets, quirks, runbook links. Pinned notes first, then newest. " +
      "Read them before changing a resource. Returns { key, count, notes: [{ id, resource, env, pinned, tags, author, created, edited, body }] }.",
    risk: "read",
    perm: "view",
    input: { type: "object", additionalProperties: false, required: ["key"], properties: { key: KEY } },
    run: async (i: { key: string }) => {
      const notes = await listNotes(i.key);
      return { key: i.key, count: notes.length, notes: notes.map((n) => view(n)) };
    },
  },
  {
    name: "notes.search",
    title: "Search notes across resources",
    description:
      "Searches every note, most recently written first. `q` matches the text, the resource's name and key and the tags; `tag` keeps notes with that tag; `env` keeps one environment. " +
      "With no filters it returns the latest notes. Bodies longer than 1,000 characters are cut (truncated: true) — use notes.list on the note's key for the whole text.",
    risk: "read",
    perm: "view",
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        q: { type: "string", maxLength: NOTE_LIMITS.search, description: "Text to look for (case-insensitive)." },
        tag: TAG,
        env: ENV,
        limit: { type: "integer", minimum: 1, maximum: NOTE_LIMITS.searchResults, default: 20, description: "How many (default 20)." },
      },
    },
    run: async (i: { q?: string; tag?: string; env?: string; limit?: number }) => {
      const notes = await searchNotes({ ...i, limit: i.limit ?? 20 });
      return { count: notes.length, notes: notes.map((n) => view(n, 1000)) };
    },
  },
  {
    name: "notes.add",
    title: "Add a note to a resource",
    description:
      "Leaves a plain-text note on a resource for the people who look after it: what you changed and why, what you found, special traffic. Up to 10,000 characters and 10 tags; links are clickable in the console, nothing else is formatted. " +
      "Everyone signed in to the console can read notes, so never put secret values in one. The note is authored as <owner> via token '<name>' (only admins can edit or delete it later); the audit log records who added it, the tags and the length, not the text. Returns { note }.",
    risk: "change",
    perm: "notes",
    input: {
      type: "object",
      additionalProperties: false,
      required: ["key", "body"],
      properties: {
        key: KEY,
        body: { type: "string", minLength: 1, maxLength: NOTE_LIMITS.body, description: "The note, plain text with line breaks." },
        tags: { type: "array", maxItems: NOTE_LIMITS.tags, items: TAG, description: "Optional tags." },
        pinned: { type: "boolean", description: "Keep it at the top of the resource's notes (default false)." },
        resourceName: { type: "string", maxLength: NOTE_LIMITS.resourceName, description: "What people call the resource (kept if the resource disappears later)." },
        env: ENV,
      },
    },
    // What an approver sees in the plan: where, how long, which tags — the text itself is in the (sealed) input.
    plan: async (i: AddInput) => ({
      summary: `Add a note to ${i.resourceName || i.key}`,
      changes: [`${i.body.trim().length.toLocaleString("en-US")} characters`, ...(i.tags?.length ? [`tags: ${i.tags.join(", ")}`] : []), ...(i.pinned ? ["pinned"] : [])],
    }),
    run: async (i: AddInput, ctx) => ({ note: view(await createNote(ctx.user, i, { actor: ctx.actor, ip: ctx.ip })) }),
  },
]);

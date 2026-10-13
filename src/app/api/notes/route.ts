// Notes on resources. GET ?key=<resource key> → that resource's notes (pinned first, then newest); GET without a key
// searches every resource (?q= text, &tag=, &env=, &limit= up to 200). Anyone signed in may read. POST creates one
// (permission `notes`); the body is { key, body, tags?, pinned?, resourceName?, env? }. See src/lib/server/notes.ts.
import { handle, json, readJson, userOf } from "@/lib/server/http";
import { createNote, listNotes, searchNotes } from "@/lib/server/notes";
import { personOf } from "@/lib/server/ops/caller";

export const GET = handle(async (req) => {
  userOf(req); // signed in
  const p = req.nextUrl.searchParams;
  const key = p.get("key");
  if (key !== null) return json({ notes: await listNotes(key) });
  return json({ notes: await searchNotes({ q: p.get("q"), tag: p.get("tag"), env: p.get("env"), limit: p.get("limit") }) });
});

// A 10,000-character body can double in size as JSON (escaped line breaks), hence the larger cap.
export const POST = handle(async (req) => {
  const c = personOf(req);
  return json({ note: await createNote(c.user, await readJson(req, 64_000), { ip: c.ip }) }, 201);
});

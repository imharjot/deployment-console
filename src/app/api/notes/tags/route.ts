// Tags in use across all notes, most used first: { tags: { tag, count }[] } (at most 100). Suggestions for the note
// form's tag input and the /notes filter. Anyone signed in.
import { handle, json, userOf } from "@/lib/server/http";
import { noteTags } from "@/lib/server/notes";

export const GET = handle(async (req) => {
  userOf(req);
  return json({ tags: await noteTags() });
});

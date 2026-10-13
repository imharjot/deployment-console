// Notes on resources: create → list → search → edit → delete on an ECS service key, the validation and permission
// edges, the operations, and the audit log (every write, never the body). Cleans up after itself.
export default async function notesSmoke({ get, post, call, check }) {
  const envs = (await get("/api/envs")).json;
  const cluster = envs.find?.((e) => e.id === "staging")?.cluster;
  if (!cluster) return check("notes: staging env found", false);
  const key = `ecs:service/${cluster}/api`;
  const marker = `smoke-${Date.now().toString(36)}`;
  const body = `${marker} changed the health check grace period to 60s\nsee https://example.com/runbook`;

  const made = await post("/api/notes", { key, body, tags: ["Smoke", "traffic"], resourceName: "api", env: "staging" });
  const note = made.json.note;
  check("notes: create", made.status === 201 && note?.id && note.body === body.trim() && note.tags.join() === "smoke,traffic", made.json.error ?? note?.id);
  if (!note?.id) return;

  const list = await get(`/api/notes?key=${encodeURIComponent(key)}`);
  check("notes: list by resource key", list.status === 200 && list.json.notes.some((n) => n.id === note.id));
  check("notes: search by text", (await get(`/api/notes?q=${marker}`)).json.notes?.some((n) => n.id === note.id));
  check("notes: search by tag and env", (await get("/api/notes?tag=smoke&env=staging")).json.notes?.some((n) => n.id === note.id));
  check("notes: LIKE wildcards are literal", !(await get(`/api/notes?q=${encodeURIComponent(`${marker}%`)}`)).json.notes?.length);
  check("notes: tags in use", (await get("/api/notes/tags")).json.tags?.some((t) => t.tag === "smoke"));

  const ed = await call("PATCH", `/api/notes/${note.id}`, { body: `${marker} edited`, pinned: true });
  check("notes: edit", ed.status === 200 && ed.json.note?.body === `${marker} edited` && ed.json.note.pinned && ed.json.note.updatedAt > ed.json.note.createdAt, ed.json.error ?? "");

  check("notes: invalid tag is 400", (await post("/api/notes", { key, body: "x", tags: ["Not A Tag!"] })).status === 400);
  check("notes: unknown key shape is 400", (await post("/api/notes", { key: "service:api", body: "x" })).status === 400);
  check("notes: empty body is 400", (await post("/api/notes", { key, body: "   " })).status === 400);
  check("notes: body over 10,000 characters is 400", (await post("/api/notes", { key, body: "x".repeat(10_001) })).status === 400);
  check("notes: unknown fields are 400", (await post("/api/notes", { key, body: "x", author: "someone@else" })).status === 400);
  check("notes: empty patch is 400", (await call("PATCH", `/api/notes/${note.id}`, {})).status === 400);
  check("notes: unknown note is 404", (await call("PATCH", "/api/notes/7c9e6679-7425-40de-944b-e07fc1f90ae7", { pinned: true })).status === 404);
  check("notes: writes need the CSRF header", (await call("PATCH", `/api/notes/${note.id}`, { pinned: false }, { "content-type": "application/json" })).status === 403);

  // Operations: agents read and add through the registry.
  const opList = await post("/api/ops/notes.list", { input: { key } });
  check("notes: ops notes.list", opList.status === 200 && opList.json.result?.notes?.some((n) => n.id === note.id), opList.json.error ?? "");
  const opSearch = await post("/api/ops/notes.search", { input: { q: marker } });
  check("notes: ops notes.search", opSearch.status === 200 && opSearch.json.result?.count >= 1, opSearch.json.error ?? "");
  const opAdd = await post("/api/ops/notes.add", { input: { key, body: `${marker} from ops`, tags: ["smoke"] } });
  check("notes: ops notes.add", opAdd.status === 200 && opAdd.json.result?.note?.id, opAdd.json.error ?? "");
  check("notes: ops input is validated", (await post("/api/ops/notes.add", { input: { key } })).status === 400);

  const del = await call("DELETE", `/api/notes/${note.id}`);
  check("notes: delete", del.status === 200 && del.json.ok === true);
  check("notes: deleted note is gone", !(await get(`/api/notes?key=${encodeURIComponent(key)}`)).json.notes.some((n) => n.id === note.id));
  check("notes: delete twice is 404", (await call("DELETE", `/api/notes/${note.id}`)).status === 404);
  if (opAdd.json.result?.note?.id) await call("DELETE", `/api/notes/${opAdd.json.result.note.id}`);

  const audit = (await get("/api/audit?limit=200")).json;
  const rows = Array.isArray(audit) ? audit.filter((e) => e.action?.startsWith("note.") && e.params?.note === note.id) : [];
  check("notes: create, edit and delete are audited", ["note.create", "note.update", "note.delete"].every((a) => rows.some((e) => e.action === a && e.phase === "intent") && rows.some((e) => e.action === a && e.result === "ok")), rows.map((e) => `${e.action}:${e.phase}`).join(" "));
  check("notes: the audit log never holds the body", !JSON.stringify(audit).includes(marker));
}

// Dashboards (docs/dashboards.md): the list with its built-in templates, and a create → update → stale update → delete
// round trip on a private dashboard of the smoke user. The pages render.
export default async function dashboardsSmoke({ get, post, call, check, BASE }) {
  const list = await get("/api/dashboards");
  check("dashboards: list with the built-in templates", list.status === 200 && Array.isArray(list.json.dashboards) && list.json.templates?.length === 2, `${list.json.templates?.length} templates`);

  const made = await post("/api/dashboards", { name: "smoke dashboard" });
  const d = made.json.dashboard;
  check("dashboards: create", made.status === 201 && typeof d?.id === "string" && d.version === 1, made.json.error ?? "");
  if (d?.id) {
    const url = `/api/dashboards/${encodeURIComponent(d.id)}`;
    const renamed = await call("PATCH", url, { version: 1, name: "smoke dashboard (renamed)" });
    check("dashboards: update at the version read", renamed.status === 200 && renamed.json.dashboard?.version === 2, renamed.json.error ?? "");
    const stale = await call("PATCH", url, { version: 1, name: "smoke dashboard (stale)" });
    check("dashboards: an update from a stale version is refused", stale.status === 409 && stale.json.code === "version_conflict", `${stale.status} ${stale.json.error ?? ""}`);
    check("dashboards: delete", (await call("DELETE", url)).status === 200 && (await get(url)).status === 404);
  }

  for (const p of ["/dashboards", "/incident"]) check(`dashboards: page ${p}`, (await fetch(BASE + p)).status === 200);
}

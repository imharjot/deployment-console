# Dashboards

A **dashboard** is a board of live widgets you arrange yourself: the environments' state, open issues, an alarm list,
a metric chart, the neighbourhood of a resource on the cloud map, a saved log query, deploys and rollbacks, failing
CI, pending approvals, spend, your pinned resources, a note. Keep one per team or per service, share it with the
team, and make one your **home page** so it is the first thing you see.

Dashboards live under **Dashboards** (`/dashboards`). The same page lists the built-in templates and your saved views
and log queries.

## Widgets

Every widget reads an API the rest of the console already uses, so it shows exactly what **its viewer** may see — a
teammate with a smaller role sees "Needs operator" on a costs widget instead of the numbers. Each widget says how
fresh its own data is: when a refresh fails, the widget keeps what it had and says "Last refresh failed" (or
"Showing stale data") with the time, instead of quietly showing old values. One widget failing never breaks the
others.

| Widget | Shows | Settings |
|---|---|---|
| Environment status | Every environment's worst state and how many resources need attention (from the background sampler) | Which environments (all when none chosen) |
| Service status | One ECS service: state, reasons, tasks, revision and its CPU trend | Environment, service |
| Metric chart | One CloudWatch metric of a service, host, database, cache or load balancer | Environment, resource, metric (`cpu`, `mem`, `rps`, `p90`…), window: 1 h, 6 h, 24 h, 7 d (the metrics API serves at most 24 h; the chart says so) |
| CloudWatch alarms | Alarms from the cloud map, firing first, then those without data | Environment, region (optional) |
| Map neighbourhood | A resource and everything one or two hops away on the cloud map, each linking to it on the map | Resource key (an ARN or map key — type its name to pick it), hops |
| Pinned resources | Everything you starred on the overview or the map, newest first; unpin from here | — |
| Log query | Matches of a log search in the window and the newest lines; opens in Logs | A saved query, or its own environment, services, text and window (15 min – 24 h) |
| Costs | Spend this month, the forecast, last month and the biggest services (Cost Explorer) | — (needs **operator**) |
| Activity | Deploys and rollbacks only, or everything (CI, ECS events, console actions) | Environment (all in view when none), deploys or everything, window: 1 h – 7 d |
| Approvals | Agent requests waiting for a person | — |
| Issues | Everything down, degraded or unreadable right now; each opens its panel on the overview | — |
| CI failures | Workflows whose **latest** run failed (one that failed and then passed is not listed) | Repository (all connected ones when none) |
| Text | A note: plain text with `[label](https://…)` links and bare `https://` addresses; console paths such as `/logs` work too. Nothing else is interpreted, and `javascript:` or `//host` links stay text | Text (up to 4,000 characters) |

The global **region filter** in the header applies to every widget: lists drop what is outside the region, and a
widget pinned to one environment in another region says so instead of showing it.

## Layout

The board is a 12-column grid. A widget is 3, 4, 6, 8 or 12 columns wide and 1–3 rows tall (one row is about 150 px);
each type allows the sizes that suit it. On a tablet narrow widgets take half a row; on a phone everything is one
column, in the same order.

## Making and editing one

- **New dashboard** starts **blank** (it opens in edit mode) or from a template.
- **Edit** (the owner, or an admin for a team dashboard): rename, describe, **Add widget** from the catalogue, then fill
  in its settings — environments, services, resources, metrics, regions, repositories and saved queries are pickers,
  and the form checks the same rules the server does. Each widget gets a toolbar: move up, move down, size,
  configure, remove. **Save** keeps the change; **Cancel** drops it (closing the tab with unsaved changes asks first).
- **Duplicate** makes a private copy you own, of any dashboard you can see.
- **Delete** (owner, or an admin for a team dashboard) asks first.

If someone else saves the same dashboard while you are editing it, your save is refused rather than overwriting
theirs: you choose **Discard mine, load theirs** or **Save mine over theirs**.

## Sharing

| Visibility | Who sees it | Who can change or delete it |
|---|---|---|
| **Only me** (private, the default) | You | You |
| **The team**, from a minimum role | Everyone signed in whose role is at least that role ("Viewer" = everyone) | You, and admins |

Nobody else — admins included — sees a private dashboard. Teammates can view and duplicate a shared one. Sharing a
dashboard, changing who on the team sees it, and deleting a shared one are written to the [audit
log](security.md) (`dashboard.share`, `dashboard.delete`; an intent row in the same transaction as the change, so the
change can't land without it). Personal edits — renames, widgets, layout — are not audited.

A widget shows each viewer only what their role allows, so sharing a dashboard never shares data a teammate couldn't
open themselves. A log-query widget that uses one of your **private** saved queries shows "not found" to others:
share the query too.

## Templates

| Template | Widgets |
|---|---|
| **Team overview** | Environment status, issues, approvals, deploys in the last 24 h, costs |
| **Incident** | Issues, CloudWatch alarms, CI failures, deploys and rollbacks in the last 6 h, a CPU chart for each unhealthy service (at most four, worst first), approvals |

**Use template** makes your own copy to change. The Incident template's charts are worked out from the issues at
the moment you copy it.

## The Incident view

**Incident view** (`/incident`, linked from the issues list) is the Incident template rendered live and read-only for
everyone: the charts follow whichever services are unhealthy right now. **Copy to my dashboards** turns it into a
dashboard of your own.

## Home page

**Set as my home page** on a dashboard or on the Incident view makes `/` open it instead of the Overview; press it
again (it reads **Home page**) to go back to the Overview. Each person has their own home page.

- Links into the Overview always open it: `/?r=<resource>` (from the palette, notifications and the issues list),
  `/?env=<environment>` and `/?view=overview`. The home dashboard's header links to the Overview too.
- If your home dashboard is deleted or no longer shared with you, `/` shows the Overview with a note, and deleting a
  dashboard clears the home page of everyone who had chosen it.

## Pins

The star on a resource's panel (overview and map) pins it to your workspace; the **Pinned resources** widget lists
them and can unpin. Pins are personal and not audited.

## Saved views and log queries

- **Saved views** remember a page and its filters (`/logs?env=staging&service=api`): ⌘K → "Save this view".
- **Saved log queries** remember a search on the Logs page (environment, services, text, window): "Save query" there.

Both are listed under **Dashboards → Saved views and log queries**, where the owner (or an admin, for a shared one)
can share an item with the team, make it private again or delete it. Sharing and deleting a shared item are audited
(`saved.share`, `saved.delete`). A view always opens a console page — never another site.

## Limits

| What | Limit |
|---|---|
| Dashboards per person | 50 |
| Widgets per dashboard | 24 |
| Dashboard name / description | 80 / 500 characters |
| A dashboard as JSON | 64 KB |
| Pins per person | 200 |
| Saved views and log queries per person | 200 (each at most 8 KB) |

## For scripts

The APIs behind this page are for people signed in to the console; API tokens can't reach them.

| Route | Does |
|---|---|
| `GET /api/dashboards` | `{ dashboards, templates }`: yours and the team's you may see (summaries), and the templates |
| `POST /api/dashboards` | `{ name, description?, visibility?, minRole?, template?, widgets? }` → 201 `{ dashboard }` |
| `GET /api/dashboards/<id>` | `{ dashboard }` (404 when it doesn't exist or isn't shared with you) |
| `PATCH /api/dashboards/<id>` | `{ version, name?, description?, visibility?, minRole?, widgets? }` → `{ dashboard }`; a stale `version` → 409 `{ error, code: "version_conflict", version, dashboard }` |
| `DELETE /api/dashboards/<id>` | `{ ok, id }` |
| `POST /api/dashboards/<id>/duplicate` | `{ name? }` → 201 `{ dashboard }` |
| `GET` / `POST` / `DELETE /api/pins` | `{ pins }`; `{ rkey, name, kind, env?, region? }`; `?rkey=` |
| `GET /api/saved?kind=view\|log-query`, `POST /api/saved` | `{ items }`; `{ kind, name, payload, visibility? }` |
| `GET` / `PATCH` / `DELETE /api/saved/<id>` | `{ item }`; `{ name?, payload?, visibility? }`; `{ ok, id }` |
| `GET` / `PATCH /api/me/prefs` | `{ home?, region?, "dashboards.lastOpened"? }`; `home` is `overview`, `incident` or `dashboard:<id>`; `null` removes a key |

A widget is `{ id, type, title?, config, w, h }`; invalid input answers 400 `{ error, problems }`. Writes need the
`x-console-csrf: 1` header like every other console write.

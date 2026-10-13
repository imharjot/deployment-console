# Notes

A **note** is something you want to remember about a resource a month or two from now: what you changed and why,
special traffic it gets, a quirk, the runbook link. Notes attach to any resource the console knows — an ECS service,
a Lambda function, a queue, a bucket, a load balancer, an EC2 host, a database — and carry optional **tags** so the
same kind of note is easy to find again.

> Raised the health-check grace period to 60s after the 14:00 deploy flapped. Partner traffic from the logistics
> integration spikes at 02:00 UTC — see https://grafana.example.com/d/api (not a bug).

## Where you find them

| Place | What it shows |
|---|---|
| **Notes** tab of a resource on the overview (services, hosts, databases, caches, the load balancer) | That resource's notes, pinned first, then newest, and the form to add one. The tab shows how many there are. |
| The detail panel of a resource on the **cloud map** | The same notes, by the same key. |
| **All notes** (`/notes`, linked from every Notes tab) | Every note, most recently written first. Search the text, the resource's name and key; filter by tag and environment; open the resource. |

Resources are identified by the same key everywhere, so a note written on the overview shows on the cloud map and
the other way round: the resource's ARN, or `ecs:service/<cluster>/<service>`, `elb:<name>`, `rds:<id>`,
`elasticache:<id>`, `ec2:<instance id>`, `eks:<cluster>/<namespace>/<kind>/<name>`, `external:<id>` and
`cloudflare:<…>` where AWS gives no ARN (or the ARN would need the account id). A note keeps the resource's name as
it was when written, so it still makes sense after the resource is gone.

## Who can read and write

| Role | Read | Add, pin | Edit or delete |
|---|---|---|---|
| viewer | every note | — (the form is shown disabled) | — |
| developer, operator | every note | yes | their own notes |
| admin | every note | yes | anyone's notes |

Everyone signed in can read every note, so **never put secret values in a note** — link to where the secret lives
instead. Pinning keeps a note at the top of its resource's list; pinning and unpinning don't mark a note "edited",
changing its text or tags does.

## Writing a note

- Plain text, up to **10,000 characters**, line breaks kept. Leading and trailing blank space is trimmed.
- Up to **10 tags**: 1–32 lower-case letters, digits or dashes (`traffic`, `incident-42`). Type a tag and press
  Enter, comma or space; tags already used elsewhere are suggested.
- **⌘/Ctrl+Enter** saves, **Esc** cancels an edit (or leaves a half-written note without closing the panel).
- Saving is instant on screen; if the server refuses (validation, permissions, limits) the change is rolled back and
  the reason shown.

## Safe rendering

A note is shown exactly as typed. Only `http://` and `https://` URLs become links (opened in a new tab with
`rel="noreferrer noopener"`); trailing punctuation and unbalanced brackets stay outside the link, and URLs with a
user name (`https://a@b.example`) or longer than 2,048 characters stay text. Nothing else is interpreted: no HTML, no
markdown, no `javascript:` or `data:` links — `<b>` shows as `<b>`.

## What is audited

Every add, edit and delete writes an **intent** row to the [audit log](security.md) before the change and a
**result** row after it (action `note.create`, `note.update` or `note.delete`; target = the resource's name, or its
key). The row records who, when, the note id, the resource key, the tags, the pinned flag and the text's **length —
never the text itself**, which may hold anything people paste. If the intent row can't be written, the change is
refused, like every other write in the console.

## Limits and retention

- At most 500 notes and 1,000,000 characters of notes per resource, and 50,000 notes in the whole console. The
  console refuses new notes beyond that (HTTP 409) until old ones are deleted.
- Notes live in the console's own database (SQLite or Postgres, like users and the audit log) and are kept until
  someone deletes them. They are not removed when the resource disappears from AWS, nor when their author's account
  is disabled or deleted. There is no automatic expiry; back them up with the rest of the database.

## API and operations

People (signed in; the proxy refuses API tokens on these routes):

| Request | Result |
|---|---|
| `GET /api/notes?key=<resource key>` | `{ notes }` — that resource's notes, pinned first, then newest |
| `GET /api/notes?q=<text>&tag=<tag>&env=<env>&limit=<1–200>` | `{ notes }` — search across resources, most recently written first (default 50) |
| `GET /api/notes/tags` | `{ tags: [{ tag, count }] }` — tags in use, most used first |
| `POST /api/notes` `{ key, body, tags?, pinned?, resourceName?, env? }` | `201 { note }` — needs the developer role |
| `PATCH /api/notes/<id>` `{ body?, tags?, pinned? }` | `{ note }` — author or admin |
| `DELETE /api/notes/<id>` | `{ ok, id }` — author or admin |

Invalid input answers 400 with the reason, a missing permission 403, an unknown note 404. Writes need the
`x-console-csrf: 1` header and a same-origin `Origin`, like every write.

Agents and scripts use the [operations](operations.md#notes): `notes.list` and `notes.search` (read) and `notes.add`
(*change*, developer role; with a *propose* token it becomes an approval request, with a *read* token it is refused).
A note an agent adds is never written as a person alone: its author (and its audit row) reads
`<owner> via token "<name>"`, or `<approver> approving token "<name>"` when a person approved the request. Since that
isn't anyone's own email, only an admin can edit or delete such a note. Agents can't edit or delete notes.

"use client";
// /dashboards: your dashboards, the ones your team shares with you, the built-in templates (Team overview, Incident)
// and your saved views and log queries. "New dashboard" starts blank or from a template.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence } from "motion/react";
import { Bookmark, House, LayoutDashboard, Plus, ScrollText, Siren, Trash2, Users, X } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { useSWRConfig } from "swr";
import { useConfirm } from "@/components/confirm";
import { Modal } from "@/components/motion";
import { useToast } from "@/components/toast";
import { Button, Chip, Empty, IconButton, Skeleton, TimeAgo, cx } from "@/components/ui";
import { WORKSPACE_LIMITS, incidentWidgets, logsHref, viewHref, type Dashboard, type DashboardSummary, type IssueLike, type LogQueryPayload, type SavedItem, type TemplateId, type TemplateInfo, type ViewPayload } from "@/lib/dashboards";
import { Page, PageHeader, SectionTitle } from "@/app/_components/page-frame";
import { ShareChip } from "./dashboard-view";
import { send, useApi, usePrefs, useRefresh } from "./data";
import { WidgetIcon } from "./widgets";

const CARD = "press lift group flex h-full min-w-0 flex-col gap-2 rounded-2xl border border-line bg-panel p-4 shadow-card hover:border-line-strong [--press-scale:0.99]";

function Types({ types }: { types: DashboardSummary["types"] }) {
  return (
    <span className="flex flex-wrap gap-1" aria-label={`Widgets: ${types.join(", ")}`}>
      {types.slice(0, 9).map((t) => (
        <span key={t} title={t} className="grid size-6 place-items-center rounded-md border border-line bg-panel-2 text-fg-3">
          <WidgetIcon type={t} className="size-3.5" />
        </span>
      ))}
    </span>
  );
}

function DashboardCard({ d, home, last }: { d: DashboardSummary; home: boolean; last: boolean }) {
  return (
    <Link href={`/dashboards/${d.id}`} className={CARD}>
      <span className="flex min-w-0 items-start gap-2">
        <span className="min-w-0 flex-1 truncate text-[16px] font-medium tracking-[-0.01em]">{d.name}</span>
        {home && <House className="mt-0.5 size-4 flex-none text-up" aria-label="Your home page" />}
      </span>
      {d.description && <span className="line-clamp-2 text-[13.5px] leading-snug text-fg-3">{d.description}</span>}
      <span className="mt-auto flex flex-wrap items-center gap-1.5 pt-1 text-[12.5px] text-fg-3">
        <ShareChip d={d} />
        {!d.mine && <span className="truncate">by {d.owner.email ?? "a teammate"}</span>}
        <span>
          {d.widgetCount} widget{d.widgetCount === 1 ? "" : "s"} · <TimeAgo at={d.updatedAt} />
        </span>
        {last && <Chip tone="muted">last opened</Chip>}
      </span>
      {d.types.length > 0 && <Types types={d.types} />}
    </Link>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="stagger grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{children}</div>;
}

const TEMPLATE_ICON: Record<TemplateId, ReactNode> = {
  "team-overview": <Users className="size-4" aria-hidden />,
  incident: <Siren className="size-4 text-down" aria-hidden />,
};

function NewDialog({ templates, initial, onClose }: { templates: TemplateInfo[]; initial: TemplateId | "blank"; onClose: () => void }) {
  const [from, setFrom] = useState<TemplateId | "blank">(initial);
  const [name, setName] = useState(initial === "blank" ? "" : (templates.find((t) => t.id === initial)?.name ?? ""));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();
  const refresh = useRefresh();
  const { mutate } = useSWRConfig();
  const issues = useApi<IssueLike[]>(from === "incident" ? "/api/issues" : null, 0);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const body = from === "blank" ? { name } : { name, template: from, ...(from === "incident" ? { widgets: incidentWidgets(Array.isArray(issues.data) ? issues.data : []) } : {}) };
      const out = await send<{ dashboard: Dashboard }>("POST", "/api/dashboards", body);
      await Promise.all([refresh("/api/dashboards"), mutate("/api/dashboards")]);
      router.push(`/dashboards/${out.dashboard.id}${from === "blank" ? "?edit=1" : ""}`);
    } catch (e2) {
      setErr((e2 as Error).message);
      setBusy(false);
    }
  };
  const option = (id: TemplateId | "blank", title: string, hint: string, icon: ReactNode) => (
    <label key={id} className={cx("press flex cursor-pointer gap-3 rounded-xl border p-3 transition-colors [--press-scale:0.985]", from === id ? "border-accent/60 bg-accent-soft" : "border-line hover:border-line-strong hover:bg-panel-2")}>
      <input
        type="radio"
        name="from"
        checked={from === id}
        onChange={() => {
          setFrom(id);
          if (!name.trim() || templates.some((t) => t.name === name) || name === "") setName(id === "blank" ? "" : (templates.find((t) => t.id === id)?.name ?? ""));
        }}
        className="mt-1"
      />
      <span className="grid size-8 flex-none place-items-center rounded-lg border border-line bg-panel-2 text-fg-2">{icon}</span>
      <span className="min-w-0">
        <span className="block text-[14px] font-medium">{title}</span>
        <span className="mt-0.5 block text-[12.5px] leading-snug text-fg-3">{hint}</span>
      </span>
    </label>
  );
  return (
    <Modal onClose={busy ? undefined : onClose} aria-labelledby="new-dash-title" className="max-w-lg">
      <form onSubmit={submit} className="flex min-h-0 flex-col">
        <div className="flex items-start justify-between gap-3 px-5 pt-5">
          <div>
            <h2 id="new-dash-title" className="font-display text-[26px] leading-tight">New dashboard</h2>
            <p className="mt-1 text-[13.5px] text-fg-3">Private to you until you share it with the team.</p>
          </div>
          <IconButton type="button" label="Close" onClick={onClose} disabled={busy}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="min-h-0 space-y-4 overflow-y-auto px-5 py-4">
          <label className="block">
            <span className="mb-1.5 block text-[13.5px] font-medium text-fg-2">Name</span>
            <input
              required
              autoFocus
              maxLength={WORKSPACE_LIMITS.nameChars}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Payments on call"
              className="h-10 w-full rounded-lg border border-line bg-panel-2 px-3 text-[14.5px] outline-none placeholder:text-fg-3 focus:border-accent focus:bg-panel pointer-coarse:h-11"
            />
          </label>
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-[13.5px] font-medium text-fg-2">Start from</legend>
            {option("blank", "Blank", "Add widgets from the catalogue.", <LayoutDashboard className="size-4" aria-hidden />)}
            {templates.map((t) => option(t.id, t.name, t.description, TEMPLATE_ICON[t.id]))}
          </fieldset>
          {err && <div role="alert" className="rounded-lg border border-down/25 bg-down/10 px-3 py-2 text-[13.5px] text-down">{err}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create"}</Button>
        </div>
      </form>
    </Modal>
  );
}

function SavedRow({ s }: { s: SavedItem }) {
  const toast = useToast();
  const ask = useConfirm();
  const refresh = useRefresh();
  const { mutate } = useSWRConfig();
  const [busy, setBusy] = useState(false);
  const href = s.kind === "view" ? viewHref(s.payload as ViewPayload) : logsHref(s.payload as LogQueryPayload);
  const after = () => Promise.all([refresh("/api/saved"), mutate(`/api/saved?kind=${s.kind}`)]);
  const share = async () => {
    setBusy(true);
    try {
      await send("PATCH", `/api/saved/${s.id}`, { visibility: s.visibility === "team" ? "private" : "team" });
      await after();
    } catch (e) {
      toast.push({ tone: "error", title: "Couldn't change who sees it", body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const remove = () =>
    ask({
      env: "",
      title: `Delete “${s.name}”?`,
      description: s.visibility === "team" ? "It is shared with the team: it disappears for everyone." : "This can't be undone.",
      danger: true,
      expected: "yes",
      confirmLabel: "Delete",
      run: async () => {
        await send("DELETE", `/api/saved/${s.id}`);
        await after();
      },
    });
  return (
    <li className="flex min-w-0 items-center gap-2 py-1.5">
      <Link href={href} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-panel-2 pointer-coarse:py-2.5">
        {s.kind === "view" ? <Bookmark className="size-3.5 flex-none text-fg-3" aria-hidden /> : <ScrollText className="size-3.5 flex-none text-fg-3" aria-hidden />}
        <span className="min-w-0 truncate text-[14px] font-medium">{s.name}</span>
        <span className="hidden min-w-0 truncate font-mono text-[12.5px] text-fg-3 sm:inline">{s.kind === "view" ? href : (s.payload as LogQueryPayload).query}</span>
      </Link>
      {!s.mine && <span className="hidden flex-none truncate text-[12.5px] text-fg-3 md:inline">by {s.owner.email ?? "a teammate"}</span>}
      {s.canEdit ? (
        <button type="button" disabled={busy} onClick={share} title={s.visibility === "team" ? "Shared with the team — make it private" : "Private — share it with the team"} className="press flex-none rounded-md pointer-coarse:p-2">
          <ShareChip d={{ visibility: s.visibility, minRole: "viewer" }} />
        </button>
      ) : (
        <ShareChip d={{ visibility: s.visibility, minRole: "viewer" }} />
      )}
      {s.canEdit && (
        <IconButton label={`Delete ${s.name}`} onClick={remove}>
          <Trash2 className="size-3.5" />
        </IconButton>
      )}
    </li>
  );
}

export function DashboardsPage() {
  const r = useApi<{ dashboards: DashboardSummary[]; templates: TemplateInfo[] }>("/api/dashboards", 60_000);
  const saved = useApi<{ items: SavedItem[] }>("/api/saved", 60_000);
  const { prefs } = usePrefs();
  const [creating, setCreating] = useState<TemplateId | "blank" | null>(null);
  const all = r.data?.dashboards ?? [];
  const lastId = prefs?.["dashboards.lastOpened"];
  const mine = [...all.filter((d) => d.mine)].sort((a, b) => (a.id === lastId ? -1 : b.id === lastId ? 1 : 0));
  const team = all.filter((d) => !d.mine);
  const homeId = prefs?.home?.startsWith("dashboard:") ? prefs.home.slice(10) : undefined;
  const full = mine.length >= WORKSPACE_LIMITS.dashboardsPerUser;
  const items = saved.data?.items ?? [];

  return (
    <Page width="wide">
      <PageHeader
        title="Dashboards"
        description="Your own boards and the ones your team shares, built from live widgets. Each widget shows only what your role may see."
        actions={
          <Button variant="primary" onClick={() => setCreating("blank")} disabled={!r.data || full} title={full ? `At most ${WORKSPACE_LIMITS.dashboardsPerUser} dashboards` : undefined}>
            <Plus className="size-3.5" aria-hidden /> New dashboard
          </Button>
        }
      />

      {!r.data ? (
        r.error ? (
          <Empty icon={<LayoutDashboard className="size-5" />} title="Couldn't load dashboards" hint={r.error.message} />
        ) : (
          <Grid>{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-36 rounded-2xl" />)}</Grid>
        )
      ) : (
        <>
          <section className="space-y-3">
            <SectionTitle>Yours</SectionTitle>
            {mine.length ? (
              <Grid>{mine.map((d) => <DashboardCard key={d.id} d={d} home={d.id === homeId} last={d.id === lastId && mine.length > 1} />)}</Grid>
            ) : (
              <div className="rounded-2xl border border-dashed border-line-strong">
                <Empty icon={<LayoutDashboard className="size-5" />} title="No dashboards yet" hint="Start blank or from a template below — Team overview is a good first one." />
              </div>
            )}
          </section>

          {team.length > 0 && (
            <section className="space-y-3">
              <SectionTitle>Shared with you</SectionTitle>
              <Grid>{team.map((d) => <DashboardCard key={d.id} d={d} home={d.id === homeId} last={false} />)}</Grid>
            </section>
          )}

          <section className="space-y-3">
            <SectionTitle>Templates</SectionTitle>
            <Grid>
              {r.data.templates.map((t) => (
                <div key={t.id} className={cx(CARD, "hover:border-line")}>
                  <span className="flex items-center gap-2">
                    <span className="grid size-7 place-items-center rounded-lg border border-line bg-panel-2 text-fg-2">{TEMPLATE_ICON[t.id]}</span>
                    <span className="text-[16px] font-medium tracking-[-0.01em]">{t.name}</span>
                  </span>
                  <span className="text-[13.5px] leading-snug text-fg-3">{t.description}</span>
                  <Types types={[...new Set(t.widgets.map((w) => w.type))]} />
                  <span className="mt-auto flex flex-wrap gap-2 pt-1">
                    <Button size="sm" variant="secondary" onClick={() => setCreating(t.id)} disabled={full}>
                      <Plus className="size-3.5" aria-hidden /> Use template
                    </Button>
                    {t.id === "incident" && (
                      <Link href="/incident" className="press inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-fg-2 hover:bg-panel-3 hover:text-fg pointer-coarse:h-9">
                        <Siren className="size-3.5" aria-hidden /> Open the live view
                      </Link>
                    )}
                  </span>
                </div>
              ))}
            </Grid>
          </section>

          <section className="space-y-2">
            <SectionTitle>Saved views and log queries</SectionTitle>
            {!saved.data ? (
              saved.error ? <p className="text-[13.5px] text-fg-3">{saved.error.message}</p> : <Skeleton className="h-16 rounded-xl" />
            ) : items.length ? (
              <ul className="divide-y divide-line rounded-2xl border border-line bg-panel px-3 shadow-card">{items.map((s) => <SavedRow key={s.id} s={s} />)}</ul>
            ) : (
              <p className="flex items-center gap-2 rounded-xl border border-dashed border-line-strong px-3.5 py-3 text-[13.5px] text-fg-3">
                <Bookmark className="size-3.5 flex-none" aria-hidden /> Save a view from the command palette (⌘K → “Save this view”) or a query from the Logs page; they show up here.
              </p>
            )}
          </section>
        </>
      )}

      <AnimatePresence>{creating && r.data && <NewDialog key={creating} templates={r.data.templates} initial={creating} onClose={() => setCreating(null)} />}</AnimatePresence>
    </Page>
  );
}

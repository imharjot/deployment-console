"use client";
// One dashboard: view mode for everyone who may see it, and an edit mode for its owner (or an admin, for a team
// dashboard) — add from the catalogue, configure, move, resize, remove, rename, share. Saving sends the version that
// was edited; if someone else saved in between, the server refuses (409) and this offers to load their version or to
// save over it deliberately. Also: duplicate, delete, and "Set as my home page".
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Copy, House, LayoutDashboard, Lock, Pencil, Plus, Trash2, TriangleAlert, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSWRConfig } from "swr";
import { useConfirm } from "@/components/confirm";
import { useToast } from "@/components/toast";
import { Button, Chip, Empty, Segmented, Skeleton, TimeAgo, cx } from "@/components/ui";
import { ROLE_INFO } from "@/components/user-menu";
import { WORKSPACE_LIMITS, moveWidget, snapSize, type Dashboard, type Visibility, type Widget } from "@/lib/dashboards";
import { ROLES, type Role } from "@/lib/rbac";
import { Page } from "@/app/_components/page-frame";
import { WidgetDialog } from "./config-form";
import { SendError, send, useApi, usePrefs, useRefresh } from "./data";
import { DashboardGrid } from "./grid";
import { Select } from "@/components/select";

interface Draft {
  version: number;
  name: string;
  description: string;
  visibility: Visibility;
  minRole: Role;
  widgets: Widget[];
}

const draftOf = (d: Dashboard): Draft => ({ version: d.version, name: d.name, description: d.description ?? "", visibility: d.visibility, minRole: d.minRole, widgets: d.widgets });
const same = (a: Draft, d: Dashboard) => JSON.stringify(draftOf(d)) === JSON.stringify({ ...a, version: d.version });

export function ShareChip({ d }: { d: Pick<Dashboard, "visibility" | "minRole"> }) {
  return d.visibility === "team" ? (
    <Chip tone="accent" className="flex-none">
      <Users className="size-3" aria-hidden /> Team{d.minRole !== "viewer" ? ` · ${ROLE_INFO[d.minRole].label.toLowerCase()}+` : ""}
    </Chip>
  ) : (
    <Chip tone="muted" className="flex-none">
      <Lock className="size-3" aria-hidden /> Private
    </Chip>
  );
}

export function DashboardSkeleton() {
  return (
    <Page width="wide">
      <Skeleton className="h-10 w-64" />
      <div className="grid auto-rows-[148px] grid-cols-1 gap-4 md:grid-cols-12">
        {[12, 6, 6, 8, 4].map((w, i) => <Skeleton key={i} className={cx("rounded-2xl", w === 12 ? "md:col-span-12" : w === 8 ? "md:col-span-12 xl:col-span-8" : w === 4 ? "md:col-span-6 xl:col-span-4" : "md:col-span-6", i ? "row-span-2" : "")} />)}
      </div>
    </Page>
  );
}

export function DashboardView({ id, home, startEditing }: { id: string; home?: boolean; startEditing?: boolean }) {
  const url = `/api/dashboards/${encodeURIComponent(id)}`;
  const r = useApi<{ dashboard: Dashboard }>(url, 60_000);
  const d = r.data?.dashboard;
  const { prefs, set: setPrefs } = usePrefs();
  const isHome = prefs?.home === `dashboard:${id}`;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dialog, setDialog] = useState<{ editing?: string } | null>(null);
  const [conflict, setConflict] = useState<Dashboard | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  const ask = useConfirm();
  const router = useRouter();
  const refresh = useRefresh();
  const { mutate } = useSWRConfig();
  const dirty = !!draft && !!d && !same(draft, d);

  // Opened in edit mode (a new blank dashboard), once it has loaded.
  const [autoEdit, setAutoEdit] = useState(!!startEditing);
  if (autoEdit && d && !draft) {
    setAutoEdit(false);
    if (d.canEdit) setDraft(draftOf(d));
  }

  // Remember the last dashboard opened (the list offers it first). Not for the home page, which opens itself.
  const lastOpened = prefs?.["dashboards.lastOpened"];
  useEffect(() => {
    if (!home && d && prefs && lastOpened !== d.id) setPrefs({ "dashboards.lastOpened": d.id }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per dashboard, when both have loaded
  }, [home, d?.id, !!prefs, lastOpened]);

  // Unsaved edits survive neither a reload nor closing the tab without a warning.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const lists = useCallback(() => Promise.all([refresh("/api/dashboards"), mutate("/api/dashboards")]), [refresh, mutate]);

  const save = async (version?: number) => {
    if (!draft) return;
    setBusy(true);
    setErr(null);
    try {
      await send<{ dashboard: Dashboard }>("PATCH", url, {
        version: version ?? draft.version, name: draft.name, description: draft.description.trim() || null, visibility: draft.visibility, minRole: draft.minRole, widgets: draft.widgets,
      });
      await Promise.all([r.reload(), lists()]);
      setDraft(null);
      setConflict(null);
      toast.push({ tone: "ok", title: "Dashboard saved" }, 2500);
    } catch (e) {
      if (e instanceof SendError && e.status === 409 && e.body?.dashboard) setConflict(e.body.dashboard as Dashboard);
      else {
        const problems = e instanceof SendError && Array.isArray(e.body?.problems) ? (e.body!.problems as string[]) : [];
        setErr(problems.length > 1 ? problems.slice(0, 3).join(" · ") : (e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  const setHome = async () => {
    try {
      await setPrefs({ home: isHome ? null : `dashboard:${id}` });
      toast.push({ tone: "ok", title: isHome ? "Home page is the Overview again" : `“${d?.name}” is your home page` }, 3000);
    } catch (e) {
      toast.push({ tone: "error", title: "Couldn't change your home page", body: (e as Error).message });
    }
  };

  const duplicate = async () => {
    try {
      const out = await send<{ dashboard: Dashboard }>("POST", `${url}/duplicate`, {});
      await lists();
      toast.push({ tone: "ok", title: `Copied to “${out.dashboard.name}”` }, 3000);
      router.push(`/dashboards/${out.dashboard.id}`);
    } catch (e) {
      toast.push({ tone: "error", title: "Couldn't duplicate", body: (e as Error).message });
    }
  };

  const remove = () =>
    d &&
    ask({
      env: "",
      title: `Delete “${d.name}”?`,
      description: d.visibility === "team" ? "It is shared with the team: it disappears for everyone, and anyone using it as their home page sees the Overview again." : "This can't be undone.",
      danger: true,
      expected: "yes",
      confirmLabel: "Delete dashboard",
      run: async () => {
        await send("DELETE", url);
        await Promise.all([lists(), refresh("/api/me/prefs")]);
        toast.push({ tone: "ok", title: `“${d.name}” deleted` }, 3000);
        router.push("/dashboards");
      },
    });

  const edit = useMemo(
    () =>
      draft && {
        move: (wid: string, by: -1 | 1) => setDraft((x) => x && { ...x, widgets: moveWidget(x.widgets, wid, by) }),
        resize: (wid: string, w: Widget["w"], h: Widget["h"]) => setDraft((x) => x && { ...x, widgets: x.widgets.map((it) => (it.id === wid ? { ...it, ...snapSize(it.type, w, h) } : it)) }),
        configure: (wid: string) => setDialog({ editing: wid }),
        remove: (wid: string) => setDraft((x) => x && { ...x, widgets: x.widgets.filter((it) => it.id !== wid) }),
      },
    [draft],
  );

  if (!d) {
    if (r.error) {
      return (
        <Page width="wide">
          <Empty icon={<LayoutDashboard className="size-5" />} title={(r.error as { status?: number }).status === 404 ? "No such dashboard" : "Couldn't load this dashboard"} hint={<>{r.error.message} <Link href="/dashboards" className="text-accent hover:underline">All dashboards</Link></>} />
        </Page>
      );
    }
    return <DashboardSkeleton />;
  }

  const widgets = draft?.widgets ?? d.widgets;
  const full = (draft?.widgets.length ?? 0) >= WORKSPACE_LIMITS.widgets;
  const editingWidget = dialog?.editing ? draft?.widgets.find((w) => w.id === dialog.editing) : undefined;

  return (
    <Page width="wide">
      <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        {draft ? (
          <div className="grid w-full min-w-0 max-w-2xl gap-2">
            <input
              aria-label="Dashboard name"
              value={draft.name}
              maxLength={WORKSPACE_LIMITS.nameChars}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className="w-full min-w-0 rounded-lg border border-line bg-panel-2 px-3 py-1 font-display text-[30px] leading-tight outline-none focus:border-accent sm:text-[34px]"
            />
            <input
              aria-label="Description"
              value={draft.description}
              maxLength={WORKSPACE_LIMITS.descriptionChars}
              placeholder="What this dashboard is for (optional)"
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              className="h-9 w-full min-w-0 rounded-lg border border-line bg-panel-2 px-3 text-[14px] text-fg-2 outline-none placeholder:text-fg-3 focus:border-accent pointer-coarse:h-11"
            />
          </div>
        ) : (
          <div className="min-w-0 max-w-2xl">
            <h1 className="text-[34px] leading-none [overflow-wrap:anywhere] sm:text-[40px]">{d.name}</h1>
            {d.description && <p className="mt-2 text-[14px] leading-relaxed text-fg-3">{d.description}</p>}
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[12.5px] text-fg-3">
              <ShareChip d={d} />
              {isHome && <Chip tone="ok"><House className="size-3" aria-hidden /> Your home page</Chip>}
              {!d.mine && <span>by {d.owner.email ?? "a teammate"}</span>}
              <span>· updated <TimeAgo at={d.updatedAt} /></span>
              {home && (
                <span>
                  · <Link href="/?view=overview" className="text-accent hover:underline">Overview</Link> · <Link href="/dashboards" className="text-accent hover:underline">All dashboards</Link>
                </span>
              )}
            </div>
          </div>
        )}
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          {draft ? (
            <>
              <Button variant="secondary" onClick={() => setDialog({})} disabled={full} title={full ? `At most ${WORKSPACE_LIMITS.widgets} widgets` : undefined}>
                <Plus className="size-3.5" aria-hidden /> Add widget
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => (setDraft(null), setErr(null), setConflict(null))}>Cancel</Button>
              <Button variant="primary" disabled={busy || !draft.name.trim() || !dirty} onClick={() => save()}>{busy ? "Saving…" : "Save"}</Button>
            </>
          ) : (
            <>
              {d.canEdit && (
                <Button variant="secondary" onClick={() => setDraft(draftOf(d))}>
                  <Pencil className="size-3.5" aria-hidden /> Edit
                </Button>
              )}
              <Button variant={isHome ? "secondary" : "ghost"} aria-pressed={isHome} onClick={setHome} disabled={!prefs} title={isHome ? "Make the Overview your home page again" : "Open this dashboard when you open the console"}>
                <House className="size-3.5" aria-hidden /> {isHome ? "Home page" : "Set as my home page"}
              </Button>
              <Button variant="ghost" onClick={duplicate}>
                <Copy className="size-3.5" aria-hidden /> Duplicate
              </Button>
              {d.canEdit && (
                <Button variant="ghost" onClick={remove} aria-label="Delete dashboard" title="Delete dashboard">
                  <Trash2 className="size-3.5" aria-hidden />
                  <span className="sm:sr-only">Delete</span>
                </Button>
              )}
            </>
          )}
        </div>
      </header>

      {draft && (
        <section aria-label="Sharing" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-panel px-3.5 py-2.5">
          <span className="text-[13.5px] font-medium text-fg-2">Who sees it</span>
          <Segmented
            id="dash-share"
            size="sm"
            value={draft.visibility}
            onChange={(v) => setDraft({ ...draft, visibility: v })}
            options={[{ value: "private", label: "Only me" }, { value: "team", label: "The team" }]}
          />
          {draft.visibility === "team" && (
            <label className="flex items-center gap-2 text-[13.5px] text-fg-2">
              from
              <Select<Role>
                aria-label="Minimum role"
                value={draft.minRole}
                onChange={(r) => setDraft({ ...draft, minRole: r })}
                base="h-8 rounded-lg border border-line bg-panel-2 px-2 text-[13.5px] outline-none hover:border-line-strong focus-visible:border-accent pointer-coarse:h-10"
                options={ROLES.map((x) => ({ value: x, label: `${ROLE_INFO[x].label}${x === "viewer" ? " (everyone)" : " and up"}` }))}
              />
            </label>
          )}
          <span className="text-[12.5px] text-fg-3">
            {draft.visibility === "team" ? "Teammates can view and duplicate it; only you (and admins) can change it. Sharing is recorded in the audit log." : "Only you can see it."}
          </span>
        </section>
      )}

      {conflict && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-degraded/30 bg-degraded/8 px-3.5 py-2.5 text-[13.5px] text-degraded">
          <TriangleAlert className="size-4 flex-none" aria-hidden />
          <span className="min-w-0 flex-1 text-fg-2">
            <b className="font-medium text-degraded">Changed by someone else</b> while you were editing (now version {conflict.version}, updated <TimeAgo at={conflict.updatedAt} />). Your edits aren&apos;t saved yet.
          </span>
          <span className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => (setDraft(null), setConflict(null), r.reload())}>Discard mine, load theirs</Button>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => save(conflict.version)}>Save mine over theirs</Button>
          </span>
        </div>
      )}
      {err && <div role="alert" className="rounded-lg border border-down/25 bg-down/10 px-3 py-2 text-[13.5px] text-down">{err}</div>}

      <DashboardGrid
        widgets={widgets}
        edit={edit || undefined}
        empty={
          <div className="rounded-2xl border border-dashed border-line-strong">
            <Empty
              icon={<LayoutDashboard className="size-5" />}
              title="No widgets yet"
              hint={draft ? <Button variant="primary" size="sm" onClick={() => setDialog({})}><Plus className="size-3.5" aria-hidden /> Add a widget</Button> : d.canEdit ? "Edit the dashboard to add widgets." : "Its owner hasn't added any widgets yet."}
            />
          </div>
        }
      />

      <WidgetDialog
        open={!!dialog}
        editing={editingWidget}
        taken={draft?.widgets.map((w) => w.id) ?? []}
        onClose={() => setDialog(null)}
        onSave={(w) => setDraft((x) => x && { ...x, widgets: x.widgets.some((it) => it.id === w.id) ? x.widgets.map((it) => (it.id === w.id ? w : it)) : [...x.widgets, w] })}
      />
    </Page>
  );
}

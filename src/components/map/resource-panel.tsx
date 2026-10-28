"use client";
// The cloud map's resource panel: a sheet from the right (a bottom sheet on phones) with Overview, Connections,
// Details, Actions and Notes for any resource in the inventory. On desktop the sheet is not modal (F22): the map
// beside it stays live, clicking another node switches the panel, and one Escape closes only the panel.
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, ArrowRight, ArrowUpRight, Check, ChevronRight, Copy, Download, ExternalLink, File as FileIcon, Folder, LineChart, Loader2, Lock, Play, ShieldAlert, ShieldCheck, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createElement, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, getJson } from "@/lib/client/api";
import { stamp } from "@/lib/client/format";
import { vpcIdOfKey } from "@/lib/inventory/layout";
import { categoryOf, kindLabelOf, serviceOf, type ActionInfo, type Edge, type EdgeKind, type EnrichState, type InventoryView, type Prop, type Resource, type ResourceDetail } from "@/lib/inventory/types";
import { AskAbout, mapSubject } from "../assistant/status";
import { MetricChart } from "../charts";
import { Modal, Sheet, Swap, enter, swap, usePhone } from "../motion";
import { Notes } from "../notes";
import { PinButton } from "../pin-button";
import { catHue } from "../hue";
import { Button, Chip, Empty, IconButton, Skeleton, Tabs, copy, cx } from "../ui";
import { ActionDialog } from "./action-dialog";
import { CONNECT_PROVIDER, connectTargets } from "./connect";
import { detailUrl, useResourceActions, useResourceDetail } from "./data";
import { REMOTE_TEXT, isRemote, isVanishing } from "./chips";
import { CONFIDENCE, EDGE_FAMILY, EDGE_VERB, FAMILY, HEALTH, HealthDot, healthStyle, iconOf, routingText } from "./kinds";

export const TAGS_UNREAD_TEXT = "tags not read — treated as protected"; // same words as src/lib/inventory/action-rules.ts

// F16: resources whose metrics live on the Metrics page (by environment).
const METRIC_KINDS = new Set(["rds", "loadbalancer", "elasticache"]);
export const metricsHref = (r: Pick<Resource, "kind" | "env">) => (METRIC_KINDS.has(r.kind) && r.env ? `/metrics?env=${encodeURIComponent(r.env)}` : undefined);

type Tab = "overview" | "connections" | "details" | "actions" | "notes";
const titles = { open: 0, base: "" };

// The ECS overview opens its own panel for services (`?env=<env>&r=service:<name>`); keys look like
// ecs:service/<cluster>/<service> (src/lib/inventory/types.ts → keys.ecsService).
export function ecsPanelHref(r: Resource) {
  if (r.kind !== "ecs-service" || !r.env) return undefined;
  const m = /^ecs:service\/[^/]+\/(.+)$/.exec(r.key);
  const name = m?.[1] ?? r.name;
  return `/?env=${encodeURIComponent(r.env)}&r=${encodeURIComponent(`service:${name}`)}`;
}

export function MapResourcePanel({ r, view, visible, onClose, onSelect, onShowChildren }: {
  r: Resource;
  view: InventoryView;
  visible: ReadonlySet<string>; // keys drawn on the map right now (the rest are hidden by filters)
  onClose(): void;
  onSelect(key: string): void; // focus another resource (Connections, Relationships)
  onShowChildren?(key: string): void; // unfold this resource's children on the map
}) {
  const phone = usePhone();
  const [tab, setTab] = useState<Tab>("overview");
  const bodyReady = useDeferredValue(true, false);
  const root = useRef<HTMLDivElement>(null);
  const byKey = useMemo(() => new Map(view.resources.map((x) => [x.key, x])), [view.resources]);
  const incoming = useMemo(() => view.edges.filter((e) => e.to === r.key), [view.edges, r.key]);
  const outgoing = useMemo(() => view.edges.filter((e) => e.from === r.key), [view.edges, r.key]);
  const env = r.env ? view.envs.find((e) => e.id === r.env) : undefined;
  const multiRegion = (view.regions?.length ?? 0) > 1;
  const onMap = usePathname() === "/map";

  // Esc closes the panel unless a dialog above it (an action, a confirmation) is open, a field used the key, or
  // something on the map already handled it (a pinned connection closes first). It marks the key as used, so the
  // map's own Escape handlers leave it alone: one press, one thing closed.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const others = [...document.querySelectorAll("[role=dialog][aria-modal]")].filter((d) => !d.contains(root.current));
      if (others.length) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("textarea, input:not([type=checkbox]):not([type=radio])") && (t as HTMLInputElement).value) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  // F43: the tab says which resource is open. Panels overlap while one animates out and the next comes in, so the
  // page's own title is kept aside by the first and put back by the last.
  const where = onMap ? "Cloud map" : "All resources";
  useEffect(() => {
    if (titles.open++ === 0) titles.base = document.title;
    document.title = `${r.name} · ${where}`;
    return () => {
      if (--titles.open === 0) document.title = titles.base;
    };
  }, [r.name, where]);

  const ecsHref = ecsPanelHref(r);
  // The assistant: "Explain this" for any resource, "Why is this unhealthy?" when its health isn't ok.
  const asked = mapSubject(r, kindLabelOf(r), env?.label ?? r.env);
  const body = (
    <div ref={root} className="flex min-h-0 flex-1 flex-col" style={healthStyle(r.health)} data-map-panel>
      <header className="relative flex-none space-y-3 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-6 sm:pt-5">
        <div className="flex items-start gap-3">
          <span className="hue-chip mt-1 grid size-9 flex-none place-items-center rounded-xl" style={catHue(categoryOf(r))}>
            {createElement(iconOf(r), { className: "size-[18px]", strokeWidth: 1.7, "aria-hidden": true })}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-display text-[26px] leading-[1.15] sm:text-[30px]" title={r.name}>{r.name}</h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
              <span>{kindLabelOf(r)}</span>
              <span aria-hidden>·</span>
              <span>{r.region === "global" ? "global" : r.region}</span>
            </div>
          </div>
          <PinButton rkey={r.key} name={r.name} kind={r.kind} env={r.env} region={r.region === "global" ? undefined : r.region} className="max-sm:size-10" />
          <IconButton label="Close (Esc)" onClick={onClose} className="-mr-1 max-sm:size-10">
            <X className="size-[18px]" />
          </IconButton>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-[color-mix(in_srgb,var(--dot)_24%,transparent)] bg-[color-mix(in_srgb,var(--dot)_7%,transparent)] px-2 py-0.5 text-[12px] font-medium text-[var(--dot)]"
          >
            <HealthDot health={r.health} className="!size-1.5" />
            {HEALTH[r.health].label}
          </span>
          <span title={r.envWhy ? `Environment from ${r.envWhy}` : r.env ? undefined : "No environment claims this resource"}>
            <Chip tone={env?.protected ? "bad" : r.env ? undefined : "muted"} mono>
              {env?.protected && <Lock className="size-2.5" />}
              {env?.label ?? r.env ?? "Shared"}
            </Chip>
          </span>
          {multiRegion && r.region !== "global" && <Chip mono tone="muted">{r.region}</Chip>}
          {r.idle && <Chip tone="muted">idle</Chip>}
          {isRemote(r) && <Chip tone="muted">{REMOTE_TEXT}</Chip>}
          {r.tagsUnread && (
            <span title="Its tags couldn't be read (a cap, a time budget or a refused read), so changes follow the protected-environment rules until they are.">
              <Chip tone="warn">{TAGS_UNREAD_TEXT}</Chip>
            </span>
          )}
          {r.envWhy && <span className="text-[12px] text-fg-3">· {r.envWhy}</span>}
        </div>

        {(r.healthReason || r.idle || r.facts?.idleEvidence === "insufficient") && (
          <ul className="space-y-1 text-[14px] leading-relaxed">
            {r.healthReason && <li className={r.health === "ok" || isVanishing(r) || isRemote(r) ? "text-fg-2" : "text-[var(--dot)]"}>{r.healthReason}</li>}
            {r.idle && (
              <li className="text-fg-2">
                Idle: {r.idle.why}
                {r.idle.since ? <span className="text-fg-3"> · since {stamp(r.idle.since)}</span> : null}
              </li>
            )}
            {!r.idle && r.facts?.idleEvidence === "insufficient" && <li className="text-fg-3">Not enough activity data to judge whether it is idle.</li>}
            {isVanishing(r) && <li className="text-fg-3">The last complete read didn&apos;t list it. If the next one doesn&apos;t either, it leaves the map.</li>}
          </ul>
        )}

        <div className="flex flex-wrap gap-2">
          <AskAbout subject={asked.subject} unhealthy={asked.unhealthy} className="contents" />
          {ecsHref && (
            <Link href={ecsHref} className="press inline-flex h-7 items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 text-xs font-medium text-fg shadow-card hover:border-line-strong hover:bg-panel-2 pointer-coarse:h-9">
              Open the service panel <ArrowRight className="size-3.5" />
            </Link>
          )}
          {!onMap && !r.hidden && (
            <Link href={`/map?r=${encodeURIComponent(r.key)}`} className="press inline-flex h-7 items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 text-xs font-medium text-fg shadow-card hover:border-line-strong hover:bg-panel-2 pointer-coarse:h-9">
              Show on the map <ArrowRight className="size-3.5" />
            </Link>
          )}
          {metricsHref(r) && (
            <Link href={metricsHref(r)!} className="press inline-flex h-7 items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 text-xs font-medium text-fg shadow-card hover:border-line-strong hover:bg-panel-2 pointer-coarse:h-9">
              <LineChart className="size-3.5 text-fg-3" /> Open metrics
            </Link>
          )}
          {r.consoleUrl && (
            <a href={r.consoleUrl} target="_blank" rel="noreferrer" className="press inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-accent hover:bg-accent-soft pointer-coarse:h-9">
              Open in AWS console <ExternalLink className="size-3" />
            </a>
          )}
          <Link href={`/settings/permissions#pv-${encodeURIComponent(r.provider)}`} title="What the console can read and change for this service" className="press inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-fg-3 hover:bg-panel-2 hover:text-fg pointer-coarse:h-9">
            <ShieldCheck className="size-3.5" /> Coverage
          </Link>
        </div>

        <Tabs
          id={`map-panel-${r.key}`}
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "overview", label: "Overview" },
            { value: "connections", label: "Connections", badge: <Count n={incoming.length + outgoing.length} /> },
            { value: "details", label: "Details" },
            { value: "actions", label: "Actions" },
            { value: "notes", label: "Notes", badge: r.notes ? <Count n={r.notes} /> : undefined },
          ]}
        />
      </header>

      <div className="relative min-h-0 flex-1">
        <AnimatePresence initial={false}>
          {bodyReady && (
            <motion.div key={tab} {...swap} className="absolute inset-0 overflow-y-auto overscroll-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-6">
              {tab === "overview" && <Overview r={r} view={view} byKey={byKey} visible={visible} onSelect={onSelect} onShowChildren={onShowChildren} />}
              {tab === "connections" && <Connections r={r} incoming={incoming} outgoing={outgoing} byKey={byKey} visible={visible} onSelect={onSelect} />}
              {tab === "details" && <Details r={r} env={env} />}
              {tab === "actions" && <Actions r={r} env={env} view={view} />}
              {tab === "notes" && <Notes resourceKey={r.key} resourceName={r.name} env={r.env} />}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );

  // On phones too it keeps the side sheet's layer (z-50), so its action dialogs (z-85) open above it.
  return phone ? (
    <Modal onClose={onClose} z="z-50" aria-label={`${r.name} details`} className="h-[90dvh]">
      {body}
    </Modal>
  ) : (
    <Sheet modal={false} onClose={onClose} role="dialog" aria-label={`${r.name} details`} className="flex h-full w-[min(640px,100vw)] flex-col overflow-hidden border-l border-line bg-panel shadow-float md:rounded-l-2xl">
      {body}
    </Sheet>
  );
}

function Count({ n }: { n: number }) {
  return <span className="rounded-full bg-panel-3 px-1.5 text-[11.5px] font-medium tabular-nums text-fg-3">{n}</span>;
}

function Section({ title, children, i = 0, aside }: { title: string; children: ReactNode; i?: number; aside?: ReactNode }) {
  return (
    <motion.section initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ ...enter, delay: Math.min(i, 6) * 0.03 }} className="rounded-2xl border border-line bg-panel">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h3 className="eyebrow">{title}</h3>
        {aside}
      </div>
      {children}
    </motion.section>
  );
}

function CopyValue({ value, mono, label }: { value: string; mono?: boolean; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className={cx("group/v inline-flex min-w-0 items-center gap-1.5 break-all", mono && "font-mono text-[13px]")}>
      <span className="min-w-0">{value}</span>
      <button
        className="flex-none rounded opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/v:opacity-100 pointer-coarse:-m-3 pointer-coarse:p-3 pointer-coarse:opacity-100"
        aria-label={`Copy ${label}`}
        onClick={() => {
          copy(value);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }}
      >
        {done ? <Check className="size-3 text-up" /> : <Copy className="size-3 text-fg-3 hover:text-fg" />}
      </button>
    </span>
  );
}

function Rows({ rows }: { rows: Prop[] }) {
  return (
    <dl className="divide-y divide-line">
      {rows.map((p, i) => (
        <div key={`${p.label}-${i}`} className="grid grid-cols-1 gap-x-3 gap-y-0.5 px-4 py-2.5 text-[14px] sm:grid-cols-[minmax(110px,36%)_1fr] sm:py-2">
          <dt className="text-xs text-fg-3 sm:text-[14px] sm:text-fg-2">{p.label}</dt>
          <dd className="min-w-0 text-fg">{p.mono || p.value.length > 40 ? <CopyValue value={p.value} mono={p.mono} label={p.label} /> : p.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// Facts the panel explains in words (the rest are listed as they are). Owner-set only (types.ts → Facts).
const FACT_LABEL: Record<string, string> = {
  peerGroups: "Shares a self-referencing security group",
  ambiguousHost: "Hostname matches more than one resource",
  idleEvidence: "Idle evidence",
  remote: "Referenced, not listed",
  vanishing: "Pending deletion confirmation",
  lastSeen: "Last seen",
  public: "Publicly addressable",
  openIngress: "Open to the internet on",
  cidrIngress: "Open to address ranges",
  attachments: "Network interfaces",
  referencedBy: "Referenced by",
  isDefault: "Default",
  routesToIgw: "Routes to an internet gateway",
  naclOpen: "Network ACL allows from anywhere",
  alarmState: "Alarm state",
  scaling: "Scaling alarm",
  notAfter: "Expires",
  inUse: "In use",
  autoRenew: "Renews automatically",
  deletionDate: "Deletion date",
  neverUsed: "Never used",
  lastBackupAt: "Last backup",
};
const IDLE_EVIDENCE: Record<string, string> = {
  "confirmed-zero": "every activity metric read zero over the idle window",
  activity: "activity seen",
  insufficient: "not enough activity data (a metric couldn't be read) — never marked idle",
  provider: "from the service itself",
  none: "no activity metric for this kind",
};
const ENRICH: Record<EnrichState, string> = { ok: "read", skipped: "skipped (time budget)", denied: "denied by IAM", error: "failed", capped: "not read (over the per-type cap)" };

function factValue(k: string, v: string | number | boolean | string[]): string {
  if (k === "idleEvidence" && typeof v === "string") return IDLE_EVIDENCE[v] ?? v;
  if ((k === "lastSeen" || k === "lastBackupAt" || k === "notAfter" || k === "deletionDate") && (typeof v === "number" || /^\d{4}-/.test(String(v)))) return stamp(typeof v === "number" ? v : Date.parse(String(v)));
  if (k === "vanishing" && v === true) return "not listed by the last complete read — confirming";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "none";
  return String(v);
}

function Overview({ r, view, byKey, visible, onSelect, onShowChildren }: {
  r: Resource;
  view: InventoryView;
  byKey: Map<string, Resource>;
  visible: ReadonlySet<string>;
  onSelect(key: string): void;
  onShowChildren?(key: string): void;
}) {
  const identity: Prop[] = [
    { label: "Key", value: r.key, mono: true },
    { label: "Service", value: serviceOf(r) },
    { label: "Discovered by", value: r.provider },
    ...(r.source && r.source !== "provider" ? [{ label: "Listed by", value: SOURCE_LABEL[r.source] ?? r.source }] : []),
    { label: "Region", value: r.region },
    ...(r.account ? [{ label: "Account", value: r.account, mono: true }] : []),
    ...(r.createdAt ? [{ label: "Created", value: stamp(r.createdAt) }] : []),
    ...(r.lastModified ? [{ label: "Last modified", value: stamp(r.lastModified) }] : []),
    ...(r.lastActivityAt ? [{ label: "Last activity", value: stamp(r.lastActivityAt) }] : []),
    ...(r.observedAt ? [{ label: "Read at", value: stamp(r.observedAt) }] : []),
  ];
  const facts = Object.entries(r.facts ?? {}).filter(([k]) => !(k === "remote" && isRemote(r) && r.source === "reference"));
  const enrichment = Object.entries(r.enrichment ?? {}).filter(([, st]) => st !== "ok");
  const tags = Object.entries(r.tags ?? {}).sort(([a], [b]) => a.localeCompare(b));
  let i = 0;
  return (
    <div className="space-y-4">
      {r.slim && !r.props.length && (
        <p className="rounded-xl border border-line bg-panel-2/60 px-3 py-2 text-xs text-fg-3">This row was sent without its properties to keep the map light. Details has everything the console read for it.</p>
      )}
      {r.props.length > 0 && (
        <Section title="Properties" i={i++}>
          <Rows rows={r.props} />
        </Section>
      )}
      {facts.length > 0 && (
        <Section title="Facts" i={i++}>
          <Rows rows={facts.map(([k, v]) => ({ label: FACT_LABEL[k] ?? k, value: factValue(k, v) }))} />
          {Array.isArray(r.facts?.peerGroups) && (
            <p className="border-t border-line px-4 py-2.5 text-xs leading-relaxed text-fg-3">
              Members of a security group that admits itself may reach each other, so the map draws no connections between them — it can&apos;t tell which of them really talk.
            </p>
          )}
        </Section>
      )}
      <Relationships r={r} view={view} byKey={byKey} visible={visible} onSelect={onSelect} onShowChildren={onShowChildren} i={i++} />
      {!!r.endpoints?.length && (
        <Section title="Endpoints" i={i++}>
          <ul className="divide-y divide-line">
            {r.endpoints.map((e) => (
              <li key={e} className="px-4 py-2 text-[14px]">
                <CopyValue value={e} mono label="endpoint" />
              </li>
            ))}
          </ul>
        </Section>
      )}
      {!!r.aliases?.length && (
        <Section title="Also known as" i={i++}>
          <ul className="divide-y divide-line">
            {r.aliases.map((a) => (
              <li key={a} className="px-4 py-2 text-[14px]">
                <CopyValue value={a} mono label="alias" />
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="Identity" i={i++}>
        <Rows rows={identity} />
      </Section>
      {(enrichment.length > 0 || r.tagsUnread) && (
        <Section title="What wasn't read" i={i++}>
          <Rows rows={[...(r.tagsUnread ? [{ label: "Tags", value: TAGS_UNREAD_TEXT }] : []), ...enrichment.map(([k, st]) => ({ label: capital(k), value: ENRICH[st] ?? st }))]} />
          <p className="border-t border-line px-4 py-2.5 text-xs leading-relaxed text-fg-3">
            Optional reads are skipped when a discovery runs out of time or permissions.{" "}
            <Link href={`/settings/permissions#pv-${encodeURIComponent(r.provider)}`} className="text-accent hover:underline">Coverage in Settings → AWS permissions</Link>
          </p>
        </Section>
      )}
      <Section title="Tags" i={i++} aside={<span className="text-[12px] text-fg-3">{tags.length}</span>}>
        {tags.length ? (
          <div className="flex flex-wrap gap-1.5 p-4">
            {tags.map(([k, v]) => (
              <Chip key={k} mono className="max-w-full">
                <span className="truncate">
                  <span className="text-fg-3">{k}</span>={v}
                </span>
              </Chip>
            ))}
          </div>
        ) : (
          <p className="px-4 py-3 text-xs text-fg-3">{r.tagsUnread ? "Not read." : "No tags. Tag it Environment=… to place it in an environment."}</p>
        )}
      </Section>
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  "resource-explorer": "AWS Resource Explorer",
  tagging: "the Tagging API",
  config: "AWS Config",
  cloudcontrol: "Cloud Control",
  reference: "a reference in configuration",
};

// D.9: where it sits — its parent, what folds into it, its VPC, subnets and security groups — each a click away.
function Relationships({ r, view, byKey, visible, onSelect, onShowChildren, i }: {
  r: Resource;
  view: InventoryView;
  byKey: Map<string, Resource>;
  visible: ReadonlySet<string>;
  onSelect(key: string): void;
  onShowChildren?(key: string): void;
  i: number;
}) {
  const rows = useMemo(() => {
    const byId = new Map<string, Resource>(); // "vpc-…", "subnet-…", "sg-…" → its resource
    for (const x of view.resources) {
      if (x.kind !== "vpc" && x.kind !== "subnet" && x.kind !== "security-group") continue;
      const id = x.kind === "vpc" ? vpcIdOfKey(x.key) : /(subnet-[0-9a-z-]+|sg-[0-9a-z-]+)(?:@|$)/i.exec(x.key)?.[1];
      if (id) byId.set(id, x);
      for (const a of x.aliases ?? []) if (/^(vpc|subnet|sg)-/.test(a)) byId.set(a, x);
    }
    const out: { label: string; items: { key?: string; name: string; sub?: string }[] }[] = [];
    const item = (key: string | undefined, fallback: string) => {
      const x = key ? byKey.get(key) : undefined;
      return x ? { key: x.key, name: x.name, sub: kindLabelOf(x) } : { name: fallback };
    };
    if (r.parent) out.push({ label: "Part of", items: [item(r.parent, r.parent)] });
    const children = view.resources.filter((x) => x.parent === r.key);
    if (children.length) out.push({ label: `Contains (${children.length})`, items: children.slice(0, 8).map((x) => item(x.key, x.name)) });
    if (r.vpcId && r.kind !== "vpc") out.push({ label: "VPC", items: [item(byId.get(r.vpcId)?.key, r.vpcId)] });
    if (r.subnetIds?.length) out.push({ label: "Subnets", items: r.subnetIds.map((id) => item(byId.get(id)?.key, id)) });
    if (r.securityGroups?.length) out.push({ label: "Security groups", items: r.securityGroups.map((id) => item(byId.get(id)?.key, id)) });
    return { out, children: children.length };
  }, [r, view.resources, byKey]);
  if (!rows.out.length) return null;
  return (
    <Section
      title="Relationships"
      i={i}
      aside={
        rows.children > 0 && onShowChildren && visible.has(r.key) ? (
          <button onClick={() => onShowChildren(r.key)} className="rounded px-1 text-[12.5px] font-medium text-accent hover:underline pointer-coarse:py-2">
            Show the {rows.children} inside on the map
          </button>
        ) : undefined
      }
    >
      <dl className="divide-y divide-line">
        {rows.out.map((row) => (
          <div key={row.label} className="grid grid-cols-1 gap-x-3 gap-y-1 px-4 py-2.5 text-[14px] sm:grid-cols-[minmax(110px,36%)_1fr]">
            <dt className="text-xs text-fg-3 sm:text-[14px] sm:text-fg-2">{row.label}</dt>
            <dd className="min-w-0 space-y-1">
              {row.items.map((x, k) =>
                x.key ? (
                  <button key={`${x.key}-${k}`} onClick={() => onSelect(x.key!)} className="group/rel flex max-w-full items-center gap-1.5 text-left text-fg hover:text-accent">
                    <span className="truncate">{x.name}</span>
                    <span className="flex-none text-[12px] text-fg-3">{x.sub}</span>
                    <ChevronRight className="size-3 flex-none text-fg-3 group-hover/rel:text-accent" />
                  </button>
                ) : (
                  <div key={`${x.name}-${k}`} className="truncate font-mono text-[13px] text-fg-2" title="Not in the inventory (not read, or in a layer that wasn't listed)">{x.name}</div>
                ),
              )}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function Connections({ r, incoming, outgoing, byKey, visible, onSelect }: { r: Resource; incoming: Edge[]; outgoing: Edge[]; byKey: Map<string, Resource>; visible: ReadonlySet<string>; onSelect(key: string): void }) {
  if (!incoming.length && !outgoing.length)
    return <Empty title="No connections found" hint={<>Nothing in the account points at {r.name}, and its configuration names nothing else the console can see. Settings that only exist inside the application stay invisible.</>} />;
  return (
    <div className="space-y-6">
      {outgoing.length > 0 && <EdgeGroup title={`${r.name} →`} dir="out" edges={outgoing} byKey={byKey} visible={visible} onSelect={onSelect} />}
      {incoming.length > 0 && <EdgeGroup title={`→ ${r.name}`} dir="in" edges={incoming} byKey={byKey} visible={visible} onSelect={onSelect} />}
    </div>
  );
}

function EdgeGroup({ title, dir, edges, byKey, visible, onSelect }: { title: string; dir: "in" | "out"; edges: Edge[]; byKey: Map<string, Resource>; visible: ReadonlySet<string>; onSelect(key: string): void }) {
  const groups = useMemo(() => {
    const m = new Map<EdgeKind, Edge[]>();
    for (const e of edges) (m.get(e.kind) ?? m.set(e.kind, []).get(e.kind)!).push(e);
    return [...m.entries()];
  }, [edges]);
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-2 text-[14px] font-medium">
        <span className="eyebrow">{dir === "out" ? "Outgoing" : "Incoming"}</span>
        <span className="truncate text-xs font-normal text-fg-3">{title}</span>
      </h3>
      <div className="space-y-3">
        {groups.map(([kind, list]) => (
          <div key={kind} className="overflow-hidden rounded-2xl border border-line">
            <div className="flex items-center gap-2 border-b border-line bg-panel-2/60 px-4 py-2 text-xs">
              <span className="size-1.5 rounded-full" style={{ background: FAMILY[EDGE_FAMILY[kind]].color }} aria-hidden />
              <span className="font-medium text-fg-2">{dir === "out" ? capital(EDGE_VERB[kind]) : `${capital(EDGE_VERB[kind])} this`}</span>
              <span className="text-fg-3">{list.length}</span>
            </div>
            <ul className="divide-y divide-line">
              {list.map((e) => {
                const otherKey = dir === "out" ? e.to : e.from;
                const o = byKey.get(otherKey);
                const I = o ? iconOf(o) : ArrowUpRight;
                const hidden = !visible.has(otherKey);
                return (
                  <li key={e.id}>
                    <button onClick={() => o && onSelect(otherKey)} disabled={!o} className="press flex w-full items-start gap-3 px-4 py-2.5 text-left [--press-scale:0.99] enabled:hover:bg-panel-2/60">
                      <I className="mt-0.5 size-4 flex-none text-fg-3" strokeWidth={1.5} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="min-w-0 truncate text-[14px] font-medium text-fg">{o?.name ?? otherKey}</span>
                          {o && <HealthDot health={o.health} still className="!size-1.5" />}
                          <span className="text-[12px] text-fg-3">{o ? `${kindLabelOf(o)} · ${o.env ?? "Shared"}` : "not in the inventory"}</span>
                          {hidden && o && <Chip tone="muted">hidden by filters</Chip>}
                        </span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-fg-2">
                          {e.label && <span>{e.label}</span>}
                          {routingText(e.routing) && <span className="rounded border border-line px-1 text-[11px] text-fg-2">{routingText(e.routing)}</span>}
                          <span className="rounded border border-line px-1 font-mono text-[11px] text-fg-3" title={CONFIDENCE[e.confidence].hint}>
                            {CONFIDENCE[e.confidence].label}
                          </span>
                        </span>
                        {e.evidence.length > 0 && (
                          <span className="mt-1 block space-y-0.5 text-[12.5px] leading-snug text-fg-3">
                            {e.evidence.map((ev) => (
                              <span key={ev} className="block [overflow-wrap:anywhere]">· {ev}</span>
                            ))}
                          </span>
                        )}
                      </span>
                      {o && <ArrowRight className="mt-0.5 size-3.5 flex-none text-fg-3" aria-hidden />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Details: the provider's sections (settings, tables, notes) and metric charts. For S3 buckets the object listing
// is a browser: folders open (breadcrumb back up), "Load more" follows page.next, and files offer the audited
// download-link action. Object contents are never shown here.
function Details({ r, env }: { r: Resource; env?: { label: string; protected: boolean } }) {
  const [prefix, setPrefix] = useState(""); // requested folder
  const { data: latest, error, isLoading, isValidating } = useResourceDetail(r.key, prefix);
  // What is on screen and which folder it belongs to: the previous folder stays until the next one has loaded.
  const [shown, setShown] = useState<{ data?: ResourceDetail; prefix: string }>({ prefix: "" });
  if (latest && !isValidating && (shown.data !== latest || shown.prefix !== prefix)) setShown({ data: latest, prefix });
  const data = shown.data ?? latest;
  const at = data?.page?.prefix ?? shown.prefix;
  const notFound = error instanceof ApiError && error.status === 404;
  const isObjects = (t?: { columns: string[] }) => r.kind === "s3" && t?.columns[0] === "Key";
  return (
    <Swap id={isLoading && !data ? "loading" : error && !data ? "error" : "data"}>
      {isLoading && !data ? (
        <div className="space-y-3">
          <Skeleton className="h-28 rounded-2xl" />
          <Skeleton className="h-44 rounded-2xl" />
        </div>
      ) : error && !data ? (
        <Empty title={notFound ? "No extra detail for this resource" : "Could not load details"} hint={notFound ? "The overview has everything the console reads for it." : (error as Error).message} />
      ) : !data || (!data.sections?.length && !data.metrics?.length) ? (
        <Empty title="No extra detail for this resource" hint="The overview has everything the console reads for it." />
      ) : (
        <div className="space-y-4">
          {!!data.metrics?.length && (
            <div className="grid gap-4 lg:grid-cols-2">
              {data.metrics.map((m) => (
                <MetricChart key={m.id} series={{ id: m.id, label: m.label, unit: m.unit ?? "", points: m.points }} color={r.health === "ok" ? "var(--text-2)" : HEALTH[r.health].color} height={120} />
              ))}
            </div>
          )}
          {data.sections.map((s, i) =>
            isObjects(s.table) ? (
              <ObjectBrowser key={`objects-${s.title}`} r={r} env={env} section={s} page={data.page} prefix={at} loading={isValidating} error={error ? (error as Error).message : undefined} onPrefix={setPrefix} i={i} />
            ) : (
              <Section key={`${s.title}-${i}`} title={s.title} i={i}>
                {s.rows && s.rows.length > 0 && <Rows rows={s.rows} />}
                {s.table && <Table columns={s.table.columns} rows={s.table.rows} />}
                {s.note && <p className="px-4 py-3 text-xs leading-relaxed text-fg-3">{s.note}</p>}
              </Section>
            ),
          )}
        </div>
      )}
    </Swap>
  );
}

function Table({ columns, rows }: { columns: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto overscroll-x-contain">
      <table className="w-full text-[13.5px]">
        <thead className="eyebrow border-b border-line text-left">
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col" className="whitespace-nowrap px-4 py-2 font-medium">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row, ri) => (
            <tr key={ri} className="hover:bg-panel-2/60">
              {row.map((cell, ci) => (
                <td key={ci} className={cx("px-4 py-2 align-top [overflow-wrap:anywhere]", ci === 0 ? "text-fg" : "text-fg-2")}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="px-4 py-3 text-xs text-fg-3">None.</p>}
    </div>
  );
}

type DetailSection = ResourceDetail["sections"][number];

function ObjectBrowser({ r, env, section, page, prefix, loading, error, onPrefix, i }: {
  r: Resource;
  env?: { label: string; protected: boolean };
  section: DetailSection;
  page?: ResourceDetail["page"];
  prefix: string;
  loading: boolean;
  error?: string;
  onPrefix(p: string): void;
  i: number;
}) {
  const actions = useResourceActions(r.key).data?.actions ?? [];
  const download = actions.find((a) => a.id === "download-object");
  const [more, setMore] = useState<{ prefix: string; rows: string[][]; next?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [moreErr, setMoreErr] = useState<string | null>(null);
  const [dl, setDl] = useState<string | null>(null); // key to download
  const extra = more && more.prefix === prefix ? more : null;
  // A row for the folder itself (some listings include it) adds nothing.
  const rows = [...(section.table?.rows ?? []), ...(extra?.rows ?? [])].filter((row) => !prefix || row[0] !== prefix);
  const next = extra ? extra.next : page?.next;
  const rel = (key: string) => (prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key);
  const full = (key: string) => (prefix && !key.startsWith(prefix) ? prefix + key : key);
  const parts = prefix.split("/").filter(Boolean);
  const blocked = download ? (download.blocked ?? (download.allowed === false ? `needs the “${download.perm}” permission` : undefined)) : undefined;

  async function loadMore() {
    if (!next) return;
    setBusy(true);
    setMoreErr(null);
    try {
      const d = await getJson<ResourceDetail>(detailUrl(r.key, prefix, next));
      const s = d.sections.find((x) => x.table?.columns[0] === "Key");
      setMore({ prefix, rows: [...(extra?.rows ?? []), ...(s?.table?.rows ?? [])], next: d.page?.next });
    } catch (e) {
      setMoreErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title={section.title} i={i} aside={loading ? <Loader2 className="size-3.5 animate-spin text-fg-3" aria-label="Loading" /> : null}>
      <nav aria-label="Folder" className="flex flex-wrap items-center gap-1 border-b border-line px-4 py-2 font-mono text-[13px]">
        <button onClick={() => onPrefix("")} disabled={!prefix} className="rounded px-1 text-accent hover:underline disabled:text-fg disabled:no-underline pointer-coarse:py-2">
          {r.name}
        </button>
        {parts.map((p, k) => {
          const to = parts.slice(0, k + 1).join("/") + "/";
          const last = k === parts.length - 1;
          return (
            <span key={to} className="inline-flex items-center gap-1">
              <span className="text-fg-3">/</span>
              <button onClick={() => onPrefix(to)} disabled={last} aria-current={last ? "location" : undefined} className="rounded px-1 text-accent hover:underline disabled:text-fg disabled:no-underline pointer-coarse:py-2">
                {p}
              </button>
            </span>
          );
        })}
      </nav>
      {error ? (
        <p className="px-4 py-3 text-xs text-down">{error}</p>
      ) : (
        <div className="overflow-x-auto overscroll-x-contain">
          <table className="w-full text-[13.5px]">
            <thead className="eyebrow border-b border-line text-left">
              <tr>
                {(section.table?.columns ?? []).map((c) => (
                  <th key={c} scope="col" className="whitespace-nowrap px-4 py-2 font-medium">{c}</th>
                ))}
                {download && <th scope="col" className="px-4 py-2"><span className="sr-only">Download</span></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((row, ri) => {
                const key = row[0] ?? "";
                const folder = key.endsWith("/") || row[1] === "folder";
                return (
                  <tr key={`${key}-${ri}`} className="hover:bg-panel-2/60">
                    <td className="px-4 py-1.5 font-mono text-[13px] [overflow-wrap:anywhere]">
                      {folder ? (
                        <button onClick={() => onPrefix(full(key))} className="inline-flex items-center gap-1.5 rounded text-accent hover:underline pointer-coarse:py-2">
                          <Folder className="size-3.5 flex-none" strokeWidth={1.6} aria-hidden />
                          {rel(key)}
                        </button>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-fg">
                          <FileIcon className="size-3.5 flex-none text-fg-3" strokeWidth={1.6} aria-hidden />
                          {rel(key)}
                        </span>
                      )}
                    </td>
                    {row.slice(1).map((cell, ci) => (
                      <td key={ci} className="whitespace-nowrap px-4 py-1.5 text-fg-2">{folder && ci === 0 ? <span className="text-fg-3">folder</span> : cell}</td>
                    ))}
                    {download && (
                      <td className="px-3 py-1 text-right">
                        {!folder && (
                          <Button size="sm" variant="ghost" disabled={!!blocked} title={blocked ?? "Create a short-lived download link (audited)"} onClick={() => setDl(full(key))} aria-label={`Download ${rel(key)}`} className="!px-2">
                            <Download className="size-3.5" />
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!rows.length && <p className="px-4 py-3 text-xs text-fg-3">Nothing here.</p>}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5">
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-fg-3">{moreErr ?? section.note}</p>
        {next && (
          <Button size="sm" onClick={loadMore} disabled={busy}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null} Load more
          </Button>
        )}
      </div>
      <AnimatePresence>{dl && download && <ActionDialog key={dl} r={r} action={download} env={env} initial={{ key: dl }} onClose={() => setDl(null)} />}</AnimatePresence>
    </Section>
  );
}

function Actions({ r, env, view }: { r: Resource; env?: { label: string; protected: boolean }; view: InventoryView }) {
  const { data, error, isLoading } = useResourceActions(r.key);
  const [open, setOpen] = useState<ActionInfo | null>(null);
  const list = data?.actions ?? [];
  return (
    <>
      <Swap id={isLoading ? "loading" : error ? "error" : list.length ? "list" : "empty"}>
        {isLoading ? (
          <div className="space-y-2">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-20 rounded-2xl" />)}</div>
        ) : error ? (
          <Empty title="Could not load actions" hint={(error as Error).message} />
        ) : !list.length ? (
          <Empty title={`No actions for ${kindLabelOf(r).toLowerCase()}s yet`} hint="The console only reads this kind of resource. Use the AWS console link above to change it." />
        ) : (
          <ul className="space-y-2">
            {env?.protected && (
              <li className="eyebrow flex items-center gap-1.5 px-1 pb-1 !text-down">
                <ShieldAlert className="size-3" /> {env.label} is protected: every action asks for the name and a reason
              </li>
            )}
            {list.map((a) => {
              const blocked = a.blocked ?? (a.allowed === false ? `Your role can't run this here (needs the “${a.perm}” permission${env?.protected ? " in a protected environment" : ""})` : undefined);
              return (
                <li key={`${a.provider}:${a.id}`} className="flex flex-col gap-3 rounded-2xl border border-line bg-panel p-4 sm:flex-row sm:items-start">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cx("text-[15px] font-medium", a.risk === "danger" && "text-down")}>{a.title}</span>
                      {a.risk === "danger" && <Chip tone="bad">danger</Chip>}
                    </div>
                    {/* F42: the plain sentence first; the API-facing description and the IAM actions behind Details. */}
                    <p className="mt-1 text-[13.5px] leading-relaxed text-fg-2">{a.summary ?? a.description}</p>
                    {a.warning && (
                      <p className="mt-1.5 flex gap-1.5 text-xs leading-relaxed text-degraded">
                        <AlertTriangle className="mt-px size-3.5 flex-none" /> {a.warning}
                      </p>
                    )}
                    {a.note && (
                      <p className="mt-1.5 flex gap-1.5 text-xs leading-relaxed text-degraded">
                        <AlertTriangle className="mt-px size-3.5 flex-none" /> {a.note}
                      </p>
                    )}
                    {(a.undo || a.verifies) && (
                      <dl className="mt-1.5 space-y-0.5 text-xs leading-relaxed text-fg-3">
                        {a.undo && (
                          <div>
                            <dt className="inline font-medium text-fg-2">Undo: </dt>
                            <dd className="inline">{a.undo}</dd>
                          </div>
                        )}
                        {a.verifies && (
                          <div>
                            <dt className="inline font-medium text-fg-2">Done when: </dt>
                            <dd className="inline">{a.verifies}</dd>
                          </div>
                        )}
                      </dl>
                    )}
                    {((a.summary && a.description && a.summary !== a.description) || !!a.iam?.length) && (
                      <details className="mt-1.5 text-xs text-fg-3">
                        <summary className="cursor-pointer select-none rounded hover:text-fg-2 pointer-coarse:py-2">Details</summary>
                        {a.summary && a.description !== a.summary && <p className="mt-1 leading-relaxed">{a.description}</p>}
                        {!!a.iam?.length && (
                          <p className="mt-1 leading-relaxed">
                            Needs{" "}
                            {a.iam.map((x, k) => (
                              <span key={x}>
                                {k > 0 && ", "}
                                <code className="rounded bg-panel-3 px-1 font-mono text-[12px]">{x}</code>
                              </span>
                            ))}
                          </p>
                        )}
                      </details>
                    )}
                    {blocked && <p className="mt-1.5 text-xs text-fg-3">{blocked}</p>}
                  </div>
                  <Button size="sm" variant={a.risk === "danger" ? "danger" : "secondary"} disabled={!!blocked} title={blocked} onClick={() => setOpen(a)} className="flex-none max-sm:h-10 max-sm:w-full">
                    <Play className="size-3" strokeWidth={2} /> {a.title}…
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Swap>
      <AnimatePresence>
        {open && (
          <ActionDialog
            key={`${open.provider}:${open.id}`}
            r={r}
            action={open}
            env={env}
            choices={open.provider === CONNECT_PROVIDER ? { to: connectTargets(r, view.resources) } : undefined}
            onClose={() => setOpen(null)}
          />
        )}
      </AnimatePresence>
    </>
  );
}


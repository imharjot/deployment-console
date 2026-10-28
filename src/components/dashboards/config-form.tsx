"use client";
// Adding and configuring a widget: pick a type from the catalogue, then fill a form generated from its config schema
// (src/lib/dashboards.ts WIDGETS). Fields the console can list — environments, services, resources, metrics, regions,
// repositories, saved queries — become pickers; everything is validated with the same rules the server applies.
import { AnimatePresence } from "motion/react";
import { ArrowLeft, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Modal } from "@/components/motion";
import { Button, IconButton, cx } from "@/components/ui";
import { regionLabel, useRegions } from "@/lib/client/region";
import { WIDGETS, WIDGET_TYPES, makeWidget, widgetProblems, type Height, type SavedItem, type Widget, type WidgetType, type Width } from "@/lib/dashboards";
import type { InventoryView } from "@/lib/inventory/types";
import type { EnvInfo, MetricSeries } from "@/lib/types";
import type { JsonSchema } from "@/lib/server/ops/types";
import { useApi } from "./data";
import { WidgetIcon } from "./widgets";
import { Select as Dropdown, optionsFrom } from "@/components/select";

interface ResourceRow {
  env: string;
  key: string;
  id: string;
  kind: string;
  name: string;
  logs: boolean;
}

const INPUT = "h-10 w-full min-w-0 rounded-lg border border-line bg-panel-2 px-3 text-[14.5px] text-fg outline-none transition-colors placeholder:text-fg-3 focus:border-accent focus:bg-panel pointer-coarse:h-11";
const LABEL = "mb-1.5 block text-[13.5px] font-medium text-fg-2";

const ENUM_LABEL: Record<string, Record<string, string>> = {
  minutes: { "15": "15 minutes", "60": "1 hour", "360": "6 hours", "1440": "24 hours", "10080": "7 days" },
  hours: { "1": "1 hour", "6": "6 hours", "24": "24 hours", "168": "7 days" },
  hops: { "1": "1 hop", "2": "2 hops" },
  kind: { deploys: "Deploys and rollbacks", all: "Everything" },
  status: { pending: "Pending" },
};

function FieldBox({ label, hint, children, wide }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cx("min-w-0", wide && "sm:col-span-2")}>
      <span className={LABEL}>{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12.5px] leading-snug text-fg-3">{hint}</span>}
    </div>
  );
}

// The fields keep writing <option> children; the console's dropdown shows them.
function Select({ value, onChange, children, label, disabled }: { value: string; onChange: (v: string) => void; children: ReactNode; label: string; disabled?: boolean }) {
  return <Dropdown aria-label={label} value={value} disabled={disabled} onChange={onChange} options={optionsFrom(children)} base={cx(INPUT, "px-2.5 disabled:opacity-60")} />;
}

function Checks({ options, value, onChange, label }: { options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void; label: string }) {
  if (!options.length) return <p className="text-[13px] text-fg-3">Nothing to choose from yet.</p>;
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <label key={o.value} className={cx("press inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[13.5px] pointer-coarse:py-2.5", on ? "border-accent/60 bg-accent-soft text-fg" : "border-line text-fg-2 hover:border-line-strong")}>
            <input type="checkbox" className="accent-[var(--accent)]" checked={on} onChange={() => onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])} />
            {o.label}
          </label>
        );
      })}
    </div>
  );
}

// One config field, by name and schema.
function ConfigField({ type, name, schema, config, set }: { type: WidgetType; name: string; schema: JsonSchema; config: Record<string, unknown>; set: (k: string, v: unknown) => void }) {
  const required = !!WIDGETS[type].schema.required?.includes(name);
  const v = config[name];
  const envId = typeof config.env === "string" ? config.env : "";
  const key = typeof config.key === "string" ? config.key : "";
  const needsEnvs = name === "env" || name === "envs";
  const needsResources = name === "service" || name === "services" || (name === "key" && type === "metric-chart");
  const envs = useApi<EnvInfo[]>(needsEnvs ? "/api/envs" : null, 0).data ?? [];
  const resources = useApi<ResourceRow[]>(needsResources ? "/api/resources" : null, 0).data ?? [];
  const inventory = useApi<InventoryView>(name === "key" && type === "map-neighbourhood" ? "/api/inventory" : null, 0).data;
  const metrics = useApi<MetricSeries[]>(name === "metric" && envId && key ? `/api/metrics?env=${encodeURIComponent(envId)}&key=${encodeURIComponent(key)}&minutes=60` : null, 0).data;
  const regions = useRegions().data?.regions ?? [];
  const repos = useApi<string[]>(name === "repo" ? "/api/ci/repos" : null, 0).data;
  const saved = useApi<{ items: SavedItem[] }>(name === "savedId" ? "/api/saved?kind=log-query" : null, 0).data?.items;
  const label = schema.description ?? name;
  const str = typeof v === "string" ? v : "";
  const any = (what: string) => (required ? <option value="">Choose {what}…</option> : <option value="">Any</option>);
  // A new resource clears the metric (ConfigStep.set); once its metrics are known, pick CPU (else the first) so the
  // form doesn't stop at an empty required field.
  const firstMetric = name === "metric" && metrics?.length && !metrics.some((m) => m.id === str) ? (metrics.find((m) => m.id === "cpu") ?? metrics[0]).id : undefined;
  useEffect(() => {
    if (firstMetric) set("metric", firstMetric);
  }, [firstMetric, set]);

  if (schema.enum) {
    return (
      <FieldBox label={label}>
        <Select label={label} value={v === undefined ? "" : String(v)} onChange={(x) => set(name, x === "" ? undefined : schema.type === "integer" ? Number(x) : x)}>
          {!required && schema.default === undefined && <option value="">—</option>}
          {schema.enum.map((o) => <option key={String(o)} value={String(o)}>{ENUM_LABEL[name]?.[String(o)] ?? String(o)}</option>)}
        </Select>
      </FieldBox>
    );
  }
  if (name === "env") {
    return (
      <FieldBox label={label}>
        <Select label={label} value={str} onChange={(x) => set(name, x || undefined)}>
          {any("an environment")}
          {envs.map((e) => <option key={e.id} value={e.id}>{e.label} ({e.id}{e.region ? ` · ${e.region}` : ""})</option>)}
          {str && !envs.some((e) => e.id === str) && <option value={str}>{str}</option>}
        </Select>
      </FieldBox>
    );
  }
  if (name === "envs") {
    return (
      <FieldBox label={label} wide>
        <Checks label={label} options={envs.map((e) => ({ value: e.id, label: e.label }))} value={Array.isArray(v) ? (v as string[]) : []} onChange={(x) => set(name, x.length ? x : undefined)} />
      </FieldBox>
    );
  }
  // Services and resources belong to one environment (the same key exists in several), so they are listed once it is
  // chosen; choosing another environment clears them (ConfigStep.set).
  if (name === "service") {
    const list = envId ? resources.filter((r) => r.kind === "service" && r.env === envId) : [];
    return (
      <FieldBox label={label} hint={envId ? undefined : "Choose the environment first."}>
        <Select label={label} value={str} disabled={!envId && !str} onChange={(x) => set(name, x || undefined)}>
          {any("a service")}
          {list.map((r) => <option key={r.key} value={r.id}>{r.name} ({r.id})</option>)}
          {str && !list.some((r) => r.id === str) && <option value={str}>{str}</option>}
        </Select>
      </FieldBox>
    );
  }
  if (name === "services") {
    const list = envId ? [...new Map(resources.filter((r) => r.logs && r.env === envId).map((r) => [r.id, r])).values()] : [];
    return (
      <FieldBox label={label} wide hint={envId ? undefined : "Choose the environment first."}>
        <Checks label={label} options={list.map((r) => ({ value: r.id, label: r.name }))} value={Array.isArray(v) ? (v as string[]) : []} onChange={(x) => set(name, x.length ? x : undefined)} />
      </FieldBox>
    );
  }
  if (name === "key" && type === "metric-chart") {
    const list = envId ? resources.filter((r) => r.env === envId) : [];
    return (
      <FieldBox label="Resource" hint={envId ? undefined : "Choose the environment first."}>
        <Select label="Resource" value={str} disabled={!envId && !str} onChange={(x) => set(name, x || undefined)}>
          {any("a resource")}
          {list.map((r) => <option key={r.key} value={r.key}>{r.name} · {r.kind}</option>)}
          {str && !list.some((r) => r.key === str) && <option value={str}>{str}</option>}
        </Select>
      </FieldBox>
    );
  }
  if (name === "key") {
    const id = `keys-${type}`;
    return (
      <FieldBox label={label} wide hint="Type a name and pick it, or paste a key from the map (an ARN or map key).">
        <input list={id} value={str} onChange={(e) => set(name, e.target.value.trim() || undefined)} className={cx(INPUT, "font-mono text-[13.5px]")} placeholder="arn:aws:… or a map key" spellCheck={false} />
        <datalist id={id}>
          {(inventory?.resources ?? []).slice(0, 800).map((r) => <option key={r.key} value={r.key} label={r.name} />)}
        </datalist>
      </FieldBox>
    );
  }
  if (name === "metric") {
    return (
      <FieldBox label={label}>
        {metrics?.length ? (
          <Select label={label} value={str} onChange={(x) => set(name, x || undefined)}>
            {!metrics.some((m) => m.id === str) && <option value={str}>{str || "Choose a metric…"}</option>}
            {metrics.map((m) => <option key={m.id} value={m.id}>{m.label} ({m.id})</option>)}
          </Select>
        ) : (
          <input value={str} onChange={(e) => set(name, e.target.value.trim() || undefined)} className={INPUT} placeholder="cpu" spellCheck={false} />
        )}
      </FieldBox>
    );
  }
  if (name === "region") {
    return (
      <FieldBox label={label}>
        <Select label={label} value={str} onChange={(x) => set(name, x || undefined)}>
          <option value="">Any</option>
          {regions.map((r) => <option key={r} value={r}>{regionLabel(r)}</option>)}
        </Select>
      </FieldBox>
    );
  }
  if (name === "repo") {
    return (
      <FieldBox label={label}>
        <Select label={label} value={str} onChange={(x) => set(name, x || undefined)}>
          <option value="">All repositories</option>
          {(repos ?? []).map((r) => <option key={r} value={r}>{r}</option>)}
          {str && !(repos ?? []).includes(str) && <option value={str}>{str}</option>}
        </Select>
      </FieldBox>
    );
  }
  if (name === "savedId") {
    return (
      <FieldBox label={label} wide hint={saved && !saved.length ? "No saved log queries yet — save one from the Logs page." : undefined}>
        <Select label={label} value={str} onChange={(x) => set(name, x || undefined)}>
          <option value="">Choose a saved query…</option>
          {(saved ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}{s.mine ? "" : ` (shared by ${s.owner.email ?? "a teammate"})`}</option>)}
        </Select>
      </FieldBox>
    );
  }
  if (name === "markdownLite") {
    return (
      <FieldBox label={label} wide hint="Plain text. Links: [label](https://…) or a bare https:// address; console paths such as /logs work too.">
        <textarea value={str} onChange={(e) => set(name, e.target.value)} rows={5} maxLength={schema.maxLength} className={cx(INPUT, "h-auto py-2 leading-relaxed")} />
      </FieldBox>
    );
  }
  return (
    <FieldBox label={label} wide={name === "query"}>
      <input value={str} onChange={(e) => set(name, e.target.value || undefined)} maxLength={schema.maxLength} className={cx(INPUT, name === "query" && "font-mono text-[13.5px]")} spellCheck={false} />
    </FieldBox>
  );
}

const sizeLabel = (w: Width) => (w === 12 ? "Full width" : w === 6 ? "Half" : w === 3 ? "Quarter" : w === 4 ? "Third" : "Two thirds");

// The form for one widget. `initial` is the widget being edited; a new one starts from its type's defaults.
function ConfigStep({ initial, isNew, onBack, onSave }: { initial: Widget; isNew: boolean; onBack?: () => void; onSave: (w: Widget) => void }) {
  const spec = WIDGETS[initial.type];
  const [w, setW] = useState<Widget>(initial);
  const savedMode = initial.type === "log-query" && typeof initial.config.savedId === "string";
  const [mode, setMode] = useState<"saved" | "inline">(savedMode ? "saved" : "inline");
  const set = useCallback(
    (k: string, v: unknown) =>
      setW((x) => {
        const config = { ...x.config };
        if (v === undefined) delete config[k];
        else config[k] = v;
        // A service, resource or metric belongs to its environment: changing the env clears them.
        if (k === "env" && v !== x.config.env) for (const dep of ["service", "services", "key", "metric"]) if (x.type !== "map-neighbourhood" || dep !== "key") delete config[dep];
        if (k === "key" && x.type === "metric-chart" && v !== x.config.key) delete config.metric;
        return { ...x, config };
      }),
    [],
  );
  const props = Object.entries(spec.schema.properties ?? {}).filter(([k]) => w.type !== "log-query" || (mode === "saved" ? k === "savedId" : k !== "savedId"));
  const candidate = useMemo<Widget>(() => {
    if (w.type !== "log-query") return w;
    const keep = mode === "saved" ? ["savedId"] : ["env", "services", "query", "minutes"];
    return { ...w, config: Object.fromEntries(Object.entries(w.config).filter(([k]) => keep.includes(k))) };
  }, [w, mode]);
  const problems = widgetProblems(candidate);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!problems.length) onSave(candidate);
      }}
      className="flex min-h-0 flex-col"
    >
      <div className="min-h-0 space-y-4 overflow-y-auto px-5 py-4">
        <p className="text-[13.5px] leading-relaxed text-fg-3">{spec.description}{spec.needs ? ` People below ${spec.needs} see “needs ${spec.needs}” instead.` : ""}</p>
        {w.type === "log-query" && (
          <div role="radiogroup" aria-label="Query" className="flex gap-1.5">
            {(["saved", "inline"] as const).map((m) => (
              <label key={m} className={cx("press flex flex-1 cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-[14px]", mode === m ? "border-accent/60 bg-accent-soft" : "border-line hover:border-line-strong")}>
                <input type="radio" name="lq-mode" checked={mode === m} onChange={() => setMode(m)} className="accent-[var(--accent)]" />
                {m === "saved" ? "A saved query" : "A query of its own"}
              </label>
            ))}
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {props.map(([k, s]) => <ConfigField key={k} type={w.type} name={k} schema={s} config={w.config} set={set} />)}
          <FieldBox label="Title (optional)">
            <input value={w.title ?? ""} maxLength={60} onChange={(e) => setW((x) => ({ ...x, title: e.target.value || undefined }))} className={INPUT} placeholder={spec.label} />
          </FieldBox>
          <div className="grid grid-cols-2 gap-2">
            <FieldBox label="Width">
              <Select label="Width" value={String(w.w)} onChange={(x) => setW((y) => ({ ...y, w: Number(x) as Width }))}>
                {spec.widths.map((n) => <option key={n} value={n}>{sizeLabel(n)}</option>)}
              </Select>
            </FieldBox>
            <FieldBox label="Height">
              <Select label="Height" value={String(w.h)} onChange={(x) => setW((y) => ({ ...y, h: Number(x) as Height }))}>
                {spec.heights.map((n) => <option key={n} value={n}>{n === 1 ? "Short" : n === 2 ? "Medium" : "Tall"}</option>)}
              </Select>
            </FieldBox>
          </div>
        </div>
        {problems.length > 0 && (
          <ul className="space-y-0.5 rounded-lg border border-line bg-panel-2 px-3 py-2 text-[13px] text-fg-3" aria-live="polite">
            {problems.slice(0, 4).map((p) => <li key={p}>{p.replace(/^widget\.config\./, "").replace(/^widget\./, "")}</li>)}
          </ul>
        )}
      </div>
      <div className="flex flex-none items-center justify-between gap-2 border-t border-line px-5 py-3">
        {onBack ? (
          <Button type="button" variant="ghost" onClick={onBack}>
            <ArrowLeft className="size-3.5" aria-hidden /> Catalogue
          </Button>
        ) : <span />}
        <Button type="submit" variant="primary" disabled={problems.length > 0}>{isNew ? "Add widget" : "Apply"}</Button>
      </div>
    </form>
  );
}

function Catalogue({ onPick }: { onPick: (t: WidgetType) => void }) {
  return (
    <ul className="grid min-h-0 gap-2 overflow-y-auto px-5 py-4 sm:grid-cols-2">
      {WIDGET_TYPES.map((t) => (
        <li key={t}>
          <button type="button" onClick={() => onPick(t)} className="press flex h-full w-full items-start gap-3 rounded-xl border border-line p-3 text-left hover:border-line-strong hover:bg-panel-2 [--press-scale:0.985]">
            <span className="grid size-8 flex-none place-items-center rounded-lg border border-line bg-panel-2 text-fg-2">
              <WidgetIcon type={t} className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-[14px] font-medium">{WIDGETS[t].label}</span>
              <span className="mt-0.5 block text-[12.5px] leading-snug text-fg-3">{WIDGETS[t].description}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// The dialog: "add" starts at the catalogue; "edit" goes straight to the form.
export function WidgetDialog({ open, editing, taken, onSave, onClose }: { open: boolean; editing?: Widget; taken: string[]; onSave: (w: Widget) => void; onClose: () => void }) {
  return <AnimatePresence>{open && <Dialog key={editing?.id ?? "new"} editing={editing} taken={taken} onSave={onSave} onClose={onClose} />}</AnimatePresence>;
}

function Dialog({ editing, taken, onSave, onClose }: { editing?: Widget; taken: string[]; onSave: (w: Widget) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<Widget | null>(editing ?? null);
  const title = editing ? `Configure ${WIDGETS[editing.type].label.toLowerCase()}` : draft ? `Add ${WIDGETS[draft.type].label.toLowerCase()}` : "Add a widget";
  return (
    <Modal onClose={onClose} aria-labelledby="widget-dialog-title" className="max-w-2xl">
      <div className="flex flex-none items-start justify-between gap-3 px-5 pt-5">
        <h2 id="widget-dialog-title" className="font-display text-[26px] leading-tight">{title}</h2>
        <IconButton type="button" label="Close" onClick={onClose}>
          <X className="size-4" />
        </IconButton>
      </div>
      {draft ? (
        <ConfigStep
          initial={draft}
          isNew={!editing}
          onBack={editing ? undefined : () => setDraft(null)}
          onSave={(w) => {
            onSave(w);
            onClose();
          }}
        />
      ) : (
        <Catalogue onPick={(t) => setDraft(makeWidget(t, taken))} />
      )}
    </Modal>
  );
}

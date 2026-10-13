"use client";
// Variables tab: every environment variable of a service — plain values, secret references and env-file entries.
// Values stay masked until someone with the right role reveals them (audited). Editing works on a draft; saving shows
// the plan (names only), asks for the same confirmation as other actions, then deploys or restarts.
import { AlertTriangle, Check, Copy, Eye, EyeOff, FileText, KeyRound, Link2, Loader2, Lock, Pencil, Plus, Search, Trash2, Undo2, X } from "lucide-react";
import { useMemo, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { postJson, putJson } from "@/lib/client/api";
import { useEnvInfo } from "@/lib/client/env";
import { nameProblem, parseDotenv, type VarChanges, type VarSource } from "@/lib/envvars";
import type { ResourceView } from "@/lib/types";
import { useConfirm } from "../confirm";
import { useToast } from "../toast";
import { Button, Chip, Empty, Skeleton, copy, cx } from "../ui";

// Another service reading the same SSM parameter, secret or env file (b-discovery-variables).
interface Consumer {
  env: string;
  service: string;
  region?: string;
  protected: boolean;
  self?: true; // the console's own service
}
interface Var {
  container: string;
  name: string;
  source: VarSource;
  ref?: string;
  file?: string;
  sharedWith?: Consumer[];
  lockedWhy?: string; // why this person may not reveal or change it
}
interface VarsView {
  revision: string;
  containers: { name: string; main: boolean }[];
  vars: Var[];
  files: { container: string; file: string; label: string; error?: string; sharedWith?: Consumer[]; lockedWhy?: string }[];
  canReveal: boolean;
  revealWhy?: string; // a warning when canReveal, the reason when not
  canEdit: boolean;
  editWhy?: string;
  why?: string; // older servers: the edit reason
  capability?: "denied" | "probably-denied"; // what the console's AWS identity may do here (F06)
  protected: boolean; // the strongest protection: the env, or a protected / unknown consumer of a shared value
  envProtected?: boolean;
  sharingUnknown?: string | boolean; // couldn't tell who else reads these values (the server says why)
}
type Revealed = Var & { value?: string; error?: string };
// One row of the editor. `original` is undefined for rows the user added.
interface Draft extends Var {
  id: string;
  value: string;
  original?: string;
  deleted?: boolean;
}

const keyOf = (v: Var) => `${v.container}|${v.source}|${v.file ?? ""}|${v.name}`;
const fileLabel = (arn: string) => arn.replace(/^arn:aws[\w-]*:s3:::/, "s3://");
const SOURCE: Record<VarSource, { label: string; icon: typeof KeyRound }> = {
  plain: { label: "task definition", icon: Lock },
  ssm: { label: "SSM", icon: KeyRound },
  secretsmanager: { label: "Secrets Manager", icon: KeyRound },
  file: { label: "env file", icon: FileText },
};

export function EnvVars({ r }: { r: ResourceView }) {
  const url = `/api/services/${r.env}/${r.id}/variables`;
  const { data, error, isLoading, mutate } = useSWR<VarsView>(url, { revalidateOnFocus: false });
  const [values, setValues] = useState<Map<string, Revealed> | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [draft, setDraft] = useState<Draft[] | null>(null);
  const [q, setQ] = useState("");
  const toast = useToast();

  const editWhy = data?.editWhy ?? data?.why;
  const reveal = async () => {
    setRevealing(true);
    try {
      const res = await postJson<{ revision: string; values: Revealed[] }>(`${url}/reveal`, {});
      const m = new Map(res.values.map((v) => [keyOf(v), v]));
      setValues(m);
      return m;
    } catch (e) {
      toast.push({ tone: "error", title: "Couldn't read values", body: (e as Error).message });
      return null;
    } finally {
      setRevealing(false);
    }
  };

  const startEdit = async () => {
    const m = values ?? (await reveal());
    if (!m || !data) return;
    setDraft(data.vars.map((v, i) => {
      const value = m.get(keyOf(v))?.value ?? "";
      return { ...v, id: `v${i}`, value, original: value };
    }));
  };

  if (error) return <Empty title="Couldn't load variables" hint={(error as Error).message} />;
  if (isLoading || !data) return <div className="space-y-2">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-11" />)}</div>;

  const counts = { secrets: data.vars.filter((v) => v.source === "ssm" || v.source === "secretsmanager").length, files: data.files.length };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto text-[14px] text-fg-3">
          {data.vars.length} variable{data.vars.length === 1 ? "" : "s"}
          {counts.secrets > 0 && ` · ${counts.secrets} secret${counts.secrets === 1 ? "" : "s"}`}
          {counts.files > 0 && ` · ${counts.files} env file${counts.files === 1 ? "" : "s"}`}
        </div>
        {!draft && (
          <>
            {data.canReveal && (
              <Button size="sm" onClick={() => (values ? setValues(null) : reveal())} disabled={revealing} title={data.revealWhy}>
                {revealing ? <Loader2 className="size-3.5 animate-spin" /> : values ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                {values ? "Hide values" : "Reveal values"}
              </Button>
            )}
            <Button size="sm" variant="primary" onClick={startEdit} disabled={!data.canEdit || revealing} title={editWhy}>
              <Pencil className="size-3.5" /> Edit
            </Button>
          </>
        )}
      </div>
      {!data.canReveal && <p className="text-xs text-fg-3">Values are hidden. {data.revealWhy ?? data.why}</p>}
      {/* Enabled, but AWS may refuse: say it before anyone starts editing (F06). */}
      {(data.capability === "probably-denied" || (data.canEdit && editWhy) || (data.canReveal && data.revealWhy)) && (
        <div className="flex gap-2 rounded-xl border border-degraded/30 bg-degraded/8 px-3 py-2 text-xs text-degraded">
          <AlertTriangle className="mt-px size-3.5 flex-none" />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {[data.capability === "probably-denied" ? "AWS permission not verified: saving or revealing may be refused." : undefined, data.canEdit ? editWhy : undefined, data.canReveal ? data.revealWhy : undefined].filter(Boolean).join(" ")}
          </span>
        </div>
      )}
      {data.sharingUnknown && (
        <p className="text-xs text-fg-3">
          {typeof data.sharingUnknown === "string" ? `${data.sharingUnknown[0].toUpperCase()}${data.sharingUnknown.slice(1)}` : "Couldn't tell whether other services read these secrets or files"}, so changes follow the protected-environment rules.
        </p>
      )}
      {data.protected && !data.envProtected && data.envProtected !== undefined && (
        <p className="flex items-center gap-1.5 text-xs text-fg-2">
          <Lock className="size-3 flex-none text-down" /> Some values are shared with a protected service: saving asks for the service name and a reason.
        </p>
      )}

      {data.files.filter((f) => f.error).map((f) => (
        <div key={f.file} className="flex gap-2 rounded-xl border border-degraded/30 bg-degraded/8 px-3 py-2 text-xs text-degraded">
          <AlertTriangle className="mt-px size-3.5 flex-none" />
          <span>Couldn&apos;t read {f.label}: {f.error}. Its variables aren&apos;t listed (the console needs s3:GetObject on it).</span>
        </div>
      ))}

      {draft ? (
        <Editor data={data} draft={draft} setDraft={setDraft} url={url} r={r} onDone={() => { setDraft(null); setValues(null); void mutate(); }} />
      ) : (
        <>
          {data.vars.length > 8 && (
            <label className="flex h-9 items-center gap-2 rounded-lg border border-line bg-panel px-3 text-[14px] text-fg-3 focus-within:border-line-strong">
              <Search className="size-3.5" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name" className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-fg-3" />
            </label>
          )}
          <List data={data} values={values} q={q} />
        </>
      )}
    </div>
  );
}

function SourceChip({ v }: { v: Var }) {
  const S = SOURCE[v.source];
  const detail = v.source === "file" ? fileLabel(v.file ?? "") : v.ref;
  return (
    <Chip tone="muted" className="max-w-full">
      <S.icon className="size-3 flex-none" />
      <span className="truncate" title={detail}>{S.label}{detail ? ` · ${detail}` : ""}</span>
    </Chip>
  );
}

function List({ data, values, q }: { data: VarsView; values: Map<string, Revealed> | null; q: string }) {
  const shown = data.vars.filter((v) => !q || v.name.toLowerCase().includes(q.toLowerCase()));
  const multi = data.containers.length > 1;
  if (!data.vars.length) return <Empty title="No environment variables" hint="This task definition sets none. Add one with Edit." />;
  if (!shown.length) return <Empty title="No variable matches" />;
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel">
      {shown.map((v, i) => (
        <li key={keyOf(v)} className="grid gap-x-4 gap-y-1 px-4 py-2.5 sm:grid-cols-[minmax(150px,1fr)_minmax(0,1.5fr)_minmax(0,16rem)] sm:items-center">
          <div className="min-w-0">
            <div className="truncate font-mono text-[13.5px] text-fg">{v.name}</div>
            {multi && (i === 0 || shown[i - 1].container !== v.container) && <div className="eyebrow mt-0.5">{v.container}</div>}
          </div>
          <Value v={v} revealed={values?.get(keyOf(v))} />
          <div className="flex min-w-0 flex-wrap items-center gap-1 sm:justify-end sm:justify-self-end">
            <SourceChip v={v} />
            <Shared list={v.sharedWith ?? data.files.find((f) => f.file === v.file)?.sharedWith} />
            {v.lockedWhy && <span title={v.lockedWhy}><Chip tone="muted"><Lock className="size-3" /> locked</Chip></span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

// "Shared with production/api" (and "this console" for the console's own service): changing the value changes theirs.
function Shared({ list }: { list?: Consumer[] }) {
  if (!list?.length) return null;
  const names = list.map((c) => (c.self ? "this console" : `${c.env}/${c.service}`));
  const prot = list.some((c) => c.protected || c.self);
  return (
    <span title={`Also read by ${names.join(", ")}. Saving changes the value for them too${prot ? "; a protected reader means the protected rules apply" : ""}.`}>
      <Chip tone={prot ? "bad" : "warn"} className="max-w-full">
        <Link2 className="size-3 flex-none" />
        <span className="truncate">shared with {names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ")}</span>
      </Chip>
    </span>
  );
}

function Value({ v, revealed }: { v: Var; revealed?: Revealed }) {
  const [copied, setCopied] = useState(false);
  if (!revealed) return <span className="select-none font-mono text-[13.5px] tracking-widest text-fg-3">••••••••</span>;
  if (revealed.error) return <span className="text-xs text-down">{revealed.error}</span>;
  return (
    <span className="group/v flex min-w-0 items-center gap-2">
      <span className="min-w-0 font-mono text-[13.5px] text-fg-2 [overflow-wrap:anywhere]">{revealed.value || <span className="text-fg-3">(empty)</span>}</span>
      <button
        aria-label={`Copy ${v.name}`}
        className="flex-none rounded text-fg-3 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/v:opacity-100 hover:text-fg pointer-coarse:-m-3 pointer-coarse:p-3 pointer-coarse:opacity-100"
        onClick={() => {
          copy(revealed.value ?? "");
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? <Check className="size-3.5 text-up" /> : <Copy className="size-3.5" />}
      </button>
    </span>
  );
}

// ---------- editor ----------

function toChanges(draft: Draft[]): VarChanges {
  const plain = new Map<string, VarChanges["plain"][number]>();
  const files = new Map<string, VarChanges["files"][number]>();
  const secrets: VarChanges["secrets"] = [];
  for (const d of draft) {
    const changed = d.original === undefined || d.value !== d.original;
    if (d.source === "ssm" || d.source === "secretsmanager") {
      if (!d.deleted && changed && d.value) secrets.push({ container: d.container, name: d.name, value: d.value });
      continue;
    }
    const bucket = d.source === "file"
      ? files.get(d.file!) ?? files.set(d.file!, { container: d.container, file: d.file!, set: {}, remove: [] }).get(d.file!)!
      : plain.get(d.container) ?? plain.set(d.container, { container: d.container, set: {}, remove: [] }).get(d.container)!;
    if (d.deleted) {
      if (d.original !== undefined) bucket.remove.push(d.name);
    } else if (changed && d.name) bucket.set[d.name] = d.value;
  }
  const keep = <T extends { set: Record<string, string>; remove: string[] }>(x: T) => Object.keys(x.set).length > 0 || x.remove.length > 0;
  return { plain: [...plain.values()].filter(keep), secrets, files: [...files.values()].filter(keep) };
}

function problems(draft: Draft[]): string[] {
  const out: string[] = [];
  const seen = new Map<string, number>();
  for (const d of draft) {
    if (d.deleted || d.source === "file") continue;
    if (d.original === undefined) {
      if (!d.name) out.push("a new variable has no name");
      else {
        const p = nameProblem(d.name);
        if (p) out.push(p);
      }
    }
    const k = `${d.container}|${d.name}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  for (const [k, n] of seen) if (n > 1) out.push(`${k.split("|")[1]} is defined more than once in ${k.split("|")[0]}`);
  return out;
}

function Editor({ data, draft, setDraft, url, r, onDone }: { data: VarsView; draft: Draft[]; setDraft(d: Draft[]): void; url: string; r: ResourceView; onDone(): void }) {
  const editWhy = data.editWhy ?? data.why;
  const ask = useConfirm();
  const toast = useToast();
  const env = useEnvInfo(r.env);
  const { mutate } = useSWRConfig();
  const main = data.containers.find((c) => c.main)?.name ?? data.containers[0]?.name ?? "";
  const [asText, setAsText] = useState<string | null>(null);
  const [textProblems, setTextProblems] = useState<string[]>([]);
  const changes = useMemo(() => toChanges(draft), [draft]);
  const issues = problems(draft);
  const dirty = changes.plain.length + changes.secrets.length + changes.files.length > 0;
  const update = (id: string, patch: Partial<Draft>) => setDraft(draft.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  const add = (target: string) => {
    const file = target === "plain" ? undefined : target;
    setDraft([...draft, { id: `n${Date.now()}`, container: file ? (data.files.find((f) => f.file === file)?.container ?? main) : main, name: "", value: "", source: file ? "file" : "plain", file }]);
  };

  // "Edit as .env" covers the main container's plain variables: the textarea replaces them wholesale.
  const openText = () => setAsText(draft.filter((d) => d.source === "plain" && d.container === main && !d.deleted).map((d) => `${d.name}=${d.value}`).join("\n"));
  const applyText = () => {
    const { vars, problems: p } = parseDotenv(asText ?? "");
    setTextProblems(p);
    if (p.length) return;
    const byName = new Map(vars.map((v) => [v.name, v.value]));
    const next = draft.flatMap((d): Draft[] => {
      if (d.source !== "plain" || d.container !== main) return [d];
      if (d.original === undefined) return []; // unsaved new rows are replaced by the text
      return byName.has(d.name) ? [{ ...d, value: byName.get(d.name)!, deleted: false }] : [{ ...d, deleted: true }];
    });
    for (const v of vars) if (!next.some((d) => d.source === "plain" && d.container === main && d.name === v.name)) next.push({ id: `n${v.name}`, container: main, name: v.name, value: v.value, source: "plain" });
    setDraft(next);
    setAsText(null);
  };

  const save = () => {
    const plainChanged = changes.plain.length > 0;
    const sharedProtected = data.protected && data.envProtected === false;
    ask({
      env: r.env,
      protectedEnv: data.protected,
      envLabel: sharedProtected ? `${env?.label ?? r.env} · shared with a protected service` : env?.label,
      title: `Save variables for ${r.name}?`,
      description: <Plan changes={changes} draft={draft} deploys={plainChanged} />,
      warnings: [data.capability === "probably-denied" ? "AWS permission not verified: AWS may refuse this change." : undefined, editWhy].filter((w): w is string => !!w),
      expected: data.protected ? r.id : "yes",
      needReason: data.protected,
      confirmLabel: plainChanged ? "Save & deploy" : "Save & restart",
      run: async (input) => {
        const res = await putJson<{ revision?: string; restarted: boolean; alsoUsedBy?: string[] }>(url, { revision: data.revision, confirm: input.confirm, reason: input.reason, changes });
        const also = Array.isArray(res.alsoUsedBy) && res.alsoUsedBy.length ? ` Also used by ${res.alsoUsedBy.join(", ")}: they read the new values when their tasks restart.` : "";
        toast.push({ tone: "ok", title: res.revision ? `Deploying revision ${res.revision.split(":").pop()}` : "Saved — restarting", body: `${r.name} · ${r.env}. New tasks pick up the change.${also}` }, also ? 10_000 : undefined);
        void mutate((k) => typeof k === "string" && (k.startsWith(`/api/overview?env=${r.env}`) || k.includes(`/api/services/${r.env}/${r.id}`)));
        onDone();
      },
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => add("plain")}><Plus className="size-3.5" /> Add variable</Button>
        {data.files.filter((f) => !f.error).map((f) => (
          <Button key={f.file} size="sm" variant="ghost" onClick={() => add(f.file)} title={`Add to ${f.label}`}><Plus className="size-3.5" /> Add to {f.label.split("/").pop()}</Button>
        ))}
        <Button size="sm" variant="ghost" onClick={() => (asText === null ? openText() : setAsText(null))}>
          <FileText className="size-3.5" /> {asText === null ? "Edit as .env" : "Back to list"}
        </Button>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="ghost" onClick={onDone}><X className="size-3.5" /> Cancel</Button>
          <Button size="sm" variant="primary" onClick={save} disabled={!dirty || issues.length > 0 || asText !== null}>
            <Check className="size-3.5" /> Review & save
          </Button>
        </div>
      </div>

      {asText !== null ? (
        <div className="space-y-2">
          <p className="text-xs text-fg-3">
            Plain variables of <span className="font-mono">{main}</span>, one <span className="font-mono">NAME=value</span> per line. Secrets and env-file entries stay as they are.
          </p>
          <textarea
            value={asText}
            onChange={(e) => setAsText(e.target.value)}
            spellCheck={false}
            rows={Math.min(24, Math.max(8, asText.split("\n").length + 1))}
            className="w-full rounded-xl border border-line bg-panel p-3 font-mono text-[13.5px] leading-relaxed text-fg outline-none focus:border-line-strong"
          />
          {textProblems.length > 0 && <ul className="space-y-0.5 text-xs text-down">{textProblems.map((p) => <li key={p}>{p}</li>)}</ul>}
          <Button size="sm" onClick={applyText}><Check className="size-3.5" /> Apply to draft</Button>
        </div>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel">
          {draft.map((d) => {
            const secret = d.source === "ssm" || d.source === "secretsmanager";
            const isNew = d.original === undefined;
            const changed = !isNew && d.value !== d.original;
            return (
              <li key={d.id} className={cx("grid gap-x-3 gap-y-2 px-4 py-2.5 sm:grid-cols-[minmax(150px,1fr)_minmax(0,1.5fr)_minmax(0,18.5rem)] sm:items-center", d.deleted && "opacity-45")}>
                <div className="flex min-w-0 items-center gap-2">
                  {isNew ? (
                    <input
                      value={d.name}
                      onChange={(e) => update(d.id, { name: e.target.value.trim() })}
                      placeholder="NAME"
                      aria-label="Variable name"
                      className="h-9 w-full min-w-0 rounded-lg border border-line bg-panel-2 px-2.5 font-mono text-[13.5px] uppercase text-fg outline-none focus:border-line-strong"
                    />
                  ) : (
                    <span className={cx("truncate font-mono text-[13.5px]", d.deleted ? "text-fg-3 line-through" : "text-fg")}>{d.name}</span>
                  )}
                  {(isNew || changed) && !d.deleted && <span className="size-1.5 flex-none rounded-full bg-accent" title={isNew ? "new" : "changed"} />}
                </div>
                <input
                  value={d.value}
                  onChange={(e) => update(d.id, { value: e.target.value })}
                  disabled={d.deleted || !!d.lockedWhy}
                  title={d.lockedWhy}
                  type={secret ? "password" : "text"}
                  placeholder={secret ? "new secret value" : "value"}
                  aria-label={`Value of ${d.name || "new variable"}`}
                  spellCheck={false}
                  autoComplete="off"
                  className="h-9 w-full min-w-0 rounded-lg border border-line bg-panel-2 px-2.5 font-mono text-[13.5px] text-fg outline-none focus:border-line-strong disabled:opacity-60"
                />
                <div className="flex min-w-0 items-center justify-end gap-1.5">
                  <SourceChip v={d} />
                  {d.lockedWhy ? (
                    <span title={d.lockedWhy} className="grid size-7 place-items-center text-fg-3"><Lock className="size-3.5" aria-label={`locked: ${d.lockedWhy}`} /></span>
                  ) : secret ? (
                    changed && <Button size="sm" variant="ghost" onClick={() => update(d.id, { value: d.original ?? "" })} aria-label={`Undo ${d.name}`}><Undo2 className="size-3.5" /></Button>
                  ) : d.deleted ? (
                    <Button size="sm" variant="ghost" onClick={() => update(d.id, { deleted: false })} aria-label={`Keep ${d.name}`}><Undo2 className="size-3.5" /></Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => (isNew ? setDraft(draft.filter((x) => x.id !== d.id)) : update(d.id, { deleted: true }))} aria-label={`Remove ${d.name || "new variable"}`}><Trash2 className="size-3.5" /></Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {issues.length > 0 && <ul className="space-y-0.5 text-xs text-down">{issues.map((p) => <li key={p}>{p}</li>)}</ul>}
      <p className="text-xs text-fg-3">
        Plain variables deploy a new task-definition revision. Secret values are written to SSM / Secrets Manager and env files to S3, then the service restarts so new tasks read them.
        Secrets can&apos;t be added or removed here — create them in AWS and reference them in the task definition.
      </p>
    </div>
  );
}

function Plan({ changes, draft, deploys }: { changes: VarChanges; draft: Draft[]; deploys: boolean }) {
  const had = (container: string, name: string, source: VarSource, file?: string) => draft.some((d) => d.original !== undefined && d.container === container && d.name === name && d.source === source && d.file === file);
  const line = (label: string, names: string[], tone: string) => names.length > 0 && (
    <li className="flex gap-2"><span className={cx("w-16 flex-none", tone)}>{label}</span><span className="break-all font-mono text-[13px] text-fg">{names.join(", ")}</span></li>
  );
  return (
    <div className="space-y-3 text-[14px]">
      {changes.plain.map((p) => {
        const names = Object.keys(p.set);
        return (
          <div key={p.container}>
            <div className="eyebrow mb-1">task definition · {p.container}</div>
            <ul className="space-y-0.5">
              {line("add", names.filter((n) => !had(p.container, n, "plain")), "text-up")}
              {line("change", names.filter((n) => had(p.container, n, "plain")), "text-degraded")}
              {line("remove", p.remove, "text-down")}
            </ul>
          </div>
        );
      })}
      {changes.files.map((f) => {
        const names = Object.keys(f.set);
        return (
          <div key={f.file}>
            <div className="eyebrow mb-1">{fileLabel(f.file)}</div>
            <ul className="space-y-0.5">
              {line("add", names.filter((n) => !had(f.container, n, "file", f.file)), "text-up")}
              {line("change", names.filter((n) => had(f.container, n, "file", f.file)), "text-degraded")}
              {line("remove", f.remove, "text-down")}
            </ul>
          </div>
        );
      })}
      {changes.secrets.length > 0 && (
        <div>
          <div className="eyebrow mb-1">secret values</div>
          <ul>{line("update", changes.secrets.map((s) => s.name), "text-degraded")}</ul>
        </div>
      )}
      <p className="text-fg-3">
        {deploys ? "Registers a new task-definition revision and deploys it (the circuit breaker rolls back if it fails to start)." : "Writes the new values, then restarts the service so new tasks read them."} Values aren&apos;t shown here or stored in the audit log.
      </p>
    </div>
  );
}

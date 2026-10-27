"use client";
// Settings → AWS connection: which account the console reads (the simulated one or yours), how it signs in to AWS,
// its home region and the other regions it reads. Admins only. A part an environment variable (or console.config.json)
// decides is shown, not editable. "Test connection" asks AWS who the sign-in is and where its ECS clusters are; saving
// switches at once (src/lib/server/connection.ts), then the app reloads so nothing of the previous account stays on
// screen.
import { CircleCheck, Cloud, FlaskConical, KeyRound, Loader2, Lock, MapPin, ShieldCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import useSWR from "swr";
import { useConfirm } from "@/components/confirm";
import { hue } from "@/components/hue";
import { useToast } from "@/components/toast";
import { Button, Chip, Empty, Segmented, Skeleton, TimeAgo, cx } from "@/components/ui";
import { ROLE_INFO, useMe } from "@/components/user-menu";
import { ApiError, postJson, putJson } from "@/lib/client/api";
import { describeSignIn, type ConnectionTest, type ConnectionView, type SignIn } from "@/lib/connection-rules";

type Kind = SignIn["kind"];
type RegionsMode = "home" | "all" | "pick";
interface Form {
  source: "aws" | "mock";
  kind: Kind;
  profile: string;
  roleArn: string;
  externalId: string;
  home: string;
  regions: RegionsMode;
  picked: string[];
}

const inputCls = "h-9 w-full rounded-lg border border-line bg-panel-2 px-3 text-[14px] outline-none transition-colors placeholder:text-fg-3 focus:border-accent pointer-coarse:h-10";
const account = (id: string) => id.replace(/^(\d{4})(\d{4})(\d{4})$/, "$1-$2-$3");

function formOf(v: ConnectionView): Form {
  const s = v.signIn;
  const choice = v.regions.choice;
  return {
    source: v.source,
    kind: s.kind,
    profile: s.kind === "profile" ? s.profile : (v.profiles[0] ?? ""),
    roleArn: s.kind === "role" ? s.roleArn : "",
    externalId: s.kind === "role" ? (s.externalId ?? "") : "",
    home: v.awsHome,
    regions: choice === "all-enabled" ? "all" : Array.isArray(choice) && choice.length ? "pick" : "home",
    picked: Array.isArray(choice) ? choice : [],
  };
}

// What PUT /api/connection and POST /api/connection/test get: only the parts the environment doesn't decide.
function bodyOf(f: Form, locked: ConnectionView["locked"]): Record<string, unknown> {
  if (f.source === "mock") return { source: "mock" };
  const signIn = f.kind === "chain" ? { kind: "chain" } : f.kind === "profile" ? { kind: "profile", profile: f.profile } : { kind: "role", roleArn: f.roleArn.trim(), ...(f.externalId.trim() ? { externalId: f.externalId.trim() } : {}) };
  return {
    source: "aws",
    ...(locked.signIn ? {} : { signIn }),
    ...(locked.home ? {} : { home: f.home }),
    ...(locked.regions ? {} : { regions: f.regions === "all" ? "all-enabled" : f.regions === "pick" ? f.picked : [] }),
  };
}

export default function AwsConnectionPage() {
  const { data: me, error } = useMe();
  if (error) return <Empty title="Couldn't load your account" hint={(error as Error).message} />;
  if (!me) return <Skeleton className="h-64 rounded-2xl" />;
  if (!me.perms.includes("admin"))
    return (
      <div className="rounded-2xl border border-line bg-panel shadow-card">
        <Empty icon={<Lock className="size-6" />} title="Admins only" hint={`Connecting AWS needs the admin role. You're signed in as ${ROLE_INFO[me.user.role].label.toLowerCase()}.`} />
      </div>
    );
  return <Connection />;
}

function Connection() {
  const { data: view, error } = useSWR<ConnectionView>("/api/connection", { revalidateOnFocus: false });
  if (error) return <Empty title="Couldn't read the AWS connection" hint={(error as Error).message} />;
  if (!view) return <Skeleton className="h-96 rounded-2xl" />;
  return <Editor key={`${view.source}:${view.saved?.at ?? 0}`} view={view} />;
}

function Editor({ view }: { view: ConnectionView }) {
  const toast = useToast();
  const ask = useConfirm();
  const [form, setForm] = useState<Form>(() => formOf(view));
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<{ body: string; result: ConnectionTest } | null>(null);
  const set = (p: Partial<Form>) => setForm((f) => ({ ...f, ...p }));
  const { locked } = view;
  const body = useMemo(() => bodyOf(form, locked), [form, locked]);
  const bodyKey = JSON.stringify(body);
  // A test proves the sign-in: picking the home region it suggested (or other regions) doesn't need another one, and
  // saving checks the sign-in with AWS again anyway.
  const testKey = JSON.stringify({ source: body.source, signIn: body.signIn ?? null });
  const result = tested?.body === testKey ? tested.result : undefined;
  const sameAsNow = bodyKey === JSON.stringify(bodyOf(formOf(view), locked));
  const awsReady = form.source === "mock" || !!result?.ok;
  const signInIncomplete = form.source === "aws" && !locked.signIn && ((form.kind === "profile" && !form.profile) || (form.kind === "role" && !form.roleArn.trim()));
  const regionList = useMemo(() => {
    const all = new Set([form.home, ...view.regions.list, ...(tested?.result.regions ?? []).map((r) => r.region)]);
    return [...all].filter(Boolean).sort();
  }, [form.home, view.regions.list, tested]);
  const clustersIn = (r: string) => tested?.result.regions?.find((x) => x.region === r);

  async function test() {
    setTesting(true);
    try {
      const r = await postJson<ConnectionTest>("/api/connection/test", body);
      setTested({ body: testKey, result: r });
      if (r.ok && r.suggestedHome && r.suggestedHome !== form.home && !locked.home) toast.push({ tone: "info", title: `Your ECS clusters are in ${r.suggestedHome}`, body: "Make it the home region below." });
    } catch (e) {
      toast.push({ tone: "error", title: "Couldn't test the connection", body: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  }

  function save() {
    const to = form.source === "mock" ? "the simulated account" : `AWS account ${account(result?.identity?.account ?? "")}`;
    ask({
      env: "",
      title: `Switch to ${to}?`,
      description: (
        <>
          The console reads the new connection from the next request; nothing restarts. When the account or the home region is new, it forgets what it learned
          about the current one: remembered task counts, state history, the costs snapshot, pending host launches and approvals nobody has used. The audit log and
          notes stay.
        </>
      ),
      expected: "yes",
      confirmLabel: "Switch",
      run: async () => {
        await putJson<ConnectionView>("/api/connection", body);
        toast.push({ tone: "ok", title: `Switched to ${to}`, body: "Reloading…" });
        // A full reload, not a route change: every page's data and polls start over on the new connection.
        window.location.reload();
      },
    });
  }

  return (
    <div className="stagger max-w-3xl space-y-4">
      <Current view={view} />

      <Row icon={<Cloud className="size-[18px]" />} tone="hue-blue" title="Account" hint={lockHint(locked.source, "The simulated account is a demo shop (Acme): nothing there touches AWS.")}>
        {locked.source ? (
          <Chip>{view.source === "aws" ? "Your AWS account" : "Simulated"}</Chip>
        ) : (
          <Segmented<"mock" | "aws">
            id="conn-source"
            value={form.source}
            onChange={(v) => set({ source: v })}
            options={[
              { value: "mock", label: "Simulated" },
              { value: "aws", label: "Your AWS account" },
            ]}
          />
        )}
      </Row>

      {form.source === "aws" && (
        <>
          <section className="rounded-2xl border border-line bg-panel p-5 shadow-card">
            <Head icon={<KeyRound className="size-[18px]" />} tone="hue-indigo" title="Sign-in">
              {lockHint(locked.signIn, <>How the console signs in to AWS. It stores no keys: give it a profile from this machine&apos;s AWS config, the role of the task or instance it runs on, or a role to assume. <Link href="/docs/connect-aws" className="text-accent hover:underline">Connect AWS</Link> shows how to make a read-only one.</>)}
            </Head>
            {locked.signIn ? (
              <p className="mt-3 text-[14px] text-fg-2">{describeSignIn(view.signIn)}</p>
            ) : (
              <div className="mt-4 space-y-3">
                <Segmented<Kind>
                  id="conn-signin"
                  value={form.kind}
                  onChange={(v) => set({ kind: v })}
                  options={[
                    { value: "profile", label: "Profile" },
                    { value: "chain", label: "Default credentials" },
                    { value: "role", label: "Assume a role" },
                  ]}
                />
                {form.kind === "profile" &&
                  (view.profiles.length ? (
                    <label className="block max-w-sm">
                      <span className="eyebrow mb-1 block">Profile in ~/.aws/config</span>
                      <select className={inputCls} value={form.profile} onChange={(e) => set({ profile: e.target.value })}>
                        {view.profiles.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <p className="text-[13.5px] text-fg-3">No profiles in this machine&apos;s AWS config files. Add one with <code className="font-mono">aws configure</code>, or use default credentials or a role.</p>
                  ))}
                {form.kind === "chain" && <p className="text-[13.5px] text-fg-3">The AWS SDK&apos;s usual order: the ECS task role or EC2 instance profile the console runs with, or this machine&apos;s default profile.</p>}
                {form.kind === "role" && (
                  <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
                    <label className="block">
                      <span className="eyebrow mb-1 block">Role ARN</span>
                      <input className={cx(inputCls, "font-mono text-[13px]")} value={form.roleArn} onChange={(e) => set({ roleArn: e.target.value })} placeholder="arn:aws:iam::123456789012:role/console-readonly" spellCheck={false} autoComplete="off" />
                    </label>
                    <label className="block">
                      <span className="eyebrow mb-1 block">External ID (optional)</span>
                      <input className={inputCls} value={form.externalId} onChange={(e) => set({ externalId: e.target.value })} spellCheck={false} autoComplete="off" />
                    </label>
                    <p className="text-[13px] text-fg-3 sm:col-span-2">Assumed with the default credentials, which need sts:AssumeRole on it; the role must trust them.</p>
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-line bg-panel p-5 shadow-card">
            <Head icon={<MapPin className="size-[18px]" />} tone="hue-teal" title="Regions">
              Environments are your ECS clusters in the home region (and the other regions read). Test the connection to see where they are.
            </Head>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="eyebrow mb-1 block">Home region</span>
                {locked.home ? (
                  <p className="text-[14px] text-fg-2">
                    {view.awsHome} <span className="text-fg-3">· {locked.home} decides it</span>
                  </p>
                ) : (
                  <select className={inputCls} value={form.home} onChange={(e) => set({ home: e.target.value })}>
                    {regionList.map((r) => {
                      const c = clustersIn(r);
                      return (
                        <option key={r} value={r}>
                          {r}
                          {c?.clusters ? ` · ${c.clusters}${c.more ? "+" : ""} cluster${c.clusters === 1 ? "" : "s"}` : ""}
                        </option>
                      );
                    })}
                  </select>
                )}
              </label>
              <div>
                <span className="eyebrow mb-1 block">Also read</span>
                {locked.regions ? (
                  <p className="text-[14px] text-fg-2">
                    {view.regions.list.join(", ")} <span className="text-fg-3">· {locked.regions} decides it</span>
                  </p>
                ) : (
                  <Segmented<RegionsMode>
                    id="conn-regions"
                    size="sm"
                    value={form.regions}
                    onChange={(v) => set({ regions: v })}
                    options={[
                      { value: "home", label: "Home only" },
                      { value: "all", label: "All enabled" },
                      { value: "pick", label: "Choose" },
                    ]}
                  />
                )}
              </div>
            </div>
            {!locked.regions && form.regions === "pick" && (
              <div className="mt-3 grid gap-1.5 sm:grid-cols-3">
                {regionList
                  .filter((r) => r !== form.home)
                  .map((r) => (
                    <label key={r} className="flex items-center gap-2 text-[13.5px]">
                      <input type="checkbox" className="accent-[var(--accent)]" checked={form.picked.includes(r)} onChange={(e) => set({ picked: e.target.checked ? [...form.picked, r] : form.picked.filter((x) => x !== r) })} />
                      <span className="font-mono text-[13px]">{r}</span>
                      {clustersIn(r)?.clusters ? <span className="text-fg-3">· {clustersIn(r)!.clusters}</span> : null}
                    </label>
                  ))}
                {regionList.length <= 1 && <p className="text-[13px] text-fg-3 sm:col-span-3">Test the connection to list this account&apos;s regions.</p>}
              </div>
            )}
          </section>
        </>
      )}

      <section className="flex flex-col gap-3 rounded-2xl border border-line bg-panel p-5 shadow-card">
        {form.source === "aws" && <TestResult result={result} stale={!!tested && !result} />}
        <div className="flex flex-wrap items-center gap-2">
          {form.source === "aws" && (
            <Button onClick={test} disabled={testing || signInIncomplete}>
              {testing ? <Loader2 className="size-4 animate-spin" /> : <FlaskConical className="size-4" />}
              Test connection
            </Button>
          )}
          <Button variant="primary" onClick={save} disabled={!awsReady || sameAsNow || signInIncomplete} title={!awsReady ? "Test the connection first" : sameAsNow ? "Nothing changed" : undefined}>
            <ShieldCheck className="size-4" />
            {form.source === "mock" ? "Use the simulated account" : "Save and switch"}
          </Button>
          <span className="text-[13px] text-fg-3">No restart: the console switches as you save.</span>
        </div>
      </section>
    </div>
  );
}

function Current({ view }: { view: ConnectionView }) {
  const aws = view.source === "aws";
  return (
    <section className="rounded-2xl border border-line bg-panel p-5 shadow-card">
      <div className="flex items-start gap-3.5">
        <span className="hue-chip grid size-10 flex-none place-items-center rounded-xl" style={hue(aws ? "hue-orange" : "hue-slate")}>
          {aws ? <Cloud className="size-[18px]" /> : <FlaskConical className="size-[18px]" />}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[16px] font-semibold">{aws ? (view.identity ? `AWS account ${account(view.identity.account)}` : "Your AWS account") : "Simulated account (Acme)"}</h3>
          <p className="mt-1 truncate text-[13.5px] text-fg-3" title={view.identity?.arn}>
            {aws ? `${describeSignIn(view.signIn)} · home ${view.home} · reads ${view.regions.allEnabled ? "every enabled region" : view.regions.list.join(", ")}` : "A demo shop: every screen works and nothing touches AWS."}
          </p>
          {aws && view.identity?.arn && <p className="mt-0.5 truncate font-mono text-[12px] text-fg-3">{view.identity.arn}</p>}
          {view.identityError && (
            <p className="mt-2 flex items-start gap-1.5 text-[13px] text-degraded">
              <TriangleAlert className="mt-0.5 size-3.5 flex-none" />
              AWS didn&apos;t confirm this sign-in: {view.identityError}
            </p>
          )}
          <p className="mt-2 text-[12.5px] text-fg-3">
            {view.saved ? (
              <>
                Saved by {view.saved.by} <TimeAgo at={view.saved.at} />
              </>
            ) : view.from.source === "env" ? (
              "Set by the console's environment"
            ) : (
              "Not set yet: the console starts with the simulated account"
            )}
          </p>
        </div>
      </div>
    </section>
  );
}

function TestResult({ result, stale }: { result?: ConnectionTest; stale: boolean }) {
  if (!result) return <p className="text-[13.5px] text-fg-3">{stale ? "The form changed since the last test: test again before saving." : "Test the connection before saving: AWS must accept the sign-in."}</p>;
  if (!result.ok)
    return (
      <p className="flex items-start gap-2 text-[13.5px] text-down">
        <TriangleAlert className="mt-0.5 size-4 flex-none" />
        AWS didn&apos;t accept this sign-in: {result.error}
      </p>
    );
  const withClusters = (result.regions ?? []).filter((r) => r.clusters);
  return (
    <div className="space-y-1 text-[13.5px]">
      <p className="flex items-center gap-2 text-up">
        <CircleCheck className="size-4" />
        Signed in to account {account(result.identity?.account ?? "")}
      </p>
      <p className="truncate font-mono text-[12px] text-fg-3">{result.identity?.arn}</p>
      <p className="text-fg-2">
        {withClusters.length
          ? `ECS clusters in ${withClusters.map((r) => `${r.region} (${r.clusters}${r.more ? "+" : ""})`).join(", ")}`
          : "No ECS clusters in the regions checked: environments come from ECS clusters, everything else shows on the cloud map."}
      </p>
      {result.problems?.map((p) => (
        <p key={p} className="text-degraded">
          {p}
        </p>
      ))}
    </div>
  );
}

function lockHint(lockedBy: string | undefined, hint: ReactNode): ReactNode {
  return lockedBy ? (
    <>
      Set by <code className="font-mono">{lockedBy}</code> in the console&apos;s environment. Unset it where the console runs to choose here.
    </>
  ) : (
    hint
  );
}

function Head({ icon, tone, title, children }: { icon: ReactNode; tone: string; title: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 gap-3.5">
      <span className="hue-chip grid size-10 flex-none place-items-center rounded-xl" style={hue(tone)}>
        {icon}
      </span>
      <div className="min-w-0">
        <h3 className="text-[16px] font-semibold">{title}</h3>
        <p className="mt-1 text-[14px] leading-relaxed text-fg-3">{children}</p>
      </div>
    </div>
  );
}

function Row({ icon, tone, title, hint, children }: { icon: ReactNode; tone: string; title: string; hint: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-line bg-panel p-5 shadow-card sm:flex-row sm:items-center sm:justify-between sm:gap-8">
      <Head icon={icon} tone={tone} title={title}>
        {hint}
      </Head>
      <div className="flex-none">{children}</div>
    </section>
  );
}

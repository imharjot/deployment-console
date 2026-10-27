"use client";
// Settings → AWS connection: which account the console reads (the simulated one or yours), how it signs in to AWS,
// its home region and the other regions it reads. Admins only. A part an environment variable (or console.config.json)
// decides is shown, not editable. Each choice says what it means, and the machine's own login says who it is here.
// "Test connection" asks AWS who the sign-in is and where its ECS clusters are; saving switches at once
// (src/lib/server/connection.ts), then the app reloads so nothing of the previous account stays on screen.
import { CircleCheck, Cloud, FlaskConical, KeyRound, Loader2, Lock, MapPin, ShieldCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import useSWR from "swr";
import { useConfirm } from "@/components/confirm";
import { hue } from "@/components/hue";
import { useToast } from "@/components/toast";
import { Button, Empty, Segmented, Skeleton, TimeAgo, cx } from "@/components/ui";
import { ROLE_INFO, useMe } from "@/components/user-menu";
import { ApiError, postJson, putJson } from "@/lib/client/api";
import { regionName } from "@/lib/client/region";
import { describeArn, describeSignIn, roleArnProblem, type ConnectionTest, type ConnectionView, type MachineLogin, type SignIn } from "@/lib/connection-rules";

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
const withName = (r: string) => (regionName(r) ? `${r} (${regionName(r)})` : r); // "ap-south-1 (Mumbai)"

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
  const arnProblem = form.kind === "role" ? roleArnProblem(form.roleArn) : undefined;
  const signInIncomplete = form.source === "aws" && !locked.signIn && ((form.kind === "profile" && !form.profile) || !!arnProblem);
  // Who the machine's own login is, asked only when the page offers that choice.
  const machine = useSWR<MachineLogin>(form.source === "aws" && !locked.source && !locked.signIn ? "/api/connection/machine" : null, { revalidateOnFocus: false });
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
      if (r.ok && r.suggestedHome && r.suggestedHome !== form.home && !locked.home) toast.push({ tone: "info", title: `Your ECS clusters are in ${withName(r.suggestedHome)}`, body: "Make it the home region below." });
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

      <section className="rounded-2xl border border-line bg-panel p-5 shadow-card">
        <Head icon={<Cloud className="size-[18px]" />} tone="hue-blue" title="Account">
          {lockHint(locked.source, "What the console shows and acts on.")}
        </Head>
        {locked.source ? (
          <p className="mt-3 text-[14px] text-fg-2">{view.source === "aws" ? "Your AWS account" : "Simulated demo"}</p>
        ) : (
          <div className="mt-4 grid gap-1.5 sm:grid-cols-2">
            <Choice name="conn-source" value="mock" picked={form.source} onPick={(v) => set({ source: v })} title="Simulated demo">
              A demo shop (Acme): every screen works and nothing touches AWS.
            </Choice>
            <Choice name="conn-source" value="aws" picked={form.source} onPick={(v) => set({ source: v })} title="Your AWS account">
              What really runs in your account, read with the sign-in below.
            </Choice>
          </div>
        )}
      </section>

      {form.source === "aws" && (
        <>
          <section className="rounded-2xl border border-line bg-panel p-5 shadow-card">
            <Head icon={<KeyRound className="size-[18px]" />} tone="hue-indigo" title="Sign-in">
              {lockHint(locked.signIn, <>Who the console is when it calls AWS. It never stores keys: each way starts from a login the machine running it already has. <Link href="/docs/connect-aws" className="text-accent hover:underline">Connect AWS</Link> shows how to make a read-only one.</>)}
            </Head>
            {locked.signIn ? (
              <p className="mt-3 text-[14px] text-fg-2 first-letter:uppercase">{describeSignIn(view.signIn)}</p>
            ) : (
              <div className="mt-4 space-y-3">
                <div className="grid gap-1.5">
                  <Choice name="conn-signin" value="profile" picked={form.kind} onPick={(v) => set({ kind: v })} title="Saved profile">
                    A profile in ~/.aws/config on the machine running the console. Best on a laptop.
                  </Choice>
                  <Choice name="conn-signin" value="chain" picked={form.kind} onPick={(v) => set({ kind: v })} title="Machine's own login">
                    What the machine already signs in as (AWS&apos;s default credentials): its ECS task role or EC2 instance profile, or a laptop&apos;s default profile. Best when the console runs on AWS.
                    <MachineWho machine={machine} />
                  </Choice>
                  <Choice name="conn-signin" value="role" picked={form.kind} onPick={(v) => set({ kind: v })} title="Switch into a role">
                    The machine&apos;s own login assumes the IAM role you name: a read-only one, or one in another account.
                  </Choice>
                </div>
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
                    <p className="text-[13.5px] text-fg-3">No profiles in this machine&apos;s AWS config files. Add one with <code className="font-mono">aws configure</code>, or use the machine&apos;s own login.</p>
                  ))}
                {form.kind === "role" && (
                  <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
                    <label className="block">
                      <span className="eyebrow mb-1 block">Role ARN</span>
                      <input className={cx(inputCls, "font-mono text-[13px]")} value={form.roleArn} onChange={(e) => set({ roleArn: e.target.value })} placeholder="arn:aws:iam::123456789012:role/console-readonly" spellCheck={false} autoComplete="off" aria-invalid={!!form.roleArn.trim() && !!arnProblem} />
                    </label>
                    <label className="block">
                      <span className="eyebrow mb-1 block">External ID (optional)</span>
                      <input className={inputCls} value={form.externalId} onChange={(e) => set({ externalId: e.target.value })} spellCheck={false} autoComplete="off" />
                    </label>
                    {form.roleArn.trim() && arnProblem && (
                      <p className="flex items-start gap-1.5 text-[13px] text-down sm:col-span-2">
                        <TriangleAlert className="mt-0.5 size-3.5 flex-none" />
                        {arnProblem}
                      </p>
                    )}
                    <p className="text-[13px] text-fg-3 sm:col-span-2">
                      The machine&apos;s own login{machine.data?.identity ? ` (${describeArn(machine.data.identity.arn)})` : ""} asks for the role, so it needs sts:AssumeRole on it, and the role&apos;s trust policy must name it. The external ID is only for a role whose trust policy asks for one.
                    </p>
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
                    {withName(view.awsHome)} <span className="text-fg-3">· {locked.home} decides it</span>
                  </p>
                ) : (
                  <select className={inputCls} value={form.home} onChange={(e) => set({ home: e.target.value })}>
                    {regionList.map((r) => {
                      const c = clustersIn(r);
                      return (
                        <option key={r} value={r}>
                          {withName(r)}
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
                    {view.regions.list.map(withName).join(", ")} <span className="text-fg-3">· {locked.regions} decides it</span>
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
                      <span>
                        <span className="font-mono text-[13px]">{r}</span>
                        {regionName(r) && <span className="text-fg-3"> {regionName(r)}</span>}
                      </span>
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
          <p className="mt-1 truncate text-[13.5px] text-fg-3 first-letter:uppercase" title={view.identity?.arn}>
            {aws ? `${describeSignIn(view.signIn)} · home ${withName(view.home)} · reads ${view.regions.allEnabled ? "every enabled region" : view.regions.list.map(withName).join(", ")}` : "A demo shop: every screen works and nothing touches AWS."}
          </p>
          {aws && view.identity?.arn && <p className="mt-0.5 truncate font-mono text-[12px] text-fg-3">{view.identity.arn}</p>}
          {view.identityError && (
            <p className="mt-2 flex items-start gap-1.5 text-[13px] text-degraded">
              <TriangleAlert className="mt-0.5 size-3.5 flex-none" />
              {view.identityError}
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
        {result.error}
      </p>
    );
  const withClusters = (result.regions ?? []).filter((r) => r.clusters);
  return (
    <div className="space-y-1 text-[13.5px]">
      <p className="flex items-center gap-2 text-up">
        <CircleCheck className="size-4" />
        Signed in to account {account(result.identity?.account ?? "")}
        {result.identity?.arn ? ` as ${describeArn(result.identity.arn)}` : ""}
      </p>
      <p className="truncate font-mono text-[12px] text-fg-3">{result.identity?.arn}</p>
      <p className="text-fg-2">
        {withClusters.length
          ? `ECS clusters in ${withClusters.map((r) => `${withName(r.region)}: ${r.clusters}${r.more ? "+" : ""}`).join(", ")}`
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

// One option, with the line that says what it means (as in the agents' connection form).
function Choice<T extends string>({ name, value, picked, onPick, title, children }: { name: string; value: T; picked: T; onPick: (v: T) => void; title: string; children: ReactNode }) {
  return (
    <label className={cx("press flex cursor-pointer gap-2.5 rounded-xl border p-2.5 transition-colors [--press-scale:0.985]", picked === value ? "border-accent/60 bg-accent-soft" : "border-line hover:border-line-strong hover:bg-panel-2")}>
      <input type="radio" name={name} value={value} checked={picked === value} onChange={() => onPick(value)} className="mt-0.5 accent-[var(--accent)]" />
      <span className="min-w-0">
        <span className="block text-[14px] font-medium">{title}</span>
        <span className="mt-0.5 block text-[12.5px] leading-snug text-fg-3">{children}</span>
      </span>
    </label>
  );
}

// Who the machine's own login is here, or why there is none.
function MachineWho({ machine }: { machine: { data?: MachineLogin; error?: unknown } }) {
  const { data, error } = machine;
  if (error) return <span className="mt-1 block text-degraded">Couldn&apos;t check who that is here: {(error as Error).message}</span>;
  if (!data)
    return (
      <span className="mt-1 flex items-center gap-1.5">
        <Loader2 className="size-3 animate-spin" /> Checking who that is here…
      </span>
    );
  if (data.identity)
    return (
      <span className="mt-1 block text-fg-2" title={data.identity.arn}>
        Here: <span className="font-medium">{describeArn(data.identity.arn)}</span> in account {account(data.identity.account)}
      </span>
    );
  return <span className="mt-1 block text-degraded">{data.error}</span>;
}

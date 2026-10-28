"use client";
// Settings → AWS connection: which account the console reads (the simulated one or yours), how it signs in to AWS,
// its home region and the other regions it reads. Admins only. A part an environment variable (or console.config.json)
// decides is shown, not editable. Each choice says what it means, and the machine's own login says who it is here;
// a role in another account can be created from the page with CloudFormation (TemplateSteps).
// "Test connection" asks AWS who the sign-in is and where its ECS clusters are; saving switches at once
// (src/lib/server/connection.ts), then the app reloads so nothing of the previous account stays on screen.
import { ChevronRight, CircleCheck, Clock, Cloud, Download, ExternalLink, FlaskConical, KeyRound, Loader2, Lock, MapPin, Plus, ShieldCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import useSWR, { mutate } from "swr";
import { useConfirm } from "@/components/confirm";
import { hue } from "@/components/hue";
import { useToast } from "@/components/toast";
import { Button, CopyButton, Empty, Segmented, Skeleton, TimeAgo, cx } from "@/components/ui";
import { ROLE_INFO, useMe } from "@/components/user-menu";
import { ApiError, postJson, putJson } from "@/lib/client/api";
import { regionName } from "@/lib/client/region";
import { CONNECT_ROLE_NAME, CONNECT_STACK_NAME } from "@/lib/connect-template";
import { CloudFormationGuide } from "./cloudformation-guide";
import { describeArn, describeSignIn, roleArnProblem, type ConnectionTest, type ConnectionView, type MachineLogin, type ProfileKind, type SignIn } from "@/lib/connection-rules";
import { Select } from "@/components/select";

type Kind = SignIn["kind"];
type RegionsMode = "home" | "all" | "pick";
// A role made from this console's CloudFormation template (with its external ID), or one the admin already has.
type RoleSetup = "template" | "existing";
interface Form {
  source: "aws" | "mock";
  kind: Kind;
  profile: string;
  roleSetup: RoleSetup;
  roleArn: string;
  externalId: string; // an existing role's
  home: string;
  regions: RegionsMode;
  picked: string[];
}

const inputCls = "h-9 w-full rounded-lg border border-line bg-panel-2 px-3 text-[14px] outline-none transition-colors placeholder:text-fg-3 focus:border-accent pointer-coarse:h-10";
const account = (id: string) => id.replace(/^(\d{4})(\d{4})(\d{4})$/, "$1-$2-$3");
const withName = (r: string) => (regionName(r) ? `${r} (${regionName(r)})` : r); // "ap-south-1 (Mumbai)"

// What each kind of AWS CLI profile is, and how long its login lasts (when to sign in again).
const KIND_LABEL: Record<ProfileKind, string> = { keys: "access key", "temporary-keys": "temporary keys", role: "switches into a role", sso: "IAM Identity Center", login: "aws login", process: "credential process", other: "custom" };
function lasts(kind: ProfileKind | undefined, name: string): ReactNode {
  const cmd = (c: string) => <code className="font-mono text-[12.5px]">{c}</code>;
  if (kind === "keys") return "An access key doesn't expire: no signing in again. Rotate it in IAM now and then, and delete it when the console no longer needs it.";
  if (kind === "temporary-keys") return "Temporary keys stop working when their session ends: put fresh ones in the profile, or use aws login.";
  if (kind === "role") return "Switches into a role through another profile, renewed every hour on its own: it works as long as that profile does.";
  if (kind === "sso") return <>Works until your IAM Identity Center session ends (8 hours by default). Then run {cmd(`aws sso login --profile ${name}`)} and test again.</>;
  if (kind === "login") return <>Works until your AWS sign-in session ends. Then run {cmd(`aws login --profile ${name}`)} and test again.</>;
  return "Signs in the way this profile is set up in ~/.aws/config.";
}

function formOf(v: ConnectionView): Form {
  const s = v.signIn;
  const choice = v.regions.choice;
  const existing = s.kind === "role" && s.externalId !== v.externalId;
  // Nothing chosen yet on a machine with AWS CLI profiles (a laptop): start from those, not the server's role.
  const fresh = !v.saved && v.from.signIn === "default" && v.profiles.length > 0;
  return {
    source: v.source,
    kind: fresh ? "profile" : s.kind,
    profile: s.kind === "profile" ? s.profile : (v.profiles[0] ?? ""),
    roleSetup: existing ? "existing" : "template",
    roleArn: s.kind === "role" ? s.roleArn : "",
    externalId: existing ? (s.externalId ?? "") : "",
    home: v.awsHome,
    regions: choice === "all-enabled" ? "all" : Array.isArray(choice) && choice.length ? "pick" : "home",
    picked: Array.isArray(choice) ? choice : [],
  };
}

// What PUT /api/connection and POST /api/connection/test get: only the parts the environment doesn't decide.
function bodyOf(f: Form, { locked, externalId }: ConnectionView): Record<string, unknown> {
  if (f.source === "mock") return { source: "mock" };
  const ext = f.roleSetup === "template" ? externalId : f.externalId.trim();
  const signIn = f.kind === "chain" ? { kind: "chain" } : f.kind === "profile" ? { kind: "profile", profile: f.profile } : { kind: "role", roleArn: f.roleArn.trim(), ...(ext ? { externalId: ext } : {}) };
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
  const body = useMemo(() => bodyOf(form, view), [form, view]);
  const bodyKey = JSON.stringify(body);
  // A test proves the sign-in: picking the home region it suggested (or other regions) doesn't need another one, and
  // saving checks the sign-in with AWS again anyway.
  const testKey = JSON.stringify({ source: body.source, signIn: body.signIn ?? null });
  const result = tested?.body === testKey ? tested.result : undefined;
  const sameAsNow = bodyKey === JSON.stringify(bodyOf(formOf(view), view));
  const awsReady = form.source === "mock" || !!result?.ok;
  const arnProblem = form.kind === "role" ? roleArnProblem(form.roleArn) : undefined;
  const signInIncomplete = form.source === "aws" && !locked.signIn && ((form.kind === "profile" && !form.profile) || !!arnProblem);
  const incompleteWhy = !signInIncomplete ? undefined : form.kind === "profile" ? "Choose a profile first" : form.roleArn.trim() ? "Fix the role ARN first" : "Paste the role ARN first";
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
            <Head icon={<KeyRound className="size-[18px]" />} tone="hue-indigo" title="How it signs in to AWS">
              {lockHint(locked.signIn, <>Pick the one that fits where the console runs. Its database never holds AWS keys. <Link href="/docs/connect-aws" className="text-accent hover:underline">Connect AWS</Link> has the details.</>)}
            </Head>
            {locked.signIn ? (
              <p className="mt-3 text-[14px] text-fg-2 first-letter:uppercase">{describeSignIn(view.signIn)}</p>
            ) : (
              <div className="mt-4 space-y-3">
                <div className="grid gap-1.5">
                  <Choice name="conn-signin" value="profile" picked={form.kind} onPick={(v) => set({ kind: v })} title="AWS CLI profile on this computer">
                    A login you set up with the AWS CLI on the computer running the console (aws configure, aws login or SSO), or add one here with an access key. Best when the console runs on your laptop.
                  </Choice>
                  <Choice name="conn-signin" value="role" picked={form.kind} onPick={(v) => set({ kind: v })} title="Another AWS account, with CloudFormation">
                    Give this console read-only access to any AWS account by creating one CloudFormation stack there. No keys, and the access renews itself every hour.
                  </Choice>
                  <Choice name="conn-signin" value="chain" picked={form.kind} onPick={(v) => set({ kind: v })} title="This server's AWS role">
                    When the console runs on AWS (ECS or EC2), it uses the role AWS gives the server. Nothing to set up, and AWS renews it on its own.
                    <MachineWho machine={machine} />
                  </Choice>
                </div>
                {form.kind === "profile" && (
                  <div className="space-y-3">
                    {view.profiles.length ? (
                      <label className="block max-w-sm">
                        <span className="eyebrow mb-1 block">Profile</span>
                        <Select
                          aria-label="Profile"
                          base={inputCls}
                          value={form.profile}
                          onChange={(v) => set({ profile: v })}
                          options={view.profiles.map((p) => ({ value: p, label: p, hint: KIND_LABEL[view.profileKinds[p] ?? "other"] }))}
                        />
                      </label>
                    ) : (
                      <p className="text-[13.5px] text-fg-3">
                        No AWS CLI profiles on this computer yet. {view.canAddProfile ? "Add one below, or run aws login in a terminal and reload." : "Run aws configure or aws login where the console runs, then reload."}
                      </p>
                    )}
                    {form.profile && view.profiles.includes(form.profile) && (
                      <p className="flex items-start gap-1.5 text-[13px] text-fg-3">
                        <Clock className="mt-0.5 size-3.5 flex-none" />
                        <span>{lasts(view.profileKinds[form.profile], form.profile)}</span>
                      </p>
                    )}
                    {view.canAddProfile && <AddProfile onAdded={(name) => { set({ profile: name }); void mutate("/api/connection"); }} />}
                  </div>
                )}
                {form.kind === "role" && (
                  <div className="space-y-3">
                    {form.roleSetup === "template" && <TemplateSteps home={form.home} externalId={view.externalId} machine={machine} />}
                    <div className={cx("grid gap-3", form.roleSetup === "existing" && "sm:grid-cols-[2fr_1fr]")}>
                      <label className="block">
                        <span className="eyebrow mb-1 block">{form.roleSetup === "template" ? "RoleArn from the stack's Outputs" : "Role ARN"}</span>
                        <input
                          className={cx(inputCls, "font-mono text-[13px]")}
                          value={form.roleArn}
                          onChange={(e) => set({ roleArn: e.target.value })}
                          placeholder={`arn:aws:iam::123456789012:role/${form.roleSetup === "template" ? CONNECT_ROLE_NAME : "console-readonly"}`}
                          spellCheck={false}
                          autoComplete="off"
                          aria-invalid={!!form.roleArn.trim() && !!arnProblem}
                        />
                      </label>
                      {form.roleSetup === "existing" && (
                        <label className="block">
                          <span className="eyebrow mb-1 block">External ID (optional)</span>
                          <input className={inputCls} value={form.externalId} onChange={(e) => set({ externalId: e.target.value })} spellCheck={false} autoComplete="off" />
                        </label>
                      )}
                      {form.roleArn.trim() && arnProblem && (
                        <p className="flex items-start gap-1.5 text-[13px] text-down sm:col-span-2">
                          <TriangleAlert className="mt-0.5 size-3.5 flex-none" />
                          {arnProblem}
                        </p>
                      )}
                      {form.roleSetup === "existing" && (
                        <p className="text-[13px] text-fg-3 sm:col-span-2">
                          This machine&apos;s AWS login{machine.data?.identity ? ` (detected: ${describeArn(machine.data.identity.arn)})` : ""} switches into the role, so it needs sts:AssumeRole on it, and the role&apos;s trust policy must name it. The external ID is only for a role whose trust policy asks for one.
                        </p>
                      )}
                    </div>
                    <button type="button" className="text-[13px] text-accent hover:underline" onClick={() => set({ roleSetup: form.roleSetup === "template" ? "existing" : "template" })}>
                      {form.roleSetup === "template" ? "Already have a role? Enter it yourself" : "Create the role with CloudFormation instead"}
                    </button>
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
                  <Select
                    aria-label="Home region"
                    base={inputCls}
                    value={form.home}
                    onChange={(v) => set({ home: v })}
                    options={regionList.map((r) => {
                      const c = clustersIn(r);
                      return { value: r, label: withName(r), hint: c?.clusters ? `${c.clusters}${c.more ? "+" : ""} cluster${c.clusters === 1 ? "" : "s"}` : undefined };
                    })}
                  />
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
                      <input type="checkbox" checked={form.picked.includes(r)} onChange={(e) => set({ picked: e.target.checked ? [...form.picked, r] : form.picked.filter((x) => x !== r) })} />
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
            <Button onClick={test} disabled={testing || signInIncomplete} tip={incompleteWhy}>
              {testing ? <Loader2 className="size-4 animate-spin" /> : <FlaskConical className="size-4" />}
              Test connection
            </Button>
          )}
          <Button variant="primary" onClick={save} disabled={!awsReady || sameAsNow || signInIncomplete} tip={incompleteWhy ?? (!awsReady ? "Test the connection first" : sameAsNow ? "Nothing changed" : undefined)}>
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
      <input type="radio" name={name} value={value} checked={picked === value} onChange={() => onPick(value)} className="mt-0.5" />
      <span className="min-w-0">
        <span className="block text-[14px] font-medium">{title}</span>
        <span className="mt-0.5 block text-[12.5px] leading-snug text-fg-3">{children}</span>
      </span>
    </label>
  );
}

// Another AWS account, with CloudFormation: the setup file (a CloudFormation template, GET /api/connection/template)
// comes from this console with its own login and external ID filled in, so the admin only creates a stack from it in
// the account to connect and pastes back the role's ARN. No template hosting, no keys; the details sit behind "What's
// in the setup file?".
function TemplateSteps({ home, externalId, machine }: { home: string; externalId: string; machine: { data?: MachineLogin; error?: unknown } }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const who = machine.data?.identity;
  const file = `${CONNECT_STACK_NAME}.json`;
  const cli = [
    `aws cloudformation deploy --template-file ${file} --stack-name ${CONNECT_STACK_NAME} --capabilities CAPABILITY_NAMED_IAM`,
    `aws cloudformation describe-stacks --stack-name ${CONNECT_STACK_NAME} --query "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue" --output text`,
  ].join("\n");
  async function download() {
    setBusy(true);
    try {
      const r = await fetch("/api/connection/template");
      if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${r.status}`);
      const url = URL.createObjectURL(await r.blob());
      const a = Object.assign(document.createElement("a"), { href: url, download: file });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast.push({ tone: "error", title: "Couldn't make the setup file", body: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <ol className="space-y-2.5 rounded-xl border border-line bg-panel-2 p-4 text-[13.5px] leading-relaxed">
      <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span>
          <span className="font-medium">1.</span> Download the setup file this console made for itself.
        </span>
        <Button size="sm" onClick={download} disabled={busy || !who}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
          Download setup file
        </Button>
      </li>
      {machine.data?.error && <li className="text-degraded">{machine.data.error}</li>}
      <li className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span>
            <span className="font-medium">2.</span> Sign in to the AWS account you want to connect, and create a stack from the file there.
          </span>
          <a href={`https://console.aws.amazon.com/cloudformation/home?region=${home}#/stacks/create`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
            Open CloudFormation <ExternalLink className="size-3.5" />
          </a>
        </div>
        <details open className="group">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-accent hover:underline [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 transition-transform duration-200 group-open:rotate-90" aria-hidden /> What to do on each AWS screen
          </summary>
          <div className="mt-2">
            <CloudFormationGuide file={file} stack={CONNECT_STACK_NAME} role={CONNECT_ROLE_NAME} />
          </div>
        </details>
      </li>
      <li>
        <span className="font-medium">3.</span> Paste the stack&apos;s RoleArn output below, then test the connection.
      </li>
      <li className="flex items-start gap-1.5 text-fg-3">
        <Clock className="mt-1 size-3.5 flex-none" />
        <span>Access renews itself every hour, so nobody signs in again. It works as long as this machine&apos;s AWS login does; delete the stack to disconnect.</span>
      </li>
      <li>
        <details className="group">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-accent hover:underline [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 transition-transform duration-200 group-open:rotate-90" aria-hidden /> What&apos;s in the setup file?
          </summary>
          <div className="mt-2 space-y-2 text-fg-3">
            <p>
              A CloudFormation template for one read-only IAM role, {CONNECT_ROLE_NAME}. The role lets in only this machine&apos;s AWS login
              {who ? ` (detected: ${describeArn(who.arn)} in account ${account(who.account)})` : ""}, and only together with a code this console made for itself,
              its external ID. Without both, nobody can use the role.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <span>
                External ID <code className="font-mono text-[12.5px] text-fg-2">{externalId}</code>
              </span>
              <CopyButton text={externalId} label="Copy" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span>Prefer the AWS CLI? From the file&apos;s folder:</span>
              <CopyButton text={cli} label="Copy commands" />
            </div>
          </div>
        </details>
      </li>
    </ol>
  );
}

// AWS CLI profile → Add a profile with an access key, on a console run locally (view.canAddProfile): the key is checked
// with AWS and saved to this computer's ~/.aws/credentials, the way aws configure saves it (POST /api/connection/profiles).
function AddProfile({ onAdded }: { onAdded: (name: string) => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ name: "deployment-console", accessKeyId: "", secretAccessKey: "" });
  if (!open)
    return (
      <button type="button" className="inline-flex items-center gap-1 text-[13.5px] text-accent hover:underline" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" /> Add a profile with an access key
      </button>
    );
  async function save() {
    setBusy(true);
    try {
      const r = await postJson<{ name: string; identity: { account: string; arn: string } }>("/api/connection/profiles", f);
      toast.push({ tone: "ok", title: `Saved profile ${r.name}`, body: `AWS says it's ${describeArn(r.identity.arn)} in account ${account(r.identity.account)}.` });
      setF((x) => ({ ...x, accessKeyId: "", secretAccessKey: "" }));
      setOpen(false);
      onAdded(r.name);
    } catch (e) {
      toast.push({ tone: "error", title: "Couldn't save the profile", body: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3 rounded-xl border border-line bg-panel-2 p-4">
      <p className="text-[14px] font-medium">Add a profile with an access key</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="eyebrow mb-1 block">Profile name</span>
          <input className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} spellCheck={false} autoComplete="off" />
        </label>
        <label className="block">
          <span className="eyebrow mb-1 block">Access key ID</span>
          <input className={cx(inputCls, "font-mono text-[13px]")} value={f.accessKeyId} onChange={(e) => setF({ ...f, accessKeyId: e.target.value })} placeholder="AKIA…" spellCheck={false} autoComplete="off" />
        </label>
        <label className="block">
          <span className="eyebrow mb-1 block">Secret access key</span>
          <input type="password" className={cx(inputCls, "font-mono text-[13px]")} value={f.secretAccessKey} onChange={(e) => setF({ ...f, secretAccessKey: e.target.value })} spellCheck={false} autoComplete="off" />
        </label>
      </div>
      <p className="text-[13px] text-fg-3">
        AWS checks the key first. It&apos;s then saved to ~/.aws/credentials on this computer, the way aws configure saves it, so the AWS CLI can use it too; the console never
        shows the secret again or keeps it anywhere else. An access key doesn&apos;t expire: use an IAM user with only the console&apos;s policy, not your own.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" onClick={save} disabled={busy || !f.name.trim() || !f.accessKeyId.trim() || !f.secretAccessKey.trim()}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
          Check and save
        </Button>
        <Button size="sm" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// Who the machine's own login is, as AWS answers for this machine's credentials (never a fixed name), or why there is
// none.
function MachineWho({ machine }: { machine: { data?: MachineLogin; error?: unknown } }) {
  const { data, error } = machine;
  if (error) return <span className="mt-1 block text-degraded">Couldn&apos;t ask AWS who this machine&apos;s login is: {(error as Error).message}</span>;
  if (!data)
    return (
      <span className="mt-1 flex items-center gap-1.5">
        <Loader2 className="size-3 animate-spin" /> Asking AWS who this machine&apos;s login is…
      </span>
    );
  if (data.identity)
    return (
      <span className="mt-1 block text-fg-2" title={data.identity.arn}>
        Detected from this machine&apos;s AWS credentials: <span className="font-medium">{describeArn(data.identity.arn)}</span> in account {account(data.identity.account)}
      </span>
    );
  return <span className="mt-1 block text-degraded">{data.error}</span>;
}

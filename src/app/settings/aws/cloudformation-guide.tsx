// What to do on each AWS CloudFormation screen when creating the stack from this console's setup file (Settings → AWS
// connection → Another AWS account, with CloudFormation, step 2). Drawn rather than screenshotted: a screenshot would
// show someone's account and go stale whenever AWS restyles its console. Each card rings the one thing to do there and
// says why; the drawings are decorative (aria-hidden), the captions carry the instructions.
import type { ReactNode } from "react";
import { cx } from "@/components/ui";

const hot = "ring-2 ring-accent ring-offset-2 ring-offset-panel";

export function CloudFormationGuide({ file, stack, role }: { file: string; stack: string; role: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Screen n={1} title="Create stack" action={<>Pick <b>Upload a template file</b> (not Amazon S3 URL), then <b>Choose file</b> and select {file}. Next.</>} why="The setup file is on your computer, not in S3.">
        <Radio label="Amazon S3 URL" />
        <Radio label="Upload a template file" on ring />
        <Btn ring>Choose file</Btn>
      </Screen>
      <Screen n={2} title="Specify stack details" action={<>Type a stack name, such as <code className="font-mono">{stack}</code>. Keep the parameters, then Next.</>} why="This console filled in the parameters. The stack keeps what it creates together, so deleting it later removes the access in one go.">
        <Field label="Stack name" value={stack} ring />
        <Field label="ExternalId" value="dc-…" />
        <Field label="RoleName" value={role} />
      </Screen>
      <Screen n={3} title="Configure stack options · Review" action={<>Leave the options as they are. Tick <b>I acknowledge that AWS CloudFormation might create IAM resources with custom names</b>, then Submit.</>} why="The stack creates one IAM role, and that role is the access; AWS asks you to confirm.">
        <div className={cx("flex items-start gap-2 rounded-md p-1.5 text-[12px] leading-snug", hot)}>
          <span className="mt-0.5 grid size-3.5 flex-none place-items-center rounded-sm bg-accent text-[10px] leading-none text-accent-fg">✓</span>
          <span>I acknowledge that AWS CloudFormation might create IAM resources with custom names.</span>
        </div>
        <Btn primary>Submit</Btn>
      </Screen>
      <Screen n={4} title="Stacks › Outputs" action={<>Wait for <b>CREATE_COMPLETE</b> (about a minute), open <b>Outputs</b> and copy <b>RoleArn</b>.</>} why="It's the address of the new role: paste it below and test the connection.">
        <div className="flex items-center justify-between gap-2 text-[12px]">
          <span className="font-medium">{stack}</span>
          <span className="text-up">✓ CREATE_COMPLETE</span>
        </div>
        <div className="flex gap-3 border-b border-line text-[12px]">
          {["Stack info", "Events", "Resources", "Outputs"].map((t) => (
            <span key={t} className={cx("pb-1", t === "Outputs" ? "border-b-2 border-accent font-medium" : "text-fg-3")}>
              {t}
            </span>
          ))}
        </div>
        <div className={cx("grid grid-cols-[auto_1fr] gap-2 rounded-md px-2 py-1.5 text-[11.5px]", hot)}>
          <span className="font-medium">RoleArn</span>
          <span className="truncate font-mono text-fg-2">arn:aws:iam::123456789012:role/{role}</span>
        </div>
      </Screen>
    </div>
  );
}

function Screen({ n, title, action, why, children }: { n: number; title: string; action: ReactNode; why: string; children: ReactNode }) {
  return (
    <figure className="overflow-hidden rounded-xl border border-line bg-panel">
      <div aria-hidden className="flex items-center gap-1.5 border-b border-line bg-panel-2 px-3 py-1.5 text-[11.5px] text-fg-3">
        <span className="size-2 rounded-full bg-fg-3/40" />
        <span className="size-2 rounded-full bg-fg-3/40" />
        <span className="size-2 rounded-full bg-fg-3/40" />
        <span className="ml-1 truncate">CloudFormation › {title}</span>
      </div>
      <div aria-hidden className="space-y-2 p-3">
        {children}
      </div>
      <figcaption className="space-y-1 border-t border-line px-3 py-2 text-[12.5px] leading-snug">
        <p>
          <span className="mr-1.5 inline-grid size-[18px] place-items-center rounded-full bg-accent text-[11px] font-semibold text-accent-fg">{n}</span>
          {action}
        </p>
        <p className="text-fg-3">Why: {why}</p>
      </figcaption>
    </figure>
  );
}

function Radio({ label, on, ring }: { label: string; on?: boolean; ring?: boolean }) {
  return (
    <div className={cx("flex items-center gap-2 rounded-md border px-2 py-1.5 text-[12px]", on ? "border-accent/60 bg-accent-soft" : "border-line", ring && hot)}>
      <span className={cx("grid size-3 place-items-center rounded-full border", on ? "border-accent" : "border-fg-3")}>{on && <span className="size-1.5 rounded-full bg-accent" />}</span>
      {label}
    </div>
  );
}

function Btn({ children, primary, ring }: { children: ReactNode; primary?: boolean; ring?: boolean }) {
  return <span className={cx("inline-flex rounded-md border px-2.5 py-1 text-[12px]", primary ? "border-transparent bg-accent font-medium text-accent-fg" : "border-line", ring && hot)}>{children}</span>;
}

function Field({ label, value, ring }: { label: string; value: string; ring?: boolean }) {
  return (
    <div className="space-y-0.5">
      <div className="text-[11.5px] text-fg-3">{label}</div>
      <div className={cx("truncate rounded-md border border-line bg-panel-2 px-2 py-1 font-mono text-[11.5px]", ring && hot)}>{value}</div>
    </div>
  );
}

# Common questions

Short answers, with links to the details.

## Does connecting it change anything in my AWS account?

No. With the read-only policy (`infra/iam-policy-readonly.json`) the console can only read: it lists and describes
your resources, reads metrics and logs, and asks Cost Explorer for your spend. It doesn't install anything, tag
anything or create anything. The only thing it writes is its own database.

It does make some calls that AWS bills, only while people use those pages: Cost Explorer requests
([at most about $5 a month](costs.md#what-it-costs)), CloudWatch metric reads, and Logs Insights queries (billed by
the data they scan). See [Connect AWS](connect-aws.md).

## Can it delete my stuff?

It can only delete what it created itself: services it copied and EC2 hosts it launched, which carry the tag
`console:created=true`. The console checks that tag, and the shipped IAM policy enforces it as well. It never deletes
anything it discovered, and it never touches the data inside your databases.

With the full policy it *can* change things, which is the point: restart or stop services, roll back to another
revision, edit environment variables, secret values and S3 env files, start and stop hosts and databases you tagged
`console:power=allow`, and create or scale services. Every change is guarded, confirmed, role-checked and audited.
Grant only the statements you want; see [Security model](security.md#what-the-console-can-and-cannot-do).

## Do my developers need AWS accounts?

No. People sign in to the console, and the console uses its own IAM role. Each person gets what their
[role](auth.md#roles) allows, and everything they change is in the audit log under their name.

## What does it cost to run?

The console itself is free and open source under the Apache License 2.0. Running it costs whatever you run it on.
The shipped task definition asks for 0.25 vCPU and 0.5 GB on Fargate, about $9 a month at us-east-1 list prices. Add
a load balancer if you don't share an existing one, and a small Postgres database for its data. AWS API usage is
covered in the first answer.

## Does it work with several regions or AWS accounts?

One console covers one account and one region. Run one console per region or account you want to see. Cost Explorer
is account-wide, so the Costs page shows the whole account's spend in every one of them. See
[Limitations](limitations.md).

## Do I have to change my services or my infrastructure code?

No. The console reads what's there. You need the `awslogs` log driver for logs; everything else is optional:
`console:*` tags or a `console.config.json` for friendly names, repositories, protected environments and dependencies
AWS can't see. See [How discovery works](discovery.md).

## Does it deploy new code?

Not by itself. It isn't a CI/CD system: your pipeline builds images and registers task-definition revisions. The
console restarts services, switches between existing revisions (roll back or forward), re-runs GitHub Actions
workflows (including deploy workflows) and registers a new revision when someone edits plain environment variables.
See [GitHub & CI](github.md).

## What happens to my apps if the console goes down?

Nothing. The console sits beside your services, not in front of them: it only calls AWS APIs. Your services keep
running, and the console picks up where it left off when it comes back.

## What leaves my network?

Only the calls you'd expect: AWS APIs, the GitHub API if you set `GITHUB_TOKEN`, the integrations you configure
(Slack, Jira, …), your single sign-on provider, and the health-check URLs you tag. The console has no telemetry of its
own.

## Can it run against EKS, Lambda or plain EC2 apps?

No, only Amazon ECS (Fargate and EC2 capacity). See [Limitations](limitations.md).

## Can an AI agent break production?

An agent uses an API token that acts for the person who created it, never with more than that person's role. A change
on a protected environment, or a dangerous operation (deleting, copying a service, adding hosts, a one-off command),
always waits for a person to approve it; set `CONSOLE_APPROVALS_TWO_PERSON=true` and that person can't be the token's
owner. A token in *propose* mode (the default) sends every change for approval, and a *read* token can't change
anything. Agents can never read environment variable values. See [Agents & API](automation.md).

## Can I turn the agent API off?

Yes. Set `CONSOLE_API_TOKENS=false` and restart: every token request is refused and nobody can create a token.

## Is it ready for production?

It is an early release (0.1.0). Everything is tested against the simulated account, and calls to real AWS follow the
SDK's documented request shapes. Start on a staging account with the read-only policy, then widen it.

# Environment variables

Every service panel has a **Variables** tab that lists all environment variables of the service's task definition,
wherever they live, with a chip showing the source. People with the right role can reveal and edit them, with a
review that shows names only.

| Source | Where the value lives | Saving a change |
|---|---|---|
| **task definition** | `environment` in the task definition | registers a **new revision** with the edited values and deploys it (the ECS circuit breaker rolls back if the new tasks fail to start) |
| **SSM** | an SSM Parameter Store parameter referenced under `secrets` | writes the new value (keeping the parameter's type, tier and KMS key), then **restarts** the service |
| **Secrets Manager** | a secret, or one key of a JSON secret, referenced under `secrets` | writes the new value (only that key for JSON secrets), then **restarts** the service |
| **env file** | an S3 object listed in `environmentFiles` | rewrites only the lines you changed (everything else kept byte for byte, same encryption settings), then **restarts** the service |

ECS reads secrets and env files when a task starts, which is why those changes restart the service.

## Who sees what

Values are **masked** by default and never part of normal page data. **Reveal values** fetches them in one request,
which is written to the audit log (who revealed which names — never the values). If that audit row can't be written,
no values are returned.

| Role | Non-protected environment | Protected environment |
|---|---|---|
| viewer | names and sources only | names and sources only |
| developer | reveal and edit | names and sources only |
| operator, admin | reveal and edit | reveal and edit |

The console never reveals or edits the variables of **its own** service, not even for admins: they hold its database
URL and secret key. Agents never see values at all: no operation reveals them, and API tokens can't reach the reveal
route.

A parameter, secret or env file that several services read follows the **strictest** of them — see
[Shared parameters, secrets and env files](#shared-parameters-secrets-and-env-files). If the console's own AWS
permissions don't allow a save or a reveal, the button is disabled (or carries a warning) with the missing action
named, before anyone types a confirmation.

## Editing

1. **Edit** loads the current values into a draft (this counts as a reveal).
2. Change values, **Add variable** (to the task definition or an env file), remove variables, or use **Edit as .env**
   to paste `NAME=value` lines for the main container's plain variables.
3. **Review & save** shows the plan — names grouped by where they change (the task definition, each env file, SSM
   parameters, Secrets Manager), never values — and asks for the usual confirmation: one click on non-protected
   environments; the service name and a reason on protected ones.

The server enforces these rules:

- Names use letters, digits and `_`, and don't start with a digit. `ECS_*`, `AWS_CONTAINER_*` and
  `AWS_EXECUTION_ENV` are reserved by ECS.
- A name can't be defined twice in one container (for example as a plain variable and a secret).
- A value can be at most 32,768 characters, and one save at most about 500 KB.
- One save lists each container's plain variables, each env file and each secret once (the API and `variables.update`
  refuse duplicates with `400`).
- If the service changed since you opened the editor (a deploy, someone else's edit), the save is refused: reload and
  edit again.
- Not during a rollout, and never on the console's own service.
- One change at a time per service **and** per parameter, secret or env file: a save locks the service and everything it
  writes, and a second save, action or deploy touching any of them is refused with `409` until the first finishes.
- Each parameter, secret and env file is written **once** per save. Edits through two containers that share an env
  file, or two keys of one JSON secret, are combined; edits that disagree (two values for one parameter or key, a name
  set through one container and removed through another) refuse the save with `409` before anything is written.
- If the object changed in AWS between the console reading it and writing it (someone else's edit), the write is
  refused (`409 … changed since it was read`) instead of overwriting that change: reload and edit again. S3 checks
  this itself (the object's ETag); for SSM and Secrets Manager the console re-reads the version just before writing —
  neither service can compare-and-set, so a change in the last instant before the write can still be overwritten.
- If a save with several parts fails midway, the error says what was already applied, and the audit log records it.

## Shared parameters, secrets and env files

Services often read the same backing object: staging and production `api` both referencing `/acme/shared/JWT_KEY`, a
sidecar reading its service's env file, or one JSON secret behind several variables. Changing it through any one of
them changes it for all of them (each picks it up when its tasks next start), so the console treats it by its
**strictest reader**:

- The **Variables** tab shows, next to each such variable and env file, which other services read it (`sharedWith`).
- If any reader is in a **protected** environment, revealing or changing that object needs the protected role
  (operator), and a save that changes it asks for the service name and a reason — even from a non-protected
  environment. The tab then counts as protected for confirmations.
- If the **console's own** service reads it, nobody reveals or changes it through the console, admins included — also
  when the console runs in a cluster that isn't an environment (ignored, say).
- An API token in `act` mode makes changes in non-protected environments without asking anyone, so it can't change an
  object a protected service reads: that save is refused (`403`). A token in `propose` mode asks for approval, and the
  approved request goes through.
- If discovery couldn't read every environment (a region or a cluster didn't answer), the console can't rule out a
  protected reader, so every shared object counts as protected until it can. A service whose task definition alone
  couldn't be read only counts when it is in a protected environment or could be the console.
- Matching ignores how the reference is written: an SSM name or its ARN, a Secrets Manager ARN with or without its
  random suffix, JSON key or version stage all name the same object. A bare SSM name is the one in the service's region.

Revealing values withholds the objects you may not read and says why; the rest are shown. The audit log records the
names revealed and the names withheld, never values.

## Env files are read literally

ECS reads env files with Docker's rules, and the console shows and keeps values exactly as ECS will inject them:

- One `NAME=value` per line. The value is everything after the first `=`: quotes are part of it and nothing is
  interpolated (`GREETING="hi"` gives `"hi"`, quotes included; `$HOME` stays `$HOME`).
- Other lines — comments, blank lines, `export NAME=value` (Docker rejects it) — aren't variables. The console keeps
  them untouched.
- Saving rewrites only the lines you change or remove; every other line stays byte for byte (trailing blank lines
  collapse to a single final newline). New variables go at the end.
- A value containing a line break is refused: it would slip extra variables into the file that the plan never showed.

**Edit as .env** reads pasted lines the same way: quotes are part of the value, and an `export` line is reported as a
problem.

## What it cannot do

- **Add or remove secret references.** Create the secret in SSM or Secrets Manager, give the task's execution role
  access to it, and reference it in the task definition yourself: the console won't guess those permissions.
- **Edit secrets pinned to a version** (`…:json-key:version-stage:version-id`): a new value wouldn't reach the
  service, so the save is refused before anything is written. Update the secret and the reference together in AWS.
- **Change values from other places**, such as values baked into the image.

## Turn it on

The read-only policy shows the names of plain variables and secret references, but no values, and not the names
inside S3 env files (reading those needs `s3:GetObject`). Add these statements from `infra/iam-policy.json` to the
console's role (see [Connect AWS](connect-aws.md#step-5-turn-on-more-one-feature-at-a-time)):

| Statement | Grants | What it risks |
|---|---|---|
| `SecretValues` | `ssm:GetParameter`, `ssm:DescribeParameters`, `ssm:PutParameter`, `secretsmanager:GetSecretValue`, `secretsmanager:PutSecretValue` on `*` | the console can read and overwrite **any** parameter or secret in the region. Scope `Resource` to the parameter paths and secrets your services use. |
| `SecretValuesKms` | `kms:Decrypt`, `kms:Encrypt`, `kms:GenerateDataKey`, only through SSM, Secrets Manager and S3 | decrypting and re-encrypting those secrets and SSE-KMS env files with your KMS keys |
| `EnvironmentFiles` | `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on `ENV_FILES_BUCKET` | reading and overwriting env files in that bucket. The cloud map's S3 upload, delete and download use this statement too, so they can change other objects in that bucket — never the env files themselves, which they refuse ([S3 file actions](permissions.md#s3-file-actions)) |
| `EditVariablesNewRevision` | `ecs:RegisterTaskDefinition`, `ecs:TagResource` | registering new task-definition revisions |
| `PassTaskRolesToNewRevisions` | `iam:PassRole` of any role to `ecs-tasks.amazonaws.com` (except the console's own role) | new revisions keep the task and execution roles they already had. Narrow `Resource` to your services' roles if you can (see [Narrowing it further](connect-aws.md#narrowing-it-further)). |
| `ServiceActions` | `ecs:UpdateService` | deploying the new revision and restarting the service (also used by [actions](actions.md)) |

Once these are in place, a bad value can take a service down: that's why saves need a role, a confirmation (and a
reason on protected environments), and why plain-variable changes go through a normal ECS deployment with the circuit
breaker.

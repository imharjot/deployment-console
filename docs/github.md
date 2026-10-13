# GitHub & CI

With a token, the console shows GitHub Actions runs per repository and branch (steps, JUnit test results, job logs),
commits behind each deployed revision, release diffs between environments, and whether a rollback crosses database
migrations.

## Set it up

1. Create a **fine-grained personal access token** (GitHub → Settings → Developer settings), limited to the
   repositories of your services, with these permissions:

   | Permission | Access | Why |
   |---|---|---|
   | **Actions** | read and write | runs, jobs, logs and test-result artifacts; write only for re-runs |
   | **Contents** | read | commits, release diffs and migration checks |
   | **Metadata** | read | required by GitHub for every token |
   | **Issues** | read and write (optional) | only if the GitHub Issues integration reuses this token |

2. Set it, and optionally your organisation:

   ```bash
   GITHUB_TOKEN=github_pat_…
   GITHUB_OWNER=your-org     # optional: match services to repositories by name
   ```

3. Restart the console, then check **Settings → Environments** to see which repository each service matched.

The demo (`CONSOLE_SOURCE=mock`) simulates CI and ignores the token; with `CONSOLE_SOURCE=aws` the CI pages need it.
Without `GITHUB_TOKEN` the CI pages answer *not configured* (503, `code: not_configured`) instead of an error, and the
CI page says *Connect GitHub to see runs* with a link here.

## Which repo is a service?

1. tag `console:repo=owner/name` on the ECS service;
2. `services.<name>.repo` in [console.config.json](configuration.md);
3. with `GITHUB_OWNER` set, `owner/<ECR repository name>` or `owner/<service name>` if that repo exists.

**Settings → Environments** shows which rule matched ("tag", "config", "name match") and which services have no repo.

## Commits

The commit of a running revision comes from its image tag: any git sha in the tag works (`<sha>`,
`staging-<sha>`, `v1.4-<sha>`). Tag images with the commit in CI (e.g. `docker/metadata-action` with `type=sha`).
Moving tags (`latest`) can still be deployed and rolled back, but commit, diff and migration checks show "unknown".

**Migration checks.** GitHub lists at most 300 changed files per comparison; beyond that the console lists each
migrations directory at both commits. Anything it can't prove shows as *migrations unknown* and still needs an
acknowledgement before a switch.

`examples/github-actions/deploy-ecs.yml` in the repository is a complete deploy workflow that
tags images this way and registers a new task-definition revision per deploy.

## Test results

A completed run's test results come from its **artifacts whose name starts with `junit`** (for example `junit-unit`):
every `.xml` file inside is read as JUnit XML (node:test, Jest/Vitest JUnit reporters, pytest `--junitxml`,
gotestsum…). `<failure>` and `<error>` both count as failures. Artifacts past their retention are skipped.

## Which workflows deploy

A re-run is treated as a deploy when its **workflow file** is bound to an environment — by name nothing is decided (a
workflow called "CI" can deploy production). Bind files in `console.config.json` `ci.deployments`
(`[{ "repo": "acme/api", "workflow": ".github/workflows/deploy.yml", "env": "production" }]`, see
[Configuration](configuration.md#keys)) or with the tag `console:deploy-workflow` on the environment's ECS cluster
(space-separated files, optionally `owner/repo:` in front: `acme/api:.github/workflows/deploy.yml`).

- One file bound to several environments: a pushed run follows its branch (deploy.yml on `staging` → Staging, on
  `main` → Production); a dispatched run, whose inputs GitHub doesn't expose, counts as a deploy to the protected one.
- A workflow that isn't bound but ran on a protected environment's branch is treated as a deploy there (*unknown
  deployment scope*).
- Successful deploy runs become chart markers; all runs appear in the activity feed.

A run's panel says where a re-run deploys (bound to an environment, *unknown scope — treated as …*, or no deploy) and
why. Re-run modes:

- **Re-run failed tests** (`mode: "tests"`) re-runs the failed jobs and is refused for any workflow that deploys.
- **Redeploy** (`mode: "redeploy"`) re-runs every job and follows the protected-environment rules: on a protected
  environment it needs the operator role, the environment id typed and a reason.

## What and why

<!-- What does this change, and what problem does it solve? Link the issue if there is one. -->

## How it was verified

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run smoke` against `npm run dev` (for API, discovery, action or mock changes)
- [ ] Checked in the browser (for UI changes — screenshots below help)

## Checklist

- [ ] Nothing company-specific (names, hosts, account ids) in code, tests or docs — the demo uses the fictional Acme
- [ ] New or changed behaviour, endpoints, tags, env vars or IAM permissions are documented in `docs/`
- [ ] New AWS calls are granted in `infra/iam-policy*.json` and explained in `docs/connect-aws.md`
- [ ] Pure logic has `node:test` coverage next to it
- [ ] A line under **Unreleased** in `CHANGELOG.md`

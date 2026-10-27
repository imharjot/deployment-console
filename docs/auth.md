# Sign-in & roles

Who can get into the console, how they sign in, and what each person may do. This page is for admins setting up
sign-in and inviting their team.

Users, sessions and roles live in the console's own database (SQLite by default, Postgres with `DATABASE_URL`).

## Sign-in modes

| `AUTH_MODE` | Who signs people in | Use when |
|---|---|---|
| `session` (default) | the console: **email + password** and/or **OIDC SSO** (Google, Okta, Microsoft Entra ID, Auth0, Keycloak…) | most deployments |
| `alb` | an AWS Application Load Balancer `authenticate-oidc` action in front of the console. The console verifies the load balancer's signed header and maps the email to a user | you already use ALB authentication |
| `dev` | nobody: you're signed in as `DEV_USER_EMAIL`, an admin | your own machine only. Refused (every page shows "Console misconfigured") when `NODE_ENV=production`, which `npm start` and the Docker image set |

### `dev` mode is loopback-only

`dev` mode makes **every caller an admin**, so it answers only requests addressed to this machine:

- `npm run dev` listens on `127.0.0.1` only. Don't start `next dev` with `-H 0.0.0.0` or a LAN address.
- Every request must name a loopback host — `localhost`, `127.0.0.1`, `[::1]` or `*.localhost`, any port — in `Host`,
  in every `X-Forwarded-Host` entry and in every `Forwarded: host=`. Anything else gets **403 "dev mode is only
  reachable on localhost"**, before sign-in and before API tokens are looked at. This also stops DNS rebinding: a web
  page that points its own name at `127.0.0.1` still sends its own name as `Host`.
- To reach a dev console from another device, use real sign-in (`AUTH_MODE=session`) instead.

What you do in `dev` mode lasts: a password you set for the dev user and the API tokens you create are kept in the data
directory and keep working when you switch the same data to `AUTH_MODE=session`. That is why they can only be created
from a loopback address, and why you should revoke tokens you made for local experiments before you switch.

## First run: create the first admin

With no users yet, the console either

- creates the first admin from **`CONSOLE_ADMIN_EMAIL`** and **`CONSOLE_ADMIN_PASSWORD`** (at least 10 characters), or
- prints a **one-time setup token** to its log, valid 24 hours:

  ```
  [deployment-console] first-run setup token: …  → open /setup (valid 24 h; one admin can be created with it)
  ```

  Open `/setup`, paste the token and create the admin. `/setup` closes as soon as any user exists. Lost the log line?
  Restart the console: a new token is printed at every start while there are no users, and earlier unexpired tokens
  keep working.

`CONSOLE_ADMIN_EMAIL` without a password creates an admin who signs in through SSO or the load balancer, so it's
accepted only when OIDC is configured or `AUTH_MODE=alb`. Otherwise the console refuses it (the log says why) and
prints a setup token instead.

In `dev` mode no token is printed: the `DEV_USER_EMAIL` user is created as an admin on the first request.

**Moving from the laptop demo to real sign-in?** The demo's admin (`DEV_USER_EMAIL`) starts without a password. Give
it one first: open **Account → Password** and choose **Set password** (no current password needed in `dev` mode).
Then set `AUTH_MODE=session` and restart, and sign in with that email and password; your data stays. Or start the team
setup from scratch: set `CONSOLE_DATA_DIR` to a new folder (or delete `./data`), set `AUTH_MODE=session`, restart, and
use the setup token.

## Single sign-on (OIDC)

```bash
AUTH_MODE=session
CONSOLE_PUBLIC_URL=https://console.example.com
OIDC_ISSUER=https://accounts.google.com         # https (http only for localhost, for testing)
OIDC_CLIENT_ID=…
OIDC_CLIENT_SECRET=…                            # optional for public clients
OIDC_SCOPES=openid email profile                # the default
OIDC_LABEL=Sign in with Google                  # button text
```

1. In your identity provider, create an OIDC web application and register the redirect URI
   **`<CONSOLE_PUBLIC_URL>/api/auth/oidc/callback`**, for example `https://console.example.com/api/auth/oidc/callback`.
2. Set the variables above and restart. The sign-in page shows your button.
3. Make sure the first admin's email is the one they sign in with, or invite them (below).
4. Once admins can sign in with SSO, you can set `AUTH_PASSWORD_LOGIN=false` for SSO-only.

The console uses the authorization-code flow with PKCE, state and nonce, and verifies the ID token against the
provider's published keys (issuer, audience, expiry, nonce). If the settings are wrong (an issuer that isn't `https`, a
missing client id), the console logs a warning at start and leaves SSO off.

**Verified email.** The ID token must carry an `email` claim the provider has verified: `email_verified: true`. With
`OIDC_REQUIRE_EMAIL_VERIFIED` (on by default) a token without `email_verified` is refused too ("Your identity provider
hasn't verified your email address"). **Microsoft Entra ID** doesn't send `email_verified`: add the optional claim
**`xms_edov`** (email domain owner verified) to the app registration's ID token, and the console accepts the email when
it is `true`. Only for a provider that never says, and that you trust to control the addresses it issues, set
`OIDC_REQUIRE_EMAIL_VERIFIED=false`; an explicit `email_verified: false` is refused either way.

**One account, one SSO identity.** The first SSO sign-in to an account links it to that person's subject (the
provider's stable `sub` id). From then on only that subject can sign in to the account: an ID token with the same email
but another subject — the address was given to someone else, or another provider was configured with the same
issuer — is refused ("sso_mismatch" on the sign-in page) and recorded in the audit log as a failed sign-in. A subject
linked to one account can't sign in to another either (the provider changed that person's email): delete the stale
account (or the new one) in **Settings → Users & roles**. Deleting a user removes the link; the next SSO sign-in to a
re-invited account links it again.

## Sign-in at the load balancer (`AUTH_MODE=alb`)

1. In the listener rule for the console, add an `authenticate-oidc` action (with the `email` scope) before the
   forward action.
2. Set `AUTH_MODE=alb` and `ALB_ARN` to that load balancer's ARN. Without `ALB_ARN` every request is refused.
3. Optional: `CONSOLE_ALLOWED_EMAILS` (comma-separated) as an extra gate on top of the users table.

The console accepts the `x-amzn-oidc-data` header only if it is signed by that load balancer (ES256; the signing key is
fetched for `AWS_REGION`, so the load balancer must be in that region), is not expired, and carries a verified email.
The expiry is the `exp` in the token's signed **header**, where the load balancer puts it (the payload holds your
identity provider's user claims), checked with 60 seconds of clock tolerance.
Signing out happens at the load balancer and your identity provider. For API tokens behind an ALB, see
[Agents & API](automation.md#alb-sign-in).

## Invite your team

1. Open **Settings → Users & roles** and choose **Invite user**.
2. Enter the email and pick a role (see the table below).
3. With password sign-in on, choose **Create invite link** and send the link to the person yourself — the console
   sends no email. The link works once and expires after 7 days. With SSO only, or with `AUTH_MODE=alb`, choose
   **Add user**: there's no link, and they sign in with SSO or through the load balancer straight away.

To let colleagues in without inviting each one, set `AUTH_ALLOWED_DOMAINS` (for example `acme.com`): SSO or load
balancer users with that email domain are created on their first sign-in with `AUTH_DEFAULT_ROLE` (default `viewer`).
Admin is never granted this way.

Who gets in:

- **Invited** users always get in with their invited role: with a password (set through the invite link), or with SSO
  or the load balancer using the same email.
- **Uninvited SSO or load balancer users** get in only if their email domain is in `AUTH_ALLOWED_DOMAINS`.
- Everyone else sees a "Not allowed" page that tells them to ask an admin for an invite. **Disabled** users are always
  refused.

## Roles

Each role includes everything the roles above it in this table can do.

| Role | Can |
|---|---|
| **viewer** | see the overview, the cloud map, logs, metrics, CI, releases, activity, the audit log and [notes](notes.md), and the names (not values) of environment variables |
| **developer** | + restart, stop/start and switch revision, reveal and edit environment variables, and run one-off tasks on **non-protected** environments; re-run CI (except deploys to protected environments); create tickets; write [notes](notes.md); refresh the cloud map (a full re-discovery) |
| **operator** | + the same on **protected** environments; re-run deploys to protected environments; start/stop hosts and databases (never on protected environments); see [costs](costs.md); [create & scale](provisioning.md) on non-protected environments |
| **admin** | + users, integrations, the AWS connection, discovery re-scan, everyone's API tokens, and create & scale on protected environments |

In detail:

| What | viewer | developer | operator | admin |
|---|---|---|---|---|
| Overview, logs, metrics, CI, releases, activity, audit log | ✓ | ✓ | ✓ | ✓ |
| Variable names and where they live | ✓ | ✓ | ✓ | ✓ |
| Restart, stop/start, switch revision | | non-protected | ✓ | ✓ |
| Reveal and edit variable values | | non-protected | ✓ | ✓ |
| Run a one-off task | | non-protected | ✓ | ✓ |
| Re-run CI | | except protected deploys | ✓ | ✓ |
| Create tickets | | ✓ | ✓ | ✓ |
| Refresh the cloud map now (re-discover the account) | | ✓ | ✓ | ✓ |
| Start/stop hosts and databases (never on protected environments) | | | ✓ | ✓ |
| Costs page and cost operations | | | ✓ | ✓ |
| Copy, scale, add hosts, delete what the console created | | | non-protected | ✓ |
| Users, integrations, the AWS connection, discovery re-scan, everyone's API tokens | | | | ✓ |

Anyone can create [API tokens](automation.md) for themselves, never with more than their own role. Approving an
agent's request needs the permission the request itself needs (and, with `CONSOLE_APPROVALS_TWO_PERSON=true`, someone
other than the token's owner).

The server checks every request, whatever the page shows. In the UI, most buttons a person can't use are disabled and
say which role they need; a few (such as **Re-scan now**, the cloud map's **Refresh** and **Ticket**) are hidden
instead.

### Protected environments

A *protected* environment is a production-like one. Changes there need a higher role (operator, or admin for create &
scale), a typed confirmation and a reason, which goes to the audit log. Clusters whose names include the word `prod`,
`production`, `prd` or `live` are protected automatically; the cluster tag `console:protected=true/false` or
`protected` in the config file decides otherwise. See [How discovery works](discovery.md). On the cloud map,
protection is decided per resource and fails safe: see
[Which resources count as protected](cloud-map.md#which-resources-count-as-protected).

## Managing users (admin)

In **Settings → Users & roles** an admin can:

- **invite** a user (a one-time link valid 7 days, or instant access with SSO only or behind the load balancer);
- **change a role**: it applies from the person's next request;
- **disable** or **enable** a user: disabling ends their sessions, their API tokens stop working, and requests their
  tokens left waiting for approval are rejected;
- create a **password reset link**: the old password and all sessions stop working immediately (only with password
  sign-in on, so never in `alb` mode);
- **delete** a user, which also rejects their tokens' pending approval requests.

The console never lets you demote, disable or delete the **last active admin**.

Everyone can change their own password and see their sessions on the **Account** page (in the menu under their name),
and revoke them one by one (**Revoke**) or all other sessions at once. The local dev user (`AUTH_MODE=dev`) can set a
first password there.

## Sessions

- The cookie is `console_session`: `HttpOnly`, `SameSite=Lax`, and `Secure` when `CONSOLE_PUBLIC_URL` is `https://`
  (or the proxy says the request was HTTPS). Only a hash of the session token is stored.
- A session lasts `SESSION_TTL_HOURS` (default 12) and is renewed as you use it (at most every 10 minutes), but never
  beyond 7 days after sign-in (or the TTL itself, if you set it above 168 hours).
- Signing out, disabling a user or resetting their password ends their sessions. Role changes apply on the next
  request.
- Failed password sign-ins are rate-limited over 15 minutes: 10 for one email from one address, 50 from one address,
  and 50 for one email whatever the address. The address comes from `X-Forwarded-For`, as written by the proxies
  `CONSOLE_TRUSTED_PROXIES` trusts (`1` by default, `2` for CloudFront → ALB). When the console can't know it (`0`, or
  no proxy that appends the header), the per-address limit is off and every client counts as the same address, so an
  email is locked after 10 failures. Unknown emails and wrong passwords get the same message, and a `429` says when to
  retry (`Retry-After`). The counters are kept in memory, so a restart resets them.

## Reference

| Variable | Default | Meaning |
|---|---|---|
| `AUTH_MODE` | `session` | `session`, `alb` or `dev` |
| `CONSOLE_ADMIN_EMAIL`, `CONSOLE_ADMIN_PASSWORD` | — | the first admin, used only while there are no users |
| `CONSOLE_PUBLIC_URL` | the request's origin | redirect URI, invite links, notification links, `Secure` cookies, the one origin allowed to send changes — **set it in production**: without it these follow the request's `Host` header, and the console logs a warning at start in `session` and `alb` mode |
| `CONSOLE_TRUSTED_PROXIES` | `1` | proxies in front that append `X-Forwarded-For` (`2` for CloudFront → ALB, `0` for none) — see [Configuration](configuration.md#environment-variables) |
| `SESSION_TTL_HOURS` | `12` | sliding session length, at most 720; an empty or invalid value means 12 |
| `AUTH_PASSWORD_LOGIN` | `true` | `false` = SSO only (always off in `alb` mode) |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | — | OIDC SSO (the secret is optional for public clients) |
| `OIDC_SCOPES` | `openid email profile` | scopes requested from the provider |
| `OIDC_LABEL` | `Sign in with SSO` | text on the sign-in button |
| `OIDC_REQUIRE_EMAIL_VERIFIED` | `true` | `false` = accept an ID token without `email_verified` (an explicit `false` is still refused) |
| `AUTH_ALLOWED_DOMAINS` | — | comma-separated email domains whose SSO or load balancer users are created on first sign-in |
| `AUTH_DEFAULT_ROLE` | `viewer` | role for those users: `viewer`, `developer` or `operator` (anything else means `viewer`) |
| `ALB_ARN` | — | `alb` mode, required: only headers signed by this load balancer are accepted |
| `CONSOLE_ALLOWED_EMAILS` | — | `alb` mode: optional extra allowlist |
| `DEV_USER_EMAIL` | `dev@localhost` (`.env.example` sets `you@example.com`) | `dev` mode identity (loopback requests only) |

## API tokens

Agents and scripts use an API token (`Authorization: Bearer dc_…`) created under **Automation → API tokens**. A token
acts as the person who created it, with at most the role chosen for it and never more than that person's current
role, and it reaches only the operations API. Disabling or deleting a user stops their tokens too and rejects their
pending approval requests. Tokens work in every `AUTH_MODE`. See [Agents & API](automation.md).

## Not yet

Email delivery of invites and resets, SCIM provisioning, and falling back to the userinfo endpoint for providers that
leave the `email` claim out of ID tokens.

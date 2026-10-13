# Quickstart

Run the console on your laptop in about two minutes, against a **simulated AWS account**. You don't need an AWS
account, and nothing you click touches AWS. When you've seen enough, [connect your own account](connect-aws.md).

## Before you start

- **Either** Node.js **24 or newer** with npm (check with `node -v`; it should print `v24` or higher) and about 600 MB
  of disk for dependencies,
- **or** Docker with Compose v2 (`docker compose version`).

## Option A: run it with npm

```bash
git clone https://github.com/imharjot/deployment-console.git
cd deployment-console
npm install
cp .env.example .env.local
npm run dev
```

You should see:

```
▲ Next.js 16.x (Turbopack)
- Local:         http://localhost:3200
- Environments: .env.local
✓ Ready in …
```

Open **http://localhost:3200**. The first page takes a few seconds to compile. You're signed in as `you@example.com`
with the admin role, and a **Mock data** banner on the overview tells you you're looking at the simulation.

Why no sign-in? `.env.local` (copied from `.env.example`) sets two things:

| Setting | Means |
|---|---|
| `CONSOLE_SOURCE=mock` | use the simulated account instead of AWS |
| `AUTH_MODE=dev` | skip sign-in and act as `DEV_USER_EMAIL`, an admin. Only for your own machine: it is refused when `NODE_ENV=production` |

Users, the audit log and other console data are stored in SQLite under `./data`. Delete that folder to start fresh.

## Option B: run it with Docker

```bash
git clone https://github.com/imharjot/deployment-console.git
cd deployment-console
docker compose up --build
```

The first build takes a few minutes. When it's ready, the log shows a line like this:

```
[deployment-console] first-run setup token: 3xAmPlE…  → open /setup (valid 24 h; one admin can be created with it)
```

1. Open **http://localhost:3000**. You're sent to the setup page.
2. Paste the token, enter your email and a password (at least 10 characters), and choose **Create admin and sign in**.

Lost the log line? Run `docker compose logs console | grep "setup token"` in the same folder, or
`docker compose restart console`: until the first admin exists, every start prints a new token.

Would you rather skip the setup page? Create the admin from environment variables on the first start instead (this
only works while there are no users yet):

```bash
CONSOLE_ADMIN_EMAIL=you@example.com CONSOLE_ADMIN_PASSWORD='choose-a-long-password' docker compose up --build
```

The Docker demo uses real sign-in (`AUTH_MODE=session`), just like a team deployment. Its data lives in the Docker
volume `console-data`: `docker compose down` keeps it, `docker compose down -v` deletes it.

Compose reads settings from your shell or from a `.env` file next to `docker-compose.yml` (not `.env.local`). To try
it with Postgres instead of SQLite, uncomment the `DATABASE_URL` and `CONSOLE_SECRET_KEY` lines in
`docker-compose.yml`, put a key in `.env` so it stays the same between runs, and start the `postgres` profile:

```bash
echo "CONSOLE_SECRET_KEY=$(openssl rand -base64 48)" >> .env
docker compose --profile postgres up --build
```

## Take a tour

The simulated account belongs to **Acme**, a fictional online shop, with two environments:

- **Staging** (cluster `acme-staging`): one ECS-on-EC2 host, Caddy as the reverse proxy and Redis in a container.
- **Production** (cluster `acme-production`): Fargate behind a load balancer, with RDS and ElastiCache. It is a
  *protected* environment, and it includes a recent rollout that the ECS circuit breaker rolled back.

Things to try:

1. **Switch environments** with the picker at the top. The map shows services, data stores and external systems,
   with arrows for dependencies. Choose **Grid** for a list view.
2. **Click a service** to open its panel: status and why, tasks, revisions, events, logs, metrics and the
   **Variables** tab.
3. **Restart a staging service.** It takes one click. Now try a production service: you'll need to type the
   service's name and give a reason, because production is protected.
4. **Open the issues drawer** (the warning badge at the top, when there is something to show) to see what's
   degraded or down across environments, and why.
5. Visit **Logs** for a live tail across services, **Metrics**, **CI**, **Releases** and **Costs**.
6. Open **Audit** to see every action you just took, with who, when and why.
7. Under **Automation → API tokens**, create a token and follow [Agents & API](automation.md) to call the console
   from `curl`, from Claude Code over MCP, or with the example agent.

Actions only change the simulation, which lives in memory: restarting the server resets it.

## Next steps

- [Connect AWS](connect-aws.md): point the console at your account with a read-only policy.
- [Deploy the console](deploy.md): run it on ECS for your team, with HTTPS and single sign-on.
- [Common questions](faq.md): what it costs, what it can change, and more.

## If something goes wrong

| What you see | What to do |
|---|---|
| `npm warn EBADENGINE Unsupported engine … required: { node: '>=24' }` | Your Node.js is too old. npm installs anyway, but the console fails when it opens its database, often with `No such built-in module: node:sqlite`. Install Node.js 24 (for example `nvm install 24`) and run `npm install` again. |
| `ExperimentalWarning: SQLite is an experimental feature` | Harmless. Node.js prints it because the console uses its built-in SQLite. |
| `Error: listen EADDRINUSE … :3200` | Something else uses port 3200. Run the console on another port: `npx next dev -p 3300`. |
| A "Console misconfigured" page saying `AUTH_MODE=dev is refused when NODE_ENV=production` | `AUTH_MODE=dev` only works with `npm run dev`. After `npm run build && npm start`, or in Docker, set `AUTH_MODE=session` instead. |
| Docker: no setup token in the log | Look further back with `docker compose logs console`, restart with `docker compose restart console` to print a new one, or create the admin with `CONSOLE_ADMIN_EMAIL` and `CONSOLE_ADMIN_PASSWORD` as shown above. |
| Docker: `cross-site request refused` on the setup or sign-in page | Open the console at exactly `http://localhost:3000` (not `127.0.0.1`), or set `CONSOLE_PUBLIC_URL` to the address you use: changes are accepted only from that address. |
| Docker: `bind: address already in use` for port 3000 | Change the left side of `ports: "3000:3000"` in `docker-compose.yml`, for example `"3001:3000"`, and set `CONSOLE_PUBLIC_URL=http://localhost:3001`. |

More in [Troubleshooting](troubleshooting.md).

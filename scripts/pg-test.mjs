#!/usr/bin/env node
// Runs the DB and coordinator suites against a real, throwaway Postgres 16 — SQLite and Postgres differ in exactly
// the places those suites test (transaction isolation, advisory-lock migrations, BIGSERIAL, ON CONFLICT … WHERE).
//
//   node scripts/pg-test.mjs [extra test files…]
//
// Uses the postgres:16 image only if it is already present (never pulls), publishes it on a free loopback port with a
// random password, waits until it accepts connections, runs the suites with PG_TEST_URL set, and always removes the
// container. Without Docker (or without the image) it prints "skipped" and exits 0.
//
// With PG_TEST_URL already set (CI: a `services: postgres:16` container) it runs the suites against that server and
// starts nothing. The suites create and drop their own databases, so the URL needs a role that may CREATE DATABASE.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE = "postgres:16";
// The agent worker suite (wave C) joins as soon as it exists.
const WORKER = "src/lib/server/agents/worker.test.ts";
const SUITES = ["src/lib/db-core.test.ts", "src/lib/mutation-core.test.ts", ...(existsSync(path.join(root, WORKER)) ? [WORKER] : []), ...process.argv.slice(2)];

const runSuites = (url) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-reporter=spec", "--test-concurrency=1", ...SUITES], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, PG_TEST_URL: url, NODE_NO_WARNINGS: "1" },
    });
    child.on("exit", (c, sig) => resolve(sig ? 1 : (c ?? 1)));
    child.on("error", () => resolve(1));
  });

if (process.env.PG_TEST_URL) {
  console.log(`pg-test: using PG_TEST_URL; running ${SUITES.join(", ")}`);
  const code = await runSuites(process.env.PG_TEST_URL);
  console.log(`pg-test: ${code === 0 ? "passed" : "FAILED"}`);
  process.exit(code);
}

const docker = (args, opts = {}) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const skip = (why) => {
  console.log(`pg-test: skipped — ${why}`);
  process.exit(0);
};

try {
  docker(["info", "--format", "{{.ServerVersion}}"], { timeout: 15_000 });
} catch {
  skip("Docker isn't running");
}
// The local image's id. Docker Desktop sometimes fails to resolve the short name while the fully qualified one and
// the listing still work, so try all three; the container then runs from the id (nothing to resolve, nothing to pull).
const imageId = (() => {
  for (const ref of [IMAGE, `docker.io/library/${IMAGE}`]) {
    try {
      return docker(["image", "inspect", ref, "--format", "{{.Id}}"]);
    } catch {
      // next
    }
  }
  try {
    return docker(["images", "-q", "--no-trunc", IMAGE]).split("\n")[0];
  } catch {
    return "";
  }
})();
if (!imageId) skip(`the ${IMAGE} image isn't present locally (this script never pulls)`);

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const port = await freePort();
const password = randomBytes(18).toString("base64url");
const name = `deployment-console-pg-test-${randomBytes(4).toString("hex")}`;
let id = "";
const stop = () => {
  if (!id) return;
  try {
    docker(["stop", "-t", "2", id], { timeout: 30_000 }); // --rm removes it
  } catch {
    try {
      docker(["rm", "-f", id]);
    } catch {
      // already gone
    }
  }
  id = "";
};
for (const sig of ["SIGINT", "SIGTERM"])
  process.once(sig, () => {
    stop();
    process.exit(130);
  });

let code = 1;
try {
  id = docker(["run", "--rm", "-d", "--pull", "never", "--name", name, "-p", `127.0.0.1:${port}:5432`, "-e", `POSTGRES_PASSWORD=${password}`, imageId]);
  const url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;

  // The image's init runs a socket-only server first; a TCP connection succeeds only once the real one is up.
  const pg = (await import("pg")).default;
  const deadline = Date.now() + 60_000;
  for (;;) {
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
    try {
      await c.connect();
      await c.query("SELECT 1");
      await c.end();
      break;
    } catch (e) {
      await c.end().catch(() => {});
      if (Date.now() > deadline) throw new Error(`Postgres didn't become ready in 60 s: ${e.message}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.log(`pg-test: ${IMAGE} ready on 127.0.0.1:${port}; running ${SUITES.join(", ")}`);

  code = await runSuites(url);
} catch (e) {
  console.error(`pg-test: ${e.message}`);
  code = 1;
} finally {
  stop();
}
console.log(`pg-test: ${code === 0 ? "passed" : "FAILED"} (container removed)`);
process.exit(code);

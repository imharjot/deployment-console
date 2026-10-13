import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SESSION_MS, RENEW_EVERY_MS, RateLimiter, SESSION_COOKIE, autoRole, cleanName, hashToken, isSecure, isTokenShape, newToken, normalizeEmail,
  provisionDecision, readAuthConfig, renewedExpiry, resolveAuthMode, safeNext, sessionCookie,
} from "./authn.ts";

test("auth mode: session by default, dev refused in production, unknown refused", () => {
  assert.deepEqual(resolveAuthMode({}), { ok: true, mode: "session" });
  assert.deepEqual(resolveAuthMode({ AUTH_MODE: "ALB" }), { ok: true, mode: "alb" });
  assert.deepEqual(resolveAuthMode({ AUTH_MODE: "dev", NODE_ENV: "development" }), { ok: true, mode: "dev" });
  assert.equal(resolveAuthMode({ AUTH_MODE: "dev", NODE_ENV: "production" }).ok, false);
  assert.equal(resolveAuthMode({ AUTH_MODE: "none" }).ok, false);
});

test("config: password login on unless false, OIDC needs https + client id, TTL default 12h", () => {
  const c = readAuthConfig({});
  assert.equal(c.passwordLogin, true);
  assert.equal(c.oidc, null);
  assert.equal(c.ttlMs, 12 * 3_600_000);
  assert.equal(readAuthConfig({ AUTH_PASSWORD_LOGIN: "false" }).passwordLogin, false);
  assert.equal(readAuthConfig({ SESSION_TTL_HOURS: "2" }).ttlMs, 2 * 3_600_000);
  assert.equal(readAuthConfig({ SESSION_TTL_HOURS: "-1" }).ttlMs, 12 * 3_600_000);

  const o = readAuthConfig({ OIDC_ISSUER: "https://accounts.google.com/", OIDC_CLIENT_ID: "abc", OIDC_CLIENT_SECRET: "s" }).oidc!;
  assert.equal(o.issuer, "https://accounts.google.com");
  assert.equal(o.scopes, "openid email profile");
  assert.equal(o.label, "Sign in with SSO");
  assert.equal(readAuthConfig({ OIDC_ISSUER: "http://idp.example.com", OIDC_CLIENT_ID: "abc" }).oidc, null, "plain http refused");
  assert.ok(readAuthConfig({ OIDC_ISSUER: "http://127.0.0.1:9999", OIDC_CLIENT_ID: "abc" }).oidc, "http allowed for localhost");
  assert.equal(readAuthConfig({ OIDC_ISSUER: "https://idp.example.com" }).oidc, null, "client id required");
  assert.deepEqual(readAuthConfig({ AUTH_ALLOWED_DOMAINS: " Example.com, @acme.io ,," }).allowedDomains, ["example.com", "acme.io"]);
});

test("auto-provisioned role defaults to viewer and can never be admin", () => {
  assert.equal(autoRole(undefined), "viewer");
  assert.equal(autoRole("developer"), "developer");
  assert.equal(autoRole("Operator"), "operator");
  assert.equal(autoRole("admin"), "viewer");
  assert.equal(autoRole("superuser"), "viewer");
});

test("tokens: 32 random bytes, base64url, stored as sha256 hex", () => {
  const t = newToken();
  assert.ok(isTokenShape(t));
  assert.notEqual(t, newToken());
  assert.match(hashToken(t), /^[0-9a-f]{64}$/);
  assert.equal(hashToken(t), hashToken(t));
  for (const bad of ["", "short", t + "x", t.slice(0, 42) + "/", null, 5]) assert.equal(isTokenShape(bad), false);
});

test("emails and names are normalised and bounded", () => {
  assert.equal(normalizeEmail("  Ada@Example.COM "), "ada@example.com");
  for (const bad of ["", "no-at", "a@b", "a b@c.io", "<a@b.io>", `${"x".repeat(250)}@b.io`, 7]) assert.equal(normalizeEmail(bad), null, String(bad));
  assert.equal(cleanName("  Ada\u0000 Lovelace\n "), "Ada Lovelace");
  assert.equal(cleanName("   "), null);
  assert.equal(cleanName("x".repeat(300))!.length, 100);
});

test("safeNext: only same-origin relative paths survive", () => {
  assert.equal(safeNext("/ci?repo=a#run"), "/ci?repo=a#run");
  assert.equal(safeNext("/settings/users"), "/settings/users");
  for (const bad of [
    "https://evil.example", "//evil.example", "///evil.example", "/\\evil.example", "\\\\evil.example", "/\\/evil.example",
    "javascript:alert(1)", "evil.example", "", null, undefined, "/\tjavascript:x", "/\r\n/evil.example", "/a/../..//evil.example",
    "/a/../../..//evil.example", "/login", "/login?next=/x", "/setup", "/invite/abc", "/api/users",
  ])
    assert.equal(safeNext(bad), "/", String(bad));
  // Percent-encoded separators stay inside the path: the browser does not decode them into a host.
  assert.equal(safeNext("/%2F%2Fevil.example"), "/%2F%2Fevil.example");
  assert.equal(safeNext("/%0d%0aSet-Cookie:x"), "/%0d%0aSet-Cookie:x");
});

test("session cookie: httpOnly, SameSite=Lax, path /, Secure only over https", () => {
  const c = sessionCookie("tok", true, 12 * 3_600_000);
  assert.deepEqual(c, { name: SESSION_COOKIE, value: "tok", httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 43_200 });
  assert.equal(sessionCookie("", false, 0).maxAge, 0);
  assert.equal(isSecure({ publicUrl: "https://console.acme.io" }), true);
  assert.equal(isSecure({ publicUrl: "http://localhost:3200", forwardedProto: "https" }), false, "explicit public URL wins");
  assert.equal(isSecure({ forwardedProto: "https, http" }), true);
  assert.equal(isSecure({ forwardedProto: "http", protocol: "https:" }), false);
  assert.equal(isSecure({ protocol: "https:" }), true);
  assert.equal(isSecure({ protocol: "http:" }), false);
});

test("sliding renewal: at most every 10 minutes, never past the absolute cap", () => {
  const ttl = 12 * 3_600_000;
  const created = 1_000_000_000_000;
  const fresh = { createdAt: created, expiresAt: created + ttl };
  assert.equal(renewedExpiry(fresh, created + RENEW_EVERY_MS - 1, ttl), null, "too soon");
  assert.equal(renewedExpiry(fresh, created + RENEW_EVERY_MS, ttl), created + RENEW_EVERY_MS + ttl);
  const old = { createdAt: created, expiresAt: created + MAX_SESSION_MS };
  assert.equal(renewedExpiry(old, created + MAX_SESSION_MS - 60_000, ttl), null, "capped: no extension past created + 7d");
});

test("SSO provisioning: invited row wins, disabled is denied, allow-listed domains auto-create", () => {
  assert.equal(provisionDecision({ disabled: 0 }, "a@other.io", []), "use");
  assert.equal(provisionDecision({ disabled: 1 }, "a@acme.io", ["acme.io"]), "disabled");
  assert.equal(provisionDecision(undefined, "a@acme.io", ["acme.io"]), "create");
  assert.equal(provisionDecision(undefined, "a@evil-acme.io", ["acme.io"]), "denied");
  assert.equal(provisionDecision(undefined, "a@sub.acme.io", ["acme.io"]), "denied", "exact domain match only");
  assert.equal(provisionDecision(undefined, "a@acme.io", []), "denied");
});

test("rate limiter: blocks after N failures in the window, reset clears, window slides", () => {
  const rl = new RateLimiter(3, 60_000);
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) {
    assert.equal(rl.retryIn("k", t0 + i), 0);
    rl.fail("k", t0 + i);
  }
  assert.ok(rl.retryIn("k", t0 + 10) > 59_000);
  assert.equal(rl.retryIn("other", t0 + 10), 0, "keys are independent");
  assert.equal(rl.retryIn("k", t0 + 60_001), 0, "old failures age out");
  rl.fail("k", t0 + 70_000);
  rl.reset("k");
  assert.equal(rl.retryIn("k", t0 + 70_001), 0);
});

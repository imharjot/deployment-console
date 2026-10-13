import { test } from "node:test";
import assert from "node:assert/strict";
import { DEV_HOST_REFUSED, devHostProblem, isLoopbackHost } from "./dev-host.ts";

test("isLoopbackHost: localhost, 127.0.0.1, [::1] and *.localhost, with or without a port", () => {
  for (const h of ["localhost", "localhost:3200", "LOCALHOST:3200", "localhost.", "127.0.0.1", "127.0.0.1:3200", "[::1]", "[::1]:3200", "console.localhost", "a.b.localhost:3201"]) {
    assert.equal(isLoopbackHost(h), true, h);
  }
});

test("isLoopbackHost: everything else is refused (other names, addresses, rebinding hosts, malformed values)", () => {
  for (const h of [
    null, undefined, "", " ", "attacker.example", "attacker.example:3200", "localhost.attacker.example", "localhostx", "127.0.0.2", "127.0.0.1.nip.io",
    "10.0.0.5:3200", "192.168.1.20", "0.0.0.0", "[::]", "[::ffff:127.0.0.1]", "[::1", "[::1]x", "[::1]:", "localhost:", "localhost:abc", "localhost:3200:1",
    "user@localhost", "localhost/x", "evil..localhost", "a_b.localhost",
  ]) {
    assert.equal(isLoopbackHost(h as string), false, String(h));
  }
});

const headers = (h: Record<string, string>) => (name: string) => h[name] ?? null;

test("devHostProblem: Host, every X-Forwarded-Host entry and every Forwarded host= must be loopback", () => {
  assert.equal(devHostProblem(headers({ host: "127.0.0.1:3200" })), null);
  assert.equal(devHostProblem(headers({ host: "localhost:3200", "x-forwarded-host": "localhost:3200" })), null);
  assert.equal(devHostProblem(headers({ host: "localhost:3200", forwarded: "for=127.0.0.1;host=localhost:3200;proto=http" })), null);
  assert.equal(devHostProblem(headers({ host: "localhost:3200", forwarded: "for=127.0.0.1" })), null, "no host= in Forwarded");

  assert.equal(devHostProblem(headers({})), DEV_HOST_REFUSED, "no Host");
  assert.equal(devHostProblem(headers({ host: "attacker.example:3200" })), DEV_HOST_REFUSED, "DNS rebinding: the browser sends the attacker's name");
  assert.equal(devHostProblem(headers({ host: "192.168.1.20:3200" })), DEV_HOST_REFUSED, "a LAN address");
  assert.equal(devHostProblem(headers({ host: "127.0.0.1:3200", "x-forwarded-host": "attacker.example" })), DEV_HOST_REFUSED, "a proxy in front names another host");
  assert.equal(devHostProblem(headers({ host: "127.0.0.1:3200", "x-forwarded-host": "localhost, attacker.example" })), DEV_HOST_REFUSED);
  assert.equal(devHostProblem(headers({ host: "127.0.0.1:3200", "x-forwarded-host": "" })), DEV_HOST_REFUSED, "an empty X-Forwarded-Host");
  assert.equal(devHostProblem(headers({ host: "127.0.0.1:3200", forwarded: 'for=1.2.3.4;host="attacker.example"' })), DEV_HOST_REFUSED);
});

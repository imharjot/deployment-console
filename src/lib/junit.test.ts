import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJUnit, summarize } from "./junit.ts";

const NODE_TEST = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testsuite name="orders" tests="3" failures="1" skipped="1" time="0.4">
    <testcase name="creates order" time="0.120" classname="test" file="tests/unit/orders.test.ts"/>
    <testcase name="rejects &lt;empty&gt; cart" time="0.050" classname="test">
      <failure type="testCodeFailure" message="Expected values to be strictly equal:&#10;&#10;1 !== 2">
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal
    at TestContext.&lt;anonymous&gt; (tests/unit/orders.test.ts:42:12)
      </failure>
    </testcase>
    <testcase name="todo later" time="0" classname="test"><skipped type="skipped" message="skip"/></testcase>
  </testsuite>
</testsuites>`;

const GOTESTSUM = `<testsuites tests="2" failures="0" errors="0" time="1.2">
  <testsuite tests="2" failures="0" time="1.2" name="github.com/acme/jobs/internal/email">
    <testcase classname="github.com/acme/jobs/internal/email" name="TestUpsert/ok" time="0.010000"></testcase>
    <testcase classname="github.com/acme/jobs/internal/email" name="TestRetry" time="1.100000"><error message="panic">boom</error></testcase>
  </testsuite>
</testsuites>`;

test("node:test JUnit: names, entities, failure text, skipped", () => {
  const cases = parseJUnit(NODE_TEST, "unit.xml");
  assert.equal(cases.length, 3);
  assert.equal(cases[1].name, "rejects <empty> cart");
  assert.match(cases[1].failure!, /1 !== 2/);
  assert.match(cases[1].failure!, /orders\.test\.ts:42:12/);
  assert.equal(cases[2].skipped, true);
  assert.equal(cases[0].failure, undefined);
});

test("gotestsum JUnit: <error> counts as a failure", () => {
  const cases = parseJUnit(GOTESTSUM);
  assert.equal(cases.length, 2);
  assert.equal(cases[1].suite, "github.com/acme/jobs/internal/email");
  assert.match(cases[1].failure!, /panic/);
});

test("summary across files", () => {
  const r = summarize([{ name: "unit.xml", xml: NODE_TEST }, { name: "go.xml", xml: GOTESTSUM }]);
  assert.deepEqual([r.total, r.failed, r.skipped], [5, 2, 1]);
  assert.equal(r.seconds, 1.3);
});

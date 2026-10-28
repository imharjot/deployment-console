import { test } from "node:test";
import assert from "node:assert/strict";
import { firstEnabled, lastEnabled, placeMenu, step, typeaheadMatch } from "./select-rules.ts";

test("keys step over disabled options and stop at the ends, as native selects do", () => {
  const off = [false, true, false, false, true];
  assert.equal(step(off, 0, 1), 2);
  assert.equal(step(off, 2, 1), 3);
  assert.equal(step(off, 3, 1), 3, "no option after the last enabled one: stays");
  assert.equal(step(off, 3, -1), 2);
  assert.equal(step(off, 2, -1), 0);
  assert.equal(step(off, 0, -1), 0);
  assert.equal(step(off, 0, 1, 10), 3, "a page moves as far as it can");
  assert.equal(firstEnabled([true, false]), 1);
  assert.equal(lastEnabled(off), 3);
  assert.equal(firstEnabled([true]), -1);
});

test("typing jumps to the next match after the active option; the same letter again cycles", () => {
  const texts = ["eu-west-1 · Ireland", "us-east-1 · N. Virginia", "us-east-2 · Ohio", "us-west-2 · Oregon", "ap-south-1 · Mumbai"];
  const off = texts.map(() => false);
  assert.equal(typeaheadMatch(texts, off, -1, "u"), 1);
  assert.equal(typeaheadMatch(texts, off, 1, "u"), 2, "one letter again: the next one");
  assert.equal(typeaheadMatch(texts, off, 2, "uu"), 3, "a repeated letter cycles too");
  assert.equal(typeaheadMatch(texts, off, 3, "u"), 1, "wraps around");
  assert.equal(typeaheadMatch(texts, off, 1, "us-east-2"), 2, "a longer prefix matches from the active option on");
  assert.equal(typeaheadMatch(texts, off, 0, "AP"), 4, "case doesn't matter");
  assert.equal(typeaheadMatch(texts, [false, true, true, false, false], -1, "u"), 3, "disabled options are skipped");
  assert.equal(typeaheadMatch(texts, off, 0, "zz"), -1);
  assert.equal(typeaheadMatch(texts, off, 0, ""), -1);
});

test("the menu opens below its trigger, above it when there's no room below, and stays in the window", () => {
  const view = { width: 1280, height: 800 };
  const below = placeMenu({ left: 100, top: 100, bottom: 136, width: 240 }, view, 5);
  assert.deepEqual(below, { left: 100, top: 140, minWidth: 240, maxHeight: 320, from: "top" });
  const up = placeMenu({ left: 100, top: 700, bottom: 736, width: 240 }, view, 20);
  assert.equal(up.from, "bottom");
  assert.equal(up.bottom, 800 - 700 + 4);
  assert.equal(up.maxHeight, 320);
  const short = placeMenu({ left: 100, top: 614, bottom: 650, width: 240 }, view, 2);
  assert.equal(short.from, "top", "a short list that fits below stays below");
  assert.equal(short.maxHeight, 800 - 650 - 12);
  assert.equal(placeMenu({ left: 100, top: 690, bottom: 726, width: 240 }, view, 2).from, "bottom", "one that doesn't fit goes up");
  const edge = placeMenu({ left: 1200, top: 100, bottom: 136, width: 60 }, view, 3);
  assert.equal(edge.minWidth, 160, "never narrower than a readable menu");
  assert.equal(edge.left, 1280 - 8 - 160, "pulled back inside the window");
  const phoneish = placeMenu({ left: 10, top: 100, bottom: 136, width: 500 }, { width: 375, height: 700 }, 3);
  assert.equal(phoneish.minWidth, 375 - 16);
  assert.equal(phoneish.left, 8);
});

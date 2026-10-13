import { test } from "node:test";
import assert from "node:assert/strict";
import { covers, createViewport, renderWindow, type View } from "./viewport.ts";

// A hand-driven scheduler: frames and timers run when the test says so.
function manual() {
  let frames: (() => void)[] = [];
  const timers = new Map<number, () => void>();
  let id = 0;
  return {
    s: {
      raf: (f: () => void) => (frames.push(f), frames.length),
      caf: () => (frames = []),
      setTimeout: (f: () => void) => (timers.set(++id, f), id),
      clearTimeout: (t: unknown) => void timers.delete(t as number),
    },
    frame() {
      const f = frames;
      frames = [];
      for (const x of f) x();
    },
    fire() {
      const t = [...timers.values()];
      timers.clear();
      for (const x of t) x();
    },
  };
}

test("F47: a gesture moves the view frame by frame without telling React; the end of it commits once", () => {
  const m = manual();
  const vp = createViewport({ x: 0, y: 0, z: 1 }, m.s);
  const frames: View[] = [], commits: View[] = [];
  vp.onFrame((v) => frames.push(v));
  vp.onCommit((v) => commits.push(v));
  for (let i = 1; i <= 10; i++) vp.set({ x: i * 4, y: i * 2, z: 1 });
  assert.equal(frames.length, 0, "nothing until the frame");
  m.frame();
  assert.deepEqual(frames, [{ x: 40, y: 20, z: 1 }], "ten moves, one frame with the latest view");
  assert.equal(commits.length, 0, "no React render while panning");
  vp.commit();
  vp.commit();
  assert.deepEqual(commits, [{ x: 40, y: 20, z: 1 }], "the gesture's end commits once");
  vp.set({ x: 40, y: 20, z: 1 }, { commit: true });
  assert.equal(commits.length, 1, "an unchanged view is not news");
  // Wheel streams: commit after a quiet moment.
  vp.update((v) => ({ ...v, x: v.x + 5 }));
  vp.commitSoon();
  vp.update((v) => ({ ...v, x: v.x + 5 }));
  vp.commitSoon();
  m.fire();
  assert.deepEqual(commits.at(-1), { x: 50, y: 20, z: 1 });
  assert.equal(commits.length, 2);
  // Nonsense never gets in.
  vp.set({ x: NaN, y: 0, z: 1 });
  vp.set({ x: 0, y: 0, z: 0 });
  assert.deepEqual(vp.get(), { x: 50, y: 20, z: 1 });
  vp.dispose();
  vp.set({ x: 1, y: 1, z: 1 }, { commit: true });
  m.frame();
  assert.equal(commits.length, 2, "disposed: no listeners");
});

test("the render window holds the screen plus a screen of margin, and covers small pans", () => {
  const size = { w: 1000, h: 600 };
  const v = { x: -300, y: -200, z: 0.5 };
  const w = renderWindow(v, size);
  assert.ok(covers(w, v, size));
  assert.ok(covers(w, { ...v, x: v.x - 400 }, size), "a 400 px pan stays inside");
  assert.ok(!covers(w, { ...v, x: v.x - 4000 }, size), "a long pan leaves it");
  assert.ok(covers(renderWindow({ ...v, x: v.x - 4000 }, size), { ...v, x: v.x - 4000 }, size));
});

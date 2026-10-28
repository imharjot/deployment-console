// The console's dropdown (src/components/select.tsx): which option the keys move to, which one typing jumps to, and
// where the menu opens. Pure, so the arithmetic is tested without a browser.

// The next option that can be chosen from `from` in `dir`, or `from` when there is none. No wrapping, as native selects.
export function step(disabled: readonly boolean[], from: number, dir: 1 | -1, by = 1): number {
  let best = from;
  for (let i = from + dir, left = by; i >= 0 && i < disabled.length && left > 0; i += dir) {
    if (disabled[i]) continue;
    best = i;
    left--;
  }
  return best;
}

export const firstEnabled = (disabled: readonly boolean[]) => disabled.findIndex((d) => !d);
export function lastEnabled(disabled: readonly boolean[]): number {
  for (let i = disabled.length - 1; i >= 0; i--) if (!disabled[i]) return i;
  return -1;
}

// Typing jumps to the first option, after the active one, whose text starts with what was typed in the last moment.
// Pressing the same letter again cycles through the options starting with it, as native selects do. -1: none.
export function typeaheadMatch(texts: readonly string[], disabled: readonly boolean[], from: number, query: string): number {
  const q = query.toLowerCase();
  if (!q) return -1;
  const repeat = q.length > 1 && [...q].every((c) => c === q[0]);
  const needle = repeat ? q[0] : q;
  const start = q.length === 1 || repeat ? from + 1 : Math.max(from, 0);
  for (let k = 0; k < texts.length; k++) {
    const i = (((start + k) % texts.length) + texts.length) % texts.length;
    if (!disabled[i] && texts[i].toLowerCase().startsWith(needle)) return i;
  }
  return -1;
}

// Where the menu opens: under its trigger, or above it when there's more room there and too little below. As wide as
// the trigger at least, kept inside the window, and only as tall as the room it has (it scrolls past that).
export interface MenuPlace {
  left: number;
  top?: number;
  bottom?: number;
  minWidth: number;
  maxHeight: number;
  from: "top" | "bottom"; // the side it grows from (the transform origin)
}
export function placeMenu(r: { left: number; top: number; bottom: number; width: number }, view: { width: number; height: number }, rows: number, rowHeight = 36): MenuPlace {
  const gap = 4;
  const margin = 8;
  const want = Math.min(320, rows * rowHeight + 12);
  const below = view.height - r.bottom - gap - margin;
  const above = r.top - gap - margin;
  const up = below < Math.min(want, 180) && above > below;
  const minWidth = Math.min(Math.max(r.width, 160), view.width - 2 * margin);
  const left = Math.max(margin, Math.min(r.left, view.width - margin - minWidth));
  const maxHeight = Math.max(96, Math.min(320, up ? above : below));
  return up ? { left, bottom: view.height - r.top + gap, minWidth, maxHeight, from: "bottom" } : { left, top: r.bottom + gap, minWidth, maxHeight, from: "top" };
}

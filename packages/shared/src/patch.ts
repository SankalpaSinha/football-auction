/**
 * Small JSON patches for room snapshots. After the first full snapshot the
 * server only sends what changed (a new bid, a feed line, a goal) instead of
 * every squad again, which cuts a game's traffic by over 90%.
 *
 * Works on plain JSON data (what Socket.IO sends): `undefined` counts as missing.
 */

export type PatchPath = (string | number)[];
export type PatchOp =
  /** Set the value at the path (empty path = replace everything). */
  | { p: PatchPath; v: unknown }
  /** Delete the key at the path. */
  | { p: PatchPath; d: 1 }
  /** Array at the path: drop `s` items from the front, then append `a` (rolling feeds, growing lists). */
  | { p: PatchPath; a: unknown[]; s?: number };

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (isObj(a)) {
    if (!isObj(b)) return false;
    for (const k in a) if (a[k] !== undefined && !deepEqual(a[k], b[k])) return false;
    for (const k in b) if (b[k] !== undefined && a[k] === undefined) return false;
    return true;
  }
  return false;
}

/** Longest shift tried when looking for a rolling window (e.g. the last N feed lines). */
const MAX_SHIFT = 24;

/** Operations that turn `a` into `b`. Keys in `ignore` are skipped at the top level. */
export function diff(a: unknown, b: unknown, ignore: readonly string[] = []): PatchOp[] {
  const ops: PatchOp[] = [];
  walk(a, b, [], ops, ignore);
  return ops;
}

function walk(a: unknown, b: unknown, path: PatchPath, ops: PatchOp[], ignore: readonly string[]) {
  if (a === b) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length === 0) {
      if (b.length) ops.push({ p: path, v: b });
      return;
    }
    // Shift + append: covers growing lists (s = 0) and rolling windows (s > 0).
    for (let s = 0; s < Math.min(a.length, MAX_SHIFT + 1); s++) {
      const kept = a.length - s;
      if (kept > b.length) continue;
      let same = true;
      for (let i = 0; i < kept && same; i++) same = deepEqual(a[s + i], b[i]);
      if (!same) continue;
      if (s > 0 || b.length > kept) ops.push(s ? { p: path, a: b.slice(kept), s } : { p: path, a: b.slice(kept) });
      return;
    }
    if (a.length === b.length) {
      for (let i = 0; i < a.length; i++) walk(a[i], b[i], [...path, i], ops, []);
      return;
    }
    ops.push({ p: path, v: b });
    return;
  }
  if (isObj(a) && isObj(b)) {
    for (const k in b) {
      if (path.length === 0 && ignore.includes(k)) continue;
      const bv = b[k];
      if (bv === undefined) continue;
      if (a[k] === undefined) ops.push({ p: [...path, k], v: bv });
      else walk(a[k], bv, [...path, k], ops, []);
    }
    for (const k in a) {
      if (path.length === 0 && ignore.includes(k)) continue;
      if (a[k] !== undefined && b[k] === undefined) ops.push({ p: [...path, k], d: 1 });
    }
    return;
  }
  if (!deepEqual(a, b)) ops.push({ p: path, v: b });
}

/** Apply `ops` to `root` without mutating it (changed branches are copied, the rest is shared). */
export function applyPatch<T>(root: T, ops: readonly PatchOp[]): T {
  const fresh = new WeakSet<object>();
  const copy = (x: unknown): Obj | unknown[] => {
    const c = Array.isArray(x) ? [...x] : { ...(x as Obj) };
    fresh.add(c);
    return c;
  };
  let out: unknown = root;
  for (const op of ops) {
    if (op.p.length === 0) {
      if ('v' in op) out = op.v;
      else if ('a' in op) out = [...(out as unknown[]).slice(op.s ?? 0), ...op.a];
      continue;
    }
    if (!fresh.has(out as object)) out = copy(out);
    let node = out as Obj;
    for (let i = 0; i < op.p.length - 1; i++) {
      const k = op.p[i] as string;
      let child = node[k];
      if (typeof child !== 'object' || child === null) throw new Error(`Bad patch path ${op.p.join('.')}`);
      if (!fresh.has(child)) node[k] = child = copy(child);
      node = child as Obj;
    }
    const last = op.p[op.p.length - 1] as string;
    if ('d' in op) delete node[last];
    else if ('a' in op) {
      const arr = node[last];
      if (!Array.isArray(arr)) throw new Error(`Bad patch path ${op.p.join('.')}`);
      const next = [...arr.slice(op.s ?? 0), ...op.a];
      fresh.add(next);
      node[last] = next;
    } else node[last] = op.v;
  }
  return out as T;
}

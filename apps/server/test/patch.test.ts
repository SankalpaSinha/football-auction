import { describe, expect, it } from 'vitest';
import { applyPatch, diff } from '@fa/shared';

const roundTrip = (a: unknown, b: unknown) => {
  const ops = diff(a, b);
  expect(JSON.parse(JSON.stringify(applyPatch(a, ops)))).toEqual(JSON.parse(JSON.stringify(b)));
  return ops;
};

describe('room patches', () => {
  it('sends only what changed', () => {
    const squad = Array.from({ length: 10 }, (_, i) => ({ player: { id: `p${i}`, stats: { pace: 80 } }, price: i }));
    const a = { phase: 'AUCTION', members: [{ id: 'u1', squad }], lot: { bid: 10, bidder: 'u1' } };
    const b = { phase: 'AUCTION', members: [{ id: 'u1', squad }], lot: { bid: 25, bidder: 'u2' } };
    expect(roundTrip(a, b)).toEqual([
      { p: ['lot', 'bid'], v: 25 },
      { p: ['lot', 'bidder'], v: 'u2' },
    ]);
  });

  it('appends to growing lists and rolls windows', () => {
    expect(roundTrip({ s: [1, 2] }, { s: [1, 2, 3] })).toEqual([{ p: ['s'], a: [3] }]);
    expect(roundTrip({ feed: ['a', 'b', 'c', 'd'] }, { feed: ['c', 'd', 'e', 'f'] })).toEqual([{ p: ['feed'], a: ['e', 'f'], s: 2 }]);
    roundTrip({ s: [1, 2, 3] }, { s: [3, 1] });
    roundTrip({ s: [] }, { s: [{ x: 1 }] });
    roundTrip({ s: [{ x: 1 }, { x: 2 }] }, { s: [{ x: 1 }, { x: 3 }] });
  });

  it('handles added, removed and undefined keys, and type changes', () => {
    roundTrip({ a: 1, b: { c: 2 } }, { a: 1, d: 4 });
    roundTrip({ a: null, b: undefined }, { a: { x: 1 }, b: 2 });
    roundTrip({ a: [1], b: 'x' }, { a: 'now a string', b: ['now', 'a', 'list'] });
    expect(diff({ a: 1, u: undefined }, { a: 1 })).toEqual([]);
  });

  it('ignores top-level keys that change every time', () => {
    expect(diff({ version: 1, serverTime: 5, x: 1 }, { version: 2, serverTime: 9, x: 1 }, ['version', 'serverTime'])).toEqual([]);
  });

  it('never mutates the original and shares untouched branches', () => {
    const a = { keep: { deep: [1, 2] }, change: { n: 1 } };
    const frozen = JSON.stringify(a);
    const out = applyPatch(a, diff(a, { keep: { deep: [1, 2] }, change: { n: 2 } }));
    expect(JSON.stringify(a)).toBe(frozen);
    expect(out.keep).toBe(a.keep);
    expect(out.change).not.toBe(a.change);
  });
});

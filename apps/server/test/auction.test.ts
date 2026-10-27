import { describe, expect, it } from 'vitest';
import { GameError } from '../src/engine/errors';
import { POSITION_GROUP } from '@fa/shared';
import { seededRandomOrder } from '../src/engine/ordering';
import { createHarness, freePickStep, makeCard, makePool, nextLot, skipAll } from './helpers';

const code = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof GameError) return e.code;
    throw e;
  }
  return 'OK';
};

describe('bidding', () => {
  it('accepts a valid bid and updates the lot', () => {
    const h = createHarness();
    const lot = h.lot();
    expect(lot.minNextBid).toBe(10);
    h.room.bid('u1', lot.lotNumber, 50);
    const after = h.lot();
    expect(after.currentBid).toBe(50);
    expect(after.highestBidderId).toBe('u1');
    expect(after.minNextBid).toBe(60);
    expect(h.events.some((e) => e.type === 'BID' && e.amount === 50)).toBe(true);
  });

  it('rejects bids below the minimum', () => {
    const h = createHarness();
    const n = h.lot().lotNumber;
    expect(code(() => h.room.bid('u1', n, 5))).toBe('BID_TOO_LOW');
    h.room.bid('u1', n, 100);
    expect(code(() => h.room.bid('u2', n, 105))).toBe('BID_TOO_LOW');
    expect(code(() => h.room.bid('u2', n, 110))).toBe('OK');
  });

  it('rejects bids above the budget', () => {
    const h = createHarness();
    expect(code(() => h.room.bid('u1', h.lot().lotNumber, 1001))).toBe('OVER_BUDGET');
  });

  it('keeps a reserve so a squad can always be completed', () => {
    const h = createHarness();
    const n = h.lot().lotNumber;
    // 18 empty slots, 1000 coins: must keep 17 × 10 back.
    expect(h.member('u1').maxBid).toBe(830);
    expect(code(() => h.room.bid('u1', n, 840))).toBe('RESERVE_REQUIRED');
    expect(code(() => h.room.bid('u1', n, 830))).toBe('OK');
  });

  it('rejects a bid from the current highest bidder', () => {
    const h = createHarness();
    const n = h.lot().lotNumber;
    h.room.bid('u1', n, 20);
    expect(code(() => h.room.bid('u1', n, 30))).toBe('ALREADY_HIGHEST');
  });

  it('rejects bids after the timer expires and for stale lots', () => {
    const h = createHarness();
    const n = h.lot().lotNumber;
    h.clock.advance(30_000);
    expect(code(() => h.room.bid('u1', n, 20))).toBe('NO_ACTIVE_LOT');
    nextLot(h);
    expect(h.lot().lotNumber).toBe(n + 1);
    expect(code(() => h.room.bid('u1', n, 20))).toBe('STALE_LOT');
  });

  it('rejects bids from non-members', () => {
    const h = createHarness();
    expect(code(() => h.room.bid('intruder', h.lot().lotNumber, 20))).toBe('NOT_IN_ROOM');
  });
});

describe('server timer and sale', () => {
  it('sells to the highest bidder when the server clock runs out', () => {
    const h = createHarness();
    const lot = h.lot();
    h.room.bid('u1', lot.lotNumber, 40);
    h.room.bid('u2', lot.lotNumber, 120);
    h.clock.advance(29_999);
    expect(h.room.phase).toBe('AUCTION');
    h.clock.advance(1);
    expect(h.room.phase).toBe('PLAYER_SOLD');
    const result = h.room.view().auction!.lastResult!;
    expect(result.outcome).toBe('SOLD');
    expect(result.winnerId).toBe('u2');
    expect(result.price).toBe(120);
    expect(h.member('u2').budget).toBe(880);
    expect(h.member('u2').squad.map((s) => s.player.id)).toEqual([lot.player.id]);
    expect(h.member('u1').budget).toBe(1000);
    nextLot(h);
    expect(h.room.phase).toBe('AUCTION');
    expect(h.lot().player.id).not.toBe(lot.player.id);
  });

  it('extends the clock for a last-second bid', () => {
    const h = createHarness();
    const lot = h.lot();
    h.clock.advance(28_000); // 2s left
    h.room.bid('u1', lot.lotNumber, 20);
    expect(h.lot().endsAt - h.clock.now()).toBe(5_000);
    expect(h.lot().extended).toBe(true);
    h.clock.advance(4_000);
    expect(h.room.phase).toBe('AUCTION');
    h.clock.advance(1_000);
    expect(h.room.phase).toBe('PLAYER_SOLD');
  });

  it('does not extend early bids or when anti-snipe is off', () => {
    const h = createHarness();
    const lot = h.lot();
    h.clock.advance(20_000);
    h.room.bid('u1', lot.lotNumber, 20);
    expect(h.lot().endsAt).toBe(lot.endsAt);

    const off = createHarness({ settings: { antiSnipe: false } });
    const l2 = off.lot();
    off.clock.advance(29_000);
    off.room.bid('u1', l2.lotNumber, 20);
    expect(off.lot().endsAt).toBe(l2.endsAt);
  });

  it('the highest bidder still wins if they disconnect before the hammer', () => {
    const h = createHarness({ players: 3 });
    const lot = h.lot();
    h.room.bid('u2', lot.lotNumber, 70);
    h.room.setConnected('u2', false);
    h.clock.advance(30_000);
    const r = h.room.view().auction!.lastResult!;
    expect(r.winnerId).toBe('u2');
    expect(h.member('u2').squad).toHaveLength(1);
    expect(h.member('u2').budget).toBe(930);
  });
});

describe('skip', () => {
  it('a skipping manager cannot bid on that player but the lot continues', () => {
    const h = createHarness({ players: 3 });
    const n = h.lot().lotNumber;
    h.room.skip('u1', n);
    expect(code(() => h.room.bid('u1', n, 20))).toBe('ALREADY_SKIPPED');
    expect(h.room.phase).toBe('AUCTION');
    expect(h.lot().skippedBy).toEqual(['u1']);
  });

  it('closes immediately (unsold) when every manager skips', () => {
    const h = createHarness({ players: 3 });
    const n = h.lot().lotNumber;
    h.room.skip('u1', n);
    h.room.skip('u2', n);
    h.room.skip('u3', n);
    expect(h.room.phase).toBe('PLAYER_SOLD');
    expect(h.room.view().auction!.lastResult!.outcome).toBe('UNSOLD');
  });

  it('sells immediately when everyone except the top bidder has skipped', () => {
    const h = createHarness({ players: 3 });
    const n = h.lot().lotNumber;
    h.room.bid('u3', n, 30);
    h.room.skip('u1', n);
    expect(h.room.phase).toBe('AUCTION');
    h.room.skip('u2', n);
    const r = h.room.view().auction!.lastResult!;
    expect(r.outcome).toBe('SOLD');
    expect(r.winnerId).toBe('u3');
  });

  it('treats disconnected managers as passing', () => {
    const h = createHarness({ players: 3 });
    const n = h.lot().lotNumber;
    h.room.setConnected('u3', false);
    h.room.skip('u1', n);
    h.room.skip('u2', n);
    expect(h.room.phase).toBe('PLAYER_SOLD');
  });
});

describe('squads', () => {
  /** Drive a whole auction: on each lot a rotating manager bids the opening price, others skip. */
  function playOut(h: ReturnType<typeof createHarness>, opts: { avoidGk?: string[] } = {}) {
    let turn = 0;
    for (let guard = 0; guard < 2000 && h.room.phase !== 'SQUAD_BUILDING'; guard++) {
      if (freePickStep(h)) continue;
      if (h.room.phase === 'PLAYER_SOLD') {
        nextLot(h);
        continue;
      }
      const lot = h.lot();
      const buyer = h.users[turn++ % h.users.length];
      const avoid = lot.player.position === 'GK' && opts.avoidGk?.includes(buyer.id);
      if (!avoid) {
        try {
          h.room.bid(buyer.id, lot.lotNumber, lot.minNextBid);
        } catch {
          /* full / not allowed — others decide */
        }
      }
      if (h.room.view().auction?.lot?.lotNumber === lot.lotNumber) skipAll(h, []);
    }
    expect(h.room.phase).toBe('SQUAD_BUILDING');
  }

  it('every manager ends with exactly 18 players, no duplicates, at least one GK', () => {
    const h = createHarness({ players: 4 });
    playOut(h);
    const ids = new Set<string>();
    for (const m of h.room.view().members) {
      expect(m.squad).toHaveLength(18);
      expect(m.squad.some((s) => s.player.position === 'GK')).toBe(true);
      expect(m.budget).toBeGreaterThanOrEqual(0);
      for (const s of m.squad) {
        expect(ids.has(s.player.id)).toBe(false);
        ids.add(s.player.id);
      }
    }
  });

  it('a full squad cannot bid', () => {
    const h = createHarness({ players: 2 });
    // u1 buys 18 players
    while (h.member('u1').squad.length < 18) {
      if (h.room.phase === 'PLAYER_SOLD') nextLot(h);
      const lot = h.lot();
      h.room.bid('u1', lot.lotNumber, lot.minNextBid);
      if (h.room.phase === 'AUCTION') h.room.skip('u2', lot.lotNumber);
    }
    nextLot(h);
    // u1 is full, so u2 is the only one left: free pick, and u1 can't take players.
    expect(h.room.view().auction!.freePick!.userId).toBe('u2');
    const someone = h.room.pickPool('u1')[0];
    expect(code(() => h.room.pick('u1', someone.id))).toBe('NOT_YOUR_PICK');
  });

  it('free pick: the last manager chooses players at the opening price', () => {
    const h = createHarness({ players: 2 });
    while (h.member('u1').squad.length < 18) {
      if (h.room.phase === 'PLAYER_SOLD') nextLot(h);
      const lot = h.lot();
      h.room.bid('u1', lot.lotNumber, lot.minNextBid);
      if (h.room.phase === 'AUCTION') h.room.skip('u2', lot.lotNumber);
    }
    nextLot(h);
    const fp = h.room.view().auction!.freePick!;
    expect(fp).toMatchObject({ userId: 'u2', picksLeft: 18 });
    expect(h.room.view().auction!.lot).toBeNull();
    const pool = h.room.pickPool('u2');
    expect(pool[0].overall).toBeGreaterThanOrEqual(pool[pool.length - 1].overall); // best first
    const star = pool[0];
    h.room.pick('u2', star.id);
    const u2 = h.member('u2');
    expect(u2.squad.map((e) => e.player.id)).toEqual([star.id]);
    expect(u2.squad[0]).toMatchObject({ price: 10, via: 'PICK' });
    expect(u2.budget).toBe(990);
    expect(code(() => h.room.pick('u2', star.id))).toBe('PLAYER_UNAVAILABLE');
    expect(code(() => h.room.pick('u2', h.member('u1').squad[0].player.id))).toBe('PLAYER_UNAVAILABLE');
    // Finish: picks continue until 18, then the auction completes.
    while (h.room.phase !== 'SQUAD_BUILDING') freePickStep(h);
    expect(h.member('u2').squad).toHaveLength(18);
    expect(h.member('u2').squad.some((e) => e.player.position === 'GK')).toBe(true);
  });

  it('free pick: running out of time picks the best player in a position you need', () => {
    const h = createHarness({ players: 2 });
    while (h.member('u1').squad.length < 18) {
      if (h.room.phase === 'PLAYER_SOLD') nextLot(h);
      const lot = h.lot();
      h.room.bid('u1', lot.lotNumber, lot.minNextBid);
      if (h.room.phase === 'AUCTION') h.room.skip('u2', lot.lotNumber);
    }
    nextLot(h);
    const pool = h.room.pickPool('u2');
    h.clock.advance(h.room.view().auction!.freePick!.endsAt - h.clock.now());
    const picked = h.member('u2').squad[0].player;
    // An empty 18-man squad needs defenders most: the best one available is taken.
    expect(POSITION_GROUP[picked.position]).toBe('DEF');
    expect(picked.id).toBe(pool.find((p) => POSITION_GROUP[p.position] === 'DEF')!.id);
    expect(h.room.view().auction!.freePick!.picksLeft).toBe(17);
  });

  it('forces the last open slot to be a goalkeeper', () => {
    const pool = [...makePool(60, 0), ...[0, 1, 2].map((i) => makeCard(`gk${i}`, 'GK'))];
    const h = createHarness({ players: 2, pool });
    // u1 buys outfielders only until one slot is left
    let blocked = false;
    for (let guard = 0; guard < 500 && !blocked; guard++) {
      if (h.room.phase === 'PLAYER_SOLD') {
        nextLot(h);
        continue;
      }
      const lot = h.lot();
      if (lot.player.position !== 'GK' && h.member('u1').squad.length === 17) {
        expect(code(() => h.room.bid('u1', lot.lotNumber, lot.minNextBid))).toBe('NEED_GOALKEEPER');
        blocked = true;
        break;
      }
      if (lot.player.position !== 'GK') h.room.bid('u1', lot.lotNumber, lot.minNextBid);
      if (h.room.view().auction?.lot?.lotNumber === lot.lotNumber) skipAll(h);
    }
    expect(blocked || h.member('u1').squad.some((s) => s.player.position === 'GK')).toBe(true);
  });

  it('managers who never buy a keeper still finish with one', () => {
    const h = createHarness({ players: 3 });
    playOut(h, { avoidGk: ['u1', 'u2', 'u3'] });
    for (const m of h.room.view().members) {
      expect(m.squad.filter((s) => s.player.position === 'GK').length).toBeGreaterThanOrEqual(1);
    }
  });

  it('refuses an extra keeper if it would leave someone without one', () => {
    const pool = [...makePool(60, 0), makeCard('gkA', 'GK'), makeCard('gkB', 'GK')];
    const h = createHarness({ players: 2, pool, rules: { gkUrgencySlots: 0 } });
    let gkBought = 0;
    for (let guard = 0; guard < 300; guard++) {
      if (h.room.phase === 'PLAYER_SOLD') {
        nextLot(h);
        continue;
      }
      const lot = h.lot();
      if (lot.player.position === 'GK') {
        if (gkBought === 0) {
          h.room.bid('u1', lot.lotNumber, 10);
          gkBought++;
          skipAll(h);
          continue;
        }
        expect(code(() => h.room.bid('u1', lot.lotNumber, 10))).toBe('GOALKEEPER_LIMIT');
        expect(code(() => h.room.bid('u2', lot.lotNumber, 10))).toBe('OK');
        return;
      }
      skipAll(h);
    }
    throw new Error('second keeper never came up');
  });

  it('unsold players are re-offered before auto-fill', () => {
    const h = createHarness({ players: 2, pool: makePool(38, 4) });
    const seen = new Map<string, number>();
    for (let guard = 0; guard < 500 && h.room.phase !== 'SQUAD_BUILDING'; guard++) {
      if (h.room.phase === 'PLAYER_SOLD') {
        nextLot(h);
        continue;
      }
      const lot = h.lot();
      seen.set(lot.player.id, (seen.get(lot.player.id) ?? 0) + 1);
      skipAll(h);
    }
    expect(h.room.phase).toBe('SQUAD_BUILDING');
    expect(Math.max(...seen.values())).toBe(2);
    for (const m of h.room.view().members) {
      expect(m.squad).toHaveLength(18);
      expect(m.squad.every((s) => s.via === 'AUTO')).toBe(true);
      expect(m.squad.some((s) => s.player.position === 'GK')).toBe(true);
    }
  });
});

describe('ordering', () => {
  it('the same seed always gives the same order', () => {
    const pool = makePool(50, 5);
    const a = seededRandomOrder.order(pool, 'abc').map((p) => p.id);
    const b = seededRandomOrder.order([...pool].reverse(), 'abc').map((p) => p.id);
    const c = seededRandomOrder.order(pool, 'xyz').map((p) => p.id);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(new Set(a).size).toBe(50);
  });
});

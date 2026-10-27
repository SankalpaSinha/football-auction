import { describe, expect, it } from 'vitest';
import { ALL_TWISTS, NO_TWISTS, autoPick, makeRules, scoreSquad, type Twists } from '@fa/shared';
import { Auction, type Participant } from '../src/engine/auction';
import { ManualClock } from '../src/engine/clock';
import { GameError } from '../src/engine/errors';
import { completeAuction, createHarness, makeCard, makePool, nextLot, testRules, toResults } from './helpers';

const code = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof GameError) return e.code;
    throw e;
  }
  return 'OK';
};

const twists = (o: Partial<Twists>): Twists => ({ ...NO_TWISTS, ...o });
const auction = (h: ReturnType<typeof createHarness>) => h.room.view().auction!;

describe('mystery lots', () => {
  it('hide the player until the hammer falls, then reveal who it was', () => {
    const h = createHarness({ players: 2, settings: { twists: twists({ mystery: true }) }, rules: { mysteryEvery: 2 } });
    expect(h.lot().kind).toBe('NORMAL');
    h.room.bid('u1', h.lot().lotNumber, 10);
    h.room.skip('u2', h.lot().lotNumber);
    nextLot(h);
    const lot = h.lot();
    expect(lot.kind).toBe('MYSTERY');
    expect(lot.player.id).toBe(`mystery-${lot.lotNumber}`);
    expect(lot.player.name).toBe('Mystery Player');
    expect(lot.player.overall).toBe(0);
    expect(lot.player.outfield).toBeNull();
    // Nothing in any view gives the real player away.
    const real = JSON.stringify(h.room.view('u1'));
    h.room.bid('u2', lot.lotNumber, 10);
    h.room.skip('u1', lot.lotNumber);
    const result = auction(h).lastResult!;
    expect(result.kind).toBe('MYSTERY');
    expect(result.player.id).not.toContain('mystery');
    expect(real).not.toContain(result.player.id);
    expect(h.member('u2').squad.map((e) => e.player.id)).toContain(result.player.id);
  });

  it('are never star players', () => {
    const pool = makePool(120, 16).map((p, i) => (i % 2 ? { ...p, star: true } : p));
    const h = createHarness({ players: 2, pool, settings: { twists: twists({ mystery: true }) }, rules: { mysteryEvery: 1, starCap: { max: 9 } } });
    for (let i = 0; i < 6; i++) {
      const lot = h.lot();
      if (lot.kind === 'MYSTERY') expect(lot.player.id).toContain('mystery');
      else expect(pool.find((p) => p.id === lot.player.id)!.star).toBe(true);
      h.room.skip('u1', lot.lotNumber);
      h.room.skip('u2', lot.lotNumber);
      nextLot(h);
    }
  });
});

describe('sealed bids', () => {
  const sealedRoom = (players = 3) =>
    createHarness({ players, settings: { twists: twists({ sealed: true }) }, rules: { sealedEvery: 2 } });

  it('one secret bid each; the highest wins and pays their own bid', () => {
    const h = sealedRoom();
    const lot = h.lot();
    expect(lot.kind).toBe('SEALED');
    expect(code(() => h.room.bid('u1', lot.lotNumber, 50))).toBe('SEALED_LOT');
    h.room.sealedBid('u1', lot.lotNumber, 40);
    expect(code(() => h.room.sealedBid('u1', lot.lotNumber, 90))).toBe('ALREADY_DECIDED');
    h.room.sealedBid('u2', lot.lotNumber, 75);
    // Who has decided is public, amounts are not — except your own.
    const v2 = h.room.view('u2').auction!.lot!;
    expect(v2.sealed).toEqual({ decided: ['u1', 'u2'], mine: 75 });
    expect(h.room.view('u3').auction!.lot!.sealed!.mine).toBeNull();
    expect(v2.currentBid).toBeNull();
    h.room.skip('u3', lot.lotNumber); // a pass
    const r = auction(h).lastResult!;
    expect(r.winnerId).toBe('u2');
    expect(r.price).toBe(75);
    expect(r.sealedBids).toEqual([
      { userId: 'u2', amount: 75 },
      { userId: 'u1', amount: 40 },
    ]);
    expect(h.member('u2').budget).toBe(925);
  });

  it('a tie goes to whoever bid first; nobody bidding leaves the player unsold', () => {
    const h = sealedRoom(2);
    let lot = h.lot();
    h.room.sealedBid('u2', lot.lotNumber, 30);
    h.clock.advance(1000);
    h.room.sealedBid('u1', lot.lotNumber, 30);
    expect(auction(h).lastResult!.winnerId).toBe('u2');
    nextLot(h);
    h.room.bid('u1', h.lot().lotNumber, 10);
    h.room.skip('u2', h.lot().lotNumber);
    nextLot(h);
    lot = h.lot();
    expect(lot.kind).toBe('SEALED');
    h.room.sealedBid('u1', lot.lotNumber, null);
    h.room.sealedBid('u2', lot.lotNumber, null);
    expect(auction(h).lastResult!.outcome).toBe('UNSOLD');
  });

  it('closes when the clock runs out, with whatever bids are in', () => {
    const h = sealedRoom();
    const lot = h.lot();
    h.room.sealedBid('u3', lot.lotNumber, 20);
    h.clock.advance(lot.endsAt - h.clock.now());
    expect(auction(h).lastResult!.winnerId).toBe('u3');
  });
});

describe('power cards', () => {
  const cardRoom = (players = 3) => createHarness({ players, settings: { twists: twists({ cards: true }) } });

  it('everyone starts with one Freeze, one Steal and one Refund', () => {
    const h = cardRoom();
    expect(auction(h).cards).toEqual({ u1: ['FREEZE', 'STEAL', 'REFUND'], u2: ['FREEZE', 'STEAL', 'REFUND'], u3: ['FREEZE', 'STEAL', 'REFUND'] });
  });

  it('Freeze: the target can’t bid on this player; the card is gone after one use', () => {
    const h = cardRoom();
    const lot = h.lot();
    expect(code(() => h.room.freeze('u1', lot.lotNumber, 'u1'))).toBe('BAD_TARGET');
    h.room.freeze('u1', lot.lotNumber, 'u2');
    expect(h.lot().frozen).toEqual(['u2']);
    expect(code(() => h.room.bid('u2', lot.lotNumber, 10))).toBe('FROZEN');
    expect(code(() => h.room.freeze('u1', lot.lotNumber, 'u3'))).toBe('NO_CARD');
    expect(auction(h).cards.u1).toEqual(['STEAL', 'REFUND']);
    // With u2 frozen, the lot only waits for u1 and u3.
    h.room.bid('u1', lot.lotNumber, 10);
    h.room.skip('u3', lot.lotNumber);
    expect(auction(h).lastResult!.winnerId).toBe('u1');
    // A frozen manager isn't counted as idle.
    expect(auction(h).idleLots.u2).toBeUndefined();
  });

  it('Steal: within the window, match the price and take the player; the buyer gets their coins back', () => {
    const h = cardRoom();
    const lot = h.lot();
    h.room.bid('u1', lot.lotNumber, 60);
    h.room.skip('u2', lot.lotNumber);
    h.room.skip('u3', lot.lotNumber);
    const r = auction(h).lastResult!;
    expect(r.stealUntil).toBe(h.clock.now() + testRules().stealWindowMs);
    expect(code(() => h.room.steal('u1', lot.lotNumber))).toBe('CANT_STEAL');
    h.room.steal('u2', lot.lotNumber);
    expect(h.member('u1').squad).toHaveLength(0);
    expect(h.member('u1').budget).toBe(1000);
    expect(h.member('u2').squad.map((e) => e.player.id)).toEqual([r.player.id]);
    expect(h.member('u2').budget).toBe(940);
    const after = auction(h).lastResult!;
    expect(after.winnerId).toBe('u2');
    expect(after.stolenFrom).toBe('u1');
    expect(after.stealUntil).toBeNull();
    expect(code(() => h.room.steal('u3', lot.lotNumber))).toBe('STEAL_CLOSED');
    expect(h.events.some((e) => e.type === 'STOLEN' && e.byId === 'u2' && e.fromId === 'u1')).toBe(true);
  });

  it('Steal: too late once the window has closed', () => {
    const h = cardRoom(2);
    const lot = h.lot();
    h.room.bid('u1', lot.lotNumber, 30);
    h.room.skip('u2', lot.lotNumber);
    h.clock.advance(testRules().stealWindowMs + 1);
    expect(code(() => h.room.steal('u2', lot.lotNumber))).toBe('STEAL_CLOSED');
  });

  it('Refund: release a player and get half the price back, once', () => {
    const h = cardRoom(2);
    const lot = h.lot();
    h.room.bid('u1', lot.lotNumber, 81);
    h.room.skip('u2', lot.lotNumber);
    const id = auction(h).lastResult!.player.id;
    h.room.refund('u1', id);
    expect(h.member('u1').squad).toHaveLength(0);
    expect(h.member('u1').budget).toBe(1000 - 81 + 40);
    expect(auction(h).cards.u1).toEqual(['FREEZE', 'STEAL']);
    expect(code(() => h.room.refund('u1', id))).toBe('NO_CARD');
  });

  it('no cards when the twist is off', () => {
    const h = createHarness({ players: 2 });
    expect(auction(h).cards).toEqual({});
    expect(code(() => h.room.freeze('u1', h.lot().lotNumber, 'u2'))).toBe('NO_CARD');
  });
});

describe('market events', () => {
  /** A bare auction with a scripted random source (picks which event comes up). */
  const bare = (pickIndex: number, players = 2) => {
    const clock = new ManualClock();
    const rules = makeRules({ marketEvery: 2, marketLots: 2, soldRevealMs: 100, unsoldRevealMs: 100 });
    const participants: Participant[] = Array.from({ length: players }, (_, i) => ({
      userId: `u${i + 1}`,
      username: `user${i + 1}`,
      startingBudget: 1000,
      budget: 1000,
      squad: [],
    }));
    const a = new Auction({
      order: makePool(120, 16),
      participants,
      rules,
      lotDurationMs: 30_000,
      antiSnipe: false,
      clock,
      isConnected: () => true,
      twists: { ...NO_TWISTS, events: true },
      rand: () => pickIndex / 4 + 0.01,
      hooks: { onChange() {}, onEvent() {}, onFeed() {}, onLotClosed() {}, onComplete() {} },
    });
    a.start();
    const lot = () => a.view().lot!;
    const sell = (to: string, amount: number) => {
      const n = lot().lotNumber;
      a.bid(to, n, amount);
      for (const p of participants) if (p.userId !== to) a.skip(p.userId, n);
      clock.advance(a.view().lastResult!.nextAt - clock.now());
    };
    return { a, clock, lot, sell, participants };
  };

  it('deadline day: the winning bid costs +20%', () => {
    const { a, lot, sell, participants } = bare(0);
    sell('u1', 10); // lot 1 — normal
    expect(a.view().market?.id).toBe('DEADLINE_DAY');
    expect(lot().surcharge).toBe(1.2);
    sell('u2', 100);
    expect(participants[1].budget).toBe(880);
    expect(participants[1].squad[0].price).toBe(120);
  });

  it('bargain hour: bidding opens at 1 coin', () => {
    const { a, lot, sell } = bare(1);
    sell('u1', 10);
    expect(a.view().market?.id).toBe('BARGAIN_HOUR');
    expect(lot().minNextBid).toBe(1);
  });

  it('quick-fire: half the time on the clock', () => {
    const { a, lot, sell, clock } = bare(2);
    sell('u1', 10);
    expect(a.view().market?.id).toBe('QUICK_FIRE');
    expect(lot().endsAt - clock.now()).toBe(15_000);
  });

  it('sponsor money: every manager gets a bonus', () => {
    const { a, sell, participants } = bare(3);
    sell('u1', 10);
    expect(a.view().market?.id).toBe('SPONSOR');
    expect(participants[0].budget).toBe(1000 - 10 + 50);
    expect(participants[1].budget).toBe(1050);
  });

  it('events end after their lots and come back later', () => {
    const { a, sell } = bare(2);
    sell('u1', 10);
    expect(a.view().market?.lotsLeft).toBe(2);
    sell('u2', 10);
    expect(a.view().market?.lotsLeft).toBe(1);
    sell('u1', 10);
    expect(a.view().market).toBeNull();
    sell('u2', 10);
    sell('u1', 10);
    expect(a.view().market?.id).toBe('QUICK_FIRE');
  });
});

describe('Budget Cap format', () => {
  it('everyone has 50 coins and no player costs more than 5', () => {
    const h = createHarness({ players: 2, settings: { format: 'BUDGET', startingBudget: 50 } });
    const v = h.room.view();
    expect(v.rules).toMatchObject({ openingBid: 1, minIncrement: 1, maxPrice: 5 });
    const lot = h.lot();
    expect(lot.minNextBid).toBe(1);
    expect(code(() => h.room.bid('u1', lot.lotNumber, 6))).toBe('PRICE_CAP');
    h.room.bid('u1', lot.lotNumber, 5);
    // Nobody can go higher: the lot closes at once.
    expect(auction(h).lastResult!.price).toBe(5);
    expect(h.member('u1').maxBid).toBe(5);
    completeAuction(h);
    for (const m of h.room.view().members) {
      expect(m.squad).toHaveLength(18);
      expect(m.squad.every((e) => e.price <= 5)).toBe(true);
      expect(m.squad.every((e) => e.estimatedValue >= 1 && e.estimatedValue <= 5)).toBe(true);
    }
  });
});

describe('Blitz format', () => {
  it('11-man squads, and the scores don’t punish having no bench', () => {
    const h = createHarness({ players: 2, settings: { format: 'BLITZ', lotDurationSec: 10 } });
    expect(h.room.view().rules.squadSize).toBe(11);
    completeAuction(h);
    expect(h.member('u1').squad).toHaveLength(11);
    toResults(h);
    for (const r of h.room.view().results!.rankings) expect(r.breakdown.depth).toBe(50);
    // A sensibly shaped 11 isn't marked down for being "thin" the way it would be in an 18-man game.
    const roles = ['GK', 'LB', 'CB', 'CB', 'RB', 'CM', 'CM', 'CM', 'LW', 'ST', 'RW'] as const;
    const squad = roles.map((r, i) => ({ player: makeCard(`b${i}`, r, 80), price: 50, via: 'AUCTION' as const, lotNumber: i + 1, estimatedValue: 60 }));
    const lineup = { formationId: '4-3-3', slots: autoPick(squad.map((e) => e.player), '4-3-3') };
    const blitz = scoreSquad(squad, lineup, { squadSize: 11 });
    const classic = scoreSquad(squad, lineup);
    expect(blitz.breakdown.balance).toBe(100);
    expect(classic.breakdown.balance).toBeLessThan(100);
    expect(blitz.notes.some((n) => n.text.startsWith('Thin squad'))).toBe(false);
  });
});

describe('snake draft format', () => {
  const draftRoom = (players = 3) => createHarness({ players, settings: { format: 'DRAFT', twists: { ...ALL_TWISTS }, lotDurationSec: 30 } });

  it('takes turns in snake order, players cost nothing, and there are no twists', () => {
    const h = draftRoom();
    const order: string[] = [];
    for (let i = 0; i < 6; i++) {
      const d = auction(h).draft!;
      expect(d.pick).toBe(i + 1);
      order.push(d.userId);
      const first = h.room.pickPool(d.userId).find((p) => {
        try {
          h.room.pick(d.userId, p.id);
          return true;
        } catch {
          return false;
        }
      });
      expect(first).toBeDefined();
    }
    expect(order.slice(3)).toEqual(order.slice(0, 3).reverse());
    expect(new Set(order.slice(0, 3)).size).toBe(3);
    for (const id of ['u1', 'u2', 'u3']) {
      expect(h.member(id).squad).toHaveLength(2);
      expect(h.member(id).squad.every((e) => e.price === 0)).toBe(true);
      expect(h.member(id).budget).toBe(1000);
    }
    expect(auction(h).cards).toEqual({});
    expect(auction(h).lot).toBeNull();
    // Only the picker can pick.
    const d = auction(h).draft!;
    const other = ['u1', 'u2', 'u3'].find((x) => x !== d.userId)!;
    expect(code(() => h.room.pick(other, h.room.pickPool(other)[0].id))).toBe('NOT_YOUR_PICK');
  });

  it('runs out the clock with an automatic pick, and an offline picker only gets a few seconds', () => {
    const h = draftRoom(2);
    const d = auction(h).draft!;
    h.clock.advance(d.endsAt - h.clock.now());
    expect(h.member(d.userId).squad).toHaveLength(1);
    const next = auction(h).draft!;
    h.room.setConnected(next.userId, false);
    expect(auction(h).draft!.endsAt - h.clock.now()).toBe(testRules().draftOfflinePickMs);
    h.clock.advance(testRules().draftOfflinePickMs);
    expect(h.member(next.userId).squad).toHaveLength(1);
  });

  it('a whole draft fills every squad, then goes on to the squad builder and the cup', () => {
    const h = draftRoom(2);
    for (let guard = 0; guard < 200 && h.room.phase === 'AUCTION'; guard++) h.clock.advance(auction(h).draft!.endsAt - h.clock.now());
    expect(h.room.phase).toBe('SQUAD_BUILDING');
    for (const m of h.room.view().members) {
      expect(m.squad).toHaveLength(18);
      expect(m.squad.some((e) => e.player.position === 'GK')).toBe(true);
    }
    // Spending objectives make no sense in a draft.
    for (const id of ['u1', 'u2']) expect(h.room.view(id).myObjectives!.some((o) => o === 'FRUGAL' || o === 'BARGAINS')).toBe(false);
    toResults(h);
  });
});

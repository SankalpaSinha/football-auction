import { describe, expect, it } from 'vitest';
import { GameError } from '../src/engine/errors';
import { createHarness, nextLot } from './helpers';

type H = ReturnType<typeof createHarness>;
const code = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof GameError) return e.code;
    throw e;
  }
  return 'OK';
};

/** `buyer` wins the open lot for `price`; returns the player's id. */
function buy(h: H, buyer: string, price = 10) {
  const lot = h.lot();
  h.room.bid(buyer, lot.lotNumber, price);
  for (const u of h.users) {
    if (u.id === buyer || h.room.phase !== 'AUCTION') continue;
    h.room.skip(u.id, lot.lotNumber);
  }
  nextLot(h);
  return lot.player.id;
}

const squadIds = (h: H, id: string) => h.member(id).squad.map((e) => e.player.id);

describe('releasing a player', () => {
  it('frees the slot, keeps no refund and puts the player back up for auction', () => {
    const h = createHarness();
    const id = buy(h, 'u1', 120);
    expect(h.member('u1').budget).toBe(880);
    const queued = h.room.view().auction!.remainingInQueue;
    h.room.release('u1', id);
    expect(squadIds(h, 'u1')).toEqual([]);
    expect(h.member('u1').budget).toBe(880);
    expect(h.room.view().auction!.remainingInQueue).toBe(queued + 1);
    expect(h.events.some((e) => e.type === 'RELEASED' && e.playerId === id)).toBe(true);
    expect(code(() => h.room.release('u1', id))).toBe('NOT_YOUR_PLAYER');
    expect(code(() => h.room.release('u2', squadIds(h, 'u2')[0] ?? 'x'))).toBe('NOT_YOUR_PLAYER');
  });

  it('is refused if you could no longer afford to fill the slot', () => {
    const h = createHarness({ settings: { startingBudget: 500 } });
    // Spend down to exactly the reserve, then try to release.
    const first = buy(h, 'u1', h.member('u1').maxBid!);
    expect(h.member('u1').budget).toBe(170);
    expect(code(() => h.room.release('u1', first))).toBe('CANT_REFILL');
  });

  it('the top bidder cannot release their way below the bid they hold', () => {
    const h = createHarness({ settings: { startingBudget: 500 } });
    const id = buy(h, 'u1', 300);
    const n = h.lot().lotNumber;
    h.room.bid('u1', n, h.member('u1').maxBid!);
    expect(code(() => h.room.release('u1', id))).toBe('TRADE_INVALID');
  });
});

describe('trades', () => {
  function twoSquads() {
    const h = createHarness();
    const a = buy(h, 'u1', 100);
    const b = buy(h, 'u2', 60);
    return { h, a, b };
  }

  it('swaps players and coins once the other manager accepts', () => {
    const { h, a, b } = twoSquads();
    h.room.proposeTrade('u1', { toId: 'u2', give: [a], take: [b], coins: 30 });
    const offer = h.room.view('u2').trades[0];
    expect(offer).toMatchObject({ fromId: 'u1', toId: 'u2', give: [a], take: [b], coins: 30 });
    // Only the two managers involved see it.
    expect(h.room.view('u3').trades).toEqual([]);
    expect(h.room.view().trades).toEqual([]);

    h.room.respondTrade('u2', offer.id, true);
    expect(squadIds(h, 'u1')).toEqual([b]);
    expect(squadIds(h, 'u2')).toEqual([a]);
    expect(h.member('u1').budget).toBe(900 - 30);
    expect(h.member('u2').budget).toBe(940 + 30);
    // The price each side now carries is what it gave up.
    expect(h.member('u1').squad[0]).toMatchObject({ via: 'TRADE', price: 130 });
    expect(h.member('u2').squad[0]).toMatchObject({ via: 'TRADE', price: 30 });
    expect(h.room.view('u1').trades).toEqual([]);
    expect(h.events.some((e) => e.type === 'TRADED')).toBe(true);
  });

  it('sells a player for coins', () => {
    const { h, a } = twoSquads();
    h.room.proposeTrade('u1', { toId: 'u2', give: [a], take: [], coins: -150 });
    h.room.respondTrade('u2', h.room.view('u2').trades[0].id, true);
    expect(h.member('u1').budget).toBe(900 + 150);
    expect(h.member('u2').budget).toBe(940 - 150);
    expect(h.member('u2').squad.find((e) => e.player.id === a)).toMatchObject({ price: 150, via: 'TRADE' });
  });

  it('can be declined or cancelled, and expires', () => {
    const { h, a, b } = twoSquads();
    h.room.proposeTrade('u1', { toId: 'u2', give: [a], take: [b], coins: 0 });
    expect(code(() => h.room.proposeTrade('u1', { toId: 'u2', give: [a], take: [], coins: 0 }))).toBe('TRADE_PENDING');
    const id = h.room.view('u1').trades[0].id;
    expect(code(() => h.room.respondTrade('u1', id, true))).toBe('TRADE_NOT_FOUND');
    h.room.respondTrade('u2', id, false);
    expect(h.events.some((e) => e.type === 'TRADE_DECLINED')).toBe(true);
    expect(squadIds(h, 'u1')).toEqual([a]);

    h.room.proposeTrade('u1', { toId: 'u2', give: [a], take: [b], coins: 0 });
    h.room.cancelTrade('u1', h.room.view('u1').trades[0].id);
    expect(h.room.view('u2').trades).toEqual([]);

    h.room.proposeTrade('u1', { toId: 'u2', give: [a], take: [b], coins: 0 });
    h.clock.advance(90_000);
    expect(h.room.view('u2').trades).toEqual([]);
  });

  it('rejects trades that break the rules', () => {
    const { h, a, b } = twoSquads();
    expect(code(() => h.room.proposeTrade('u1', { toId: 'u2', give: [], take: [], coins: 50 }))).toBe('TRADE_EMPTY');
    expect(code(() => h.room.proposeTrade('u1', { toId: 'u2', give: [b], take: [], coins: 0 }))).toBe('TRADE_INVALID');
    expect(code(() => h.room.proposeTrade('u1', { toId: 'u1', give: [a], take: [], coins: 0 }))).toBe('BAD_REQUEST');
    // Can't pay so much that you couldn't complete your squad.
    expect(code(() => h.room.proposeTrade('u1', { toId: 'u2', give: [], take: [b], coins: 800 }))).toBe('TRADE_INVALID');
    expect(code(() => h.room.proposeTrade('u3', { toId: 'u2', give: [], take: [b], coins: 10 }))).toBe('NOT_IN_ROOM');
  });

  it('an offer goes stale when its player is released', () => {
    const { h, a, b } = twoSquads();
    h.room.proposeTrade('u1', { toId: 'u2', give: [a], take: [b], coins: 0 });
    h.room.release('u2', b);
    expect(h.room.view('u1').trades).toEqual([]);
  });

  it('a trade cannot leave the top bidder unable to pay', () => {
    const { h, a, b } = twoSquads();
    const n = h.lot().lotNumber;
    h.room.bid('u2', n, h.member('u2').maxBid!);
    // u2 would pay 100 coins on top: no longer covers the bid they hold.
    expect(code(() => h.room.proposeTrade('u1', { toId: 'u2', give: [a], take: [b], coins: -100 }))).toBe('TRADE_INVALID');
    expect(code(() => h.room.proposeTrade('u1', { toId: 'u2', give: [a], take: [b], coins: 0 }))).toBe('OK');
  });
});

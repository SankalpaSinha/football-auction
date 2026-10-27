import { describe, expect, it } from 'vitest';
import { GameError } from '../src/engine/errors';
import { completeAuction, createHarness, nextLot, testRules, toResults } from './helpers';

const code = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof GameError) return e.code;
    throw e;
  }
  return 'OK';
};

const auction = (h: ReturnType<typeof createHarness>) => h.room.view().auction!;

describe('pause by agreement', () => {
  it('pauses only once every manager agrees, freezing the clock', () => {
    const h = createHarness({ players: 3 });
    const n = h.lot().lotNumber;
    h.clock.advance(10_000);
    h.room.requestPause('u1');
    expect(auction(h).pauseVote).toMatchObject({ requestedBy: 'u1', yes: ['u1'], waitingOn: ['u2', 'u3'] });
    expect(auction(h).hold).toBeNull();
    h.room.votePause('u2', true);
    expect(auction(h).hold).toBeNull();
    h.room.votePause('u3', true);
    expect(auction(h).hold).toMatchObject({ by: 'u1' });
    expect(auction(h).pauseVote).toBeNull();
    expect(h.lot().pausedRemainingMs).toBe(20_000);
    expect(h.events.some((e) => e.type === 'PAUSED')).toBe(true);

    // Frozen: no bids, and the clock running past the old deadline changes nothing.
    expect(code(() => h.room.bid('u2', n, 20))).toBe('AUCTION_PAUSED');
    h.clock.advance(60_000);
    expect(h.room.phase).toBe('AUCTION');
    expect(h.lot().lotNumber).toBe(n);

    // Anyone can resume; the clock picks up where it stopped.
    h.room.resumePause('u3');
    expect(auction(h).hold).toBeNull();
    expect(h.lot().pausedRemainingMs).toBeNull();
    expect(h.lot().endsAt - h.clock.now()).toBe(20_000);
    expect(code(() => h.room.bid('u2', n, 20))).toBe('OK');
  });

  it('a single "no" cancels the vote, and the asker has to wait before asking again', () => {
    const h = createHarness({ players: 3 });
    h.room.requestPause('u1');
    h.room.votePause('u2', false);
    expect(auction(h).pauseVote).toBeNull();
    expect(auction(h).hold).toBeNull();
    expect(code(() => h.room.requestPause('u1'))).toBe('PAUSE_COOLDOWN');
    expect(code(() => h.room.votePause('u3', true))).toBe('NO_PAUSE_VOTE');
    // Someone else may ask straight away.
    expect(code(() => h.room.requestPause('u2'))).toBe('OK');
    expect(code(() => h.room.requestPause('u3'))).toBe('PAUSE_VOTE_OPEN');
  });

  it('the vote lapses if not everyone answers in time', () => {
    const h = createHarness({ players: 2 });
    h.room.requestPause('u1');
    h.clock.advance(20_000);
    expect(auction(h).pauseVote).toBeNull();
    expect(auction(h).hold).toBeNull();
  });

  it('managers who are offline do not hold up the vote', () => {
    const h = createHarness({ players: 3 });
    h.room.setConnected('u3', false);
    h.room.requestPause('u1');
    h.room.votePause('u2', true);
    expect(auction(h).hold).not.toBeNull();
  });

  it('someone leaving mid-vote can complete it', () => {
    const h = createHarness({ players: 3 });
    h.room.requestPause('u1');
    h.room.votePause('u2', true);
    h.room.setConnected('u3', false);
    expect(auction(h).hold).not.toBeNull();
  });

  it('a reconnect does not end an agreed pause, but the time limit does', () => {
    const h = createHarness({ players: 2 });
    h.room.requestPause('u1');
    h.room.votePause('u2', true);
    h.room.setConnected('u2', false);
    h.room.setConnected('u2', true);
    expect(auction(h).hold).not.toBeNull();
    h.clock.advance(5 * 60_000);
    expect(auction(h).hold).toBeNull();
    expect(h.lot().pausedRemainingMs).toBeNull();
    expect(h.events.some((e) => e.type === 'RESUMED')).toBe(true);
  });

  it('agreed during the sold reveal → the next lot opens paused with its full clock', () => {
    const h = createHarness({ players: 2 });
    const n = h.lot().lotNumber;
    h.room.bid('u1', n, 20);
    h.room.skip('u2', n);
    expect(h.room.phase).toBe('PLAYER_SOLD');
    h.room.requestPause('u2');
    h.room.votePause('u1', true);
    nextLot(h);
    expect(h.lot().lotNumber).toBe(n + 1);
    expect(h.lot().pausedRemainingMs).toBe(30_000);
    h.clock.advance(120_000);
    expect(h.lot().lotNumber).toBe(n + 1);
    h.room.resumePause('u1');
    expect(h.lot().endsAt - h.clock.now()).toBe(30_000);
  });

  it('only managers in the room can ask, vote or resume', () => {
    const h = createHarness({ players: 2 });
    expect(code(() => h.room.requestPause('stranger'))).toBe('NOT_IN_ROOM');
    h.room.requestPause('u1');
    expect(code(() => h.room.votePause('stranger', true))).toBe('NOT_IN_ROOM');
    expect(code(() => h.room.resumePause('u2'))).toBe('NOT_PAUSED');
  });
});

describe('inactive managers', () => {
  /** u1 bids, u2 skips (if present), everyone else sits out; the lot runs out its clock. */
  const timedLot = (h: ReturnType<typeof createHarness>, active = ['u1']) => {
    const n = h.lot().lotNumber;
    for (const id of active) h.room.bid(id, n, h.lot().minNextBid);
    h.clock.advance(h.lot().endsAt - h.clock.now());
    nextLot(h);
  };

  it('warns after two idle lots and sits the manager out after three — they keep their squad', () => {
    const h = createHarness({ players: 3, rules: { inactiveLotsToRemove: 3 } });
    // u3 buys one player first, so we can check it stays theirs.
    const first = h.lot();
    h.room.bid('u3', first.lotNumber, 10);
    h.room.skip('u1', first.lotNumber);
    h.room.skip('u2', first.lotNumber);
    nextLot(h);
    expect(h.member('u3').squad).toHaveLength(1);

    timedLot(h);
    timedLot(h);
    expect(auction(h).idleLots).toMatchObject({ u2: 2, u3: 2 });
    expect(h.room.view().feed.some((f) => f.text.includes('user3 has sat out 2 lots'))).toBe(true);

    const before = auction(h).remainingInQueue;
    // u2 wakes up on lot 3; u3 doesn't.
    const n = h.lot().lotNumber;
    h.room.bid('u1', n, 10);
    h.room.bid('u2', n, 20);
    h.clock.advance(h.lot().endsAt - h.clock.now());

    expect(h.room.memberIds()).toEqual(['u1', 'u2', 'u3']);
    expect(h.member('u3').connected).toBe(false);
    expect(h.kicked).toEqual([{ userId: 'u3', reason: expect.stringContaining('3 lots') }]);
    expect(h.events.some((e) => e.type === 'REMOVED' && e.userId === 'u3')).toBe(true);
    expect(auction(h).idleLots).toEqual({});
    // Their player stays theirs; nothing went back into the pool.
    expect(h.member('u3').squad).toHaveLength(1);
    expect(auction(h).remainingInQueue).toBe(before);
    // Lots no longer wait for them…
    nextLot(h);
    const m = h.lot().lotNumber;
    h.room.bid('u1', m, 10);
    h.room.skip('u2', m);
    expect(h.room.phase).toBe('PLAYER_SOLD');
    // …until they come back with the code.
    h.room.join({ id: 'u3', username: 'user3' });
    expect(h.member('u3').connected).toBe(true);
    nextLot(h);
    h.room.bid('u3', h.lot().lotNumber, 10);
    expect(h.lot().highestBidderId).toBe('u3');
  });
  it('a lot nobody touched counts against nobody', () => {
    const h = createHarness({ players: 2, rules: { inactiveLotsToRemove: 3 } });
    for (let i = 0; i < 4; i++) {
      h.clock.advance(30_000);
      nextLot(h);
    }
    expect(h.room.memberIds()).toEqual(['u1', 'u2']);
    expect(auction(h).idleLots).toEqual({});
  });

  it('a skip resets the count', () => {
    const h = createHarness({ players: 2, rules: { inactiveLotsToRemove: 3 } });
    timedLot(h);
    timedLot(h);
    expect(auction(h).idleLots).toEqual({ u2: 2 });
    h.room.skip('u2', h.lot().lotNumber);
    h.clock.advance(h.lot().endsAt - h.clock.now());
    nextLot(h);
    // u2 is clear again; u1 let that one run out without acting.
    expect(auction(h).idleLots).toEqual({ u1: 1 });
    timedLot(h);
    timedLot(h);
    expect(h.room.memberIds()).toEqual(['u1', 'u2']);
  });

  it('a sat-out host hands over hosting after the grace period and the game carries on', () => {
    const h = createHarness({ players: 2, rules: { inactiveLotsToRemove: 3 } });
    timedLot(h, ['u2']);
    timedLot(h, ['u2']);
    timedLot(h, ['u2']);
    expect(h.member('u1').connected).toBe(false);
    h.clock.advance(testRules().hostTransferGraceMs);
    expect(h.room.hostId).toBe('u2');
    expect(h.room.phase === 'AUCTION' || h.room.phase === 'PLAYER_SOLD').toBe(true);
    expect(h.closed).toEqual([]);
  });
  it('an agreed pause does not count as idle time', () => {
    const h = createHarness({ players: 2, rules: { inactiveLotsToRemove: 3 } });
    timedLot(h);
    timedLot(h);
    h.room.requestPause('u1');
    h.room.votePause('u2', true);
    h.clock.advance(4 * 60_000);
    expect(h.room.memberIds()).toEqual(['u1', 'u2']);
  });
});

describe('inactivity: acting always resets the count', () => {
  it('a skip on a lot that closes early still counts as being there', () => {
    const h = createHarness({ players: 2, rules: { inactiveLotsToRemove: 3 } });
    const timed = () => {
      const n = h.lot().lotNumber;
      h.room.bid('u1', n, h.lot().minNextBid);
      h.clock.advance(h.lot().endsAt - h.clock.now());
      nextLot(h);
    };
    for (let i = 0; i < 4; i++) {
      timed(); // u2 misses one…
      expect(auction(h).idleLots.u2).toBe(1);
      // …then skips the next, which closes at once.
      const n = h.lot().lotNumber;
      h.room.bid('u1', n, 10);
      h.room.skip('u2', n);
      expect(auction(h).idleLots.u2).toBeUndefined();
      nextLot(h);
    }
    expect(h.member('u2').connected).toBe(true);
  });
});

describe('inactivity edge cases', () => {
  it('offline managers are never removed for inactivity — they can come back', () => {
    const h = createHarness({ players: 3, rules: { inactiveLotsToRemove: 3 } });
    h.room.setConnected('u3', false);
    for (let i = 0; i < 4; i++) {
      // A bidding war that runs the clock out while u3 is away.
      const n = h.lot().lotNumber;
      h.room.bid('u1', n, h.lot().minNextBid);
      h.room.bid('u2', n, h.lot().minNextBid);
      h.clock.advance(h.lot().endsAt - h.clock.now());
      nextLot(h);
    }
    expect(h.room.memberIds()).toContain('u3');
    expect(auction(h).idleLots.u3).toBeUndefined();
  });

  it('a sat-out manager is told why, and gets their squad back by rejoining', () => {
    const h = createHarness({ players: 2, rules: { inactiveLotsToRemove: 3 } });
    const first = h.lot();
    h.room.bid('u2', first.lotNumber, 10);
    h.room.skip('u1', first.lotNumber);
    nextLot(h);
    for (let i = 0; i < 3; i++) {
      const n = h.lot().lotNumber;
      h.room.bid('u1', n, h.lot().minNextBid);
      h.clock.advance(h.lot().endsAt - h.clock.now());
      nextLot(h);
    }
    expect(h.kicked[0]).toMatchObject({ userId: 'u2', reason: expect.stringContaining('3 lots') });
    expect(h.member('u2').connected).toBe(false);
    h.room.join({ id: 'u2', username: 'user2' });
    expect(h.member('u2').connected).toBe(true);
    expect(h.member('u2').squad).toHaveLength(1);
  });
  it('a sat-out manager who never comes back still finishes the game with a full squad and a result', async () => {
    const h = createHarness({ players: 3, settings: { mode: 'RANKED' }, rules: { inactiveLotsToRemove: 3 } });
    await new Promise((r) => setTimeout(r, 0)); // ratings load
    for (let i = 0; i < 3; i++) {
      const n = h.lot().lotNumber;
      h.room.bid('u1', n, h.lot().minNextBid);
      h.room.skip('u2', n);
      h.clock.advance(h.lot().endsAt - h.clock.now());
      nextLot(h);
    }
    expect(h.member('u3').connected).toBe(false);
    completeAuction(h);
    expect(h.room.phase).toBe('SQUAD_BUILDING');
    expect(h.member('u3').squad).toHaveLength(18);
    toResults(h);
    const changes = h.room.view().results!.ratingChanges!;
    expect(changes.map((c) => c.userId).sort()).toEqual(['u1', 'u2', 'u3']);
    expect(h.room.view().results!.rankings.map((r) => r.userId).sort()).toEqual(['u1', 'u2', 'u3']);
  });
});

describe('away (screen locked / app in the background)', () => {
  it('away managers are never counted as idle, and show as away', () => {
    const h = createHarness({ players: 3 });
    h.room.setAway('u3', true);
    expect(h.member('u3').away).toBe(true);
    for (let i = 0; i < 4; i++) {
      const n = h.lot().lotNumber;
      h.room.bid('u1', n, h.lot().minNextBid);
      h.room.bid('u2', n, h.lot().minNextBid);
      h.clock.advance(h.lot().endsAt - h.clock.now());
      nextLot(h);
    }
    expect(h.room.memberIds()).toContain('u3');
    expect(auction(h).idleLots.u3).toBeUndefined();
  });

  it('coming back resets away; a reconnect starts present', () => {
    const h = createHarness({ players: 2 });
    h.room.setAway('u2', true);
    h.room.setAway('u2', false);
    expect(h.member('u2').away).toBe(false);
    h.room.setAway('u2', true);
    h.room.setConnected('u2', false);
    expect(h.member('u2').away).toBe(false);
    h.room.setConnected('u2', true);
    expect(h.member('u2').away).toBe(false);
  });
});

describe('long absences', () => {
  it('after the grace period an away manager no longer holds up lots or pause votes', () => {
    const h = createHarness({ players: 3 });
    h.room.setAway('u3', true);
    // Briefly away: the lot still waits for u3.
    let n = h.lot().lotNumber;
    h.room.bid('u1', n, 10);
    h.room.skip('u2', n);
    expect(h.room.phase).toBe('AUCTION');
    h.clock.advance(h.lot().endsAt - h.clock.now());
    nextLot(h);
    // Past the grace period: lots close as soon as the present managers are done.
    h.clock.advance(20_000);
    nextLot(h);
    n = h.lot().lotNumber;
    h.room.bid('u1', n, 10);
    h.room.skip('u2', n);
    expect(h.room.phase).toBe('PLAYER_SOLD');
    nextLot(h);
    // …and a pause vote doesn't need their answer.
    h.room.requestPause('u1');
    h.room.votePause('u2', true);
    expect(auction(h).hold).not.toBeNull();
    // Back: they count again (and were never removed).
    h.room.setAway('u3', false);
    expect(h.room.memberIds()).toContain('u3');
  });
});

describe('default inactivity limit', () => {
  it('is 5 lots: warned after 4, removed after 5', () => {
    expect(testRules().inactiveLotsToRemove).toBe(5);
    const h = createHarness({ players: 2 });
    const timed = () => {
      const n = h.lot().lotNumber;
      h.room.bid('u1', n, h.lot().minNextBid);
      h.clock.advance(h.lot().endsAt - h.clock.now());
      nextLot(h);
    };
    for (let i = 0; i < 4; i++) timed();
    expect(auction(h).idleLots).toEqual({ u2: 4 });
    expect(h.room.view().feed.some((f) => f.text.includes('user2 has sat out 4 lots'))).toBe(true);
    expect(h.room.memberIds()).toEqual(['u1', 'u2']);
    timed();
    expect(h.room.memberIds()).toEqual(['u1', 'u2']);
    expect(h.member('u2').connected).toBe(false);
    expect(h.kicked[0].reason).toContain('5 lots');
  });
});

describe('exit game', () => {
  it('exiting mid-auction keeps your squad, and entering the code again brings you back', () => {
    const h = createHarness({ players: 3 });
    const first = h.lot();
    h.room.bid('u3', first.lotNumber, 10);
    h.room.skip('u1', first.lotNumber);
    h.room.skip('u2', first.lotNumber);
    nextLot(h);
    const queued = auction(h).remainingInQueue;
    h.room.quit('u3');
    expect(h.room.memberIds()).toEqual(['u1', 'u2', 'u3']);
    expect(h.member('u3').connected).toBe(false);
    expect(h.member('u3').squad).toHaveLength(1);
    expect(auction(h).remainingInQueue).toBe(queued);
    expect(h.kicked).toEqual([]); // they chose to go: no "you were removed" notice
    expect(h.room.view().feed.some((f) => f.text.startsWith('user3 left the game') && f.text.includes('rejoin'))).toBe(true);
    // Lots don't wait for them while they're gone.
    const n = h.lot().lotNumber;
    h.room.bid('u1', n, 10);
    h.room.skip('u2', n);
    expect(h.room.phase).toBe('PLAYER_SOLD');
    h.room.join({ id: 'u3', username: 'user3' });
    expect(h.member('u3').connected).toBe(true);
    expect(h.member('u3').squad).toHaveLength(1);
  });

  it('a manager who stepped out can watch without rejoining as a player', () => {
    const h = createHarness({ players: 2 });
    h.room.quit('u2');
    h.room.addSpectator('u2');
    expect(h.room.view().spectators).toBe(1);
    expect(h.member('u2').connected).toBe(false);
    // Someone still playing is never a spectator.
    h.room.addSpectator('u1');
    expect(h.room.view().spectators).toBe(1);
  });

  it('exiting while holding the top bid: you still win the player', () => {
    const h = createHarness({ players: 3 });
    const n = h.lot().lotNumber;
    h.room.bid('u3', n, 50);
    h.room.quit('u3');
    h.clock.advance(h.lot().endsAt - h.clock.now());
    expect(h.member('u3').squad).toHaveLength(1);
    expect(h.member('u3').budget).toBe(950);
  });

  it('the free-pick manager exiting: their squad is completed automatically', () => {
    const h = createHarness({ players: 2 });
    while (h.member('u1').squad.length < 18) {
      if (h.room.phase === 'PLAYER_SOLD') {
        nextLot(h);
        continue;
      }
      h.room.bid('u1', h.lot().lotNumber, 10);
      if (h.room.phase === 'AUCTION') h.room.skip('u2', h.lot().lotNumber);
    }
    nextLot(h);
    expect(auction(h).freePick?.userId).toBe('u2');
    h.room.quit('u2');
    h.clock.advance(testRules().absentAutoFillMs);
    expect(h.room.phase).toBe('SQUAD_BUILDING');
    expect(h.member('u2').squad).toHaveLength(18);
  });

  it('in a ranked game leaving doesn’t dodge the result', async () => {
    const h = createHarness({ players: 3, settings: { mode: 'RANKED' } });
    await new Promise((r) => setTimeout(r, 0));
    h.room.quit('u3');
    completeAuction(h);
    toResults(h);
    const c = h.room.view().results!.ratingChanges!.find((x) => x.userId === 'u3');
    expect(c).toBeDefined();
  });

  it('after the auction, exiting just takes you offline and you still get a result', () => {
    const h = createHarness({ players: 2 });
    completeAuction(h);
    h.room.quit('u2');
    expect(h.room.memberIds()).toEqual(['u1', 'u2']);
    expect(h.member('u2').connected).toBe(false);
    toResults(h);
    expect(h.room.view().results!.rankings.map((r) => r.userId).sort()).toEqual(['u1', 'u2']);
  });
});

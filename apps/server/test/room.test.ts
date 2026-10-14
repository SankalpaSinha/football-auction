import { describe, expect, it } from 'vitest';
import { GameError } from '../src/engine/errors';
import { createHarness, nextLot, skipAll, testRules } from './helpers';

const code = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof GameError) return e.code;
    throw e;
  }
  return 'OK';
};

describe('lobby state machine', () => {
  it('moves WAITING_FOR_PLAYERS → LOBBY → STARTING → AUCTION', () => {
    const h = createHarness({ players: 1, start: false });
    expect(h.room.phase).toBe('WAITING_FOR_PLAYERS');
    h.room.join({ id: 'u2', username: 'user2' });
    expect(h.room.phase).toBe('LOBBY');
    expect(code(() => h.room.start('u1'))).toBe('NOT_ALL_READY');
    h.room.setReady('u2', true);
    expect(code(() => h.room.start('u2'))).toBe('NOT_HOST');
    h.room.start('u1');
    expect(h.room.phase).toBe('STARTING');
    h.clock.advance(testRules().startCountdownMs);
    expect(h.room.phase).toBe('AUCTION');
    expect(h.room.view().members.every((m) => m.budget === 1000)).toBe(true);
  });

  it('cannot start with one player', () => {
    const h = createHarness({ players: 1, start: false });
    expect(code(() => h.room.start('u1'))).toBe('NOT_ENOUGH_PLAYERS');
  });

  it('enforces room size and blocks new joiners mid-game', () => {
    const h = createHarness({ players: 2, settings: { maxPlayers: 2 }, start: false });
    expect(code(() => h.room.join({ id: 'u3', username: 'user3' }))).toBe('ROOM_FULL');
    h.room.setReady('u2', true);
    h.room.start('u1');
    h.clock.advance(1000);
    expect(code(() => h.room.join({ id: 'u9', username: 'late' }))).toBe('GAME_IN_PROGRESS');
  });

  it('cancels the countdown if someone leaves', () => {
    const h = createHarness({ players: 2, start: false });
    h.room.setReady('u2', true);
    h.room.start('u1');
    h.room.leave('u2');
    expect(h.room.phase).toBe('WAITING_FOR_PLAYERS');
    h.clock.advance(5000);
    expect(h.room.view().auction).toBeNull();
  });

  it('rejects a pool too small for the room', () => {
    const h = createHarness({ players: 2, start: false, pool: [] });
    h.room.setReady('u2', true);
    expect(code(() => h.room.start('u1'))).toBe('POOL_TOO_SMALL');
  });
});

describe('host', () => {
  it('transfers host immediately when the host leaves the lobby', () => {
    const h = createHarness({ players: 3, start: false });
    h.room.leave('u1');
    expect(h.room.hostId).toBe('u2');
  });

  it('transfers host after the grace period when the host disconnects', () => {
    const h = createHarness({ players: 3 });
    h.room.setConnected('u1', false);
    h.clock.advance(testRules().hostTransferGraceMs - 1);
    expect(h.room.hostId).toBe('u1');
    h.clock.advance(1);
    expect(h.room.hostId).toBe('u2');
  });

  it('keeps host if they reconnect within the grace period', () => {
    const h = createHarness({ players: 3, start: false });
    h.room.setConnected('u1', false);
    h.clock.advance(5_000);
    h.room.setConnected('u1', true);
    h.clock.advance(20_000);
    expect(h.room.hostId).toBe('u1');
  });
});

describe('disconnect / reconnect', () => {
  it('a manager reconnecting after 20s keeps squad and budget', () => {
    const h = createHarness({ players: 3 });
    const lot = h.lot();
    h.room.bid('u2', lot.lotNumber, 90);
    skipAll(h);
    expect(h.member('u2').squad).toHaveLength(1);
    h.room.setConnected('u2', false);
    nextLot(h);
    h.clock.advance(20_000);
    h.room.join({ id: 'u2', username: 'user2' }); // refresh → rejoin
    const m = h.member('u2');
    expect(m.connected).toBe(true);
    expect(m.budget).toBe(910);
    expect(m.squad).toHaveLength(1);
  });

  it('a disconnected manager cannot be skipped over forever: lots keep flowing', () => {
    const h = createHarness({ players: 3 });
    h.room.setConnected('u3', false);
    const n = h.lot().lotNumber;
    h.room.skip('u1', n);
    h.room.skip('u2', n);
    expect(h.room.phase).toBe('PLAYER_SOLD');
  });

  it('pauses when everyone is offline and resumes on reconnect', () => {
    const h = createHarness({ players: 2 });
    h.clock.advance(28_000);
    h.room.setConnected('u1', false);
    h.room.setConnected('u2', false);
    expect(h.room.view().auction!.paused).toBe(true);
    h.clock.advance(30_000);
    expect(h.room.phase).toBe('AUCTION');
    h.room.setConnected('u2', true);
    const lot = h.lot();
    expect(lot.pausedRemainingMs).toBeNull();
    expect(lot.endsAt - h.clock.now()).toBe(5_000);
  });

  it('removes a lobby member who stays away past the grace period', () => {
    const h = createHarness({ players: 3, start: false });
    h.room.setConnected('u3', false);
    h.clock.advance(testRules().lobbyDisconnectGraceMs);
    expect(h.room.hasMember('u3')).toBe(false);
  });

  it('closes an abandoned game after everyone is gone long enough', () => {
    const h = createHarness({ players: 2 });
    h.room.setConnected('u1', false);
    h.room.setConnected('u2', false);
    h.clock.advance(testRules().abandonAfterMs);
    expect(h.closed).toEqual(['everyone left']);
  });

  it('leaving mid-game keeps the squad (member is just offline)', () => {
    const h = createHarness({ players: 2 });
    const lot = h.lot();
    h.room.bid('u1', lot.lotNumber, 10);
    h.room.leave('u1');
    expect(h.room.hasMember('u1')).toBe(true);
    expect(h.member('u1').connected).toBe(false);
    // u2 is the only one left to decide — lot still sells to u1 at the hammer
    h.room.skip('u2', lot.lotNumber);
    expect(h.room.view().auction!.lastResult!.winnerId).toBe('u1');
  });

  it('a rage-quit cannot freeze the game: absent squads are completed', () => {
    const h = createHarness({ players: 2 });
    h.room.leave('u2'); // u2 walks out mid-auction
    // u1 fills their squad; u2 is offline and treated as passing.
    for (let guard = 0; guard < 400 && h.member('u1').squad.length < 15; guard++) {
      if (h.room.phase === 'PLAYER_SOLD') {
        nextLot(h);
        continue;
      }
      const lot = h.lot();
      try {
        h.room.bid('u1', lot.lotNumber, lot.minNextBid);
      } catch {
        h.room.skip('u1', lot.lotNumber);
      }
      if (h.room.view().auction?.lot?.lotNumber === lot.lotNumber) h.room.skip('u1', lot.lotNumber);
    }
    nextLot(h);
    // Only the absent manager still needs players → free pick, but they're not here.
    expect(h.room.view().auction!.freePick?.userId).toBe('u2');
    h.clock.advance(testRules().absentAutoFillMs);
    expect(h.room.phase).toBe('SQUAD_BUILDING');
    expect(h.member('u2').squad).toHaveLength(15);
    expect(h.member('u2').squad.some((e) => e.player.position === 'GK')).toBe(true);
  });
});


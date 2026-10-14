import { makeRules, tierFor, type GameEvent, type GameRules, type PlayerCard, type Position, type RoomSettings } from '@fa/shared';
import { ManualClock } from '../src/engine/clock';
import { Room } from '../src/engine/room';
import { NoopGameStore } from '../src/engine/store';

const OUTFIELD: Position[] = ['CB', 'LB', 'RB', 'CDM', 'CM', 'CAM', 'LW', 'RW', 'ST'];

export function makeCard(id: string, position: Position, overall = 75): PlayerCard {
  const isGk = position === 'GK';
  return {
    id,
    playerId: id,
    name: `Player ${id}`,
    shortName: id,
    nation: { code: 'ENG', name: 'England', flag: '🏴' },
    club: { id: 'test-fc', name: 'Test FC', shortName: 'TFC', colors: ['#000000', '#ffffff'], logoUrl: null },
    league: 'test-league',
    season: '2026-27',
    position,
    secondaryPositions: [],
    overall,
    tier: tierFor(overall),
    outfield: isGk ? null : { pace: 70, shooting: 70, passing: 70, dribbling: 70, defending: 70, physical: 70 },
    goalkeeping: isGk ? { diving: 70, handling: 70, kicking: 70, reflexes: 70, speed: 50, positioning: 70 } : null,
    age: 26,
    preferredFoot: 'Right',
    heightCm: 182,
    imageUrl: null,
    imageCredit: null,
  };
}

/** `size` players, the first `gks` of which are goalkeepers (order is shuffled by the room anyway). */
export function makePool(size: number, gks: number): PlayerCard[] {
  return Array.from({ length: size }, (_, i) =>
    makeCard(`p${String(i).padStart(3, '0')}`, i < gks ? 'GK' : OUTFIELD[i % OUTFIELD.length], 70 + (i % 20)),
  );
}

export const testRules = (o: Partial<GameRules> = {}) =>
  makeRules({ startCountdownMs: 1000, soldRevealMs: 1000, unsoldRevealMs: 500, ...o });

export function settings(o: Partial<RoomSettings> = {}): RoomSettings {
  return {
    competitionId: 'test',
    seasonId: '2026-27',
    startingBudget: 1000,
    maxPlayers: 6,
    lotDurationSec: 30,
    mode: 'CASUAL',
    isPublic: false,
    antiSnipe: true,
    ...o,
  };
}

export interface Harness {
  room: Room;
  clock: ManualClock;
  events: GameEvent[];
  users: { id: string; username: string }[];
  closed: string[];
  lot(): NonNullable<NonNullable<ReturnType<Room['view']>['auction']>['lot']>;
  member(userId: string): ReturnType<Room['view']>['members'][number];
}

export function createHarness(opts: {
  players?: number;
  pool?: PlayerCard[];
  rules?: Partial<GameRules>;
  settings?: Partial<RoomSettings>;
  start?: boolean;
  seed?: string;
  commentator?: import('../src/services/commentary').Commentator;
} = {}): Harness {
  const clock = new ManualClock();
  const events: GameEvent[] = [];
  const closed: string[] = [];
  const n = opts.players ?? 2;
  const users = Array.from({ length: n }, (_, i) => ({ id: `u${i + 1}`, username: `user${i + 1}` }));
  const room = new Room(
    'TEST01',
    'Test Room',
    settings(opts.settings),
    { id: 'test', name: 'Test League', shortName: 'TL', accent: '#fff', seasonLabel: '2026–27' },
    opts.pool ?? makePool(120, 16),
    users[0],
    {
      clock,
      rules: testRules(opts.rules),
      store: new NoopGameStore(),
      seed: opts.seed ?? 'fixed-seed',
      commentator: opts.commentator,
      onChange: () => {},
      onEvent: (_r, e) => events.push(e),
      onClosed: (_r, reason) => closed.push(reason),
      onMemberRemoved: () => {},
    },
  );
  for (const u of users.slice(1)) room.join(u);

  const h: Harness = {
    room,
    clock,
    events,
    users,
    closed,
    lot() {
      const lot = room.view().auction?.lot;
      if (!lot) throw new Error(`no open lot (phase ${room.phase})`);
      return lot;
    },
    member(userId) {
      return room.view().members.find((m) => m.userId === userId)!;
    },
  };

  if (opts.start !== false) {
    for (const u of users.slice(1)) room.setReady(u.id, true);
    room.start(users[0].id);
    clock.advance(testRules(opts.rules).startCountdownMs);
  }
  return h;
}

/** Everyone except `except` skips the current lot. */
export function skipAll(h: Harness, except: string[] = []) {
  const lot = h.lot();
  for (const u of h.users) {
    if (except.includes(u.id) || lot.skippedBy.includes(u.id) || lot.highestBidderId === u.id) continue;
    try {
      h.room.skip(u.id, lot.lotNumber);
    } catch {
      // squad full etc. — irrelevant here
    }
    if (h.room.view().auction?.lot?.lotNumber !== lot.lotNumber) return;
  }
}

/** Advance through the reveal so the next lot is open. */
export function nextLot(h: Harness) {
  const r = h.room.view().auction?.lastResult;
  if (r) h.clock.advance(r.nextAt - h.clock.now());
}

/** During free pick, the picker takes the first player they're allowed to. Returns true if it acted. */
export function freePickStep(h: Harness): boolean {
  const fp = h.room.view().auction?.freePick;
  if (!fp) return false;
  for (const p of h.room.pickPool(fp.userId)) {
    try {
      h.room.pick(fp.userId, p.id);
      return true;
    } catch {
      /* not allowed (e.g. must be a keeper) — try the next one */
    }
  }
  throw new Error('free pick: no legal player');
}

/** Run the auction to completion: managers take turns buying at the minimum price. */
export function completeAuction(h: Harness) {
  let turn = 0;
  for (let guard = 0; guard < 3000 && (h.room.phase === 'AUCTION' || h.room.phase === 'PLAYER_SOLD'); guard++) {
    if (freePickStep(h)) continue;
    if (h.room.phase === 'PLAYER_SOLD') {
      nextLot(h);
      continue;
    }
    const lot = h.lot();
    const buyer = h.users[turn++ % h.users.length];
    try {
      h.room.bid(buyer.id, lot.lotNumber, lot.minNextBid);
    } catch {
      /* not allowed for this buyer */
    }
    if (h.room.view().auction?.lot?.lotNumber === lot.lotNumber) skipAll(h);
  }
}

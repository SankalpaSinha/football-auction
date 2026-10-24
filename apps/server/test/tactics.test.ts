import { describe, expect, it } from 'vitest';
import {
  autoPick,
  drawObjectives,
  getFormation,
  GAME_RULES,
  lineupSchema,
  OBJECTIVE_IDS,
  playstyleOf,
  scoreSquad,
  softenRating,
  TACTIC_IDS,
  tierFor,
  type OutfieldStats,
  type PlayerCard,
  type Position,
  type SquadEntry,
} from '@fa/shared';
import { GameError } from '../src/engine/errors';
import { createRng } from '../src/engine/rng';
import { completeAuction, createHarness, makeCard, makePool, nextLot } from './helpers';

const code = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof GameError) return e.code;
    throw e;
  }
  return 'OK';
};

function card(id: string, position: Position, overall: number, stats: Partial<OutfieldStats> = {}, extra: Partial<PlayerCard> = {}): PlayerCard {
  const base = makeCard(id, position, overall);
  return {
    ...base,
    club: { ...base.club, id: `club-${id}` },
    nation: { ...base.nation, code: `N-${id}` },
    outfield: base.outfield ? { ...base.outfield, ...stats } : null,
    tier: tierFor(overall),
    ...extra,
  };
}
const entry = (p: PlayerCard, price = 10): SquadEntry => ({ player: p, price, via: 'AUCTION', lotNumber: 1, estimatedValue: 50 });

describe('playstyles', () => {
  it('are derived from position and attributes', () => {
    expect(playstyleOf(card('tm', 'ST', 84, { physical: 88 }))).toBe('TARGET_MAN');
    expect(playstyleOf(card('pf', 'ST', 84, { pace: 92, physical: 70 }))).toBe('PACE_FORWARD');
    expect(playstyleOf(card('wc', 'LW', 80, { passing: 80, shooting: 70 }, { preferredFoot: 'Left' }))).toBe('WIDE_CROSSER');
    expect(playstyleOf(card('if', 'LW', 80, { passing: 70, shooting: 80 }, { preferredFoot: 'Right' }))).toBe('INSIDE_FORWARD');
    expect(playstyleOf(card('bpd', 'CB', 80, { passing: 70 }))).toBe('BALL_PLAYING_DEFENDER');
    expect(playstyleOf(card('sto', 'CB', 80, { passing: 50 }))).toBe('STOPPER');
    const keeper = makeCard('gk-a', 'GK', 80);
    expect(playstyleOf({ ...keeper, goalkeeping: { ...keeper.goalkeeping!, kicking: 60, speed: 45 } })).toBe('SHOT_STOPPER');
    expect(playstyleOf({ ...keeper, id: 'gk-b', goalkeeping: { ...keeper.goalkeeping!, kicking: 80, speed: 60 } })).toBe('SWEEPER_KEEPER');
  });
});

describe('scoring with tactics and synergy', () => {
  // 4-4-2: GK, LB, CB, CB, RB, LM, CM, CM, RM, ST, ST
  const xi = [
    makeCard('gk', 'GK', 80),
    card('lb', 'LB', 80, { pace: 85, dribbling: 80, defending: 70 }),
    card('cb1', 'CB', 80, { passing: 50, defending: 85 }),
    card('cb2', 'CB', 80, { passing: 70, defending: 85 }),
    card('rb', 'RB', 80, { pace: 70, dribbling: 65, defending: 82 }),
    card('lm', 'LM', 80, { pace: 88, passing: 82, shooting: 65 }, { preferredFoot: 'Left' }),
    card('cm1', 'CM', 80, { physical: 80, defending: 75 }),
    card('cm2', 'CM', 80, { passing: 85, dribbling: 75, physical: 60 }),
    card('rm', 'RM', 80, { pace: 88, passing: 82, shooting: 65 }),
    card('st1', 'ST', 80, { physical: 88 }),
    card('st2', 'ST', 80, { shooting: 85, pace: 75, physical: 70, passing: 60 }),
  ];
  const squad = xi.map((p) => entry(p));
  const lineup = { formationId: '4-4-2', slots: xi.map((p) => p.id) };

  it('finds synergy combos between playstyles', () => {
    const s = scoreSquad(squad, lineup);
    const keys = s.synergies.map((h) => h.key);
    expect(keys).toContain('AERIAL'); // wide crosser → target man
    expect(keys).toContain('BIG_LITTLE'); // target man + poacher
    expect(keys).toContain('CB_PARTNERSHIP');
    expect(s.breakdown.synergy).toBeGreaterThan(0);
  });

  it('players out of position do not bring their playstyle', () => {
    // Swap the target man into goal: no aerial combo any more.
    const bad = { ...lineup, slots: ['st1', ...lineup.slots.slice(1, 9), 'gk', 'st2'] };
    expect(scoreSquad(squad, bad).synergies.map((h) => h.key)).not.toContain('AERIAL');
  });

  it('the chosen tactic changes the score', () => {
    const totals = Object.fromEntries(TACTIC_IDS.map((t) => [t, scoreSquad(squad, { ...lineup, tactic: t }).total]));
    expect(new Set(Object.values(totals)).size).toBeGreaterThan(1);
    // A crossing team built around a target man suits wing play better than tiki-taka.
    expect(totals.WING_PLAY).toBeGreaterThan(totals.TIKI_TAKA);
    expect(scoreSquad(squad, { ...lineup, tactic: 'WING_PLAY' }).tacticId).toBe('WING_PLAY');
    expect(scoreSquad(squad, lineup).tacticId).toBe('BALANCED');
  });

  it('a tactic without the positions it relies on is penalised', () => {
    // 4-1-2-1-2 has no wide players at all.
    const f = getFormation('4-1-2-1-2')!;
    const narrow = { formationId: f.id, slots: xi.map((p) => p.id), tactic: 'WING_PLAY' as const };
    const s = scoreSquad(squad, narrow);
    expect(s.tactics.some((t) => t.score === 35)).toBe(true);
    expect(s.notes.some((n) => n.text.includes('this formation has none'))).toBe(true);
  });

  it('stars have diminishing returns', () => {
    expect(softenRating(80)).toBe(80);
    expect(softenRating(83)).toBe(83);
    expect(softenRating(91)).toBe(87);
  });

  it('completed objectives add bonus points', () => {
    const none = scoreSquad(squad, lineup, { objectives: [] });
    const done = scoreSquad(squad, lineup, { objectives: ['NO_SUPERSTARS', 'CLUB_TRIO'] });
    expect(done.objectives).toEqual([
      { id: 'NO_SUPERSTARS', done: true },
      { id: 'CLUB_TRIO', done: false },
    ]);
    expect(done.objectiveBonus).toBe(3);
    expect(done.total).toBeCloseTo(none.total + 3, 5);
    const frugal = scoreSquad(squad, lineup, { objectives: ['FRUGAL'], startingBudget: 1000, budgetLeft: 300 });
    expect(frugal.objectives[0].done).toBe(true);
    expect(scoreSquad(squad, lineup, { objectives: ['FRUGAL'], startingBudget: 1000, budgetLeft: 100 }).objectives[0].done).toBe(false);
  });

  it('objectives are drawn deterministically and never repeat', () => {
    const a = drawObjectives(createRng('seed:u1'));
    expect(a).toEqual(drawObjectives(createRng('seed:u1')));
    expect(new Set(a).size).toBe(2);
    expect(a.every((id) => OBJECTIVE_IDS.includes(id))).toBe(true);
  });

  it('the lineup message accepts known tactics only', () => {
    expect(lineupSchema.safeParse({ formationId: '4-4-2', slots: [], tactic: 'HIGH_PRESS' }).success).toBe(true);
    expect(lineupSchema.safeParse({ formationId: '4-4-2', slots: [] }).success).toBe(true);
    expect(lineupSchema.safeParse({ formationId: '4-4-2', slots: [], tactic: 'ALL_OUT' }).success).toBe(false);
  });
});

describe('star cap', () => {
  /** Pool where the first `stars` outfielders are rated 88. */
  function starPool(stars: number) {
    return makePool(120, 16).map((p, i) => (i >= 16 && i < 16 + stars ? { ...p, overall: 88, tier: tierFor(88), star: true } : p));
  }

  it('a manager can own at most 6 star players', () => {
    const h = createHarness({ pool: starPool(10), fixedOrder: true });
    const isStar = () => !!h.lot().player.star;
    let bought = 0;
    for (let guard = 0; guard < 60 && bought < 6; guard++) {
      if (h.room.phase === 'PLAYER_SOLD') {
        nextLot(h);
        continue;
      }
      if (isStar()) {
        h.room.bid('u1', h.lot().lotNumber, 10);
        bought++;
      }
      for (const u of ['u1', 'u2']) if (h.room.phase === 'AUCTION') code(() => h.room.skip(u, h.lot().lotNumber));
      nextLot(h);
    }
    while (!isStar()) {
      for (const u of ['u1', 'u2']) if (h.room.phase === 'AUCTION') code(() => h.room.skip(u, h.lot().lotNumber));
      nextLot(h);
    }
    expect(h.member('u1').squad.filter((e) => e.player.star)).toHaveLength(6);
    expect(code(() => h.room.bid('u1', h.lot().lotNumber, 10))).toBe('STAR_LIMIT');
    expect(code(() => h.room.bid('u2', h.lot().lotNumber, 10))).toBe('OK');
    expect(h.room.view().rules.starCap).toEqual(GAME_RULES.starCap);
  });

  it('a pool without enough non-stars for everyone cannot start', () => {
    const pool = makePool(60, 8).map((p) => (p.position === 'GK' ? p : { ...p, overall: 88, tier: tierFor(88), star: true }));
    const h = createHarness({ pool, start: false });
    h.room.setReady('u2', true);
    expect(code(() => h.room.start('u1'))).toBe('POOL_TOO_SMALL');
  });
});

describe('room: tactics and objectives', () => {
  it('each manager sees only their own two objectives; everyone sees them at the end', () => {
    const h = createHarness({ players: 3 });
    const mine = h.room.view('u1').myObjectives!;
    expect(mine).toHaveLength(2);
    expect(h.room.view('u2').myObjectives).not.toBeNull();
    expect(h.room.view().myObjectives).toBeNull();
    completeAuction(h);
    expect(h.room.phase).toBe('SQUAD_BUILDING');
    h.clock.advance(GAME_RULES.squadBuildingMs + 10_000);
    const r = h.room.view().results!.rankings.find((x) => x.userId === 'u1')!;
    expect(r.objectives.map((o) => o.id)).toEqual(mine);
  });

  it('the squad builder lasts 10 minutes', () => {
    expect(GAME_RULES.squadBuildingMs).toBe(600_000);
    const h = createHarness();
    completeAuction(h);
    const sb = h.room.view().squadBuilding!;
    expect(sb.endsAt - h.clock.now()).toBe(600_000);
    h.clock.advance(599_000);
    expect(h.room.phase).toBe('SQUAD_BUILDING');
  });

  it('the chosen tactic is saved with the lineup and used for the score', () => {
    const h = createHarness();
    completeAuction(h);
    const squad = h.member('u1').squad.map((e) => e.player);
    const slots = autoPick(squad, '4-3-3');
    h.room.saveLineupDraft('u1', { formationId: '4-3-3', slots, tactic: 'COUNTER_ATTACK' });
    expect(h.room.view('u1').squadBuilding!.mine!.tactic).toBe('COUNTER_ATTACK');
    h.room.lockLineup('u1', { formationId: '4-3-3', slots, tactic: 'HIGH_PRESS' });
    h.clock.advance(600_000 + 10_000); // deadline, then the evaluation pause
    const results = h.room.view().results!;
    expect(results.rankings.find((r) => r.userId === 'u1')!.tacticId).toBe('HIGH_PRESS');
    // Auto-completed lineups keep the default tactic.
    expect(results.rankings.find((r) => r.userId === 'u2')!.tacticId).toBe('BALANCED');
    expect(h.room.view().lineups!.u1.tactic).toBe('HIGH_PRESS');
  });
});

describe('star cap keeps every squad completable', () => {
  const star = (p: PlayerCard): PlayerCard => ({ ...p, overall: 88, tier: tierFor(88), star: true });

  /** Lots in the given order: u1 buys the ones in `u1Buys`, u2 skips everything. */
  function play(h: ReturnType<typeof createHarness>, lots: number) {
    for (let i = 0; i < lots; i++) {
      h.room.bid('u1', h.lot().lotNumber, 10);
      if (h.room.phase === 'AUCTION') h.room.skip('u2', h.lot().lotNumber);
      nextLot(h);
    }
  }

  it('the last keeper under 85 is saved for a manager who can only take that kind', () => {
    const pool = [
      ...['ST', 'CM', 'CB', 'LW', 'RW', 'CDM'].map((pos, i) => star(makeCard(`s${i}`, pos as Position))),
      makeCard('gk-normal', 'GK', 80),
      star(makeCard('gk-star1', 'GK')),
      star(makeCard('gk-star2', 'GK')),
      ...makePool(60, 0).map((p, i) => ({ ...p, id: `o${i}`, playerId: `o${i}` })),
    ];
    const h = createHarness({ pool, fixedOrder: true });
    play(h, 6); // u1 now has 6 stars and no keeper
    expect(h.lot().player.id).toBe('gk-normal');
    expect(code(() => h.room.bid('u2', h.lot().lotNumber, 10))).toBe('GOALKEEPER_LIMIT');
    expect(code(() => h.room.bid('u1', h.lot().lotNumber, 10))).toBe('OK');
  });

  it('one manager cannot hoard the non-stars another needs', () => {
    // 2 managers: 24 non-stars (2 keepers) + 12 stars — exactly enough (each needs 18 − 6 non-stars).
    const nonStars = [makeCard('gk1', 'GK', 80), ...makePool(22, 0).map((p, i) => ({ ...p, id: `n${i}`, playerId: `n${i}` })), makeCard('gk2', 'GK', 80)];
    const stars = Array.from({ length: 12 }, (_, i) => star(makeCard(`s${i}`, 'ST')));
    const h = createHarness({ pool: [...nonStars, ...stars], fixedOrder: true });
    play(h, 12); // u1 takes a keeper + 11 outfielders who aren't stars
    expect(h.member('u1').squad).toHaveLength(12);
    expect(code(() => h.room.bid('u1', h.lot().lotNumber, 10))).toBe('POOL_RESERVED');
  });

  for (const seed of ['a', 'b', 'c', 'd', 'e']) {
    it(`full games on a star-heavy pool never break the cap (seed ${seed})`, () => {
      const pool = makePool(150, 20).map((p, i) => (i % 3 === 0 ? star(p) : p));
      const h = createHarness({ players: 3, pool, seed });
      completeAuction(h);
      expect(h.room.phase).toBe('SQUAD_BUILDING');
      for (const m of h.room.view().members) {
        expect(m.squad).toHaveLength(18);
        expect(m.squad.filter((e) => e.player.star).length).toBeLessThanOrEqual(6);
        expect(m.squad.some((e) => e.player.position === 'GK')).toBe(true);
      }
    });
  }

  it('auto-completed squads respect the cap too', () => {
    const pool = makePool(150, 20).map((p, i) => (i % 2 === 0 ? star(p) : p));
    const h = createHarness({ players: 2, pool });
    h.room.setConnected('u1', false);
    h.room.setConnected('u2', false);
    h.clock.advance(GAME_RULES.absentAutoFillMs + 1_000);
    expect(h.room.phase).toBe('SQUAD_BUILDING');
    for (const m of h.room.view().members) {
      expect(m.squad).toHaveLength(18);
      expect(m.squad.filter((e) => e.player.star).length).toBeLessThanOrEqual(6);
    }
  });
});

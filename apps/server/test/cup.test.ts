import { describe, expect, it } from 'vitest';
import {
  autoPick,
  buildBracket,
  cupAchievements,
  cupPlacements,
  advance,
  MatchSim,
  roundNames,
  seedOrder,
  type CupSummary,
  type CupTeam,
  type PlayerCard,
  type Position,
  type TacticId,
} from '@fa/shared';
import { createRng } from '../src/engine/rng';
import { GameError } from '../src/engine/errors';
import { completeAuction, createHarness, makeCard, testRules, toResults } from './helpers';

const code = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof GameError) return e.code;
    throw e;
  }
  return 'OK';
};

/** Lock every manager's best 4-3-3 so the cup starts after the evaluation pause. */
function lockAll(h: ReturnType<typeof createHarness>, tactic?: TacticId) {
  for (const u of h.users) {
    const squad = h.member(u.id).squad.map((e) => e.player);
    h.room.lockLineup(u.id, { formationId: '4-3-3', slots: autoPick(squad, '4-3-3'), tactic });
  }
}

function toCup(h: ReturnType<typeof createHarness>) {
  completeAuction(h);
  lockAll(h);
  expect(h.room.phase).toBe('FINAL_EVALUATION');
  h.clock.advance(testRules().evaluationMs);
  expect(h.room.phase).toBe('TOURNAMENT');
}

const ROLES: Position[] = ['GK', 'LB', 'CB', 'CB', 'RB', 'CM', 'CM', 'CAM', 'LW', 'ST', 'RW'];
function team(userId: string, total: number, rating = 80, tactic: TacticId = 'BALANCED'): CupTeam {
  const xi = ROLES.map((role, i) => ({ player: makeCard(`${userId}-${i}`, role, rating) as PlayerCard, role }));
  return {
    userId,
    name: userId,
    seed: 1,
    formationId: '4-3-3',
    score: { total, tacticId: tactic, lines: { gk: rating, def: rating, mid: rating, att: rating } },
    xi,
  };
}

function play(home: CupTeam, away: CupTeam, seed: string, mods = { home: null as null | 'ATTACK' | 'TIGHT', away: null as null | 'ATTACK' | 'TIGHT' }) {
  const sim = new MatchSim(home, away, createRng(seed));
  sim.playMinutes(45, [
    { talk: null, shout: null },
    { talk: null, shout: null },
  ]);
  sim.playMinutes(90, [
    { talk: mods.home, shout: null },
    { talk: mods.away, shout: null },
  ]);
  if (sim.goals[0] === sim.goals[1]) {
    sim.playMinutes(120, [{ talk: null, shout: null }, { talk: null, shout: null }], true);
    while (sim.goals[0] === sim.goals[1] && sim.nextKick()) {
      /* shootout */
    }
  }
  return sim;
}

describe('bracket', () => {
  it('seeds the standard way and gives byes to the top seeds', () => {
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    expect(roundNames(2)).toEqual(['Final']);
    expect(roundNames(3)).toEqual(['Semi-finals', 'Final']);
    expect(roundNames(8)).toEqual(['Quarter-finals', 'Semi-finals', 'Final']);
    const b = buildBracket(['s1', 's2', 's3', 's4', 's5']);
    const first = b.filter((x) => x.round === 0);
    expect(first).toHaveLength(4);
    expect(first.filter((x) => x.bye).map((x) => x.winnerId).sort()).toEqual(['s1', 's2', 's3']);
    expect(first.find((x) => !x.bye)).toMatchObject({ homeId: 's4', awayId: 's5' });
    for (let n = 2; n <= 8; n++) {
      const br = buildBracket(Array.from({ length: n }, (_, i) => `m${i}`));
      const ids = br.filter((x) => x.round === 0).flatMap((x) => [x.homeId, x.awayId]).filter(Boolean);
      expect(new Set(ids).size).toBe(n);
    }
  });

  it('places everyone: champion, runner-up, then by the round they went out in', () => {
    const seeds = { a: 1, b: 2, c: 3, d: 4 };
    const b = buildBracket(['a', 'b', 'c', 'd']);
    const r0 = b.filter((x) => x.round === 0);
    r0[0].winnerId = 'd'; // a v d → d
    r0[1].winnerId = 'b'; // b v c → b
    advance(b, 0);
    const final = b.find((x) => x.round === 1)!;
    expect([final.homeId, final.awayId]).toEqual(['d', 'b']);
    final.winnerId = 'd';
    expect(cupPlacements(b, seeds)).toEqual(['d', 'b', 'a', 'c']);
  });
});

describe('match engine', () => {
  it('is deterministic for a seed', () => {
    const a = play(team('h', 75), team('a', 72), 'same');
    const b = play(team('h', 75), team('a', 72), 'same');
    expect(a.events).toEqual(b.events);
    expect(a.goals).toEqual(b.goals);
  });

  it('the better-built squad usually wins — but not always', () => {
    let strong = 0;
    for (let i = 0; i < 300; i++) if (play(team('h', 80), team('a', 70), `g${i}`).winnerSide() === 0) strong++;
    expect(strong / 300).toBeGreaterThan(0.62);
    expect(strong / 300).toBeLessThan(0.95);
  });

  it('a weaker squad that suits its tactic beats a strong one that doesn’t (tactical battle)', () => {
    const edge = new MatchSim(team('h', 75, 80, 'COUNTER_ATTACK'), team('a', 75, 80, 'HIGH_PRESS'), createRng('x'));
    expect(edge.edges[0]).toContain('Counter-Attack');
    let wins = 0;
    for (let i = 0; i < 300; i++) if (play(team('h', 75, 80, 'COUNTER_ATTACK'), team('a', 75, 80, 'HIGH_PRESS'), `t${i}`).winnerSide() === 0) wins++;
    expect(wins / 300).toBeGreaterThan(0.5);
  });

  it('“Go for it” at half-time means more goals than “keep it tight”', () => {
    let open = 0;
    let tight = 0;
    for (let i = 0; i < 200; i++) {
      const o = play(team('h', 75), team('a', 75), `o${i}`, { home: 'ATTACK', away: 'ATTACK' });
      const t = play(team('h', 75), team('a', 75), `o${i}`, { home: 'TIGHT', away: 'TIGHT' });
      open += o.goals[0] + o.goals[1];
      tight += t.goals[0] + t.goals[1];
    }
    expect(open).toBeGreaterThan(tight * 1.4);
  });

  it('a knockout match always has a winner (extra time, then penalties)', () => {
    for (let i = 0; i < 100; i++) {
      const s = play(team('h', 74), team('a', 74), `p${i}`);
      expect(s.winnerSide()).not.toBeNull();
      if (s.pens) {
        expect(s.pens[0]).not.toBe(s.pens[1]);
        expect(s.shootout.length).toBeGreaterThanOrEqual(6);
      }
    }
  });

  it('every goal names a scorer from the right team, and the man of the match played', () => {
    const s = play(team('h', 78), team('a', 70), 'scorers');
    for (const e of s.events.filter((x) => x.kind === 'GOAL' || x.kind === 'PEN_GOAL')) {
      expect(e.playerId!.startsWith(e.side === 0 ? 'h-' : 'a-')).toBe(true);
    }
    expect(s.motm).toBeTypeOf('function');
    const motm = s.motm()!;
    expect(motm.startsWith('h-') || motm.startsWith('a-')).toBe(true);
  });
});

describe('the cup in a room', () => {
  it('follows the squad builder, seeded by squad score, and decides the final ranking', () => {
    const h = createHarness({ players: 4 });
    toCup(h);
    const t = h.room.view().tournament!;
    expect(t.rounds).toEqual(['Semi-finals', 'Final']);
    expect(Object.values(t.seeds).sort()).toEqual([1, 2, 3, 4]);
    // Seed 1 plays seed 4.
    const s1 = Object.keys(t.seeds).find((id) => t.seeds[id] === 1)!;
    const s4 = Object.keys(t.seeds).find((id) => t.seeds[id] === 4)!;
    expect(t.bracket.find((b) => b.round === 0 && b.slot === 0)).toMatchObject({ homeId: s1, awayId: s4 });
    toResults(h);
    const v = h.room.view();
    const champion = v.tournament!.championId!;
    expect(v.results!.rankings[0].userId).toBe(champion);
    expect(v.results!.rankings[0].cupFinish).toBe('Champion');
    expect(v.results!.rankings[1].cupFinish).toBe('Runner-up');
    expect(v.results!.rankings.slice(2).every((r) => r.cupFinish === 'Semi-finalist')).toBe(true);
    expect(v.results!.rankings.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    expect(v.results!.rankings.every((r) => r.squadRank! >= 1)).toBe(true);
    expect(v.tournament!.matches.every((m) => m.status === 'FINISHED' && m.winnerId && m.motm)).toBe(true);
    expect(h.events.some((e) => e.type === 'KICKOFF')).toBe(true);
    expect(h.events.some((e) => e.type === 'CHAMPION' && e.userId === champion)).toBe(true);
    expect(v.results!.report.headline).toContain('lifts the cup');
  });

  it('with three managers the top seed gets a bye to the final', () => {
    const h = createHarness({ players: 3 });
    toCup(h);
    const t = h.room.view().tournament!;
    const top = Object.keys(t.seeds).find((id) => t.seeds[id] === 1)!;
    expect(t.bracket.find((b) => b.round === 0 && b.bye)?.winnerId).toBe(top);
    toResults(h);
    const matches = h.room.view().tournament!.matches;
    expect(matches).toHaveLength(2);
    expect(matches[1].home.userId === top || matches[1].away.userId === top).toBe(true);
  });

  it('half-time team talks: only the two managers, only at half-time, secret until the second half', () => {
    const h = createHarness({ players: 2 });
    toCup(h);
    expect(code(() => h.room.talk('u1', 'ATTACK'))).toBe('NOT_IN_MATCH'); // not kicked off yet
    h.clock.advance(testRules().roundIntroMs);
    expect(code(() => h.room.talk('u1', 'ATTACK'))).toBe('TALK_CLOSED');
    h.clock.advance(45 * testRules().matchMinuteMs);
    let m = h.room.view('u1').tournament!.matches[0];
    expect(m.status).toBe('HALF_TIME');
    h.room.talk('u1', 'ATTACK');
    const mine = m.home.userId === 'u1' ? 'home' : 'away';
    const theirs = mine === 'home' ? 'away' : 'home';
    m = h.room.view('u1').tournament!.matches[0];
    expect(m[mine].talk).toBe('ATTACK');
    expect(h.room.view('u2').tournament!.matches[0][mine].talk).toBeNull();
    expect(h.room.view('u2').tournament!.matches[0][mine].talkChosen).toBe(true);
    // Both chose: the second half starts in a moment instead of waiting out the break.
    h.room.talk('u2', 'TIGHT');
    expect(h.room.view().tournament!.matches[0].halfTimeEndsAt! - h.clock.now()).toBeLessThanOrEqual(1_500);
    h.clock.advance(1_500);
    m = h.room.view('u2').tournament!.matches[0];
    expect(m.status).toBe('SECOND_HALF');
    expect(m[mine].talk).toBe('ATTACK');
    expect(m[theirs].talk).toBe('TIGHT');
  });

  it('touchline shouts: one of each per match, while the ball is in play', () => {
    const h = createHarness({ players: 2 });
    toCup(h);
    h.clock.advance(testRules().roundIntroMs + 10 * testRules().matchMinuteMs);
    h.room.shout('u1', 'ALL_OUT');
    expect(code(() => h.room.shout('u1', 'ALL_OUT'))).toBe('NO_SHOUT');
    const m = h.room.view().tournament!.matches[0];
    const side = m.home.userId === 'u1' ? m.home : m.away;
    expect(side.shoutsLeft).toEqual(['PARK_IT']);
    expect(m.events.some((e) => e.kind === 'SHOUT')).toBe(true);
  });

  it('events show over time: the view carries when to show each one', () => {
    const h = createHarness({ players: 2 });
    toCup(h);
    h.clock.advance(testRules().roundIntroMs + 1);
    const m = h.room.view().tournament!.matches[0];
    expect(m.clock).not.toBeNull();
    for (const e of m.events) expect(e.at).toBeGreaterThan(h.clock.now() - 1);
    // The score shown is only what has happened so far.
    expect(m.home.goals + m.away.goals).toBe(0);
  });

  it('if everyone leaves, the cup is played out at once and the game still counts', () => {
    const h = createHarness({ players: 4 });
    toCup(h);
    h.clock.advance(testRules().roundIntroMs + 5_000);
    for (const u of h.users) h.room.setConnected(u.id, false);
    h.clock.advance(testRules().abandonAfterMs);
    expect(h.room.phase).toBe('RESULTS');
    expect(h.closed).toEqual(['everyone left']);
  });
});

describe('cup achievements', () => {
  it('reads clean sheets, hat-tricks, shootouts, upsets and comebacks from the cup', () => {
    const summary: CupSummary = {
      rounds: ['Semi-finals', 'Final'],
      championId: 'c',
      placements: ['c', 'a', 'b', 'd'],
      seeds: { a: 1, b: 2, c: 3, d: 4 },
      matches: [
        {
          round: 0,
          homeId: 'a',
          awayId: 'd',
          score: [3, 1],
          halfTime: [0, 1],
          pens: null,
          winnerId: 'a',
          motm: null,
          goals: [
            { playerId: 'x', side: 0, minute: 50, pen: false },
            { playerId: 'x', side: 0, minute: 60, pen: false },
            { playerId: 'x', side: 0, minute: 70, pen: false },
            { playerId: 'y', side: 1, minute: 10, pen: false },
          ],
        },
        { round: 0, homeId: 'b', awayId: 'c', score: [0, 0], halfTime: [0, 0], pens: [3, 4], winnerId: 'c', motm: null, goals: [] },
        { round: 1, homeId: 'a', awayId: 'c', score: [0, 1], halfTime: [0, 0], pens: null, winnerId: 'c', motm: null, goals: [{ playerId: 'z', side: 1, minute: 80, pen: false }] },
      ],
    };
    const got = cupAchievements(summary);
    expect(got.a).toEqual(expect.arrayContaining(['hat_trick_hero', 'comeback']));
    expect(got.c).toEqual(expect.arrayContaining(['brick_wall', 'nerves_of_steel', 'upset']));
  });
});

describe('season mode', () => {
  it('points carry over a 3-game season, then a champion is crowned', () => {
    const h = createHarness({ players: 2, settings: { seasonLength: 3 } });
    for (let game = 1; game <= 3; game++) {
      if (game > 1) {
        expect(code(() => h.room.rematch('u2'))).toBe('NOT_HOST');
        h.room.rematch('u1');
        expect(h.room.phase).toBe('LOBBY');
        expect(h.room.view().results).toBeNull();
        expect(h.member('u2').ready).toBe(false);
        h.room.setReady('u2', true);
        h.room.start('u1');
        h.clock.advance(testRules().startCountdownMs);
      }
      completeAuction(h);
      lockAll(h);
      toResults(h);
      const season = h.room.view().season!;
      expect(season.played).toBe(game);
      expect(season.table.reduce((n, r) => n + r.points, 0)).toBe(game * (10 + 7));
    }
    const season = h.room.view().season!;
    expect(season.finished).toBe(true);
    expect(season.championId).toBe(season.table[0].userId);
    expect(h.room.view().results!.achievements[season.championId!]).toContain('season_champion');
    // A rematch after the last game starts a fresh season.
    h.room.rematch('u1');
    expect(h.room.view().season).toMatchObject({ played: 0, table: [], finished: false });
  });

  it('a rematch drops managers who already left', () => {
    const h = createHarness({ players: 3 });
    completeAuction(h);
    lockAll(h);
    toResults(h);
    h.room.leave('u3');
    h.room.rematch('u1');
    expect(h.room.memberIds().sort()).toEqual(['u1', 'u2']);
    expect(h.room.view().season).toBeNull();
  });
});

describe('reactions', () => {
  it('managers can send emojis and taunts; spectators only emojis', () => {
    const h = createHarness({ players: 2 });
    const r = h.room.react({ id: 'u1', username: 'user1' }, { emoji: '🔥' });
    expect(r).toMatchObject({ userId: 'u1', username: 'user1', emoji: '🔥' });
    expect(h.room.react({ id: 'u2', username: 'user2' }, { taunt: 'ROBBED' }).taunt).toBe('Robbed!');
    h.room.addSpectator('fan');
    expect(h.room.react({ id: 'fan', username: 'fan' }, { emoji: '😂' }).emoji).toBe('😂');
    expect(code(() => h.room.react({ id: 'fan', username: 'fan' }, { taunt: 'GG' }))).toBe('CHAT_SPECTATOR');
    expect(code(() => h.room.react({ id: 'stranger', username: 'x' }, { emoji: '😂' }))).toBe('NOT_IN_ROOM');
  });
});

describe('squad builder with managers gone', () => {
  it('once everyone still here has locked in, offline managers get 45 seconds, not 10 minutes', () => {
    const h = createHarness({ players: 2 });
    completeAuction(h);
    h.room.quit('u2');
    const squad = h.member('u1').squad.map((e) => e.player);
    h.room.lockLineup('u1', { formationId: '4-3-3', slots: autoPick(squad, '4-3-3') });
    expect(h.room.view().squadBuilding!.endsAt - h.clock.now()).toBe(testRules().squadOfflineGraceMs);
    h.clock.advance(testRules().squadOfflineGraceMs);
    expect(h.room.phase).toBe('FINAL_EVALUATION');
    expect(h.room.view().lineups!.u2.auto).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { autoPick, careerAchievements, gameAchievements, scoreSquad, type SquadEntry } from '@fa/shared';
import { completeAuction, createHarness, makeCard } from './helpers';

function squad(prefix: string, ovr: number, price = 30, value = 60): SquadEntry[] {
  const shape = ['GK', 'GK', 'CB', 'CB', 'CB', 'LB', 'RB', 'CDM', 'CM', 'CM', 'CAM', 'LW', 'RW', 'ST', 'ST'] as const;
  return shape.map((pos, i) => ({ player: makeCard(`${prefix}${i}`, pos, ovr), price, via: 'AUCTION', lotNumber: i, estimatedValue: value }));
}

function manager(userId: string, s: SquadEntry[], rank: number, eloBefore?: number) {
  const lineup = { formationId: '4-3-3', slots: autoPick(s.map((e) => e.player), '4-3-3') };
  return { userId, squad: s, lineup, eloBefore, score: { ...scoreSquad(s, lineup), userId, rank } };
}

describe('achievements', () => {
  it('awards the basics and room-size achievements', () => {
    const managers = Array.from({ length: 6 }, (_, i) => manager(`u${i}`, squad(`s${i}`, 80), i + 1));
    const a = gameAchievements({ mode: 'CASUAL', startingBudget: 1000, managers });
    expect(a.u0).toEqual(expect.arrayContaining(['first_whistle', 'champion', 'podium', 'full_house', 'perfect_fit']));
    expect(a.u2).toContain('podium');
    expect(a.u3).not.toContain('podium');
    expect(a.u5).toEqual(expect.arrayContaining(['first_whistle']));
    expect(a.u5).not.toContain('champion');
  });

  it('giant killer only in ranked wins over a much stronger opponent', () => {
    const win = manager('a', squad('a', 80), 1, 1200);
    const lose = manager('b', squad('b', 80), 2, 1350);
    expect(gameAchievements({ mode: 'RANKED', startingBudget: 1000, managers: [win, lose] }).a).toContain('giant_killer');
    expect(gameAchievements({ mode: 'CASUAL', startingBudget: 1000, managers: [win, lose] }).a).not.toContain('giant_killer');
    const close = manager('c', squad('c', 80), 2, 1250);
    expect(gameAchievements({ mode: 'RANKED', startingBudget: 1000, managers: [win, close] }).a).not.toContain('giant_killer');
  });

  it('underdog, shrewd, galacticos, bargain hunter and big spender', () => {
    const cheapWinner = manager('w', squad('w', 78, 20, 200), 1);
    const richLoser = manager('l', [...squad('l', 88, 30, 60).slice(0, 14), { ...squad('x', 88, 450, 300)[0], player: makeCard('lx', 'ST', 88) }], 2);
    const a = gameAchievements({ mode: 'CASUAL', startingBudget: 1000, managers: [cheapWinner, richLoser] });
    expect(a.w).toEqual(expect.arrayContaining(['underdog', 'shrewd', 'bargain_hunter']));
    expect(a.l).toEqual(expect.arrayContaining(['galacticos', 'big_spender']));
  });

  it('career achievements come from totals', () => {
    expect(careerAchievements({ games: 2, wins: 1, rankedElo: 1200 })).toEqual([]);
    expect(careerAchievements({ games: 10, wins: 3, rankedElo: 1400 })).toEqual(['hat_trick', 'veteran', 'elite']);
  });

  it('are part of the results for every manager', () => {
    const h = createHarness({ players: 2 });
    completeAuction(h);
    for (const u of h.users) {
      const s = h.member(u.id).squad.map((e) => e.player);
      h.room.lockLineup(u.id, { formationId: '4-3-3', slots: autoPick(s, '4-3-3') });
    }
    h.clock.advance(h.room.view('u1').resultsAt! - h.clock.now());
    const r = h.room.view('u1').results!;
    expect(r.achievements.u1).toContain('first_whistle');
    expect(r.achievements[r.rankings[0].userId]).toContain('champion');
  });
});

import { describe, expect, it } from 'vitest';
import { computeEloChanges, ELO_CONFIG } from '@fa/shared';

const veteran = (userId: string, rank: number, elo = 1200) => ({ userId, rank, elo, games: 50 });

describe('ELO', () => {
  it('winner gains, loser loses, equal ratings swing symmetrically', () => {
    const [a, b] = computeEloChanges([veteran('a', 1), veteran('b', 2)]);
    expect(a.delta).toBe(16);
    expect(b.delta).toBe(-16);
  });

  it('beating a stronger opponent earns more than beating a weaker one', () => {
    const upset = computeEloChanges([veteran('a', 1, 1200), veteran('b', 2, 1500)])[0].delta;
    const expected = computeEloChanges([veteran('a', 1, 1500), veteran('b', 2, 1200)])[0].delta;
    expect(upset).toBeGreaterThan(expected);
    expect(expected).toBeGreaterThan(0);
  });

  it('a 6-player win is worth more than a 2-player win', () => {
    const two = computeEloChanges([veteran('a', 1), veteran('b', 2)])[0].delta;
    const six = computeEloChanges(['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => veteran(id, i + 1)))[0].delta;
    expect(six).toBeGreaterThan(two);
  });

  it('middle of the table in an even room barely moves', () => {
    const changes = computeEloChanges(['a', 'b', 'c', 'd', 'e'].map((id, i) => veteran(id, i + 1)));
    expect(changes[2].delta).toBe(0);
    expect(changes[0].delta).toBeGreaterThan(0);
    expect(changes[4].delta).toBeLessThan(0);
  });

  it('new players move faster', () => {
    const fresh = computeEloChanges([{ userId: 'a', rank: 1, elo: 1200, games: 0 }, veteran('b', 2)])[0].delta;
    expect(fresh).toBe(24);
  });

  it('never drops below the floor', () => {
    const [, loser] = computeEloChanges([veteran('a', 1, 2400), veteran('b', 2, ELO_CONFIG.floor)]);
    expect(loser.after).toBe(ELO_CONFIG.floor);
  });
});

import { autoPick } from '@fa/shared';
import { completeAuction, createHarness } from './helpers';

describe('ranked games', () => {
  it('report rating changes on the results; casual games do not', async () => {
    for (const mode of ['RANKED', 'CASUAL'] as const) {
      const h = createHarness({ players: 3, settings: { mode } });
      await new Promise((r) => setTimeout(r, 0)); // ratings load
      completeAuction(h);
      for (const u of h.users) {
        const squad = h.member(u.id).squad.map((e) => e.player);
        h.room.lockLineup(u.id, { formationId: '4-3-3', slots: autoPick(squad, '4-3-3') });
      }
      h.clock.advance(h.room.view('u1').resultsAt! - h.clock.now());
      const r = h.room.view('u1').results!;
      if (mode === 'CASUAL') {
        expect(r.ratingChanges).toBeNull();
        continue;
      }
      expect(r.ratingChanges).toHaveLength(3);
      const byUser = new Map(r.ratingChanges!.map((c) => [c.userId, c]));
      expect(byUser.get(r.rankings[0].userId)!.delta).toBeGreaterThan(0);
      expect(byUser.get(r.rankings[2].userId)!.delta).toBeLessThan(0);
      expect(r.ratingChanges!.reduce((s, c) => s + c.delta, 0)).toBe(0);
    }
  });
});

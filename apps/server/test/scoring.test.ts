import { describe, expect, it } from 'vitest';
import {
  chemistryLinks,
  getFormation,
  rankScores,
  scoreSquad,
  tierFor,
  type PlayerCard,
  type Position,
  type SquadEntry,
} from '@fa/shared';
import { completeAuction, createHarness, toResults } from './helpers';
import { autoPick } from '@fa/shared';

/** A player whose attributes look like a real player of that position. */
function player(id: string, pos: Position, ovr: number, o: { club?: string; nation?: string; league?: string } = {}): PlayerCard {
  const isGk = pos === 'GK';
  const hi = Math.min(99, ovr + 3);
  const mid = ovr - 6;
  const lo = Math.max(20, ovr - 35);
  const profiles: Record<string, [number, number, number, number, number, number]> = {
    // pace, shooting, passing, dribbling, defending, physical
    CB: [mid, lo, mid, lo, hi, hi],
    LB: [hi, lo, mid, mid, hi, mid],
    RB: [hi, lo, mid, mid, hi, mid],
    CDM: [mid, lo, hi, mid, hi, hi],
    CM: [mid, mid, hi, hi, mid, mid],
    CAM: [mid, hi, hi, hi, lo, lo],
    LW: [hi, hi, mid, hi, lo, lo],
    RW: [hi, hi, mid, hi, lo, lo],
    ST: [hi, hi, lo, mid, lo, hi],
  };
  const [pace, shooting, passing, dribbling, defending, physical] = profiles[pos] ?? profiles.CM;
  const club = o.club ?? `club-${id}`;
  return {
    id,
    playerId: id,
    name: id,
    shortName: id,
    nation: { code: o.nation ?? `N${id}`, name: o.nation ?? id, flag: '' },
    club: { id: club, name: club, shortName: 'CLB', colors: ['#000', '#fff'], logoUrl: null },
    league: o.league ?? `league-${id}`,
    season: '2026-27',
    position: pos,
    secondaryPositions: [],
    overall: ovr,
    tier: tierFor(ovr),
    outfield: isGk ? null : { pace, shooting, passing, dribbling, defending, physical },
    goalkeeping: isGk ? { diving: hi, handling: ovr, kicking: mid, reflexes: hi, speed: lo, positioning: ovr } : null,
    age: 26,
    preferredFoot: 'Right',
    heightCm: 185,
    imageUrl: null,
    imageCredit: null,
  };
}

const SHAPE: Position[] = ['GK', 'GK', 'CB', 'CB', 'CB', 'LB', 'RB', 'CDM', 'CM', 'CM', 'CAM', 'LW', 'RW', 'ST', 'ST'];

function squadOf(ratings: number | number[], o: Parameters<typeof player>[3] = {}, prefix = 'p', price = 50): SquadEntry[] {
  return SHAPE.map((pos, i) => {
    const ovr = Array.isArray(ratings) ? ratings[i] : ratings;
    return { player: player(`${prefix}${i}`, pos, ovr, o), price, via: 'AUCTION' as const, lotNumber: i + 1, estimatedValue: 60 };
  });
}

const best = (squad: SquadEntry[], formationId = '4-3-3') => ({
  formationId,
  slots: autoPick(squad.map((e) => e.player), formationId),
});

describe('scoring engine', () => {
  it('is deterministic', () => {
    const s = squadOf(82);
    const l = best(s);
    expect(scoreSquad(s, l)).toEqual(scoreSquad(s, l));
  });

  it('weights sum to 1 and components stay within 0–100', () => {
    const s = squadOf(82);
    const r = scoreSquad(s, best(s));
    for (const v of Object.values(r.breakdown)) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(100);
    expect(r.total).toBeGreaterThan(0);
    expect(r.total).toBeLessThanOrEqual(100);
  });

  it('penalises players out of position', () => {
    const s = squadOf(84);
    const good = best(s);
    const scrambled = { ...good, slots: [...good.slots] };
    // put the centre-backs up front and the strikers at centre-back
    const f = getFormation('4-3-3')!;
    const cb = f.slots.findIndex((x) => x.role === 'CB');
    const st = f.slots.findIndex((x) => x.role === 'ST');
    [scrambled.slots[cb], scrambled.slots[st]] = [scrambled.slots[st], scrambled.slots[cb]];
    const a = scoreSquad(s, good);
    const b = scoreSquad(s, scrambled);
    expect(b.breakdown.positionFit).toBeLessThan(a.breakdown.positionFit);
    expect(b.breakdown.quality).toBeLessThan(a.breakdown.quality);
    expect(b.total).toBeLessThan(a.total);
    expect(b.notes.some((n) => n.text.includes('out of position'))).toBe(true);
  });

  it('rewards chemistry — same club / nation links', () => {
    const mixed = squadOf(82);
    const united = squadOf(82, { club: 'fc', nation: 'ENG', league: 'pl' });
    const a = scoreSquad(mixed, best(mixed));
    const b = scoreSquad(united, best(united));
    expect(b.breakdown.chemistry).toBeGreaterThan(a.breakdown.chemistry);
    expect(b.links.every((l) => l.strength === 'STRONG')).toBe(true);
    expect(a.links.every((l) => l.strength === 'WEAK')).toBe(true);
  });

  it('chemistry never lets a weak squad beat an elite one', () => {
    const weakPerfectChem = squadOf(75, { club: 'fc', nation: 'ENG', league: 'pl' }, 'w', 30);
    const eliteNoChem = squadOf(87, {}, 'e', 30);
    const w = scoreSquad(weakPerfectChem, best(weakPerfectChem));
    const e = scoreSquad(eliteNoChem, best(eliteNoChem));
    expect(w.breakdown.chemistry).toBeGreaterThan(e.breakdown.chemistry);
    expect(e.total).toBeGreaterThan(w.total);
  });

  it('a balanced XI beats superstar attackers with a weak spine at similar average', () => {
    const topHeavy = squadOf(SHAPE.map((p) => (['LW', 'RW', 'ST'].includes(p) ? 94 : 77)), {}, 't');
    const balanced = squadOf(81, {}, 'b');
    const t = scoreSquad(topHeavy, best(topHeavy));
    const b = scoreSquad(balanced, best(balanced));
    expect(t.breakdown.balance).toBeLessThan(b.breakdown.balance);
    expect(b.total).toBeGreaterThan(t.total);
  });

  it('formations matter: strikers forced onto the wings cost tactics and fit', () => {
    const wingers = squadOf(84);
    const strikers = squadOf(84).map((e) =>
      ['LW', 'RW'].includes(e.player.position) ? { ...e, player: player(e.player.id, 'ST', 84) } : e,
    );
    const w = scoreSquad(wingers, best(wingers));
    const s = scoreSquad(strikers, best(strikers));
    expect(s.breakdown.positionFit).toBeLessThan(w.breakdown.positionFit);
    expect(s.total).toBeLessThan(w.total);
  });

  it('buying the same squad cheaper scores better on efficiency', () => {
    const cheap = squadOf(82, {}, 'c', 30);
    const dear = squadOf(82, {}, 'c', 120);
    const a = scoreSquad(cheap, best(cheap));
    const b = scoreSquad(dear, best(dear));
    expect(a.breakdown.efficiency).toBeGreaterThan(b.breakdown.efficiency);
    expect(a.total - b.total).toBeLessThan(6); // efficiency is only 5%
  });

  it('chemistry links connect neighbouring slots in every formation', () => {
    const s = squadOf(80, { club: 'fc' });
    const l = best(s);
    const links = chemistryLinks(l, new Map(s.map((e) => [e.player.id, e.player])));
    expect(links.length).toBeGreaterThanOrEqual(11);
    const touched = new Set(links.flatMap((x) => [x.a, x.b]));
    expect(touched.size).toBe(11);
  });

  it('ranks by total, breaking ties deterministically', () => {
    const s = squadOf(80);
    const score = scoreSquad(s, best(s));
    const ranked = rankScores([
      { userId: 'b', score },
      { userId: 'a', score },
      { userId: 'c', score: { ...score, total: score.total + 1 } },
    ]);
    expect(ranked.map((r) => r.userId)).toEqual(['c', 'a', 'b']);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });
});

describe('results phase', () => {
  it('scores every manager after lineups, then shows results', () => {
    const h = createHarness({ players: 3 });
    completeAuction(h);
    for (const u of h.users) {
      const squad = h.member(u.id).squad.map((e) => e.player);
      h.room.lockLineup(u.id, { formationId: '4-4-2', slots: autoPick(squad, '4-4-2') });
    }
    expect(h.room.phase).toBe('FINAL_EVALUATION');
    expect(h.room.view('u1').results).toBeNull();
    toResults(h);
    expect(h.room.phase).toBe('RESULTS');
    const r = h.room.view('u2').results!;
    expect(r.rankings.map((x) => x.rank)).toEqual([1, 2, 3]);
    expect(new Set(r.rankings.map((x) => x.userId))).toEqual(new Set(['u1', 'u2', 'u3']));
    for (let i = 1; i < r.rankings.length; i++) expect(r.rankings[i - 1].total).toBeGreaterThanOrEqual(r.rankings[i].total);
    expect(h.events.some((e) => e.type === 'RESULTS')).toBe(true);
  });
});

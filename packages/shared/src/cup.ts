import type { BracketSlotView } from './types';

/**
 * The cup: a knockout bracket seeded by squad score (the best squad is seed 1).
 * When the number of managers isn't a power of two the top seeds get byes, so
 * building the best squad still pays off.
 */

/** Standard seeding order for a bracket of `size` (1 v size, …). */
export function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  return order;
}

export function bracketSize(managers: number) {
  let s = 1;
  while (s < managers) s *= 2;
  return Math.max(2, s);
}

export function roundNames(managers: number): string[] {
  const size = bracketSize(managers);
  const names: string[] = [];
  for (let teams = size; teams >= 2; teams /= 2) {
    names.push(teams === 2 ? 'Final' : teams === 4 ? 'Semi-finals' : teams === 8 ? 'Quarter-finals' : `Round of ${teams}`);
  }
  return names;
}

/** First-round slots, with byes where a seed has no opponent, and empty later rounds. */
export function buildBracket(seeded: string[]): BracketSlotView[] {
  const size = bracketSize(seeded.length);
  const order = seedOrder(size);
  const slots: BracketSlotView[] = [];
  for (let s = 0; s < size / 2; s++) {
    const homeId = seeded[order[2 * s] - 1] ?? null;
    const awayId = seeded[order[2 * s + 1] - 1] ?? null;
    const bye = !homeId || !awayId;
    slots.push({ round: 0, slot: s, homeId, awayId, bye, matchId: null, winnerId: bye ? (homeId ?? awayId) : null });
  }
  let count = size / 4;
  for (let r = 1; count >= 1; r++, count /= 2) {
    for (let s = 0; s < count; s++) slots.push({ round: r, slot: s, homeId: null, awayId: null, bye: false, matchId: null, winnerId: null });
  }
  return slots;
}

/** Fill the next round from the winners of this one (winner of slot 2s is home, 2s+1 away). */
export function advance(bracket: BracketSlotView[], round: number) {
  for (const next of bracket.filter((b) => b.round === round + 1)) {
    next.homeId = bracket.find((b) => b.round === round && b.slot === next.slot * 2)?.winnerId ?? null;
    next.awayId = bracket.find((b) => b.round === round && b.slot === next.slot * 2 + 1)?.winnerId ?? null;
  }
}

/**
 * Final positions: the champion, the runner-up, then everyone else by the round
 * they went out in (later is better), ties broken by seed.
 */
export function cupPlacements(bracket: BracketSlotView[], seeds: Record<string, number>): string[] {
  const rounds = Math.max(...bracket.map((b) => b.round));
  const final = bracket.find((b) => b.round === rounds);
  const out: string[] = [];
  if (final?.winnerId) out.push(final.winnerId);
  for (let r = rounds; r >= 0; r--) {
    const losers = bracket
      .filter((b) => b.round === r && !b.bye && b.winnerId)
      .map((b) => (b.homeId === b.winnerId ? b.awayId : b.homeId))
      .filter((id): id is string => !!id && !out.includes(id))
      .sort((a, b) => (seeds[a] ?? 99) - (seeds[b] ?? 99));
    out.push(...losers);
  }
  // Anyone not placed yet (shouldn't happen) goes last by seed.
  for (const id of Object.keys(seeds).sort((a, b) => seeds[a] - seeds[b])) if (!out.includes(id)) out.push(id);
  return out;
}

/** What a manager achieved in the cup, for labels ("Champion", "Semi-finalist"…). */
export function cupFinish(bracket: BracketSlotView[], userId: string, rounds: string[]): string {
  const last = rounds.length - 1;
  const final = bracket.find((b) => b.round === last);
  if (final?.winnerId === userId) return 'Champion';
  if (final && (final.homeId === userId || final.awayId === userId)) return 'Runner-up';
  for (let r = last - 1; r >= 0; r--) {
    const out = bracket.find((b) => b.round === r && !b.bye && b.winnerId && b.winnerId !== userId && (b.homeId === userId || b.awayId === userId));
    if (out) return r === last - 1 ? 'Semi-finalist' : r === last - 2 ? 'Quarter-finalist' : `Out in the ${rounds[r]}`;
  }
  return 'Out';
}

/** Compact record of the cup, kept with the game (match page, awards, achievements). */
export interface CupSummary {
  rounds: string[];
  championId: string | null;
  /** userIds in final order. */
  placements: string[];
  seeds: Record<string, number>;
  matches: {
    round: number;
    homeId: string;
    awayId: string;
    score: [number, number];
    halfTime: [number, number];
    pens: [number, number] | null;
    winnerId: string;
    /** Man of the match and the manager he plays for. */
    motm: { playerId: string; userId: string } | null;
    goals: { playerId: string; side: 0 | 1; minute: number; pen: boolean; assistId?: string }[];
  }[];
}

export interface CupPlayerLine {
  userId: string;
  goals: number;
  assists: number;
  motm: number;
}

/** Goals, assists and man-of-the-match awards per player across the cup. */
export function cupPlayerLines(summary: CupSummary): Map<string, CupPlayerLine> {
  const out = new Map<string, CupPlayerLine>();
  const line = (playerId: string, userId: string) => {
    let l = out.get(playerId);
    if (!l) out.set(playerId, (l = { userId, goals: 0, assists: 0, motm: 0 }));
    return l;
  };
  for (const m of summary.matches) {
    for (const g of m.goals) {
      const owner = g.side === 0 ? m.homeId : m.awayId;
      line(g.playerId, owner).goals++;
      if (g.assistId) line(g.assistId, owner).assists++;
    }
    if (m.motm) line(m.motm.playerId, m.motm.userId).motm++;
  }
  return out;
}

/** Achievement keys earned in the cup, per manager. */
export function cupAchievements(summary: CupSummary): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (id: string, key: string) => {
    (out[id] ??= []).includes(key) || out[id].push(key);
  };
  const champ = summary.championId;
  if (champ) {
    const played = summary.matches.filter((m) => m.homeId === champ || m.awayId === champ);
    const conceded = played.reduce((n, m) => n + (m.homeId === champ ? m.score[1] : m.score[0]), 0);
    if (played.length > 0 && conceded === 0) add(champ, 'brick_wall');
  }
  for (const m of summary.matches) {
    const sides = [m.homeId, m.awayId];
    const loserId = m.winnerId === m.homeId ? m.awayId : m.homeId;
    const winSide = m.winnerId === m.homeId ? 0 : 1;
    // Hat-trick for one of your players.
    const tally = new Map<string, number>();
    for (const g of m.goals) tally.set(`${g.side}:${g.playerId}`, (tally.get(`${g.side}:${g.playerId}`) ?? 0) + 1);
    for (const [k, n] of tally) if (n >= 3) add(sides[Number(k[0])], 'hat_trick_hero');
    if (m.pens) add(m.winnerId, 'nerves_of_steel');
    if ((summary.seeds[m.winnerId] ?? 0) - (summary.seeds[loserId] ?? 0) >= 2) add(m.winnerId, 'upset');
    const ht = m.halfTime;
    if (ht[winSide] < ht[1 - winSide]) add(m.winnerId, 'comeback');
  }
  return out;
}

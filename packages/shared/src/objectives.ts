/**
 * Secret objectives: every manager gets a couple of hidden side goals at the
 * start of a game, worth bonus points if completed. They push managers towards
 * different players, so no two auctions play out the same way.
 *
 * Each check only reads the final squad, XI and score, so results stay
 * deterministic.
 */
import { isStarPlayer } from './stars';
import type { PlayerCard } from './types';

export const OBJECTIVES = {
  CLUB_TRIO: { label: 'Club connection', text: 'Start 3+ players from the same club' },
  NATION_FOUR: { label: 'National core', text: 'Start 4+ players from the same country' },
  YOUTH: { label: 'Youth movement', text: 'Starting XI average age 25 or under' },
  VETERANS: { label: 'Old heads', text: 'Start 3+ players aged 31 or over' },
  WONDERKIDS: { label: 'Wonderkids', text: 'Start 2+ players aged 21 or under' },
  FRUGAL: { label: 'Budget hawk', text: 'Finish with at least 25% of your budget unspent' },
  BARGAINS: { label: 'Bargain hunter', text: 'Finish with 3+ players you won at auction for under half their value' },
  BIG_SPENDER: { label: 'Splash the cash', text: 'Spend 25%+ of your budget on a single player' },
  MARQUEE: { label: 'Marquee signing', text: 'Start at least one star player (Mbappé, Yamal, Kane…)' },
  ALL_IN_POSITION: { label: 'Square pegs', text: 'Every starter in a natural or secondary position' },
  COMBOS: { label: 'System builder', text: 'Trigger 3+ synergy combos' },
  TACTIC_FIT: { label: 'Tactician', text: 'Reach 85+ tactic fit' },
  LEFT_FOOTERS: { label: 'Left-footers', text: 'Start 3+ left-footed players' },
  VARIETY: { label: 'Mixed bag', text: 'Start 8+ different playstyles' },
  PACE: { label: 'Pace to burn', text: 'Start 3+ players with 85+ pace' },
  TWIN_TOWERS: { label: 'Twin towers', text: 'Start 2 centre-backs who are 189cm or taller' },
  MELTING_POT: { label: 'Melting pot', text: 'Start players from 9+ different countries' },
} as const;

export type ObjectiveId = keyof typeof OBJECTIVES;
export const OBJECTIVE_IDS = Object.keys(OBJECTIVES) as ObjectiveId[];

/** Each manager gets this many. */
export const OBJECTIVES_PER_MANAGER = 2;

/** Objectives about spending make no sense when nobody pays (snake draft). */
export const SPENDING_OBJECTIVES: readonly ObjectiveId[] = ['FRUGAL', 'BARGAINS', 'BIG_SPENDER'];

export function isObjectiveId(v: unknown): v is ObjectiveId {
  return typeof v === 'string' && v in OBJECTIVES;
}

/** Thresholds shared by the checks, the player hints and the progress counters. */
export const OBJECTIVE_RULES = {
  veteranAge: 31,
  wonderkidAge: 21,
  pace: 85,
  towerCm: 189,
  bigSpendShare: 0.25,
} as const;

/** Objectives completed by starting enough of a certain kind of player (shown as a count while you buy). */
export const PLAYER_COUNT_OBJECTIVES: readonly ObjectiveId[] = ['VETERANS', 'WONDERKIDS', 'LEFT_FOOTERS', 'PACE', 'TWIN_TOWERS', 'MARQUEE'];

/** Player-level objectives: does this player count towards it? (null = not a per-player objective) */
export function countsTowards(id: ObjectiveId, p: PlayerCard): boolean | null {
  const r = OBJECTIVE_RULES;
  switch (id) {
    case 'VETERANS':
      return p.age >= r.veteranAge;
    case 'WONDERKIDS':
      return p.age <= r.wonderkidAge;
    case 'YOUTH':
      return p.age <= 25;
    case 'LEFT_FOOTERS':
      return p.preferredFoot === 'Left';
    case 'PACE':
      return (p.outfield?.pace ?? 0) >= r.pace;
    case 'TWIN_TOWERS':
      return p.position === 'CB' && p.heightCm >= r.towerCm;
    case 'MARQUEE':
      return isStarPlayer(p);
    default:
      return null;
  }
}

/**
 * Small facts to show next to a player so you can work towards your objectives
 * without opening every card: their age always, plus whatever your objectives
 * care about (foot, pace, height, club, country). `hit` marks players that count.
 */
export function playerHints(ids: readonly ObjectiveId[], p: PlayerCard): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  const ageIds = ids.filter((id) => id === 'VETERANS' || id === 'WONDERKIDS' || id === 'YOUTH');
  out.push({ text: `${p.age}y`, hit: ageIds.some((id) => countsTowards(id, p)) });
  for (const id of ids) {
    const hit = !!countsTowards(id, p);
    if (id === 'LEFT_FOOTERS') out.push({ text: p.preferredFoot === 'Left' ? 'Left foot' : 'Right foot', hit });
    if (id === 'PACE' && p.outfield) out.push({ text: `${p.outfield.pace} pace`, hit });
    if (id === 'TWIN_TOWERS' && p.position === 'CB') out.push({ text: `${p.heightCm}cm`, hit });
    if (id === 'MARQUEE' && hit) out.push({ text: '★ star', hit });
    if (id === 'CLUB_TRIO') out.push({ text: p.club.name, hit: false });
    if (id === 'NATION_FOUR' || id === 'MELTING_POT') out.push({ text: `${p.nation.flag} ${p.nation.code}`, hit: false });
  }
  return out;
}

/**
 * Objectives this player pool can't reasonably support (no stars in the Icons
 * pool, hardly any youngsters among legends at their peak…). They're never drawn.
 */
export function unsupportedObjectives(pool: readonly PlayerCard[]): ObjectiveId[] {
  if (pool.length === 0) return [];
  const share = (id: ObjectiveId) => pool.filter((p) => countsTowards(id, p)).length / pool.length;
  const out: ObjectiveId[] = [];
  if (pool.filter((p) => isStarPlayer(p)).length < 6) out.push('MARQUEE');
  if (share('WONDERKIDS') < 0.06) out.push('WONDERKIDS');
  if (share('YOUTH') < 0.3) out.push('YOUTH');
  if (share('VETERANS') < 0.06) out.push('VETERANS');
  if (share('PACE') < 0.04) out.push('PACE');
  if (pool.filter((p) => countsTowards('TWIN_TOWERS', p)).length < 12) out.push('TWIN_TOWERS');
  const nations = new Map<string, number>();
  for (const p of pool) nations.set(p.nation.code, (nations.get(p.nation.code) ?? 0) + 1);
  // Too few countries, or one country dominates (La Liga, Bundesliga).
  if (nations.size < 16 || Math.max(...nations.values()) / pool.length >= 0.38) out.push('MELTING_POT');
  return out;
}

/**
 * Pick `count` different objectives using a 0–1 random source (seeded on the
 * server, so the draw is reproducible from the game seed).
 */
export function drawObjectives(rand: () => number, count = OBJECTIVES_PER_MANAGER, exclude: readonly ObjectiveId[] = []): ObjectiveId[] {
  let pool = OBJECTIVE_IDS.filter((id) => !exclude.includes(id));
  const out: ObjectiveId[] = [];
  while (out.length < count && pool.length) {
    const id = pool.splice(Math.floor(rand() * pool.length), 1)[0];
    out.push(id);
    const clash = CLASHES.find((c) => c.includes(id));
    if (clash) pool = pool.filter((x) => !clash.includes(x));
  }
  return out;
}

/** Pairs that pull against each other; a manager never gets both. */
const CLASHES: readonly (readonly ObjectiveId[])[] = [
  ['YOUTH', 'VETERANS'],
  ['FRUGAL', 'BIG_SPENDER'],
];

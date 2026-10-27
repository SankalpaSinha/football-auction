/**
 * Secret objectives: every manager gets a couple of hidden side goals at the
 * start of a game, worth bonus points if completed. They push managers towards
 * different players, so no two auctions play out the same way.
 *
 * Each check only reads the final squad, XI and score, so results stay
 * deterministic.
 */

export const OBJECTIVES = {
  CLUB_TRIO: { label: 'Club connection', text: 'Start 3+ players from the same club' },
  NATION_FOUR: { label: 'National core', text: 'Start 4+ players from the same country' },
  YOUTH: { label: 'Youth movement', text: 'Starting XI average age 25 or under' },
  VETERANS: { label: 'Old heads', text: 'Start 3+ players aged 31 or over' },
  FRUGAL: { label: 'Budget hawk', text: 'Finish with at least 25% of your budget unspent' },
  BARGAINS: { label: 'Bargain hunter', text: 'Finish with 3+ players you won at auction for under half their value' },
  NO_SUPERSTARS: { label: 'No superstars', text: 'No star players (Mbappé, Yamal, Kane…) in your starting XI' },
  ALL_IN_POSITION: { label: 'Square pegs', text: 'Every starter in a natural or secondary position' },
  COMBOS: { label: 'System builder', text: 'Trigger 3+ synergy combos' },
  TACTIC_FIT: { label: 'Tactician', text: 'Reach 85+ tactic fit' },
  LEFT_FOOTERS: { label: 'Left-footers', text: 'Start 3+ left-footed players' },
  VARIETY: { label: 'Mixed bag', text: 'Start 8+ different playstyles' },
} as const;

export type ObjectiveId = keyof typeof OBJECTIVES;
export const OBJECTIVE_IDS = Object.keys(OBJECTIVES) as ObjectiveId[];

/** Each manager gets this many. */
export const OBJECTIVES_PER_MANAGER = 2;

/** Objectives about spending make no sense when nobody pays (snake draft). */
export const SPENDING_OBJECTIVES: readonly ObjectiveId[] = ['FRUGAL', 'BARGAINS'];

export function isObjectiveId(v: unknown): v is ObjectiveId {
  return typeof v === 'string' && v in OBJECTIVES;
}

/**
 * Pick `count` different objectives using a 0–1 random source (seeded on the
 * server, so the draw is reproducible from the game seed).
 */
export function drawObjectives(rand: () => number, count = OBJECTIVES_PER_MANAGER, exclude: readonly ObjectiveId[] = []): ObjectiveId[] {
  const pool = OBJECTIVE_IDS.filter((id) => !exclude.includes(id));
  const out: ObjectiveId[] = [];
  while (out.length < count && pool.length) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return out;
}

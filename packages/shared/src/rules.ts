/**
 * Default game rules. The server owns the effective values; clients only use
 * these for display (button labels, option lists). Everything here is meant to
 * be tuned without touching game logic.
 */
export interface GameRules {
  squadSize: number;
  minGoalkeepers: number;
  minPlayers: number;
  maxPlayers: number;
  budgetOptions: number[];
  defaultBudget: number;
  lotDurationOptions: number[];
  defaultLotDurationSec: number;
  /** Minimum opening bid for any lot. */
  openingBid: number;
  /** Minimum raise over the current bid. */
  minIncrement: number;
  bidIncrements: number[];
  /** Coins that must be kept back for every *other* empty squad slot. */
  reservePerSlot: number;
  /** A bid in the last `thresholdMs` resets the clock to `extendToMs`. */
  antiSnipe: { enabled: boolean; thresholdMs: number; extendToMs: number };
  startCountdownMs: number;
  soldRevealMs: number;
  unsoldRevealMs: number;
  /** When someone without a GK is down to this many open slots, GKs are pulled forward. */
  gkUrgencySlots: number;
  /** Time managers get to pick formation + starting XI after the auction. */
  squadBuildingMs: number;
  /** Suspense pause between lineup reveal and the results. */
  evaluationMs: number;
  lobbyDisconnectGraceMs: number;
  hostTransferGraceMs: number;
  abandonAfterMs: number;
}

/**
 * Default game rules. The server owns the effective values; clients only use
 * these for display (button labels, option lists). Everything here is meant to
 * be tuned without touching game logic.
 */
export const GAME_RULES: Readonly<GameRules> = {
  squadSize: 15,
  minGoalkeepers: 1,
  minPlayers: 2,
  maxPlayers: 6,
  budgetOptions: [500, 750, 1000, 1500, 2000],
  defaultBudget: 1000,
  lotDurationOptions: [15, 20, 30, 45],
  defaultLotDurationSec: 30,
  openingBid: 10,
  minIncrement: 10,
  bidIncrements: [10, 25, 50, 100],
  reservePerSlot: 10,
  antiSnipe: { enabled: true, thresholdMs: 3_000, extendToMs: 5_000 },
  startCountdownMs: 3_000,
  soldRevealMs: 3_500,
  unsoldRevealMs: 1_600,
  gkUrgencySlots: 2,
  squadBuildingMs: 180_000,
  evaluationMs: 4_000,
  lobbyDisconnectGraceMs: 60_000,
  hostTransferGraceMs: 10_000,
  abandonAfterMs: 5 * 60_000,
};

export function makeRules(overrides: Partial<GameRules> = {}): GameRules {
  return { ...structuredClone(GAME_RULES as GameRules), ...overrides };
}

export const TIERS = ['COMMON', 'RARE', 'ELITE', 'LEGENDARY'] as const;
export type Tier = (typeof TIERS)[number];

/** Visual rarity only — never used for scoring. */
export const TIER_THRESHOLDS: { tier: Tier; minOverall: number }[] = [
  { tier: 'LEGENDARY', minOverall: 89 },
  { tier: 'ELITE', minOverall: 85 },
  { tier: 'RARE', minOverall: 80 },
  { tier: 'COMMON', minOverall: 0 },
];

export function tierFor(overall: number): Tier {
  return TIER_THRESHOLDS.find((t) => overall >= t.minOverall)!.tier;
}

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
  /**
   * If every manager who still needs players is offline this long, their squads are
   * auto-completed so the people still playing can finish the game.
   */
  absentAutoFillMs: number;
  /** Free pick (only one manager still needs players): time allowed per pick. */
  freePickMs: number;
  /** Pause votes: how long everyone has to agree to a pause. */
  pauseVoteMs: number;
  /** An agreed pause ends by itself after this long. */
  maxPauseMs: number;
  /** A manager must wait this long between pause requests. */
  pauseRequestCooldownMs: number;
  /**
   * Lots in a row a manager may let run out without bidding or skipping (while
   * others are playing) before they are removed. They are warned one lot earlier.
   */
  inactiveLotsToRemove: number;
  /** At most `max` real-world superstars (see stars.ts) per squad, so nobody can hoard them. */
  starCap: { max: number };
  /**
   * A manager whose app has been in the background this long is treated like a
   * disconnected one (lots and pause votes stop waiting for them). Shorter absences change nothing.
   */
  awayGraceMs: number;
  /** Trade offers lapse after this long. */
  tradeOfferMs: number;
  /** Most players each side can put into one trade. */
  maxTradePlayers: number;
  /** Time managers get to pick formation + starting XI after the auction. */
  squadBuildingMs: number;
  /**
   * Once every connected manager has locked in, managers who are offline get at most
   * this long before their lineup is completed for them.
   */
  squadOfflineGraceMs: number;
  /** Suspense pause between lineup reveal and the results. */
  evaluationMs: number;
  lobbyDisconnectGraceMs: number;
  hostTransferGraceMs: number;
  abandonAfterMs: number;

  // ------------------------------------------------------------ twists
  /** Lot n is a mystery lot when n is a multiple of this (0 = never). */
  mysteryEvery: number;
  /** Lot n is a sealed-bid lot when n % sealedEvery === sealedEvery / 2 (0 = never). */
  sealedEvery: number;
  /** A market event starts roughly every this many lots… */
  marketEvery: number;
  /** …and covers this many lots. */
  marketLots: number;
  /** After a sale, managers with a Steal card have this long to match the price. */
  stealWindowMs: number;
  /** Most any single player can cost (Budget Cap), or null for no cap. */
  maxPrice: number | null;

  // ------------------------------------------------------------ the cup
  /** Real time per match minute (a half of 45 minutes ≈ 18s). */
  matchMinuteMs: number;
  /** Real time per extra-time minute. */
  extraMinuteMs: number;
  /** Half-time: managers pick a team talk. */
  halfTimeMs: number;
  /** Between penalty kicks. */
  penaltyKickMs: number;
  /** Pause before a round kicks off (bracket on screen). */
  roundIntroMs: number;
  /** Pause after a round before the next one. */
  roundBreakMs: number;
  /** Trophy lift before the results screen. */
  ceremonyMs: number;
  /** Snake draft: an offline picker gets this long before a pick is made for them. */
  draftOfflinePickMs: number;
}

/**
 * Default game rules. The server owns the effective values; clients only use
 * these for display (button labels, option lists). Everything here is meant to
 * be tuned without touching game logic.
 */
export const GAME_RULES: Readonly<GameRules> = {
  squadSize: 18,
  minGoalkeepers: 1,
  minPlayers: 2,
  maxPlayers: 8,
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
  absentAutoFillMs: 60_000,
  freePickMs: 60_000,
  pauseVoteMs: 20_000,
  maxPauseMs: 5 * 60_000,
  pauseRequestCooldownMs: 30_000,
  inactiveLotsToRemove: 5,
  starCap: { max: 3 },
  awayGraceMs: 20_000,
  tradeOfferMs: 90_000,
  maxTradePlayers: 3,
  squadBuildingMs: 600_000,
  squadOfflineGraceMs: 45_000,
  evaluationMs: 4_000,
  lobbyDisconnectGraceMs: 60_000,
  hostTransferGraceMs: 10_000,
  abandonAfterMs: 5 * 60_000,
  mysteryEvery: 10,
  sealedEvery: 12,
  marketEvery: 15,
  marketLots: 3,
  stealWindowMs: 3_000,
  maxPrice: null,
  matchMinuteMs: 400,
  extraMinuteMs: 300,
  halfTimeMs: 9_000,
  penaltyKickMs: 1_300,
  roundIntroMs: 4_000,
  roundBreakMs: 6_000,
  ceremonyMs: 5_000,
  draftOfflinePickMs: 4_000,
};

export function makeRules(overrides: Partial<GameRules> = {}): GameRules {
  return { ...structuredClone(GAME_RULES as GameRules), ...overrides };
}

// ---------------------------------------------------------------- formats

export const GAME_FORMATS = {
  CLASSIC: { label: 'Classic', emoji: '🔨', blurb: '18-man squads and open bidding.' },
  BLITZ: { label: 'Blitz', emoji: '⚡', blurb: '11-man squads and 10-second lots — about 10 minutes.' },
  BUDGET: { label: 'Budget Cap', emoji: '🪙', blurb: 'Every player costs 1–5 coins. It’s all about fit and tactics.' },
  DRAFT: { label: 'Snake Draft', emoji: '🐍', blurb: 'No bidding: take turns picking. Calm and great for new players.' },
} as const;

export const FORMAT_IDS = Object.keys(GAME_FORMATS) as (keyof typeof GAME_FORMATS)[];

/** Budget Cap: everyone gets this many coins. */
export const BUDGET_CAP_BUDGET = 50;
/** Blitz: seconds per lot. */
export const BLITZ_LOT_SEC = 10;

export const ALL_TWISTS = { mystery: true, sealed: true, events: true, cards: true } as const;
export const NO_TWISTS = { mystery: false, sealed: false, events: false, cards: false } as const;

/** The rules a room actually plays with, given its format. */
export function rulesForFormat(base: GameRules, format: 'CLASSIC' | 'BLITZ' | 'BUDGET' | 'DRAFT'): GameRules {
  switch (format) {
    case 'BLITZ':
      return {
        ...base,
        squadSize: 11,
        soldRevealMs: Math.min(base.soldRevealMs, 2_800),
        unsoldRevealMs: Math.min(base.unsoldRevealMs, 1_200),
        squadBuildingMs: Math.min(base.squadBuildingMs, 180_000),
        mysteryEvery: base.mysteryEvery && 6,
        sealedEvery: base.sealedEvery && 8,
        marketEvery: base.marketEvery && 10,
        marketLots: Math.min(base.marketLots, 2),
      };
    case 'BUDGET':
      return { ...base, openingBid: 1, minIncrement: 1, bidIncrements: [1, 2], reservePerSlot: 1, maxPrice: 5 };
    default:
      return base;
  }
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

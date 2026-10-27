import type { MarketEventId, NationRef, PlayerCard, PowerCardId } from './types';
import type { Position } from './positions';

/**
 * Auction twists that keep games from playing out the same way: mystery lots,
 * sealed bids, market events and power cards. Plus the touchline banter
 * (emoji reactions and preset taunts).
 */

export const POWER_CARDS: Record<PowerCardId, { label: string; emoji: string; blurb: string }> = {
  FREEZE: { label: 'Freeze', emoji: '❄️', blurb: 'Block one rival from bidding on the current player.' },
  STEAL: { label: 'Steal', emoji: '🦹', blurb: 'Right after a sale, pay the same price and take the player.' },
  REFUND: { label: 'Refund', emoji: '💸', blurb: 'Release a player and get half the price back.' },
};
export const POWER_CARD_IDS = Object.keys(POWER_CARDS) as PowerCardId[];

export const MARKET_EVENTS: Record<MarketEventId, { label: string; emoji: string; blurb: string }> = {
  DEADLINE_DAY: { label: 'Deadline day', emoji: '🔥', blurb: 'Panic in the market: winning bids cost +20%.' },
  BARGAIN_HOUR: { label: 'Bargain hour', emoji: '🛍️', blurb: 'Bidding opens at 1 coin.' },
  QUICK_FIRE: { label: 'Quick-fire', emoji: '⏱️', blurb: 'Half the usual time on the clock.' },
  SPONSOR: { label: 'Sponsor money', emoji: '💰', blurb: 'A new sponsor pays every manager a bonus.' },
};
export const MARKET_EVENT_IDS = Object.keys(MARKET_EVENTS) as MarketEventId[];

/** Deadline day surcharge on the winning bid. */
export const DEADLINE_SURCHARGE = 1.2;

/** What a winning bid actually costs with a surcharge (whole coins). */
export function surchargedPrice(amount: number, surcharge: number): number {
  return surcharge === 1 ? amount : Math.round(amount * surcharge);
}

/** Highest bid whose surcharged price still fits in `coins`. */
export function maxBidForCoins(coins: number, surcharge: number): number {
  if (surcharge === 1) return coins;
  let a = Math.floor(coins / surcharge);
  while (surchargedPrice(a + 1, surcharge) <= coins) a++;
  while (a > 0 && surchargedPrice(a, surcharge) > coins) a--;
  return Math.max(0, a);
}

/** Stand-in card for a mystery lot: only the position and nation are real. */
export function mysteryCard(lotNumber: number, position: Position, nation: NationRef): PlayerCard {
  return {
    id: `mystery-${lotNumber}`,
    playerId: `mystery-${lotNumber}`,
    name: 'Mystery Player',
    shortName: '???',
    nation,
    club: { id: 'mystery', name: 'Unknown club', shortName: '???', colors: ['#1e1b4b', '#a78bfa'], logoUrl: null },
    league: 'mystery',
    season: '',
    position,
    secondaryPositions: [],
    overall: 0,
    tier: 'COMMON',
    outfield: null,
    goalkeeping: null,
    age: 0,
    preferredFoot: 'Right',
    heightCm: 0,
    imageUrl: null,
    imageCredit: null,
    star: false,
  };
}

export const isMysteryCard = (p: Pick<PlayerCard, 'id'>) => p.id.startsWith('mystery-');

// ---------------------------------------------------------------- banter

export const REACTION_EMOJIS = ['😂', '🔥', '🤡', '😱', '👏', '💀', '😭', '🫡', '🤯', '⚽'] as const;

export const TAUNTS = {
  PANIC: 'Panic buy 💀',
  ROBBED: 'Robbed!',
  WHO: 'Who?? 🤨',
  STEAL: 'Daylight robbery',
  BARGAIN: 'Bargain of the century',
  CALM: 'Calm down 😂',
  CRY: 'Cry about it 😭',
  SCENES: 'SCENES 🔥',
  GG: 'GG 🤝',
  NEXT: 'Next one’s mine',
} as const;
export type TauntId = keyof typeof TAUNTS;
export const TAUNT_IDS = Object.keys(TAUNTS) as TauntId[];

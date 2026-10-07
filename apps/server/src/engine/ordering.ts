import type { PlayerCard } from '@fa/shared';
import { seededShuffle } from './rng';

/**
 * Decides the order players come up for auction. New strategies
 * (position-balanced, star distribution, tiered) plug in here.
 */
export interface AuctionOrderStrategy {
  id: string;
  order(pool: readonly PlayerCard[], seed: string): PlayerCard[];
}

export const seededRandomOrder: AuctionOrderStrategy = {
  id: 'seeded-shuffle',
  // Sort first so the result depends only on the seed, not on catalog load order.
  order: (pool, seed) => seededShuffle([...pool].sort((a, b) => a.id.localeCompare(b.id)), seed),
};

export const ORDER_STRATEGIES: Record<string, AuctionOrderStrategy> = {
  [seededRandomOrder.id]: seededRandomOrder,
};

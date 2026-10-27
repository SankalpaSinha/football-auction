import type { Position } from './positions';

/**
 * Estimated auction value. Used for post-sale feedback (bargain / overpay) and
 * post-match analysis only — it never decides who wins.
 */
export interface ValuationConfig {
  /** Value of a reference-rated player when the room budget is `referenceBudget`. */
  referenceOverall: number;
  referenceValue: number;
  referenceBudget: number;
  /** Multiplicative growth per overall point. */
  growthPerPoint: number;
  positionMultiplier: Partial<Record<Position, number>>;
  youngAge: number;
  youngBonus: number;
  veteranAge: number;
  veteranPenalty: number;
  /** Price within ±fairBand of value is "fair". */
  fairBand: number;
}

export const DEFAULT_VALUATION: ValuationConfig = {
  referenceOverall: 75,
  referenceValue: 40,
  referenceBudget: 1000,
  growthPerPoint: 0.157,
  positionMultiplier: {
    ST: 1.08, CF: 1.06, LW: 1.05, RW: 1.05, CAM: 1.04,
    CM: 1.0, CDM: 0.97, LM: 0.98, RM: 0.98,
    CB: 0.95, LB: 0.92, RB: 0.92, LWB: 0.92, RWB: 0.92,
    GK: 0.85,
  },
  youngAge: 23,
  youngBonus: 0.06,
  veteranAge: 32,
  veteranPenalty: 0.12,
  fairBand: 0.15,
};

export function estimateValue(
  p: { overall: number; position: Position; age: number },
  budget: number,
  cfg: ValuationConfig = DEFAULT_VALUATION,
  /** Price cap (Budget Cap format): values become whole coins from 1 to the cap. */
  maxPrice: number | null = null,
): number {
  let v = cfg.referenceValue * Math.exp(cfg.growthPerPoint * (p.overall - cfg.referenceOverall));
  v *= cfg.positionMultiplier[p.position] ?? 1;
  if (p.age <= cfg.youngAge) v *= 1 + cfg.youngBonus;
  if (p.age >= cfg.veteranAge) v *= 1 - cfg.veteranPenalty;
  if (maxPrice !== null) {
    // Spread the rating range over 1..cap coins: a 75 is worth about 2 of 5.
    return Math.max(1, Math.min(maxPrice, Math.round((v / cfg.referenceValue) * 2)));
  }
  v *= budget / cfg.referenceBudget;
  return Math.max(5, Math.round(v / 5) * 5);
}

export type ValueVerdict = 'BARGAIN' | 'FAIR' | 'OVERPAY';

export function verdictFor(price: number, value: number, cfg: ValuationConfig = DEFAULT_VALUATION): ValueVerdict {
  if (price <= value * (1 - cfg.fairBand)) return 'BARGAIN';
  if (price >= value * (1 + cfg.fairBand)) return 'OVERPAY';
  return 'FAIR';
}

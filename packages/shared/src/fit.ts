import type { Position } from './positions';

/**
 * Position compatibility. Configurable tables — the scoring engine (Phase 4)
 * multiplies a player's contribution by the factor for the slot they occupy.
 */
export type FitLevel = 'NATURAL' | 'SECONDARY' | 'COMPATIBLE' | 'OUT_OF_POSITION' | 'EXTREME';

export const FIT_FACTORS: Record<FitLevel, number> = {
  NATURAL: 1,
  SECONDARY: 0.9,
  COMPATIBLE: 0.7,
  OUT_OF_POSITION: 0.3,
  EXTREME: 0.05,
};

/** Practically the same job — treated like a listed secondary position. */
export const NEAR_POSITIONS: Partial<Record<Position, Position[]>> = {
  ST: ['CF'],
  CF: ['ST'],
  LB: ['LWB'],
  LWB: ['LB'],
  RB: ['RWB'],
  RWB: ['RB'],
  LM: ['LW'],
  LW: ['LM'],
  RM: ['RW'],
  RW: ['RM'],
};

/** Roles a player can cover with a moderate penalty, keyed by natural position. */
export const COMPATIBLE_POSITIONS: Record<Position, Position[]> = {
  GK: [],
  CB: ['CDM', 'LB', 'RB'],
  LB: ['CB', 'LM', 'RB'],
  RB: ['CB', 'RM', 'LB'],
  LWB: ['LM', 'LW', 'CB'],
  RWB: ['RM', 'RW', 'CB'],
  CDM: ['CM', 'CB'],
  CM: ['CDM', 'CAM', 'LM', 'RM'],
  CAM: ['CM', 'CF', 'LW', 'RW', 'ST'],
  LM: ['LWB', 'LB', 'CM', 'RM'],
  RM: ['RWB', 'RB', 'CM', 'LM'],
  LW: ['RW', 'CF', 'CAM', 'ST', 'LWB'],
  RW: ['LW', 'CF', 'CAM', 'ST', 'RWB'],
  CF: ['CAM', 'LW', 'RW'],
  ST: ['LW', 'RW', 'CAM'],
};

export function positionFit(
  player: { position: Position; secondaryPositions: Position[] },
  role: Position,
): { level: FitLevel; factor: number } {
  const level = fitLevel(player, role);
  return { level, factor: FIT_FACTORS[level] };
}

function fitLevel(p: { position: Position; secondaryPositions: Position[] }, role: Position): FitLevel {
  if (p.position === role) return 'NATURAL';
  if ((p.position === 'GK') !== (role === 'GK')) return 'EXTREME';
  if (p.secondaryPositions.includes(role) || NEAR_POSITIONS[p.position]?.includes(role)) return 'SECONDARY';
  if (COMPATIBLE_POSITIONS[p.position].includes(role)) return 'COMPATIBLE';
  for (const s of p.secondaryPositions) {
    if (NEAR_POSITIONS[s]?.includes(role)) return 'COMPATIBLE';
  }
  return 'OUT_OF_POSITION';
}

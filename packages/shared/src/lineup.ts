import { positionFit, type FitLevel } from './fit';
import { getFormation, type Formation } from './formations';
import type { PlayerCard } from './types';

/** A manager's chosen formation and the player id in each slot (index matches formation.slots). */
export interface LineupInput {
  formationId: string;
  slots: (string | null)[];
}

export type LineupError =
  | 'INVALID_FORMATION'
  | 'LINEUP_INCOMPLETE'
  | 'LINEUP_DUPLICATE'
  | 'NOT_YOUR_PLAYER'
  | 'GOALKEEPER_REQUIRED';

/**
 * Checks a lineup against the manager's squad. `complete` additionally
 * requires all 11 slots filled and a goalkeeper in goal.
 */
export function validateLineup(l: LineupInput, squad: PlayerCard[], complete: boolean): LineupError | null {
  const formation = getFormation(l.formationId);
  if (!formation || l.slots.length !== formation.slots.length) return 'INVALID_FORMATION';
  const owned = new Map(squad.map((p) => [p.id, p]));
  const seen = new Set<string>();
  for (const id of l.slots) {
    if (id === null) continue;
    if (seen.has(id)) return 'LINEUP_DUPLICATE';
    seen.add(id);
    if (!owned.has(id)) return 'NOT_YOUR_PLAYER';
  }
  if (complete) {
    if (l.slots.some((s) => s === null)) return 'LINEUP_INCOMPLETE';
    const gkIdx = formation.slots.findIndex((s) => s.role === 'GK');
    if (owned.get(l.slots[gkIdx]!)?.position !== 'GK') return 'GOALKEEPER_REQUIRED';
  }
  return null;
}

export const slotValue = (p: PlayerCard, role: Formation['slots'][number]['role']) =>
  p.overall * positionFit(p, role).factor;

/**
 * Deterministic best-effort assignment of players to slots, maximising the sum
 * of overall × position-fit. Slots already set in `fixed` are kept. Greedy pass
 * followed by swap/replace improvements until stable.
 */
export function bestAssignment(
  candidates: PlayerCard[],
  formation: Formation,
  fixed: (string | null)[] = formation.slots.map(() => null),
): (string | null)[] {
  const result = formation.slots.map((_, i) => fixed[i] ?? null);
  const locked = new Set(result.map((id, i) => (id ? i : -1)).filter((i) => i >= 0));
  const byId = new Map(candidates.map((p) => [p.id, p]));
  const used = new Set(result.filter((x): x is string => !!x));
  const pool = candidates.filter((p) => !used.has(p.id)).sort((a, b) => a.id.localeCompare(b.id));

  const pairs: { v: number; slot: number; p: PlayerCard }[] = [];
  formation.slots.forEach((s, slot) => {
    if (locked.has(slot)) return;
    for (const p of pool) pairs.push({ v: slotValue(p, s.role), slot, p });
  });
  pairs.sort((a, b) => b.v - a.v || a.slot - b.slot || a.p.id.localeCompare(b.p.id));
  for (const { slot, p } of pairs) {
    if (result[slot] !== null || used.has(p.id)) continue;
    result[slot] = p.id;
    used.add(p.id);
  }

  const val = (id: string | null, slot: number) => (id ? slotValue(byId.get(id)!, formation.slots[slot].role) : 0);
  for (let round = 0; round < 60; round++) {
    let improved = false;
    const free = formation.slots.map((_, i) => i).filter((i) => !locked.has(i));
    for (const i of free) {
      for (const j of free) {
        if (j <= i) continue;
        const a = result[i];
        const b = result[j];
        if (val(a, i) + val(b, j) + 1e-9 < val(b, i) + val(a, j)) {
          result[i] = b;
          result[j] = a;
          improved = true;
        }
      }
      for (const p of pool) {
        if (used.has(p.id)) continue;
        if (val(result[i], i) + 1e-9 < slotValue(p, formation.slots[i].role)) {
          if (result[i]) used.delete(result[i]!);
          result[i] = p.id;
          used.add(p.id);
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return result;
}

/** Best XI from the whole squad, keeping any slots the manager already set. */
export function autoPick(squad: PlayerCard[], formationId: string, keep?: (string | null)[]): (string | null)[] {
  const formation = getFormation(formationId);
  if (!formation) throw new Error(`Unknown formation ${formationId}`);
  const fixed = formation.slots.map((s, i) => {
    const id = keep?.[i] ?? null;
    const p = id ? squad.find((x) => x.id === id) : undefined;
    // Never keep an outfielder in goal when auto-completing.
    if (!p || (s.role === 'GK' && p.position !== 'GK')) return null;
    return id;
  });
  return bestAssignment(squad, formation, fixed);
}

/** Move the same starters into a new formation, each to their best-fitting slot. */
export function remapLineup(slots: (string | null)[], toFormationId: string, squad: PlayerCard[]): (string | null)[] {
  const formation = getFormation(toFormationId);
  if (!formation) throw new Error(`Unknown formation ${toFormationId}`);
  const starters = squad.filter((p) => slots.includes(p.id));
  return bestAssignment(starters, formation);
}

export interface LineupSummary {
  filled: number;
  averageOverall: number;
  effectiveOverall: number;
  fit: Record<FitLevel, number>;
}

export function summarizeLineup(l: LineupInput, squad: PlayerCard[]): LineupSummary {
  const formation = getFormation(l.formationId)!;
  const byId = new Map(squad.map((p) => [p.id, p]));
  const fit: Record<FitLevel, number> = { NATURAL: 0, SECONDARY: 0, COMPATIBLE: 0, OUT_OF_POSITION: 0, EXTREME: 0 };
  let sum = 0;
  let eff = 0;
  let filled = 0;
  l.slots.forEach((id, i) => {
    const p = id ? byId.get(id) : undefined;
    if (!p) return;
    const f = positionFit(p, formation.slots[i].role);
    fit[f.level]++;
    sum += p.overall;
    eff += p.overall * f.factor;
    filled++;
  });
  return {
    filled,
    averageOverall: filled ? sum / filled : 0,
    effectiveOverall: filled ? eff / filled : 0,
    fit,
  };
}

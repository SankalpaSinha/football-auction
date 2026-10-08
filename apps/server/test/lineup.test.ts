import { describe, expect, it } from 'vitest';
import {
  autoPick,
  FORMATIONS,
  getFormation,
  positionFit,
  remapLineup,
  validateLineup,
  type PlayerCard,
  type Position,
} from '@fa/shared';
import { GameError } from '../src/engine/errors';
import { completeAuction, createHarness, makeCard } from './helpers';

const code = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof GameError) return e.code;
    throw e;
  }
  return 'OK';
};

const p = (position: Position, secondary: Position[] = []) => ({ position, secondaryPositions: secondary });

describe('position fit', () => {
  it('ranks fits from natural to extreme', () => {
    expect(positionFit(p('ST'), 'ST').level).toBe('NATURAL');
    expect(positionFit(p('CF'), 'ST').level).toBe('SECONDARY');
    expect(positionFit(p('CM', ['CAM']), 'CAM').level).toBe('SECONDARY');
    expect(positionFit(p('LW'), 'ST').level).toBe('COMPATIBLE');
    expect(positionFit(p('CB'), 'ST').level).toBe('OUT_OF_POSITION');
    expect(positionFit(p('GK'), 'ST').level).toBe('EXTREME');
    expect(positionFit(p('ST'), 'GK').level).toBe('EXTREME');
  });

  it('factors decrease with fit', () => {
    const f = ['ST', 'CF', 'LW', 'CB', 'GK'].map((pos) => positionFit(p(pos as Position), 'ST').factor);
    expect(f).toEqual([...f].sort((a, b) => b - a));
  });
});

/** A sensible 15: 2 GK, 5 DEF, 4 MID, 4 ATT. */
function squad(): PlayerCard[] {
  const roles: [Position, number][] = [
    ['GK', 84], ['GK', 75], ['CB', 85], ['CB', 82], ['CB', 76], ['LB', 80], ['RB', 81],
    ['CDM', 83], ['CM', 84], ['CM', 79], ['CAM', 86], ['LW', 85], ['RW', 84], ['ST', 88], ['ST', 77],
  ];
  return roles.map(([pos, ovr], i) => makeCard(`s${String(i).padStart(2, '0')}`, pos, ovr));
}

describe('lineups', () => {
  it('every formation has 11 slots with a GK first', () => {
    for (const f of FORMATIONS) {
      expect(f.slots).toHaveLength(11);
      expect(f.slots[0].role).toBe('GK');
      expect(f.slots.filter((s) => s.role === 'GK')).toHaveLength(1);
    }
  });

  it('validates formation, ownership, duplicates, completeness and keeper', () => {
    const s = squad();
    const xi = autoPick(s, '4-3-3') as string[];
    expect(validateLineup({ formationId: '4-3-3', slots: xi }, s, true)).toBeNull();
    expect(validateLineup({ formationId: '9-0-1', slots: xi }, s, true)).toBe('INVALID_FORMATION');
    expect(validateLineup({ formationId: '4-3-3', slots: xi.slice(0, 10) }, s, true)).toBe('INVALID_FORMATION');
    expect(validateLineup({ formationId: '4-3-3', slots: [...xi.slice(0, 10), 'stranger'] }, s, true)).toBe('NOT_YOUR_PLAYER');
    expect(validateLineup({ formationId: '4-3-3', slots: [...xi.slice(0, 10), xi[0]] }, s, true)).toBe('LINEUP_DUPLICATE');
    expect(validateLineup({ formationId: '4-3-3', slots: [...xi.slice(0, 10), null] }, s, true)).toBe('LINEUP_INCOMPLETE');
    expect(validateLineup({ formationId: '4-3-3', slots: [...xi.slice(0, 10), null] }, s, false)).toBeNull();
    const swapped = [...xi];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    expect(validateLineup({ formationId: '4-3-3', slots: swapped }, s, true)).toBe('GOALKEEPER_REQUIRED');
  });

  it('auto-pick puts the best keeper in goal and players in natural positions', () => {
    const s = squad();
    const byId = new Map(s.map((x) => [x.id, x]));
    const xi = autoPick(s, '4-3-3');
    const f = getFormation('4-3-3')!;
    expect(new Set(xi).size).toBe(11);
    expect(byId.get(xi[0]!)!.overall).toBe(84);
    const natural = xi.filter((id, i) => positionFit(byId.get(id!)!, f.slots[i].role).level === 'NATURAL').length;
    expect(natural).toBeGreaterThanOrEqual(9);
    expect(autoPick(s, '4-3-3')).toEqual(xi); // deterministic
  });

  it('auto-pick keeps slots the manager already chose', () => {
    const s = squad();
    const keep: (string | null)[] = Array(11).fill(null);
    keep[9] = 's14'; // 77 ST at ST
    const xi = autoPick(s, '4-3-3', keep);
    expect(xi[9]).toBe('s14');
  });

  it('switching formation keeps the same starters', () => {
    const s = squad();
    const xi = autoPick(s, '4-3-3');
    const moved = remapLineup(xi, '4-4-2', s);
    expect(new Set(moved)).toEqual(new Set(xi));
  });
});

describe('squad building phase', () => {
  function ready() {
    const h = createHarness({ players: 2 });
    completeAuction(h);
    expect(h.room.phase).toBe('SQUAD_BUILDING');
    const squadOf = (id: string) => h.member(id).squad.map((e) => e.player);
    return { h, squadOf };
  }

  it('keeps each lineup private until the reveal', () => {
    const { h, squadOf } = ready();
    const xi = autoPick(squadOf('u1'), '4-3-3');
    h.room.saveLineupDraft('u1', { formationId: '4-3-3', slots: xi });
    expect(h.room.view('u1').squadBuilding!.mine!.slots).toEqual(xi);
    expect(h.room.view('u2').squadBuilding!.mine!.slots.every((x) => x === null)).toBe(true);
    expect(h.room.view('u2').lineups).toBeNull();
  });

  it('rejects invalid locks and reveals once everyone has locked', () => {
    const { h, squadOf } = ready();
    const xi1 = autoPick(squadOf('u1'), '4-2-3-1');
    const xi2 = autoPick(squadOf('u2'), '4-4-2');
    expect(code(() => h.room.lockLineup('u1', { formationId: '4-2-3-1', slots: xi2 }))).toBe('NOT_YOUR_PLAYER');
    expect(code(() => h.room.lockLineup('u1', { formationId: '4-2-3-1', slots: [...xi1.slice(0, 10), null] }))).toBe('LINEUP_INCOMPLETE');
    h.room.lockLineup('u1', { formationId: '4-2-3-1', slots: xi1 });
    expect(code(() => h.room.saveLineupDraft('u1', { formationId: '4-2-3-1', slots: xi1 }))).toBe('LINEUP_LOCKED');
    expect(h.room.view('u2').squadBuilding!.locked).toEqual({ u1: true, u2: false });
    h.room.unlockLineup('u1');
    h.room.lockLineup('u1', { formationId: '4-2-3-1', slots: xi1 });
    h.room.lockLineup('u2', { formationId: '4-4-2', slots: xi2 });
    expect(h.room.phase).toBe('FINAL_EVALUATION');
    const lineups = h.room.view('u1').lineups!;
    expect(lineups.u2.formationId).toBe('4-4-2');
    expect(lineups.u1.auto).toBe(false);
  });

  it('auto-completes unlocked lineups at the deadline, keeping draft choices', () => {
    const { h, squadOf } = ready();
    const s1 = squadOf('u1');
    const draft: (string | null)[] = Array(11).fill(null);
    const outfielder = s1.find((p) => p.position !== 'GK')!;
    draft[5] = outfielder.id;
    h.room.saveLineupDraft('u1', { formationId: '3-5-2', slots: draft });
    h.clock.advance(h.room.view('u1').squadBuilding!.endsAt - h.clock.now());
    expect(h.room.phase).toBe('FINAL_EVALUATION');
    const l1 = h.room.view('u1').lineups!.u1;
    expect(l1.formationId).toBe('3-5-2');
    expect(l1.slots[5]).toBe(outfielder.id);
    expect(l1.auto).toBe(true);
    for (const [uid, l] of Object.entries(h.room.view('u1').lineups!)) {
      expect(validateLineup(l, squadOf(uid), true)).toBeNull();
    }
  });

  it('only accepts lineup actions during squad building', () => {
    const h = createHarness({ players: 2 });
    expect(code(() => h.room.lockLineup('u1', { formationId: '4-3-3', slots: [] }))).toBe('WRONG_PHASE');
  });
});

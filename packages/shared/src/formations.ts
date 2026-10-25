import type { Position } from './positions';

export interface FormationSlot {
  /** The role this slot asks for (used for position fit). */
  role: Position;
  /** Pitch coordinates in %, x left→right, y attack (0) → own goal (100). */
  x: number;
  y: number;
}

export interface Formation {
  id: string;
  name: string;
  slots: FormationSlot[];
}

const back4: FormationSlot[] = [
  { role: 'GK', x: 50, y: 91 },
  { role: 'LB', x: 13, y: 70 },
  { role: 'CB', x: 37, y: 75 },
  { role: 'CB', x: 63, y: 75 },
  { role: 'RB', x: 87, y: 70 },
];
const back3: FormationSlot[] = [
  { role: 'GK', x: 50, y: 91 },
  { role: 'CB', x: 27, y: 74 },
  { role: 'CB', x: 50, y: 76 },
  { role: 'CB', x: 73, y: 74 },
];

/** Every formation has exactly 11 slots and slot 0 is the goalkeeper. */
export const FORMATIONS: Formation[] = [
  {
    id: '4-3-3',
    name: '4-3-3',
    slots: [
      ...back4,
      { role: 'CM', x: 27, y: 50 },
      { role: 'CDM', x: 50, y: 56 },
      { role: 'CM', x: 73, y: 50 },
      { role: 'LW', x: 15, y: 24 },
      { role: 'ST', x: 50, y: 16 },
      { role: 'RW', x: 85, y: 24 },
    ],
  },
  {
    id: '4-4-2',
    name: '4-4-2',
    slots: [
      ...back4,
      { role: 'LM', x: 13, y: 46 },
      { role: 'CM', x: 37, y: 51 },
      { role: 'CM', x: 63, y: 51 },
      { role: 'RM', x: 87, y: 46 },
      { role: 'ST', x: 37, y: 18 },
      { role: 'ST', x: 63, y: 18 },
    ],
  },
  {
    id: '4-2-3-1',
    name: '4-2-3-1',
    slots: [
      ...back4,
      { role: 'CDM', x: 36, y: 56 },
      { role: 'CDM', x: 64, y: 56 },
      { role: 'LW', x: 15, y: 32 },
      { role: 'CAM', x: 50, y: 35 },
      { role: 'RW', x: 85, y: 32 },
      { role: 'ST', x: 50, y: 14 },
    ],
  },
  {
    id: '3-5-2',
    name: '3-5-2',
    slots: [
      ...back3,
      { role: 'LWB', x: 9, y: 50 },
      { role: 'CM', x: 32, y: 47 },
      { role: 'CDM', x: 50, y: 57 },
      { role: 'CM', x: 68, y: 47 },
      { role: 'RWB', x: 91, y: 50 },
      { role: 'ST', x: 37, y: 18 },
      { role: 'ST', x: 63, y: 18 },
    ],
  },
  {
    id: '3-4-3',
    name: '3-4-3',
    slots: [
      ...back3,
      { role: 'LM', x: 11, y: 48 },
      { role: 'CM', x: 37, y: 52 },
      { role: 'CM', x: 63, y: 52 },
      { role: 'RM', x: 89, y: 48 },
      { role: 'LW', x: 18, y: 22 },
      { role: 'ST', x: 50, y: 16 },
      { role: 'RW', x: 82, y: 22 },
    ],
  },
  {
    id: '4-1-2-1-2',
    name: '4-1-2-1-2',
    slots: [
      ...back4,
      { role: 'CDM', x: 50, y: 59 },
      { role: 'CM', x: 29, y: 46 },
      { role: 'CM', x: 71, y: 46 },
      { role: 'CAM', x: 50, y: 34 },
      { role: 'ST', x: 37, y: 15 },
      { role: 'ST', x: 63, y: 15 },
    ],
  },
  {
    id: '5-3-2',
    name: '5-3-2',
    slots: [
      { role: 'GK', x: 50, y: 91 },
      { role: 'LWB', x: 9, y: 62 },
      { role: 'CB', x: 30, y: 74 },
      { role: 'CB', x: 50, y: 76 },
      { role: 'CB', x: 70, y: 74 },
      { role: 'RWB', x: 91, y: 62 },
      { role: 'CM', x: 28, y: 46 },
      { role: 'CM', x: 50, y: 51 },
      { role: 'CM', x: 72, y: 46 },
      { role: 'ST', x: 37, y: 18 },
      { role: 'ST', x: 63, y: 18 },
    ],
  },
  {
    id: '4-5-1',
    name: '4-5-1',
    slots: [
      ...back4,
      { role: 'LM', x: 12, y: 44 },
      { role: 'CM', x: 32, y: 50 },
      { role: 'CDM', x: 50, y: 57 },
      { role: 'CM', x: 68, y: 50 },
      { role: 'RM', x: 88, y: 44 },
      { role: 'ST', x: 50, y: 16 },
    ],
  },
  {
    id: '4-1-4-1',
    name: '4-1-4-1',
    slots: [
      ...back4,
      { role: 'CDM', x: 50, y: 60 },
      { role: 'LM', x: 12, y: 40 },
      { role: 'CM', x: 36, y: 44 },
      { role: 'CM', x: 64, y: 44 },
      { role: 'RM', x: 88, y: 40 },
      { role: 'ST', x: 50, y: 15 },
    ],
  },
  {
    id: '4-3-2-1',
    name: '4-3-2-1',
    slots: [
      ...back4,
      { role: 'CM', x: 27, y: 53 },
      { role: 'CDM', x: 50, y: 58 },
      { role: 'CM', x: 73, y: 53 },
      { role: 'CAM', x: 33, y: 32 },
      { role: 'CAM', x: 67, y: 32 },
      { role: 'ST', x: 50, y: 14 },
    ],
  },
  {
    id: '4-4-1-1',
    name: '4-4-1-1',
    slots: [
      ...back4,
      { role: 'LM', x: 13, y: 47 },
      { role: 'CM', x: 37, y: 53 },
      { role: 'CM', x: 63, y: 53 },
      { role: 'RM', x: 87, y: 47 },
      { role: 'CF', x: 50, y: 31 },
      { role: 'ST', x: 50, y: 13 },
    ],
  },
  {
    id: '4-2-2-2',
    name: '4-2-2-2',
    slots: [
      ...back4,
      { role: 'CDM', x: 36, y: 57 },
      { role: 'CDM', x: 64, y: 57 },
      { role: 'CAM', x: 21, y: 35 },
      { role: 'CAM', x: 79, y: 35 },
      { role: 'ST', x: 37, y: 15 },
      { role: 'ST', x: 63, y: 15 },
    ],
  },
  {
    id: '3-4-2-1',
    name: '3-4-2-1',
    slots: [
      ...back3,
      { role: 'LWB', x: 10, y: 50 },
      { role: 'CM', x: 37, y: 54 },
      { role: 'CM', x: 63, y: 54 },
      { role: 'RWB', x: 90, y: 50 },
      { role: 'CAM', x: 33, y: 31 },
      { role: 'CAM', x: 67, y: 31 },
      { role: 'ST', x: 50, y: 13 },
    ],
  },
  {
    id: '3-4-1-2',
    name: '3-4-1-2',
    slots: [
      ...back3,
      { role: 'LM', x: 10, y: 49 },
      { role: 'CM', x: 37, y: 55 },
      { role: 'CM', x: 63, y: 55 },
      { role: 'RM', x: 90, y: 49 },
      { role: 'CAM', x: 50, y: 35 },
      { role: 'ST', x: 37, y: 15 },
      { role: 'ST', x: 63, y: 15 },
    ],
  },
  {
    id: '5-4-1',
    name: '5-4-1',
    slots: [
      { role: 'GK', x: 50, y: 91 },
      { role: 'LWB', x: 9, y: 64 },
      { role: 'CB', x: 30, y: 75 },
      { role: 'CB', x: 50, y: 77 },
      { role: 'CB', x: 70, y: 75 },
      { role: 'RWB', x: 91, y: 64 },
      { role: 'LM', x: 14, y: 43 },
      { role: 'CM', x: 38, y: 48 },
      { role: 'CM', x: 62, y: 48 },
      { role: 'RM', x: 86, y: 43 },
      { role: 'ST', x: 50, y: 16 },
    ],
  },
  {
    id: '5-2-3',
    name: '5-2-3',
    slots: [
      { role: 'GK', x: 50, y: 91 },
      { role: 'LWB', x: 9, y: 60 },
      { role: 'CB', x: 30, y: 74 },
      { role: 'CB', x: 50, y: 76 },
      { role: 'CB', x: 70, y: 74 },
      { role: 'RWB', x: 91, y: 60 },
      { role: 'CM', x: 37, y: 50 },
      { role: 'CM', x: 63, y: 50 },
      { role: 'LW', x: 18, y: 23 },
      { role: 'ST', x: 50, y: 15 },
      { role: 'RW', x: 82, y: 23 },
    ],
  },
];

export const DEFAULT_FORMATION = '4-3-3';

export function getFormation(id: string): Formation | undefined {
  return FORMATIONS.find((f) => f.id === id);
}

// ---------------------------------------------------------------- custom

/** A manager-designed formation travels with the lineup under this id. */
export const CUSTOM_FORMATION_ID = 'custom';

/** Where a formation comes from: a preset id, or `custom` plus its 11 slots. */
export interface FormationRef {
  formationId: string;
  custom?: FormationSlot[] | null;
}

/** Bounds and spacing a custom formation must respect (pitch %, x scaled by pitch width for spacing). */
export const CUSTOM_BOUNDS = { xMin: 4, xMax: 96, yMin: 8, yMax: 82, minGap: 7 } as const;
export const CUSTOM_GOALKEEPER: FormationSlot = { role: 'GK', x: 50, y: 91 };

const OUTFIELD_ROLES: Position[] = ['CB', 'LB', 'RB', 'LWB', 'RWB', 'CDM', 'CM', 'CAM', 'LM', 'RM', 'LW', 'RW', 'CF', 'ST'];

/** Why a custom formation is invalid, or null if it's fine. */
export function customFormationError(slots: FormationSlot[] | null | undefined): string | null {
  if (!slots || slots.length !== 11) return 'A formation needs exactly 11 positions.';
  const [gk, ...outfield] = slots;
  if (gk.role !== 'GK') return 'The first position must be the goalkeeper.';
  const b = CUSTOM_BOUNDS;
  for (const s of outfield) {
    if (!OUTFIELD_ROLES.includes(s.role)) return 'Only one goalkeeper is allowed.';
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y) || s.x < b.xMin || s.x > b.xMax || s.y < b.yMin || s.y > b.yMax) {
      return 'A position is off the pitch.';
    }
  }
  for (let i = 0; i < outfield.length; i++) {
    for (let j = i + 1; j < outfield.length; j++) {
      if (Math.hypot((outfield[i].x - outfield[j].x) * 0.68, outfield[i].y - outfield[j].y) < b.minGap) return 'Two positions are on top of each other.';
    }
  }
  return null;
}

/** The formation a lineup uses — a preset, or the manager's own (if valid). */
export function resolveFormation(ref: FormationRef): Formation | undefined {
  if (ref.formationId !== CUSTOM_FORMATION_ID) return getFormation(ref.formationId);
  if (customFormationError(ref.custom)) return undefined;
  const slots = ref.custom!.map((s, i) => (i === 0 ? { ...CUSTOM_GOALKEEPER } : { role: s.role, x: Math.round(s.x * 10) / 10, y: Math.round(s.y * 10) / 10 }));
  return { id: `custom:${slots.map((s) => `${s.role}@${s.x},${s.y}`).join('|')}`, name: customShape(slots), slots };
}

/** "3-4-3"-style name for a custom formation, by how many players sit in each line. */
export function customShape(slots: FormationSlot[]): string {
  const outfield = slots.filter((s) => s.role !== 'GK').map((s) => s.y);
  const lines: number[] = [];
  const sorted = [...outfield].sort((a, b) => b - a);
  let last = Infinity;
  for (const y of sorted) {
    if (last - y > 9 || !lines.length) lines.push(1);
    else lines[lines.length - 1]++;
    last = y;
  }
  return lines.join('-');
}

/** Suggested role for a spot on the pitch (used while dragging a custom formation). */
export function roleForSpot(x: number, y: number): Position {
  const left = x <= 22;
  const right = x >= 78;
  if (y >= 64) return left ? 'LB' : right ? 'RB' : 'CB';
  if (y >= 55) return x <= 18 ? 'LWB' : x >= 82 ? 'RWB' : 'CDM';
  if (y >= 40) return left ? 'LM' : right ? 'RM' : 'CM';
  if (y >= 27) return x <= 25 ? 'LW' : x >= 75 ? 'RW' : 'CAM';
  return x <= 25 ? 'LW' : x >= 75 ? 'RW' : 'ST';
}

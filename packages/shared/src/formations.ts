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
];

export const DEFAULT_FORMATION = '4-3-3';

export function getFormation(id: string): Formation | undefined {
  return FORMATIONS.find((f) => f.id === id);
}

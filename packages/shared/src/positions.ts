export const POSITIONS = [
  'GK', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'CDM', 'CM', 'CAM', 'LM', 'RM', 'LW', 'RW', 'CF', 'ST',
] as const;
export type Position = (typeof POSITIONS)[number];

export type PositionGroup = 'GK' | 'DEF' | 'MID' | 'ATT';

export const POSITION_GROUP: Record<Position, PositionGroup> = {
  GK: 'GK',
  CB: 'DEF', LB: 'DEF', RB: 'DEF', LWB: 'DEF', RWB: 'DEF',
  CDM: 'MID', CM: 'MID', CAM: 'MID', LM: 'MID', RM: 'MID',
  LW: 'ATT', RW: 'ATT', CF: 'ATT', ST: 'ATT',
};

export const GROUP_ORDER: PositionGroup[] = ['GK', 'DEF', 'MID', 'ATT'];

export function isPosition(v: string): v is Position {
  return (POSITIONS as readonly string[]).includes(v);
}

export function groupOf(p: Position): PositionGroup {
  return POSITION_GROUP[p];
}

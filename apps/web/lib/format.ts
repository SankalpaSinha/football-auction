import { POSITION_GROUP, type PlayerCard, type PositionGroup, type SquadEntry } from '@fa/shared';

export const coins = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('en-US'));

export function faceStats(p: PlayerCard): { label: string; value: number }[] {
  if (p.goalkeeping) {
    const g = p.goalkeeping;
    return [
      { label: 'DIV', value: g.diving },
      { label: 'HAN', value: g.handling },
      { label: 'KIC', value: g.kicking },
      { label: 'REF', value: g.reflexes },
      { label: 'SPD', value: g.speed },
      { label: 'POS', value: g.positioning },
    ];
  }
  const o = p.outfield!;
  return [
    { label: 'PAC', value: o.pace },
    { label: 'SHO', value: o.shooting },
    { label: 'PAS', value: o.passing },
    { label: 'DRI', value: o.dribbling },
    { label: 'DEF', value: o.defending },
    { label: 'PHY', value: o.physical },
  ];
}

export function groupSquad(squad: SquadEntry[]): Record<PositionGroup, SquadEntry[]> {
  const out: Record<PositionGroup, SquadEntry[]> = { GK: [], DEF: [], MID: [], ATT: [] };
  for (const s of squad) out[POSITION_GROUP[s.player.position]].push(s);
  for (const g of Object.values(out)) g.sort((a, b) => b.player.overall - a.player.overall);
  return out;
}

export function statColor(v: number) {
  if (v >= 85) return 'text-volt';
  if (v >= 75) return 'text-emerald-300';
  if (v >= 60) return 'text-amber-200';
  return 'text-rose-300';
}

export const GROUP_LABEL: Record<PositionGroup, string> = { GK: 'Goalkeepers', DEF: 'Defenders', MID: 'Midfielders', ATT: 'Attackers' };

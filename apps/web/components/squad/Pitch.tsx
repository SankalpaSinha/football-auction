'use client';
import { motion } from 'motion/react';
import { chemistryLinks, positionFit, resolveFormation, type ChemistryLink, type FitLevel, type FormationRef, type FormationSlot, type PlayerCard } from '@fa/shared';

export const LINK_COLOR: Record<ChemistryLink['strength'], string> = {
  STRONG: '#34d399',
  MEDIUM: '#facc15',
  WEAK: '#f87171',
};
import { PlayerAvatar } from '../PlayerAvatar';

export const FIT_STYLE: Record<FitLevel, { color: string; label: string }> = {
  NATURAL: { color: '#34d399', label: 'Natural' },
  SECONDARY: { color: '#c8ff2e', label: 'Secondary' },
  COMPATIBLE: { color: '#ffb020', label: 'Compatible' },
  OUT_OF_POSITION: { color: '#ff4d5e', label: 'Out of position' },
  EXTREME: { color: '#b91c1c', label: 'Wrong position' },
};

/** Vertical pitch markings (68 × 100 units). */
export function PitchSurface({
  children,
  className = '',
  style,
  links,
}: {
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  /** Chemistry lines between slot coordinates (x/y in %). */
  links?: { x1: number; y1: number; x2: number; y2: number; strength: ChemistryLink['strength'] }[];
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border border-white/10 ${className}`}
      style={{
        ...style,
        aspectRatio: '68 / 100',
        background:
          'repeating-linear-gradient(180deg, rgba(255,255,255,.035) 0 10%, transparent 10% 20%), radial-gradient(ellipse at 50% 40%, #1d6b3c 0%, #0f4626 70%, #0a3a1f 100%)',
      }}
    >
      <svg viewBox="0 0 68 100" className="absolute inset-0 h-full w-full" preserveAspectRatio="none" aria-hidden>
        <g fill="none" stroke="rgba(255,255,255,.28)" strokeWidth=".35">
          <rect x="2" y="2" width="64" height="96" rx=".5" />
          <line x1="2" y1="50" x2="66" y2="50" />
          <circle cx="34" cy="50" r="8.5" />
          <rect x="15" y="2" width="38" height="15" />
          <rect x="25" y="2" width="18" height="5.5" />
          <rect x="15" y="83" width="38" height="15" />
          <rect x="25" y="92.5" width="18" height="5.5" />
          <path d="M27 17 A 8 8 0 0 0 41 17" />
          <path d="M27 83 A 8 8 0 0 1 41 83" />
        </g>
        <circle cx="34" cy="50" r=".7" fill="rgba(255,255,255,.4)" />
        {links?.map((l, i) => (
          <line
            key={`${i}-${l.strength}`}
            x1={l.x1 * 0.68}
            y1={l.y1}
            x2={l.x2 * 0.68}
            y2={l.y2}
            stroke={LINK_COLOR[l.strength]}
            strokeWidth={l.strength === 'STRONG' ? 0.9 : 0.6}
            strokeOpacity={l.strength === 'WEAK' ? 0.45 : 0.8}
            strokeDasharray={l.strength === 'WEAK' ? '1.2 1' : undefined}
            strokeLinecap="round"
            className="transition-all duration-500"
          >
            {l.strength === 'STRONG' && <animate attributeName="stroke-opacity" values=".55;.95;.55" dur="2.4s" repeatCount="indefinite" />}
          </line>
        ))}
      </svg>
      {children}
    </div>
  );
}

export function SlotChip({
  player,
  role,
  selected,
  highlight,
  compact = false,
}: {
  player: PlayerCard | null;
  role: string;
  selected?: boolean;
  highlight?: boolean;
  compact?: boolean;
}) {
  const fit = player ? positionFit(player, role as PlayerCard['position']) : null;
  const size = compact ? 30 : 52;
  if (!player) {
    return (
      <div className="flex flex-col items-center gap-1">
        <div
          className={`grid place-items-center rounded-full border-2 border-dashed font-bold transition ${
            highlight ? 'border-volt bg-volt/15 text-volt' : 'border-white/35 bg-black/20 text-white/70'
          }`}
          style={{ width: size, height: size, fontSize: compact ? 8 : 11 }}
        >
          {role}
        </div>
      </div>
    );
  }
  const fitStyle = FIT_STYLE[fit!.level];
  return (
    <motion.div layout className="flex flex-col items-center" style={{ width: compact ? 54 : 88 }}>
      <div className="relative">
        <div
          className={`rounded-full transition ${selected ? 'ring-[3px] ring-volt ring-offset-2 ring-offset-[#0f4626]' : ''}`}
          style={{ boxShadow: `0 0 0 2px ${fitStyle.color}` }}
        >
          <PlayerAvatar player={player} size={size} />
        </div>
        <span
          className="display absolute -left-1.5 -top-1 rounded-md bg-night/90 px-1 font-extrabold leading-tight text-white num"
          style={{ fontSize: compact ? 9 : 13 }}
        >
          {player.overall}
        </span>
        {!compact && (
          <span
            className="absolute -right-2 -top-1 rounded-md px-1 text-[9px] font-bold uppercase leading-tight text-night"
            style={{ background: fitStyle.color }}
            title={fitStyle.label}
          >
            {role}
          </span>
        )}
      </div>
      <div
        className={`mt-1 max-w-full truncate rounded bg-night/75 px-1.5 font-semibold text-white ${compact ? 'text-[8px]' : 'text-[11px]'}`}
      >
        {player.shortName}
      </div>
    </motion.div>
  );
}

/** Read-only pitch for the reveal screen. */
export function linksFor(ref: FormationRef, slots: (string | null)[], players: Map<string, PlayerCard>) {
  const f = resolveFormation(ref);
  if (!f) return [];
  return chemistryLinks({ ...ref, slots }, players).map((l) => ({
    x1: f.slots[l.a].x,
    y1: f.slots[l.a].y,
    x2: f.slots[l.b].x,
    y2: f.slots[l.b].y,
    strength: l.strength,
  }));
}

export function MiniPitch({
  formationId,
  custom,
  slots,
  players,
  showLinks = true,
}: {
  formationId: string;
  custom?: FormationSlot[] | null;
  slots: (string | null)[];
  players: Map<string, PlayerCard>;
  showLinks?: boolean;
}) {
  const formation = resolveFormation({ formationId, custom });
  if (!formation) return null;
  return (
    <PitchSurface className="w-full" links={showLinks ? linksFor({ formationId, custom }, slots, players) : undefined}>
      {formation.slots.map((s, i) => (
        <div key={i} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${s.x}%`, top: `${s.y}%` }}>
          <SlotChip player={slots[i] ? (players.get(slots[i]!) ?? null) : null} role={s.role} compact />
        </div>
      ))}
    </PitchSurface>
  );
}

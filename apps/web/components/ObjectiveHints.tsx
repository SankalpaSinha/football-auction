'use client';
import { playerHints, type ObjectiveId, type PlayerCard } from '@fa/shared';

/**
 * Age plus whatever your secret objectives care about; players that count are highlighted.
 * `compact` (narrow lists) keeps the age and only the hints that count.
 */
export function PlayerHints({
  ids,
  player,
  compact = false,
  className = '',
}: {
  ids: readonly ObjectiveId[] | null | undefined;
  player: PlayerCard;
  compact?: boolean;
  className?: string;
}) {
  const hints = playerHints(ids ?? [], player).filter((h, i) => !compact || i === 0 || h.hit);
  return (
    <span className={`text-[10px] ${className}`}>
      {hints.map((h, i) => (
        <span key={h.text} className={h.hit ? 'font-bold text-volt' : 'text-dim'} title={h.hit ? 'Counts towards one of your secret objectives' : undefined}>
          {i > 0 && <span className="text-dim"> · </span>}
          {h.text}
        </span>
      ))}
    </span>
  );
}

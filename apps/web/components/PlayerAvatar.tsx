'use client';
import { useState } from 'react';
import type { PlayerCard } from '@fa/shared';

/** Round headshot: licensed photo when the dataset has one, club-coloured initials otherwise. */
export function PlayerAvatar({ player, size = 40 }: { player: PlayerCard; size?: number }) {
  const [failed, setFailed] = useState(false);
  const [a, b] = player.club.colors;
  if (player.imageUrl && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={player.imageUrl}
        alt={player.name}
        title={player.imageCredit ? `${player.name} — photo: ${player.imageCredit}` : player.name}
        loading="lazy"
        onError={() => setFailed(true)}
        className="rounded-full bg-white/10 object-cover object-top"
        style={{ width: size, height: size }}
      />
    );
  }
  const initials = player.shortName
    .split(/[\s.-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  return (
    <div
      className="display grid place-items-center rounded-full font-extrabold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        background: `linear-gradient(140deg, ${a} 0%, ${a} 55%, ${b} 56%, ${b} 100%)`,
        color: '#fff',
        textShadow: '0 1px 3px rgba(0,0,0,.6)',
      }}
    >
      {initials}
    </div>
  );
}

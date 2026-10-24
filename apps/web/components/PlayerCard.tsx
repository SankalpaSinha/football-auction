'use client';
import { useState } from 'react';
import { PLAYSTYLES, playstyleOf, type ClubRef, type PlayerCard as Card, type Tier } from '@fa/shared';
import { faceStats } from '@/lib/format';

const TIER_STYLE: Record<Tier, { bg: string; edge: string; glow: string; text: string; label: string }> = {
  COMMON: {
    bg: 'linear-gradient(160deg,#465066 0%,#222939 52%,#10141d 100%)',
    edge: 'linear-gradient(160deg,#cbd5e1,#475569 50%,#94a3b8)',
    glow: 'rgba(148,163,184,.25)',
    text: '#e2e8f0',
    label: 'Common',
  },
  RARE: {
    bg: 'linear-gradient(160deg,#2370d6 0%,#11316b 52%,#081531 100%)',
    edge: 'linear-gradient(160deg,#7dd3fc,#1d4ed8 50%,#38bdf8)',
    glow: 'rgba(56,189,248,.35)',
    text: '#e0f2fe',
    label: 'Rare',
  },
  ELITE: {
    bg: 'linear-gradient(160deg,#8b46f5 0%,#3d1680 52%,#170933 100%)',
    edge: 'linear-gradient(160deg,#e9d5ff,#6d28d9 50%,#c084fc)',
    glow: 'rgba(192,132,252,.4)',
    text: '#f3e8ff',
    label: 'Elite',
  },
  LEGENDARY: {
    bg: 'linear-gradient(160deg,#f7cf55 0%,#94600c 44%,#2b1a04 100%)',
    edge: 'linear-gradient(160deg,#fff7cc,#b45309 50%,#fde68a)',
    glow: 'rgba(245,197,66,.5)',
    text: '#fffbeb',
    label: 'Legendary',
  },
};

const SIZES = { lg: 16, md: 13, sm: 9.5, xs: 7 } as const;

export function PlayerCard({ player, size = 'lg', className = '' }: { player: Card; size?: keyof typeof SIZES; className?: string }) {
  const t = TIER_STYLE[player.tier];
  const stats = faceStats(player);
  const shiny = player.tier === 'ELITE' || player.tier === 'LEGENDARY';

  return (
    <div
      className={`relative select-none ${className}`}
      style={{ fontSize: SIZES[size], width: '18.75em', filter: `drop-shadow(0 1.5em 2.5em ${t.glow})` }}
    >
      {/* metallic edge */}
      <div className="cut-corners absolute inset-0" style={{ background: t.edge }} />
      <div
        className="cut-corners relative m-[0.12em] overflow-hidden"
        style={{ background: t.bg, aspectRatio: '300 / 430', color: t.text }}
      >
        {/* texture */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.12] mix-blend-overlay"
          style={{ backgroundImage: 'repeating-linear-gradient(115deg, #fff 0 1px, transparent 1px 9px)' }}
        />
        {player.tier === 'LEGENDARY' && (
          <div
            className="animate-holo pointer-events-none absolute inset-0 opacity-25 mix-blend-color-dodge"
            style={{
              backgroundImage: 'linear-gradient(110deg,transparent 20%,#ff8ad8 35%,#7af5ff 50%,#c8ff2e 65%,transparent 80%)',
              backgroundSize: '200% 100%',
            }}
          />
        )}
        {shiny && (
          <div className="pointer-events-none absolute inset-y-0 left-0 w-1/3 overflow-visible">
            <div className="animate-shine h-full w-full bg-gradient-to-r from-transparent via-white/25 to-transparent" />
          </div>
        )}

        {/* top: rating column + portrait */}
        <div className="relative flex h-[53%]">
          <div className="z-10 flex w-[30%] flex-col items-center pt-[1.1em]">
            <div className="display text-[3.6em] font-extrabold leading-[0.85]">{player.overall}</div>
            <div className="display mt-[0.15em] text-[1.35em] font-bold tracking-wider opacity-90">{player.position}</div>
            <div className="my-[0.5em] h-px w-[2.2em] bg-current opacity-30" />
            <div className="text-[1.6em] leading-none" title={player.nation.name}>
              {player.nation.flag}
            </div>
            <ClubBadge club={player.club} className="mt-[0.5em] w-[2.4em]" />
          </div>
          <div className="relative w-[70%]">
            <CardPhoto player={player} />
          </div>
        </div>

        {/* name */}
        <div className="relative px-[1em]">
          <div
            className="display truncate text-center text-[1.9em] font-extrabold leading-[1.05]"
            style={{ textShadow: '0 2px 12px rgba(0,0,0,.35)' }}
          >
            {player.shortName}
          </div>
          <div className="truncate text-center text-[0.8em] font-medium uppercase tracking-[0.18em] opacity-70">
            {player.club.name}
          </div>
          <div className="mx-auto my-[0.45em] h-px w-4/5 bg-gradient-to-r from-transparent via-current to-transparent opacity-35" />
          <div className="mx-auto grid w-fit grid-cols-2 gap-x-[2.2em] gap-y-[0.1em]">
            {stats.map((s) => (
              <div key={s.label} className="flex items-baseline gap-[0.4em] leading-[1.25]">
                <span className="display w-[1.6em] text-right text-[1.3em] font-bold num">{s.value}</span>
                <span className="text-[0.78em] font-semibold tracking-widest opacity-75">{s.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="absolute inset-x-0 bottom-[0.7em] flex items-center justify-center gap-[0.5em] text-[0.68em] font-bold uppercase tracking-[0.3em] opacity-70">
          <span className="h-px w-[2em] bg-current opacity-50" />
          <span title={PLAYSTYLES[playstyleOf(player)].blurb}>{PLAYSTYLES[playstyleOf(player)].label}</span>
          <span className="h-px w-[2em] bg-current opacity-50" />
        </div>
      </div>
    </div>
  );
}

export function ClubBadge({ club, className = 'w-6' }: { club: ClubRef; className?: string }) {
  if (club.logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={club.logoUrl} alt={club.name} className={className} />;
  }
  const [a, b] = club.colors;
  return (
    <svg viewBox="0 0 40 46" className={className} aria-label={club.name} role="img">
      <path d="M20 1 L38 7 V22 C38 34 30 41 20 45 C10 41 2 34 2 22 V7 Z" fill={a} stroke="rgba(0,0,0,.35)" strokeWidth="1.5" />
      <path d="M2 18 H38 V24 H2 Z" fill={b} opacity=".9" />
      <text
        x="20"
        y="23"
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize="10.5"
        fontWeight="800"
        fontFamily="var(--font-display)"
        fill={contrast(b)}
      >
        {club.shortName}
      </text>
    </svg>
  );
}

/** Licensed photo faded into the card, or the generated portrait if there is none / it fails. */
function CardPhoto({ player }: { player: Card }) {
  const [failed, setFailed] = useState(false);
  if (!player.imageUrl || failed) return <Portrait club={player.club} seed={player.playerId} />;
  return (
    <div
      className="absolute inset-0"
      style={{ maskImage: 'linear-gradient(to right, transparent 0%, #000 22%)', WebkitMaskImage: 'linear-gradient(to right, transparent 0%, #000 22%)' }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={player.imageUrl}
        alt={player.name}
        onError={() => setFailed(true)}
        className="h-full w-full object-cover"
        style={{
          objectPosition: '50% 18%',
          maskImage: 'linear-gradient(to bottom, #000 62%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, #000 62%, transparent 100%)',
        }}
      />
    </div>
  );
}

/** Generated, license-free portrait: silhouette in club colours. */
function Portrait({ club, seed }: { club: ClubRef; seed: string }) {
  const [a, b] = club.colors;
  let h = 0;
  for (const ch of seed) h = (h * 33 + ch.charCodeAt(0)) >>> 0;
  const hair = ['#1c1917', '#3f2a1d', '#5b3a1e', '#2b2b2b', '#d6b46a'][h % 5];
  const skin = ['#f1c7a5', '#d9a57e', '#b97c55', '#8d5a3b', '#6e4530'][(h >> 3) % 5];
  const id = `pg-${seed.replace(/[^a-z0-9]/gi, '')}`;
  return (
    <svg viewBox="0 0 200 220" className="absolute bottom-0 right-[-4%] h-[104%]" aria-hidden>
      <defs>
        <radialGradient id={`${id}-bg`} cx="50%" cy="40%" r="60%">
          <stop offset="0" stopColor={a} stopOpacity=".55" />
          <stop offset="1" stopColor={a} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-shade`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity=".45" />
        </linearGradient>
      </defs>
      <circle cx="110" cy="95" r="95" fill={`url(#${id}-bg)`} />
      {/* shoulders / shirt */}
      <path d="M22 220 C26 168 60 150 110 146 C160 150 194 168 198 220 Z" fill={a} />
      <path d="M86 147 L110 176 L134 147 C126 145 118 144 110 144 C102 144 94 145 86 147 Z" fill={b} />
      <path d="M22 220 C26 168 60 150 110 146 C160 150 194 168 198 220 Z" fill={`url(#${id}-shade)`} />
      {/* neck + head */}
      <path d="M95 118 h30 v34 c-10 7 -20 7 -30 0 z" fill={skin} />
      <path d="M95 140 c10 6 20 6 30 0 v8 c-10 6 -20 6 -30 0z" fill="#000" opacity=".15" />
      <ellipse cx="110" cy="92" rx="32" ry="38" fill={skin} />
      <path d="M78 86 C76 56 98 46 112 48 C132 48 146 62 142 88 C138 74 128 66 110 66 C94 66 84 74 78 86 Z" fill={hair} />
    </svg>
  );
}

function contrast(hex: string) {
  const v = hex.replace('#', '');
  const n = parseInt(v.length === 3 ? v.replace(/./g, '$&$&') : v, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const bl = n & 255;
  return r * 0.299 + g * 0.587 + bl * 0.114 > 150 ? '#0b0f17' : '#ffffff';
}

'use client';
import { useMemo, useRef, useState } from 'react';
import type { ProfileView } from '@fa/shared';

const W = 640;
const H = 200;
const PAD = { l: 36, r: 12, t: 12, b: 24 };
const LINE = '#c8ff2e';

/** Squad score over recent games (oldest → newest), with a hover crosshair. */
export function ScoreTrend({ trend }: { trend: ProfileView['trend'] }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const { pts, ticks, y } = useMemo(() => {
    const scores = trend.map((t) => t.score);
    const lo = Math.max(0, Math.floor((Math.min(...scores) - 5) / 10) * 10);
    const hi = Math.min(100, Math.ceil((Math.max(...scores) + 5) / 10) * 10);
    const y = (v: number) => PAD.t + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - PAD.t - PAD.b);
    const x = (i: number) => PAD.l + (trend.length === 1 ? 0.5 : i / (trend.length - 1)) * (W - PAD.l - PAD.r);
    const ticks: number[] = [];
    for (let v = lo; v <= hi; v += hi - lo > 30 ? 20 : 10) ticks.push(v);
    return { pts: trend.map((t, i) => ({ x: x(i), y: y(t.score), t })), ticks, y };
  }, [trend]);

  if (trend.length < 2) {
    return <p className="text-sm text-muted">Play a couple more games to see your score trend.</p>;
  }

  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const onMove = (e: React.PointerEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    pts.forEach((p, i) => {
      if (Math.abs(p.x - px) < Math.abs(pts[best].x - px)) best = i;
    });
    setHover(best);
  };
  const h = hover !== null ? pts[hover] : null;

  return (
    <div className="relative">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full touch-none"
        role="img"
        aria-label={`Squad score over the last ${trend.length} games, from ${trend[0].score} to ${trend[trend.length - 1].score}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,.07)" />
            <text x={PAD.l - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="#8b94a8">
              {v}
            </text>
          </g>
        ))}
        <path d={path} fill="none" stroke={LINE} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {pts.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={p.t.rank === 1 ? 5 : 4}
            fill={p.t.rank === 1 ? LINE : '#0a0f1c'}
            stroke={LINE}
            strokeWidth="2"
          />
        ))}
        {h && <line x1={h.x} x2={h.x} y1={PAD.t} y2={H - PAD.b} stroke="rgba(255,255,255,.25)" strokeDasharray="3 3" />}
        <text x={PAD.l} y={H - 6} fontSize="11" fill="#8b94a8">
          oldest
        </text>
        <text x={W - PAD.r} y={H - 6} fontSize="11" fill="#8b94a8" textAnchor="end">
          latest
        </text>
      </svg>
      {h && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-lg border border-white/10 bg-night/95 px-3 py-1.5 text-xs shadow-xl"
          style={{ left: `${(h.x / W) * 100}%`, top: `${(h.y / H) * 100}%`, marginTop: -10 }}
        >
          <div className="font-bold text-ink num">{h.t.score.toFixed(1)}</div>
          <div className="text-muted">
            #{h.t.rank} of {h.t.players} · {h.t.mode === 'RANKED' ? 'ranked' : 'casual'} · {new Date(h.t.endedAt).toLocaleDateString()}
          </div>
        </div>
      )}
      <p className="mt-1 text-xs text-dim">Filled dots are wins. Hover for details.</p>
    </div>
  );
}

/** How often each formation was used. */
export function FormationBars({ formations }: { formations: ProfileView['formations'] }) {
  if (!formations.length) return <p className="text-sm text-muted">No lineups yet.</p>;
  const max = Math.max(...formations.map((f) => f.count));
  return (
    <ul className="space-y-2">
      {formations.map((f) => (
        <li key={f.id} className="grid grid-cols-[72px_1fr_28px] items-center gap-3 text-sm" title={`${f.id}: ${f.count} game${f.count === 1 ? '' : 's'}`}>
          <span className="display font-bold">{f.id}</span>
          <span className="h-3 rounded-[4px] bg-white/[.05]">
            <span className="block h-full rounded-[4px] bg-cyan" style={{ width: `${(f.count / max) * 100}%` }} />
          </span>
          <span className="text-right text-muted num">{f.count}</span>
        </li>
      ))}
    </ul>
  );
}

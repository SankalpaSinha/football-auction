'use client';
import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import type { LotResultView, RoomView } from '@fa/shared';
import { serverNow } from '@/lib/store';
import { PlayerCard } from '../PlayerCard';
import { Avatar, Coin } from '../ui';

const VERDICT = {
  BARGAIN: { label: 'Bargain', cls: 'border-emerald-400/60 bg-emerald-400/15 text-emerald-200', icon: '🟢' },
  FAIR: { label: 'Fair price', cls: 'border-white/20 bg-white/5 text-ink', icon: '⚪' },
  OVERPAY: { label: 'Overpay', cls: 'border-danger/60 bg-danger/15 text-rose-200', icon: '🔴' },
} as const;

export function SoldOverlay({ room, result, me }: { room: RoomView; result: LotResultView; me: string }) {
  const winner = room.members.find((m) => m.userId === result.winnerId);
  const mine = result.winnerId === me;
  const sold = result.outcome === 'SOLD';
  const progress = useProgress(result.nextAt);

  if (!sold) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-night/60 backdrop-blur-[3px]"
      >
        <motion.div initial={{ scale: 0.8, rotate: -6 }} animate={{ scale: 1, rotate: -4 }} className="text-center">
          <div className="display rounded-xl border-4 border-white/30 px-8 py-2 text-6xl font-extrabold text-white/60">Unsold</div>
          <p className="mt-3 text-sm text-muted">{result.player.shortName} may return at the end of the auction</p>
        </motion.div>
      </motion.div>
    );
  }

  const verdict = result.verdict ? VERDICT[result.verdict] : null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.25 } }}
      className="fixed inset-0 z-40 grid place-items-center overflow-hidden bg-night/80 px-4 backdrop-blur-md"
    >
      {mine && <Burst />}
      <div className="relative flex flex-col items-center gap-6 sm:flex-row sm:gap-12">
        <motion.div initial={{ x: -60, opacity: 0, rotate: -8 }} animate={{ x: 0, opacity: 1, rotate: -3 }} transition={{ type: 'spring', stiffness: 120 }}>
          <PlayerCard player={result.player} size="md" />
        </motion.div>

        <div className="text-center sm:text-left">
          <motion.div
            initial={{ scale: 3, opacity: 0, rotate: -25 }}
            animate={{ scale: 1, opacity: 1, rotate: -8 }}
            transition={{ type: 'spring', stiffness: 260, damping: 14, delay: 0.1 }}
            className="display inline-block rounded-xl border-[5px] border-danger px-6 py-1 text-7xl font-extrabold text-danger shadow-[0_0_60px_-10px_#ff4d5e] sm:text-8xl"
          >
            Sold!
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }} className="mt-6">
            <div className="display text-4xl font-extrabold">{result.player.name}</div>
            <div className="label mt-4">Sold to</div>
            <div className="mt-1 flex items-center justify-center gap-3 sm:justify-start">
              <Avatar name={winner?.username ?? '?'} size={40} ring={mine ? '#c8ff2e' : undefined} />
              <span className={`display text-4xl font-extrabold ${mine ? 'text-volt' : ''}`}>{mine ? 'You!' : winner?.username}</span>
            </div>
            <div className="label mt-4">For</div>
            <div className="mt-1 flex items-center justify-center gap-2 sm:justify-start">
              <Coin className="h-8 w-8" />
              <span className="display text-6xl font-extrabold text-gold num">{result.price}</span>
              <span className="display text-xl font-bold text-muted">coins</span>
            </div>
          </motion.div>

          {verdict && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.7 }}
              className={`mt-5 inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-bold ${verdict.cls}`}
            >
              {verdict.icon} {verdict.label}
              <span className="font-medium opacity-75">· est. value {result.estimatedValue}</span>
            </motion.div>
          )}
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 h-1 bg-white/5">
        <div className="h-full bg-volt/70" style={{ width: `${progress * 100}%` }} />
      </div>
    </motion.div>
  );
}

function useProgress(until: number) {
  const [start] = useState(() => serverNow());
  const [p, setP] = useState(0);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const total = Math.max(1, until - start);
      setP(Math.min(1, (serverNow() - start) / total));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [until, start]);
  return p;
}

function Burst() {
  const bits = Array.from({ length: 28 }, (_, i) => i);
  return (
    <div className="pointer-events-none absolute inset-0">
      {bits.map((i) => {
        const angle = (i / bits.length) * Math.PI * 2;
        const dist = 260 + (i % 5) * 60;
        return (
          <motion.span
            key={i}
            initial={{ x: 0, y: 0, opacity: 1, rotate: 0 }}
            animate={{ x: Math.cos(angle) * dist, y: Math.sin(angle) * dist, opacity: 0, rotate: 360 }}
            transition={{ duration: 1.4, ease: 'easeOut' }}
            className="absolute left-1/2 top-1/2 h-2.5 w-1.5 rounded-sm"
            style={{ background: ['#c8ff2e', '#2ee6ff', '#f5c542', '#ff6b8a'][i % 4] }}
          />
        );
      })}
    </div>
  );
}

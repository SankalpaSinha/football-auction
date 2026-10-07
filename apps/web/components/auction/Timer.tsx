'use client';
import { motion } from 'motion/react';

export function Timer({ remainingMs, totalMs, paused, size = 132 }: { remainingMs: number; totalMs: number; paused: boolean; size?: number }) {
  const secs = Math.ceil(remainingMs / 1000);
  const frac = Math.max(0, Math.min(1, remainingMs / Math.max(totalMs, remainingMs, 1)));
  const urgent = secs <= 5 && !paused;
  const warn = secs <= 10 && !paused;
  const color = paused ? '#8b94a8' : urgent ? '#ff4d5e' : warn ? '#ffb020' : '#c8ff2e';
  const r = 54;
  const c = 2 * Math.PI * r;

  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg viewBox="0 0 128 128" className="absolute inset-0 -rotate-90">
        <circle cx="64" cy="64" r={r} fill="none" stroke="rgba(255,255,255,.07)" strokeWidth="9" />
        <circle
          cx="64"
          cy="64"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          style={{ filter: `drop-shadow(0 0 8px ${color}aa)`, transition: 'stroke .3s' }}
        />
      </svg>
      <motion.div
        key={urgent ? secs : 'calm'}
        initial={urgent ? { scale: 1.35 } : false}
        animate={{ scale: 1 }}
        className={`display relative text-center font-extrabold leading-none num ${urgent ? 'animate-urgent' : ''}`}
        style={{ color, fontSize: size * 0.36 }}
      >
        {paused ? '❚❚' : secs}
        <div className="label mt-1 !text-[0.6rem]" style={{ color: '#8b94a8' }}>
          {paused ? 'paused' : 'seconds'}
        </div>
      </motion.div>
    </div>
  );
}

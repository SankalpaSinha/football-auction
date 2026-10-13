'use client';
import { useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';

/** 3D tilt + moving glare that follows the pointer (desktop). */
export function TiltCard({ children, max = 10 }: { children: React.ReactNode; max?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const [t, setT] = useState({ rx: 0, ry: 0, gx: 50, gy: 30, on: false });

  const move = (e: React.PointerEvent) => {
    if (reduce || e.pointerType !== 'mouse') return;
    const r = ref.current!.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    setT({ rx: (0.5 - py) * 2 * max, ry: (px - 0.5) * 2 * max, gx: px * 100, gy: py * 100, on: true });
  };

  return (
    <motion.div
      ref={ref}
      onPointerMove={move}
      onPointerLeave={() => setT((s) => ({ ...s, rx: 0, ry: 0, on: false }))}
      animate={{ rotateX: t.rx, rotateY: t.ry }}
      transition={{ type: 'spring', stiffness: 220, damping: 18, mass: 0.6 }}
      style={{ transformStyle: 'preserve-3d' }}
      className="relative"
    >
      {children}
      <div
        className="cut-corners pointer-events-none absolute inset-0 mix-blend-overlay transition-opacity duration-300"
        style={{
          opacity: t.on ? 1 : 0,
          background: `radial-gradient(circle at ${t.gx}% ${t.gy}%, rgba(255,255,255,.45), rgba(255,255,255,0) 45%)`,
        }}
      />
    </motion.div>
  );
}

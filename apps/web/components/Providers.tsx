'use client';
import { useEffect } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { loadSession } from '@/lib/api';
import { sound } from '@/lib/sound';
import { useGame } from '@/lib/store';

export function Providers({ children }: { children: React.ReactNode }) {
  const setSession = useGame((s) => s.setSession);
  const soundOn = useGame((s) => s.soundOn);

  useEffect(() => {
    setSession(loadSession());
    try {
      if (localStorage.getItem('fa.sound') === '0') useGame.getState().setSound(false);
    } catch {}
    // Every gesture re-arms audio: iOS suspends it after interruptions (calls, screen lock).
    const unlock = () => sound.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [setSession]);

  useEffect(() => {
    sound.enabled = soundOn;
  }, [soundOn]);

  return (
    <>
      {children}
      <Toaster />
    </>
  );
}

function Toaster() {
  const toasts = useGame((s) => s.toasts);
  const dismiss = useGame((s) => s.dismiss);
  const tone = {
    error: 'border-danger/50 bg-danger/15 text-rose-100',
    info: 'border-cyan/40 bg-cyan/10 text-cyan-50',
    success: 'border-volt/50 bg-volt/10 text-lime-50',
    warn: 'border-amber/50 bg-amber/10 text-amber-50',
  };
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 top-3 z-[100] flex flex-col items-center gap-2 px-4">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.button
            key={t.id}
            layout
            initial={{ opacity: 0, y: -16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.96 }}
            onClick={() => dismiss(t.id)}
            className={`pointer-events-auto rounded-xl border px-4 py-2.5 text-sm font-medium shadow-2xl backdrop-blur-xl ${tone[t.kind]}`}
          >
            {t.text}
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  );
}

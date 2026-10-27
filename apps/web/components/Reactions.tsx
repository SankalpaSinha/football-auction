'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { REACTION_EMOJIS, TAUNT_IDS, TAUNTS, type TauntId } from '@fa/shared';
import { emit } from '@/lib/socket';
import { useGame } from '@/lib/store';

/** Emojis drifting up the screen and taunts popping up — everyone in the room sees them. */
export function ReactionLayer({ me }: { me: string }) {
  const reactions = useGame((s) => s.reactions);
  const [, setTick] = useState(0);
  // Re-render now and then so finished reactions drop out.
  useEffect(() => {
    if (!reactions.length) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [reactions.length]);
  const now = Date.now();
  const live = reactions.filter((r) => now - r.at < 4200);
  const taunts = live.filter((r) => r.taunt).slice(-3);
  return (
    <div className="pointer-events-none fixed inset-0 z-[60] overflow-hidden" aria-hidden>
      <AnimatePresence>
        {live
          .filter((r) => r.emoji)
          .map((r) => {
            const x = 8 + ((r.id * 37 + r.userId.length * 13) % 84);
            return (
              <motion.div
                key={`e${r.id}`}
                initial={{ y: 0, opacity: 0, scale: 0.4 }}
                animate={{ y: '-62vh', opacity: [0, 1, 1, 0], scale: [0.4, 1.25, 1, 0.9], rotate: (r.id % 2 ? 1 : -1) * 12 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 3.4, ease: 'easeOut' }}
                className="absolute bottom-6 flex flex-col items-center"
                style={{ left: `${x}%` }}
              >
                <span className="text-5xl drop-shadow-[0_6px_20px_rgba(0,0,0,.5)] sm:text-6xl">{r.emoji}</span>
                <span className={`mt-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${r.userId === me ? 'bg-volt/80 text-night' : 'bg-night/70 text-ink'}`}>
                  {r.userId === me ? 'you' : r.username}
                </span>
              </motion.div>
            );
          })}
      </AnimatePresence>
      <div className="absolute inset-x-0 top-20 flex flex-col items-center gap-2 px-4">
        <AnimatePresence>
          {taunts.map((r) => (
            <motion.div
              key={`t${r.id}`}
              initial={{ opacity: 0, y: -12, scale: 0.8 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ type: 'spring', stiffness: 380, damping: 22 }}
              className="max-w-sm rounded-2xl border border-white/15 bg-deep/95 px-4 py-2 text-center shadow-2xl"
            >
              <span className={`text-xs font-bold ${r.userId === me ? 'text-volt' : 'text-cyan'}`}>{r.userId === me ? 'You' : r.username}</span>
              <span className="display ml-2 text-xl font-extrabold">“{r.taunt}”</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

/** The 😀 button in the top bar: tap an emoji (anyone) or a taunt (managers). */
export function ReactionButton({ canTaunt = true }: { canTaunt?: boolean }) {
  const [open, setOpen] = useState(false);
  const toast = useGame((s) => s.toast);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  async function send(payload: { emoji?: string; taunt?: TauntId }) {
    const r = await emit('room:react', payload);
    if (!r.ok) toast('error', r.code === 'RATE_LIMITED' ? 'Easy — one at a time 😅' : r.error);
    if (payload.taunt) setOpen(false);
  }

  return (
    <>
      <button
        ref={ref}
        onClick={() => setOpen((o) => !o)}
        title="Reactions"
        aria-label="Send a reaction"
        className={`grid h-9 w-9 place-items-center rounded-lg text-lg transition hover:bg-white/5 ${open ? 'bg-white/10' : ''}`}
      >
        😀
      </button>
      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {open && (
              <>
                <div className="fixed inset-0 z-[70]" onClick={() => setOpen(false)} />
                <motion.div
                  role="dialog"
                  aria-label="Reactions"
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 16 }}
                  className="fixed inset-x-3 bottom-3 z-[71] mx-auto max-w-md rounded-2xl border border-white/10 bg-deep/97 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-2xl backdrop-blur-xl sm:bottom-auto sm:left-auto sm:right-5 sm:top-16 sm:mx-0 sm:w-[340px]"
                >
                  <div className="grid grid-cols-5 gap-1">
                    {REACTION_EMOJIS.map((e) => (
                      <button key={e} onClick={() => send({ emoji: e })} className="grid h-12 place-items-center rounded-xl text-3xl transition hover:bg-white/10 active:scale-90">
                        {e}
                      </button>
                    ))}
                  </div>
                  {canTaunt && (
                    <>
                      <div className="label mb-1.5 mt-3 !text-[10px]">Taunts</div>
                      <div className="flex flex-wrap gap-1.5">
                        {TAUNT_IDS.map((t) => (
                          <button
                            key={t}
                            onClick={() => send({ taunt: t })}
                            className="rounded-full border border-white/10 bg-white/[.04] px-3 py-1.5 text-sm font-semibold transition hover:bg-white/10 active:scale-95"
                          >
                            {TAUNTS[t]}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </motion.div>
              </>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </>
  );
}

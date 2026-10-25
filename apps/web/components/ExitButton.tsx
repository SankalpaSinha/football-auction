'use client';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import type { RoomView } from '@fa/shared';
import { emit } from '@/lib/socket';
import { useGame } from '@/lib/store';
import { Button } from './ui';

/** Leave the game for good (with a confirmation that says what happens). */
export function ExitButton({ room }: { room: RoomView }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const toast = useGame((s) => s.toast);
  const inAuction = room.phase === 'AUCTION' || room.phase === 'PLAYER_SOLD';
  const ranked = room.settings.mode === 'RANKED';

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  async function exit() {
    setBusy(true);
    const r = await emit('room:quit');
    setBusy(false);
    if (!r.ok && r.code !== 'NOT_IN_ROOM') return toast('error', r.error);
    router.push('/');
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Exit the game"
        className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white/[.06] px-2.5 text-xs font-bold text-ink transition hover:bg-danger/20 hover:text-rose-200"
      >
        <span aria-hidden>🚪</span>
        <span className="hidden sm:inline">Exit</span>
      </button>
      {/* Portal: the sticky header's backdrop blur would otherwise trap this fixed overlay inside it. */}
      {typeof document !== 'undefined' &&
        createPortal(
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-end justify-center bg-night/70 backdrop-blur-sm sm:items-center"
            onClick={() => setOpen(false)}
          >
            <motion.div
              role="dialog"
              aria-label="Exit the game"
              initial={{ y: 40 }}
              animate={{ y: 0 }}
              exit={{ y: 40 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-sm rounded-t-3xl border border-white/10 bg-deep p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:rounded-3xl"
            >
              <h3 className="display text-2xl font-extrabold">Leave the game?</h3>
              <p className="mt-2 text-sm text-muted">
                {inAuction
                  ? 'Your players go back into the auction and you can’t rejoin as a player (you can still watch).'
                  : 'Your squad is complete, so your lineup will be auto-completed and you’ll still get a result.'}
                {inAuction && ranked && ' In a ranked game this counts as finishing last.'}
              </p>
              <div className="mt-5 flex gap-2">
                <Button variant="secondary" className="flex-1" onClick={() => setOpen(false)}>
                  Stay
                </Button>
                <Button variant="danger" className="flex-1" disabled={busy} onClick={exit}>
                  Exit game
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>,
          document.body,
        )}
    </>
  );
}

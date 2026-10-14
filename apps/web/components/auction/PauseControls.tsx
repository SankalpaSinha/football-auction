'use client';
import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { RoomView } from '@fa/shared';
import { emit } from '@/lib/socket';
import { useGame } from '@/lib/store';
import { useCountdownTo } from './useCountdown';

const clock = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function useAction() {
  const toast = useGame((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const run = async (event: 'auction:pause' | 'auction:pause-vote' | 'auction:resume', payload?: unknown) => {
    setBusy(true);
    const r = await emit(event, payload);
    setBusy(false);
    if (!r.ok) toast('error', r.error);
  };
  return { busy, run };
}

/** Header button: ask everyone to pause. */
export function PauseButton({ room, me }: { room: RoomView; me: string }) {
  const a = room.auction!;
  const { busy, run } = useAction();
  const isManager = room.members.some((m) => m.userId === me);
  if (!isManager || a.freePick || a.hold || a.pauseVote) return null;
  return (
    <button
      onClick={() => run('auction:pause')}
      disabled={busy || a.paused}
      title="Pause the auction — everyone has to agree"
      className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white/[.06] px-2.5 text-xs font-bold text-ink transition hover:bg-white/10 disabled:opacity-40"
    >
      <span aria-hidden>⏸</span>
      <span className="hidden sm:inline">Pause</span>
    </button>
  );
}

/** Pause vote / agreed pause / inactivity warning, shown above the lot. */
export function PauseBanners({ room, me }: { room: RoomView; me: string }) {
  const a = room.auction!;
  const name = (id: string) => room.members.find((m) => m.userId === id)?.username ?? 'Someone';
  const idle = a.idleLots[me] ?? 0;
  const limit = room.rules.inactiveLotsToRemove;
  const showIdle = !!a.lot && !a.hold && idle >= limit - 1 && idle > 0;

  return (
    <AnimatePresence initial={false}>
      {a.pauseVote && <VoteBanner key={`vote-${a.pauseVote.endsAt}`} room={room} me={me} name={name} />}
      {a.hold && <HoldBanner key="hold" room={room} me={me} name={name} />}
      {showIdle && (
        <motion.div
          key="idle"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          role="alert"
          className="rounded-2xl border border-amber-300/40 bg-amber-300/10 px-4 py-3 text-sm text-amber-100"
        >
          <b>Still there?</b> You’ve let {idle} lot{idle === 1 ? '' : 's'} in a row run out without bidding or skipping.
          Bid or skip this one, or you’ll be removed from the game.
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function VoteBanner({ room, me, name }: { room: RoomView; me: string; name: (id: string) => string }) {
  const vote = room.auction!.pauseVote!;
  const left = useCountdownTo(vote.endsAt);
  const { busy, run } = useAction();
  const mustAnswer = vote.waitingOn.includes(me);
  const asker = vote.requestedBy === me ? 'You' : name(vote.requestedBy);
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-2xl border border-cyan/40 bg-cyan/10 px-4 py-3"
    >
      <span className="text-xl" aria-hidden>
        ⏸
      </span>
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-bold">
          {asker} asked to pause <span className="font-normal text-muted num">· {Math.ceil(left / 1000)}s</span>
        </div>
        <div className="text-xs text-muted">
          Everyone has to agree.{' '}
          {vote.waitingOn.length > 0 && `Waiting for ${vote.waitingOn.map((id) => (id === me ? 'you' : name(id))).join(', ')}.`}
        </div>
      </div>
      {mustAnswer && (
        <div className="flex gap-2">
          <button
            disabled={busy}
            onClick={() => run('auction:pause-vote', { agree: true })}
            className="h-9 rounded-lg bg-volt px-4 text-xs font-extrabold text-night disabled:opacity-50"
          >
            Agree
          </button>
          <button
            disabled={busy}
            onClick={() => run('auction:pause-vote', { agree: false })}
            className="h-9 rounded-lg bg-white/10 px-4 text-xs font-bold disabled:opacity-50"
          >
            No
          </button>
        </div>
      )}
    </motion.div>
  );
}

function HoldBanner({ room, me, name }: { room: RoomView; me: string; name: (id: string) => string }) {
  const hold = room.auction!.hold!;
  const left = useCountdownTo(hold.until);
  const { busy, run } = useAction();
  const isManager = room.members.some((m) => m.userId === me);
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="flex flex-wrap items-center gap-3 rounded-2xl border border-volt/40 bg-volt/10 px-4 py-3"
    >
      <span className="text-xl" aria-hidden>
        ⏸
      </span>
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-bold">Auction paused</div>
        <div className="text-xs text-muted">
          Everyone agreed to {hold.by === me ? 'your' : `${name(hold.by)}’s`} pause · resumes by itself in{' '}
          <span className="num">{clock(left)}</span>
        </div>
      </div>
      {isManager && (
        <button
          disabled={busy}
          onClick={() => run('auction:resume')}
          className="h-9 rounded-lg bg-volt px-4 text-xs font-extrabold text-night disabled:opacity-50"
        >
          ▶ Resume
        </button>
      )}
    </motion.div>
  );
}

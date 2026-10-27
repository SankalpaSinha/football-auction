'use client';
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { isStarPlayer, type LotView, type MemberView, type RoomView } from '@fa/shared';
import { coins } from '@/lib/format';
import { emit } from '@/lib/socket';
import { useGame } from '@/lib/store';
import { Coin } from '../ui';

/** Why the local manager can't bid right now (a hint only — the server decides). */
export function bidBlocker(room: RoomView, lot: LotView, me: MemberView | undefined, remainingMs: number): string | null {
  if (!me) return 'You are spectating';
  if (!me.connected) return 'Reconnecting…';
  if (lot.frozen?.includes(me.userId)) return 'You’ve been frozen out of this one ❄️';
  if (lot.pausedRemainingMs !== null) return room.auction?.hold ? 'Paused — anyone can resume' : 'Auction paused';
  if (remainingMs <= 0) return 'Hammer falling…';
  if (me.squad.length >= room.rules.squadSize) return 'Your squad is complete';
  if (lot.skippedBy.includes(me.userId)) return 'You skipped this player';
  if (lot.highestBidderId === me.userId) return null;
  const hasGk = me.squad.some((s) => s.player.position === 'GK');
  if (!hasGk && room.rules.squadSize - me.squad.length === 1 && lot.player.position !== 'GK') {
    return 'Your last slot must be a goalkeeper';
  }
  const cap = room.rules.starCap;
  if (isStarPlayer(lot.player) && me.squad.filter((s) => isStarPlayer(s.player)).length >= cap.max) {
    return `Star limit reached (${cap.max} star players)`;
  }
  if ((me.maxBid ?? 0) < lot.minNextBid) return `Your max bid is ${me.maxBid} — can’t match`;
  return null;
}

export function BidPanel({ room, lot, me, remainingMs }: { room: RoomView; lot: LotView; me: MemberView | undefined; remainingMs: number }) {
  const toast = useGame((s) => s.toast);
  const [pending, setPending] = useState(false);
  const [custom, setCustom] = useState('');
  const leading = lot.highestBidderId === me?.userId;
  const blocker = bidBlocker(room, lot, me, remainingMs);
  const canBid = !blocker && !leading && !pending;
  const canSkip =
    !!me && !pending && !leading && !lot.skippedBy.includes(me.userId) && !lot.frozen.includes(me.userId) && me.squad.length < room.rules.squadSize && remainingMs > 0;
  const maxBid = me?.maxBid ?? 0;
  const leader = room.members.find((m) => m.userId === lot.highestBidderId);

  useEffect(() => setCustom(''), [lot.lotNumber]);

  async function bid(amount: number) {
    if (!canBid) return;
    setPending(true);
    const r = await emit('auction:bid', { lotNumber: lot.lotNumber, amount });
    setPending(false);
    if (!r.ok) toast('error', r.error);
    else setCustom('');
  }

  async function skip() {
    if (!canSkip) return;
    setPending(true);
    const r = await emit('auction:skip', { lotNumber: lot.lotNumber });
    setPending(false);
    if (!r.ok) toast('error', r.error);
  }

  const amountFor = (inc: number) => Math.max(lot.minNextBid, (lot.currentBid ?? 0) + inc);

  // Keyboard: 1–4 quick bids, S skip.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      // Never steal browser shortcuts (Cmd/Ctrl+S…) or act on key auto-repeat.
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const idx = ['1', '2', '3', '4'].indexOf(e.key);
      if (idx >= 0 && room.rules.bidIncrements[idx] !== undefined) void bid(amountFor(room.rules.bidIncrements[idx]));
      if (e.key === 's' || e.key === 'S') void skip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const customNum = Number(custom);
  const customValid = Number.isInteger(customNum) && customNum >= lot.minNextBid && customNum <= maxBid;

  return (
    <div className="flex flex-col gap-4">
      {/* current bid */}
      <div className={`relative overflow-hidden rounded-2xl border p-4 transition-colors ${leading ? 'border-volt/60 bg-volt/[.08]' : 'border-white/10 bg-white/[.03]'}`}>
        <div className="label">{lot.currentBid === null ? 'Opening bid' : 'Current bid'}</div>
        <div className="mt-1 flex items-center gap-2">
          <Coin className="h-7 w-7" />
          <AnimatePresence mode="popLayout">
            <motion.span
              key={lot.currentBid ?? 'none'}
              initial={{ y: 24, opacity: 0, scale: 1.2 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: -24, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 400, damping: 26 }}
              className="display text-6xl font-extrabold leading-none num"
            >
              {lot.currentBid === null ? lot.minNextBid : lot.currentBid}
            </motion.span>
          </AnimatePresence>
        </div>
        <div className="mt-2 text-sm">
          {lot.currentBid === null ? (
            <span className="text-muted">No bids yet</span>
          ) : leading ? (
            <span className="font-bold text-volt">You’re the highest bidder</span>
          ) : (
            <span className="text-muted">
              Highest: <span className="font-bold text-ink">{leader?.username}</span>
            </span>
          )}
          {lot.currentBid !== null && <span className="text-dim"> · next {lot.minNextBid}</span>}
        </div>
      </div>

      {/* quick bids */}
      <div className="grid grid-cols-4 gap-2">
        {room.rules.bidIncrements.map((inc, i) => {
          const amount = amountFor(inc);
          const ok = canBid && amount <= maxBid;
          return (
            <motion.button
              key={inc}
              whileTap={ok ? { scale: 0.92 } : undefined}
              disabled={!ok}
              onClick={() => bid(amount)}
              className="cut-sm group relative flex h-16 flex-col items-center justify-center bg-volt text-night transition hover:brightness-110 disabled:bg-white/[.06] disabled:text-dim"
              title={`Bid ${amount} (key ${i + 1})`}
            >
              <span className="display text-xl font-extrabold leading-none">+{inc}</span>
              <span className="text-[11px] font-bold opacity-70 num">{amount}</span>
            </motion.button>
          );
        })}
      </div>

      {/* custom + skip */}
      <div className="flex gap-2">
        <form
          className="flex min-w-0 flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (customValid) void bid(customNum);
          }}
        >
          <input
            inputMode="numeric"
            value={custom}
            disabled={!canBid}
            onChange={(e) => setCustom(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder={canBid ? `${lot.minNextBid}–${maxBid}` : 'Custom bid'}
            className="h-12 min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-4 font-mono text-lg font-bold outline-none placeholder:text-sm placeholder:font-sans placeholder:font-normal placeholder:text-dim focus:border-volt/60 disabled:opacity-40"
          />
          <button
            type="submit"
            disabled={!canBid || !customValid}
            className="h-12 rounded-xl border border-volt/50 px-4 text-sm font-bold uppercase tracking-wider text-volt transition hover:bg-volt/10 disabled:border-white/10 disabled:text-dim"
          >
            Bid
          </button>
        </form>
        <button
          onClick={skip}
          disabled={!canSkip}
          className="h-12 rounded-xl border border-white/10 bg-white/[.04] px-5 text-sm font-bold uppercase tracking-wider text-muted transition hover:bg-white/10 hover:text-ink disabled:opacity-35"
          title="Skip this player (S)"
        >
          Skip
        </button>
      </div>

      {lot.surcharge > 1 && (
        <div className="rounded-lg border border-amber/40 bg-amber/10 px-3 py-1.5 text-xs font-semibold text-amber-100">
          🔥 Deadline day: the winning bid costs +20%{lot.currentBid !== null ? ` (${Math.round(lot.currentBid * lot.surcharge)} coins at the moment)` : ''}
        </div>
      )}
      <div className="flex min-h-5 items-center justify-between text-xs">
        <span className={blocker && !leading ? 'font-semibold text-amber-200' : 'text-dim'}>
          {leading ? (
            'Hold tight — anyone can still outbid you'
          ) : (
            blocker ?? <span className="hidden md:inline">Keys: 1–4 quick bid · S skip</span>
          )}
        </span>
        <span className="text-dim">
          Max bid <span className="font-bold text-ink num">{coins(me?.maxBid)}</span>
        </span>
      </div>
    </div>
  );
}

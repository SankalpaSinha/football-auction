'use client';
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { MARKET_EVENTS, POWER_CARDS, isStarPlayer, type LotView, type MemberView, type RoomView } from '@fa/shared';
import { emit } from '@/lib/socket';
import { useGame } from '@/lib/store';
import { Coin } from '../ui';
import { bidBlocker } from './BidPanel';
import { useCountdownTo } from './useCountdown';

/** A market event in force: what it does and how many lots it lasts. */
export function MarketBanner({ room }: { room: RoomView }) {
  const m = room.auction?.market;
  return (
    <AnimatePresence>
      {m && (
        <motion.div
          key={m.id}
          initial={{ opacity: 0, y: -10, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10 }}
          className="flex items-center gap-3 rounded-2xl border border-amber/40 bg-gradient-to-r from-amber/20 via-amber/10 to-transparent px-4 py-2.5"
        >
          <span className="text-2xl">{MARKET_EVENTS[m.id].emoji}</span>
          <div className="min-w-0 flex-1">
            <div className="display text-lg font-extrabold leading-tight text-amber-100">{MARKET_EVENTS[m.id].label}</div>
            <div className="text-xs text-amber-100/80">{MARKET_EVENTS[m.id].blurb}</div>
          </div>
          {m.id !== 'SPONSOR' && (
            <span className="shrink-0 rounded-lg bg-amber/20 px-2 py-1 text-xs font-bold text-amber-100">
              {m.lotsLeft} lot{m.lotsLeft === 1 ? '' : 's'} left
            </span>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Sealed lot: one secret bid each — highest wins, and pays what they bid. */
export function SealedPanel({ room, lot, me, remainingMs }: { room: RoomView; lot: LotView; me: MemberView | undefined; remainingMs: number }) {
  const toast = useGame((s) => s.toast);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const mine = lot.sealed?.mine ?? null;
  const decided = lot.sealed?.decided ?? [];
  const frozen = !!me && lot.frozen.includes(me.userId);
  const blocker = mine !== null ? null : frozen ? 'You’ve been frozen out of this one ❄️' : bidBlocker(room, { ...lot, skippedBy: [], highestBidderId: null }, me, remainingMs);
  const max = me?.maxBid ?? 0;
  const n = Number(amount);
  const valid = Number.isInteger(n) && n >= lot.minNextBid && n <= max;
  const waiting = room.members.filter((m) => m.squad.length < room.rules.squadSize && m.connected && !decided.includes(m.userId));

  useEffect(() => setAmount(''), [lot.lotNumber]);

  async function submit(value: number | null) {
    setBusy(true);
    const r = await emit('auction:sealed', { lotNumber: lot.lotNumber, amount: value });
    setBusy(false);
    if (!r.ok) toast('error', r.error);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-2xl border border-cyan/40 bg-cyan/[.07] p-4">
        <div className="label !text-cyan">🔒 Sealed bids</div>
        <p className="mt-1 text-sm text-ink/90">
          Everyone gets <b>one secret bid</b>. Highest wins and pays what they bid. No second chances.
          {lot.surcharge > 1 && <span className="text-amber-200"> Deadline day: the winner pays +20%.</span>}
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {room.members
            .filter((m) => m.squad.length < room.rules.squadSize)
            .map((m) => (
              <span
                key={m.userId}
                className={`rounded-full px-2.5 py-1 text-xs font-bold ${decided.includes(m.userId) ? 'bg-volt/20 text-volt' : 'bg-white/[.06] text-muted'}`}
              >
                {decided.includes(m.userId) ? '🔒' : '…'} {m.userId === me?.userId ? 'You' : m.username}
              </span>
            ))}
        </div>
      </div>

      {mine !== null ? (
        <div className="rounded-2xl border border-volt/50 bg-volt/[.08] p-4 text-center">
          <div className="label">Your sealed choice</div>
          <div className="display mt-1 flex items-center justify-center gap-2 text-4xl font-extrabold">
            {mine === 'PASS' ? (
              'Pass'
            ) : (
              <>
                <Coin className="h-7 w-7" /> <span className="num">{mine}</span>
              </>
            )}
          </div>
          <p className="mt-1 text-xs text-muted">
            {waiting.length ? `Waiting for ${waiting.map((m) => m.username).join(', ')}…` : 'Revealing…'}
          </p>
        </div>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !busy && !blocker) void submit(n);
          }}
        >
          <div className="flex gap-2">
            <input
              inputMode="numeric"
              value={amount}
              disabled={!!blocker || busy}
              onChange={(e) => setAmount(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder={blocker ? 'Sealed bid' : `${lot.minNextBid}–${max}`}
              aria-label="Your sealed bid"
              className="h-14 min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-4 font-mono text-2xl font-bold outline-none placeholder:font-sans placeholder:text-base placeholder:font-normal placeholder:text-dim focus:border-cyan/60 disabled:opacity-40"
            />
            <button
              type="submit"
              disabled={!valid || busy || !!blocker}
              className="h-14 rounded-xl bg-cyan px-5 text-sm font-extrabold uppercase tracking-wider text-night transition hover:brightness-110 disabled:bg-white/[.06] disabled:text-dim"
            >
              Seal it
            </button>
          </div>
          <button
            type="button"
            onClick={() => submit(null)}
            disabled={busy || frozen || !me || me.squad.length >= room.rules.squadSize}
            className="h-11 rounded-xl border border-white/10 bg-white/[.04] text-sm font-bold uppercase tracking-wider text-muted transition hover:bg-white/10 hover:text-ink disabled:opacity-35"
          >
            Pass
          </button>
          <div className="flex justify-between text-xs">
            <span className={blocker ? 'font-semibold text-amber-200' : 'text-dim'}>{blocker ?? 'Nobody sees your bid until the reveal'}</span>
            <span className="text-dim">
              Max <span className="font-bold text-ink num">{max}</span>
            </span>
          </div>
        </form>
      )}
    </div>
  );
}

/** Your power cards during a lot (Freeze). Steal lives on the sale screen; Refund in your squad list. */
export function CardBar({ room, lot, me }: { room: RoomView; lot: LotView; me: MemberView | undefined }) {
  const toast = useGame((s) => s.toast);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const cards = me ? (room.auction?.cards[me.userId] ?? []) : [];
  useEffect(() => setPicking(false), [lot.lotNumber]);
  if (!me || !room.settings.twists.cards) return null;
  const targets = room.members.filter(
    (m) =>
      m.userId !== me.userId &&
      m.squad.length < room.rules.squadSize &&
      !lot.frozen.includes(m.userId) &&
      !lot.skippedBy.includes(m.userId) &&
      !(lot.sealed?.decided ?? []).includes(m.userId),
  );

  async function freeze(targetId: string) {
    setBusy(true);
    const r = await emit('card:freeze', { lotNumber: lot.lotNumber, targetId });
    setBusy(false);
    setPicking(false);
    if (!r.ok) toast('error', r.error);
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/[.03] px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted">Your cards</span>
        {(['FREEZE', 'STEAL', 'REFUND'] as const).map((c) => {
          const has = cards.includes(c);
          const card = POWER_CARDS[c];
          if (c === 'FREEZE') {
            return (
              <button
                key={c}
                disabled={!has || busy || targets.length === 0}
                onClick={() => setPicking((p) => !p)}
                title={card.blurb}
                className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-bold transition disabled:opacity-35 ${
                  picking ? 'bg-cyan text-night' : 'bg-cyan/15 text-cyan hover:bg-cyan/25'
                }`}
              >
                {card.emoji} {card.label}
              </button>
            );
          }
          return (
            <span
              key={c}
              title={`${card.blurb}${c === 'STEAL' ? ' (appears right after a sale)' : ' (use it from your squad list)'}`}
              className={`inline-flex h-8 items-center gap-1.5 rounded-lg bg-white/[.05] px-2.5 text-xs font-bold ${has ? 'text-ink' : 'text-dim line-through'}`}
            >
              {card.emoji} {card.label}
            </span>
          );
        })}
      </div>
      <AnimatePresence>
        {picking && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="mt-2 text-xs text-muted">Freeze who out of {lot.kind === 'MYSTERY' ? 'this mystery player' : lot.player.shortName}?</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {targets.map((m) => (
                <button
                  key={m.userId}
                  disabled={busy}
                  onClick={() => freeze(m.userId)}
                  className="rounded-lg border border-cyan/40 bg-cyan/10 px-3 py-1.5 text-sm font-bold text-cyan transition hover:bg-cyan/20"
                >
                  ❄️ {m.username}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Big Steal button on the sale screen while the window is open. */
export function StealButton({ room, me }: { room: RoomView; me: string }) {
  const toast = useGame((s) => s.toast);
  const r = room.auction?.lastResult;
  const left = useCountdownTo(r?.stealUntil ?? 0);
  const [busy, setBusy] = useState(false);
  const self = room.members.find((m) => m.userId === me);
  if (!r || r.outcome !== 'SOLD' || !r.stealUntil || r.winnerId === me || !self) return null;
  if (!room.auction?.cards[me]?.includes('STEAL') || left <= 0) return null;
  const full = self.squad.length >= room.rules.squadSize;
  const starBlocked = isStarPlayer(r.player) && self.squad.filter((e) => isStarPlayer(e.player)).length >= room.rules.starCap.max;
  const cantAfford = (r.price ?? 0) > (self.budget ?? 0) - (room.rules.squadSize - self.squad.length - 1) * room.rules.reservePerSlot;
  const blocked = full || starBlocked || cantAfford;

  async function steal() {
    setBusy(true);
    const res = await emit('card:steal', { lotNumber: r!.lotNumber });
    setBusy(false);
    if (!res.ok) toast('error', res.error);
  }

  return (
    <motion.button
      initial={{ scale: 0.6, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      whileTap={{ scale: 0.94 }}
      disabled={busy || blocked}
      onClick={steal}
      title={blocked ? (full ? 'Your squad is full' : starBlocked ? 'Star limit reached' : 'Not enough coins to match the price') : 'Pay the same price and take him'}
      className="pointer-events-auto relative mt-5 overflow-hidden rounded-2xl border-2 border-fuchsia-300 bg-fuchsia-500/25 px-6 py-3 text-left shadow-[0_0_40px_-6px_rgba(232,121,249,.8)] disabled:border-white/20 disabled:bg-white/5 disabled:shadow-none"
    >
      <span className="absolute inset-y-0 left-0 bg-fuchsia-400/25" style={{ width: `${Math.min(100, (left / 3000) * 100)}%` }} />
      <span className="relative block display text-2xl font-extrabold text-fuchsia-100">🦹 STEAL for {r.price}</span>
      <span className="relative block text-xs text-fuchsia-100/80">
        {blocked ? (full ? 'Your squad is full' : starBlocked ? 'You’re at the star limit' : 'You can’t spare that many coins') : `${(left / 1000).toFixed(1)}s — one use per game`}
      </span>
    </motion.button>
  );
}

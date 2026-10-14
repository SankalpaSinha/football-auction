'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { GROUP_ORDER, POSITION_GROUP, type MemberView, type RoomView, type SquadEntry, type TradeOffer } from '@fa/shared';
import { coins } from '@/lib/format';
import { emit } from '@/lib/socket';
import { sound } from '@/lib/sound';
import { useGame } from '@/lib/store';
import { PlayerAvatar } from '../PlayerAvatar';
import { Avatar, Button, Coin } from '../ui';
import { useCountdownTo } from './useCountdown';

/** Trades and releases are open while lots are being auctioned (not in free pick). */
export function dealsOpen(room: RoomView) {
  return (room.phase === 'AUCTION' || room.phase === 'PLAYER_SOLD') && !!room.auction && !room.auction.freePick;
}

const RESERVE = 10;

const sortSquad = (squad: SquadEntry[]) =>
  [...squad].sort(
    (a, b) =>
      GROUP_ORDER.indexOf(POSITION_GROUP[a.player.position]) - GROUP_ORDER.indexOf(POSITION_GROUP[b.player.position]) ||
      b.player.overall - a.player.overall,
  );

/** Build an offer: players each way plus coins one way. */
export function TradeComposer({ room, me, partner, onClose }: { room: RoomView; me: MemberView; partner: MemberView; onClose: () => void }) {
  const toast = useGame((s) => s.toast);
  const [give, setGive] = useState<string[]>([]);
  const [take, setTake] = useState<string[]>([]);
  const [amount, setAmount] = useState('');
  const [iPay, setIPay] = useState(true);
  const [busy, setBusy] = useState(false);
  const size = room.rules.squadSize;
  const max = 3;
  const n = Math.max(0, Math.floor(Number(amount) || 0));
  const coinsSigned = iPay ? n : -n;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Client-side hints only — the server re-checks everything.
  const problem = useMemo(() => {
    if (give.length + take.length === 0) return 'Pick at least one player.';
    const mine = me.squad.length - give.length + take.length;
    const theirs = partner.squad.length - take.length + give.length;
    if (mine > size) return `You’d have more than ${size} players.`;
    if (theirs > size) return `${partner.username} would have more than ${size} players.`;
    const myBudget = (me.budget ?? 0) - coinsSigned;
    const theirBudget = (partner.budget ?? 0) + coinsSigned;
    if (myBudget < (size - mine) * RESERVE) return 'You wouldn’t have enough coins left to fill your squad.';
    if (theirBudget < (size - theirs) * RESERVE) return `${partner.username} couldn’t afford that.`;
    return null;
  }, [give, take, me, partner, size, coinsSigned]);

  const toggle = (list: string[], set: (v: string[]) => void, id: string) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : list.length >= max ? list : [...list, id]);

  async function send() {
    if (problem) return;
    setBusy(true);
    const r = await emit('trade:propose', { toId: partner.userId, give, take, coins: coinsSigned });
    setBusy(false);
    if (!r.ok) return toast('error', r.error);
    toast('success', `Offer sent to ${partner.username}`);
    onClose();
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-end justify-center bg-night/70 backdrop-blur-sm sm:items-center"
      onClick={onClose}
    >
      <motion.div
        role="dialog"
        aria-label={`Trade with ${partner.username}`}
        initial={{ y: 60 }}
        animate={{ y: 0 }}
        exit={{ y: 60 }}
        transition={{ type: 'spring', stiffness: 320, damping: 30 }}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90dvh] w-full max-w-2xl flex-col rounded-t-3xl border border-white/10 bg-deep p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:rounded-3xl"
      >
        <div className="mb-3 flex items-center gap-3">
          <Avatar name={partner.username} size={36} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-lg font-bold">Trade with {partner.username}</div>
            <div className="text-xs text-muted">Up to {max} players each way, plus coins. They have to accept.</div>
          </div>
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-white/5" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-2 gap-3">
          <PickList title="You give" squad={me.squad} picked={give} onToggle={(id) => toggle(give, setGive, id)} budget={me.budget} />
          <PickList title={`You get`} squad={partner.squad} picked={take} onToggle={(id) => toggle(take, setTake, id)} budget={partner.budget} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg bg-white/[.05] p-0.5 text-xs font-bold">
            {[true, false].map((v) => (
              <button
                key={String(v)}
                onClick={() => setIPay(v)}
                className={`h-8 rounded-md px-3 ${iPay === v ? 'bg-white/10 text-ink' : 'text-muted'}`}
              >
                {v ? 'You pay' : 'They pay'}
              </button>
            ))}
          </div>
          <label className="flex h-9 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[.03] px-2">
            <Coin className="h-4 w-4" />
            <input
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, '').slice(0, 5))}
              placeholder="0"
              aria-label="Coins"
              className="w-20 bg-transparent text-sm font-bold outline-none num"
            />
          </label>
          <div className="ml-auto flex items-center gap-2">
            {problem && <span className="text-xs text-amber-200">{problem}</span>}
            <Button size="sm" disabled={!!problem || busy} onClick={send}>
              Send offer
            </Button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

function PickList({
  title,
  squad,
  picked,
  onToggle,
  budget,
}: {
  title: string;
  squad: SquadEntry[];
  picked: string[];
  onToggle: (id: string) => void;
  budget: number | null;
}) {
  return (
    <div className="flex min-h-0 flex-col rounded-2xl bg-white/[.03] p-2">
      <div className="mb-1.5 flex items-baseline justify-between px-1">
        <span className="label">{title}</span>
        <span className="flex items-center gap-1 text-[10px] text-muted num">
          <Coin className="h-3 w-3" /> {coins(budget)}
        </span>
      </div>
      <ul className="scrollbar-thin max-h-[42dvh] min-h-24 space-y-1 overflow-y-auto">
        {squad.length === 0 && <li className="py-4 text-center text-xs text-dim">No players yet</li>}
        {sortSquad(squad).map((e) => {
          const on = picked.includes(e.player.id);
          return (
            <li key={e.player.id}>
              <button
                onClick={() => onToggle(e.player.id)}
                aria-pressed={on}
                className={`flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-xs transition ${
                  on ? 'bg-volt/15 ring-1 ring-volt' : 'hover:bg-white/[.06]'
                }`}
              >
                <PlayerAvatar player={e.player} size={22} />
                <span className="w-8 shrink-0 font-bold text-muted">{e.player.position}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{e.player.shortName}</span>
                <span className="display font-bold">{e.player.overall}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Offers you sent or received, shown above the lot. */
export function TradeInbox({ room, me }: { room: RoomView; me: string }) {
  useTradeToasts(room, me);
  const trades = dealsOpen(room) ? room.trades : [];
  return (
    <AnimatePresence initial={false}>
      {trades.map((t) => (
        <motion.div key={t.id} initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }}>
          <OfferCard room={room} me={me} offer={t} />
        </motion.div>
      ))}
    </AnimatePresence>
  );
}

function OfferCard({ room, me, offer }: { room: RoomView; me: string; offer: TradeOffer }) {
  const toast = useGame((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const left = useCountdownTo(offer.expiresAt);
  const incoming = offer.toId === me;
  const other = room.members.find((m) => m.userId === (incoming ? offer.fromId : offer.toId));
  const playerName = (id: string) => {
    for (const m of room.members) {
      const e = m.squad.find((x) => x.player.id === id);
      if (e) return `${e.player.shortName} (${e.player.overall})`;
    }
    return 'a player';
  };
  // From the viewer's point of view.
  const youGet = incoming ? offer.give : offer.take;
  const youGive = incoming ? offer.take : offer.give;
  const youPay = incoming ? -offer.coins : offer.coins;
  const side = (ids: string[], c: number) =>
    [...ids.map(playerName), c > 0 ? `${c} coins` : ''].filter(Boolean).join(' + ') || 'nothing';

  async function act(event: 'trade:respond' | 'trade:cancel', payload: object) {
    setBusy(true);
    const r = await emit(event, payload);
    setBusy(false);
    if (!r.ok) toast('error', r.error);
  }

  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 ${
        incoming ? 'border-cyan/40 bg-cyan/10' : 'border-white/10 bg-white/[.03]'
      }`}
    >
      <span className="text-xl" aria-hidden>
        🤝
      </span>
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-bold">
          {incoming ? `${other?.username ?? 'A manager'} offers you a trade` : `Your offer to ${other?.username ?? 'a manager'}`}
          <span className="font-normal text-muted num"> · {Math.ceil(left / 1000)}s</span>
        </div>
        <div className="text-xs text-muted">
          You get <b className="text-ink">{side(youGet, -youPay)}</b> · you give <b className="text-ink">{side(youGive, youPay)}</b>
        </div>
      </div>
      {incoming ? (
        <div className="flex gap-2">
          <button
            disabled={busy}
            onClick={() => act('trade:respond', { tradeId: offer.id, accept: true })}
            className="h-9 rounded-lg bg-volt px-4 text-xs font-extrabold text-night disabled:opacity-50"
          >
            Accept
          </button>
          <button
            disabled={busy}
            onClick={() => act('trade:respond', { tradeId: offer.id, accept: false })}
            className="h-9 rounded-lg bg-white/10 px-4 text-xs font-bold disabled:opacity-50"
          >
            Decline
          </button>
        </div>
      ) : (
        <button
          disabled={busy}
          onClick={() => act('trade:cancel', { tradeId: offer.id })}
          className="h-9 rounded-lg bg-white/10 px-4 text-xs font-bold disabled:opacity-50"
        >
          Cancel
        </button>
      )}
    </div>
  );
}

function useTradeToasts(room: RoomView, me: string) {
  const lastEvent = useGame((s) => s.lastEvent);
  const toast = useGame((s) => s.toast);
  const seen = useRef(0);
  const members = useRef(room.members);
  members.current = room.members;
  useEffect(() => {
    if (!lastEvent || lastEvent.at === seen.current) return;
    seen.current = lastEvent.at;
    const name = (id: string) => members.current.find((m) => m.userId === id)?.username ?? 'A manager';
    if (lastEvent.type === 'TRADE_OFFER' && lastEvent.toId === me) {
      toast('info', `${name(lastEvent.fromId)} sent you a trade offer`);
      sound.bid();
    } else if (lastEvent.type === 'TRADE_DECLINED' && lastEvent.fromId === me) {
      toast('warn', `${name(lastEvent.toId)} declined your offer`);
    } else if (lastEvent.type === 'TRADED' && (lastEvent.fromId === me || lastEvent.toId === me)) {
      toast('success', `Trade done with ${name(lastEvent.fromId === me ? lastEvent.toId : lastEvent.fromId)}`);
    }
  }, [lastEvent, me, toast]);
}

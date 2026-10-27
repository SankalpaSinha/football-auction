'use client';
import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { isStarPlayer, PLAYSTYLES, playstyleOf, POSITION_GROUP, type PlayerCard, type PositionGroup, type RoomView } from '@fa/shared';
import { emit } from '@/lib/socket';
import { useGame } from '@/lib/store';
import { PlayerAvatar } from '../PlayerAvatar';
import { useCountdownTo } from './useCountdown';
import { Avatar, Pill } from '../ui';

const GROUPS: (PositionGroup | 'ALL')[] = ['ALL', 'GK', 'DEF', 'MID', 'ATT'];

/**
 * Free pick: everyone else's squad is full, so the last manager simply chooses
 * players from what's left (at the opening price). Others watch it happen.
 * The snake draft uses the same list: managers take turns, the order reversing every round.
 */
export function FreePickPanel({ room, me }: { room: RoomView; me: string }) {
  const d = room.auction!.draft;
  const fp = room.auction!.freePick;
  const toast = useGame((s) => s.toast);
  const pickerId = d?.userId ?? fp!.userId;
  const picker = room.members.find((m) => m.userId === pickerId);
  const isPicker = pickerId === me;
  const slotsLeft = picker ? room.rules.squadSize - picker.squad.length : 0;
  const picksLeft = fp?.picksLeft ?? slotsLeft;
  const needsGk = !!picker && !picker.squad.some((e) => e.player.position === 'GK');
  const cap = room.rules.starCap;
  const starCapped = !!picker && picker.squad.filter((e) => isStarPlayer(e.player)).length >= cap.max;
  const [pool, setPool] = useState<PlayerCard[] | null>(null);
  const [group, setGroup] = useState<PositionGroup | 'ALL'>(needsGk && picksLeft === 1 ? 'GK' : 'ALL');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const left = useCountdownTo(d?.endsAt ?? fp!.endsAt);
  const paused = d?.pausedRemainingMs != null;
  const nameOf = (id: string) => (id === me ? 'You' : (room.members.find((m) => m.userId === id)?.username ?? '?'));

  // Refresh the pool after every pick.
  const pickKey = d ? d.pick : picksLeft;
  useEffect(() => {
    let current = true;
    emit<{ players: PlayerCard[] }>('auction:pool').then((r) => {
      if (current && r.ok) setPool(r.data!.players);
    });
    return () => {
      current = false;
    };
  }, [pickKey]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (pool ?? [])
      .filter((p) => group === 'ALL' || POSITION_GROUP[p.position] === group)
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.club.name.toLowerCase().includes(q))
      .slice(0, 80);
  }, [pool, group, query]);

  async function pick(p: PlayerCard) {
    setBusy(p.id);
    const r = await emit('auction:pick', { playerId: p.id });
    setBusy(null);
    if (!r.ok) toast('error', r.error);
    else toast('success', `${p.shortName} joins your squad`);
  }

  const secs = Math.ceil((paused ? d!.pausedRemainingMs! : left) / 1000);

  return (
    <div className="glass flex flex-col gap-4 rounded-3xl p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <Avatar name={picker?.username ?? '?'} size={40} />
        <div className="min-w-0 flex-1">
          <div className="label text-volt">{d ? `🐍 Snake draft · round ${d.round} · pick ${d.pick}/${d.totalPicks}` : 'Free pick'}</div>
          <h2 className="display text-2xl font-extrabold leading-tight sm:text-3xl">
            {d ? (isPicker ? 'Your pick!' : `${picker?.username} is picking`) : isPicker ? 'Pick your remaining players' : `${picker?.username} is picking`}
          </h2>
          {d ? (
            <p className="text-sm text-muted">
              Up next: {d.upcoming.slice(0, 4).map(nameOf).join(' → ') || '—'}
              {d.upcoming[0] === me && !isPicker && <span className="font-bold text-volt"> · you’re next!</span>}
            </p>
          ) : (
            <p className="text-sm text-muted">
              Everyone else is full, so there’s nobody to bid against — {picksLeft} pick{picksLeft === 1 ? '' : 's'} left, {room.rules.openingBid}{' '}
              coins each.
            </p>
          )}
        </div>
        <span className={`display rounded-xl px-3 py-1.5 text-2xl font-extrabold num ${!paused && secs <= 10 ? 'animate-urgent bg-danger/15 text-danger' : 'bg-white/5'}`}>
          {paused ? '❚❚' : `${secs}s`}
        </span>
      </div>

      {isPicker || d ? (
        <>
          {needsGk && isPicker && (
            <div className="rounded-lg border border-amber/40 bg-amber/10 px-3 py-2 text-xs font-semibold text-amber-100">
              ⚠ You still need a goalkeeper{picksLeft === 1 ? ' — your last pick must be one' : ''}.
            </div>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="flex gap-1 overflow-x-auto">
              {GROUPS.map((g) => (
                <button
                  key={g}
                  onClick={() => setGroup(g)}
                  className={`h-9 shrink-0 rounded-lg border px-3 text-sm font-bold ${g === group ? 'border-volt bg-volt/15 text-volt' : 'border-white/10 bg-white/[.03]'}`}
                >
                  {g === 'ALL' ? 'All' : g}
                </button>
              ))}
            </div>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search player or club"
              aria-label="Search players"
              className="h-9 min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 text-base outline-none focus:border-volt/60 sm:text-sm"
            />
          </div>
          <ul className="scrollbar-thin grid max-h-[55dvh] gap-1.5 overflow-y-auto sm:grid-cols-2">
            {!pool && <li className="h-16 animate-pulse rounded-xl bg-white/5" />}
            {pool && shown.length === 0 && <li className="py-6 text-center text-sm text-dim">No players match.</li>}
            {shown.map((p) => {
              const blocked = starCapped && isStarPlayer(p);
              return (
              <motion.li key={p.id} layout>
                <button
                  onClick={() => pick(p)}
                  disabled={!!busy || blocked || !isPicker || paused}
                  title={blocked ? `Star limit reached (${cap.max} star players)` : undefined}
                  className="flex w-full items-center gap-3 rounded-xl bg-white/[.04] px-2.5 py-2 text-left transition hover:bg-white/[.08] active:scale-[0.99] disabled:opacity-50"
                >
                  <PlayerAvatar player={p} size={38} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{p.name}</span>
                    <span className="block truncate text-xs text-muted">
                      {p.position} · {PLAYSTYLES[playstyleOf(p)].label} · {p.nation.flag} {p.club.name}
                    </span>
                  </span>
                  <span className="display text-xl font-extrabold num">{p.overall}</span>
                  {isPicker && (
                    <span className="rounded-lg bg-volt px-2.5 py-1 text-xs font-bold uppercase text-night">
                      {blocked ? '⭐ cap' : busy === p.id ? '…' : 'Pick'}
                    </span>
                  )}
                </button>
              </motion.li>
              );
            })}
          </ul>
          <p className="text-xs text-dim">
            {isPicker || !d
              ? 'If the timer runs out, the best player for a position you need is picked for you.'
              : 'Plan ahead — you can browse the pool while you wait.'}
          </p>
        </>
      ) : (
        <div className="space-y-2">
          <Pill color="#2ee6ff">Watching</Pill>
          <ul className="space-y-1">
            {[...(picker?.squad ?? [])]
              .filter((e) => e.via === 'PICK')
              .reverse()
              .slice(0, 6)
              .map((e) => (
                <li key={e.player.id} className="flex items-center gap-2 rounded-lg bg-white/[.04] px-2 py-1.5 text-sm">
                  <PlayerAvatar player={e.player} size={26} />
                  <span className="flex-1 truncate">{e.player.name}</span>
                  <span className="text-xs text-muted">{e.player.position}</span>
                  <span className="display font-bold">{e.player.overall}</span>
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}

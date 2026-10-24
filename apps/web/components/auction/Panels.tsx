'use client';
import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { GROUP_ORDER, OBJECTIVES, PLAYSTYLES, playstyleOf, POSITION_GROUP, type LotView, type MemberView, type RoomView } from '@fa/shared';
import { coins, GROUP_LABEL, groupSquad } from '@/lib/format';
import { emit } from '@/lib/socket';
import { useGame } from '@/lib/store';
import { Avatar, Coin, ConnectionDot } from '../ui';
import { dealsOpen } from './Trades';

const GROUP_COLOR = { GK: '#f5c542', DEF: '#2ee6ff', MID: '#c8ff2e', ATT: '#ff6b8a' } as const;

export function SquadPanel({ room, me }: { room: RoomView; me: MemberView | undefined }) {
  const toast = useGame((s) => s.toast);
  const [releasing, setReleasing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!me) return <div className="glass rounded-2xl p-4 text-sm text-muted">Spectating</div>;
  const canRelease = dealsOpen(room);

  async function release(playerId: string) {
    setBusy(true);
    const r = await emit('squad:release', { playerId });
    setBusy(false);
    setReleasing(null);
    if (!r.ok) toast('error', r.error);
  }

  const size = room.rules.squadSize;
  const grouped = groupSquad(me.squad);
  const hasGk = grouped.GK.length > 0;
  const left = size - me.squad.length;
  // Coins actually gone (includes released players and trades).
  const spent = room.settings.startingBudget - (me.budget ?? room.settings.startingBudget);

  return (
    <div className="glass flex h-full flex-col rounded-2xl p-4">
      <div className="label">Your squad</div>
      <div className="mt-2 flex items-end justify-between">
        <div>
          <div className="flex items-center gap-1.5">
            <Coin className="h-5 w-5" />
            <span className="display text-4xl font-extrabold leading-none num">{coins(me.budget)}</span>
          </div>
          <div className="mt-1 text-xs text-muted">
            spent {coins(spent)} · max bid <span className="font-bold text-ink">{coins(me.maxBid)}</span>
          </div>
          <div className="mt-0.5 text-xs text-muted" title={`At most ${room.rules.starCap.max} players rated ${room.rules.starCap.minOverall}+`}>
            ⭐ stars{' '}
            <span className="font-bold text-ink num">
              {me.squad.filter((e) => e.player.overall >= room.rules.starCap.minOverall).length}/{room.rules.starCap.max}
            </span>
          </div>
        </div>
        <div className="text-right">
          <div className="display text-3xl font-extrabold leading-none num">
            {me.squad.length}
            <span className="text-lg text-dim">/{size}</span>
          </div>
          <div className="text-xs text-muted">{left} slots left</div>
        </div>
      </div>

      {/* slot bar */}
      <div className="mt-3 flex gap-[3px]">
        {Array.from({ length: size }, (_, i) => {
          const e = me.squad[i];
          return (
            <div
              key={i}
              className="h-2 flex-1 rounded-full transition-colors"
              style={{ background: e ? GROUP_COLOR[POSITION_GROUP[e.player.position]] : 'rgba(255,255,255,.08)' }}
            />
          );
        })}
      </div>
      {room.myObjectives && room.myObjectives.length > 0 && (
        <div className="mt-3 rounded-lg border border-white/10 bg-white/[.03] px-3 py-2 text-xs" title="Only you can see these. Worth +3 points each.">
          <div className="mb-0.5 font-bold">🕵️ Secret objectives <span className="font-normal text-dim">· +3 each</span></div>
          {room.myObjectives.map((id) => (
            <div key={id} className="text-muted">
              • {OBJECTIVES[id].text}
            </div>
          ))}
        </div>
      )}
      {!hasGk && (
        <div className="mt-3 rounded-lg border border-amber/40 bg-amber/10 px-3 py-1.5 text-xs font-semibold text-amber-100">
          ⚠ You still need a goalkeeper
        </div>
      )}

      <div className="scrollbar-thin -mx-1 mt-3 flex-1 space-y-3 overflow-y-auto px-1">
        {me.squad.length === 0 && <p className="py-6 text-center text-sm text-dim">No players yet. Your first signing will appear here.</p>}
        {GROUP_ORDER.map((g) =>
          grouped[g].length ? (
            <div key={g}>
              <div className="mb-1 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.18em]" style={{ color: GROUP_COLOR[g] }}>
                {GROUP_LABEL[g]} <span className="text-dim">{grouped[g].length}</span>
              </div>
              <ul className="space-y-1">
                <AnimatePresence initial={false}>
                  {grouped[g].map((e) => (
                    <motion.li
                      key={e.player.id}
                      layout
                      initial={{ opacity: 0, x: -20, backgroundColor: 'rgba(200,255,46,.25)' }}
                      animate={{ opacity: 1, x: 0, backgroundColor: 'rgba(255,255,255,.03)' }}
                      transition={{ duration: 0.6 }}
                      className="group rounded-lg px-2 py-1.5 text-sm"
                    >
                      <div className="flex items-center gap-2">
                        <span className="w-8 text-[11px] font-bold text-muted">{e.player.position}</span>
                        <span className="min-w-0 flex-1 truncate font-medium" title={PLAYSTYLES[playstyleOf(e.player)].label}>
                          {e.player.shortName}
                          <span className="ml-1 text-[10px] font-semibold text-dim">{PLAYSTYLES[playstyleOf(e.player)].short}</span>
                          {e.via === 'TRADE' && <span className="ml-1 text-[10px]" title="Got in a trade">🤝</span>}
                        </span>
                        <span className="display w-6 text-right font-bold">{e.player.overall}</span>
                        <span className="w-10 text-right text-xs text-muted num">{e.price}</span>
                        {canRelease && (
                          <button
                            onClick={() => setReleasing(releasing === e.player.id ? null : e.player.id)}
                            aria-label={`Release ${e.player.shortName}`}
                            title="Release (no refund)"
                            className="grid h-6 w-6 place-items-center rounded-md text-xs text-dim hover:bg-danger/20 hover:text-rose-200"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                      {releasing === e.player.id && canRelease && (
                        <div className="mt-1.5 flex items-center gap-2 rounded-md bg-danger/10 px-2 py-1.5 text-xs">
                          <span className="min-w-0 flex-1 text-rose-100">
                            Release {e.player.shortName}? You won’t get the {e.price} coins back.
                          </span>
                          <button
                            disabled={busy}
                            onClick={() => release(e.player.id)}
                            className="rounded-md bg-danger/30 px-2 py-1 font-bold text-rose-100 disabled:opacity-50"
                          >
                            Release
                          </button>
                          <button onClick={() => setReleasing(null)} className="rounded-md px-2 py-1 text-muted hover:bg-white/5">
                            Keep
                          </button>
                        </div>
                      )}
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            </div>
          ) : null,
        )}
      </div>
    </div>
  );
}

export function ManagersPanel({
  room,
  lot,
  me,
  onSelect,
}: {
  room: RoomView;
  lot: LotView | null;
  me: string;
  /** Tap a manager to see their squad. */
  onSelect?: (userId: string) => void;
}) {
  return (
    <div className="glass rounded-2xl p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <span className="label">Live managers</span>
        {onSelect && <span className="text-[10px] text-dim">tap to see squads{dealsOpen(room) ? ' · trade' : ''}</span>}
      </div>
      <ul className="space-y-2">
        {room.members.map((m) => {
          const leading = lot?.highestBidderId === m.userId;
          const skipped = lot?.skippedBy.includes(m.userId);
          const full = m.squad.length >= room.rules.squadSize;
          return (
            <motion.li
              key={m.userId}
              animate={{ scale: leading ? 1.02 : 1 }}
              role={onSelect ? 'button' : undefined}
              tabIndex={onSelect ? 0 : undefined}
              onClick={() => onSelect?.(m.userId)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect?.(m.userId)}
              aria-label={onSelect ? `See ${m.username}'s squad` : undefined}
              className={`flex items-center gap-3 rounded-xl border px-3 py-2 transition-colors ${onSelect ? 'cursor-pointer hover:bg-white/[.06]' : ''} ${
                leading ? 'border-volt/60 bg-volt/[.09] shadow-[0_0_24px_-8px_rgba(200,255,46,.6)]' : 'border-white/5 bg-white/[.02]'
              } ${!m.connected ? 'opacity-50' : ''}`}
            >
              <Avatar name={m.username} size={34} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <ConnectionDot connected={m.connected} />
                  <span className="truncate text-sm font-bold">{m.username}</span>
                  {m.isHost && <span className="text-xs" title="Host">👑</span>}
                  {m.userId === me && <span className="text-[10px] text-muted">YOU</span>}
                  {(room.auction?.idleLots[m.userId] ?? 0) > 0 && (
                    <span
                      className="text-[10px] font-bold text-amber-200 num"
                      title={`Sat out ${room.auction!.idleLots[m.userId]} of ${room.rules.inactiveLotsToRemove} lots in a row`}
                    >
                      💤 {room.auction!.idleLots[m.userId]}/{room.rules.inactiveLotsToRemove}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-1 text-xs text-muted num">
                  <Coin className="h-3 w-3" />
                  {coins(m.budget)} · {m.squad.length}/{room.rules.squadSize}
                </div>
              </div>
              <div className="text-right">
                {leading ? (
                  <span className="display text-xl font-extrabold text-volt num">{lot?.currentBid}</span>
                ) : !m.connected ? (
                  <span className="text-[10px] font-bold uppercase tracking-wider text-amber-200">Offline</span>
                ) : full ? (
                  <span className="text-[10px] font-bold uppercase tracking-wider text-cyan">Full</span>
                ) : skipped ? (
                  <span className="text-[10px] font-bold uppercase tracking-wider text-dim">Skipped</span>
                ) : (
                  <span className="text-[10px] font-bold uppercase tracking-wider text-dim">Thinking</span>
                )}
              </div>
            </motion.li>
          );
        })}
      </ul>
    </div>
  );
}

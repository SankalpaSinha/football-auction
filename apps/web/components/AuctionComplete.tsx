'use client';
import { motion } from 'motion/react';
import { GROUP_ORDER, type RoomView } from '@fa/shared';
import { coins, GROUP_LABEL, groupSquad } from '@/lib/format';
import { Avatar, Button, Coin, Logo, Pill, SoundToggle } from './ui';

/**
 * End of Phase 2: the auction is over and every squad is locked at 15.
 * The squad builder (formation, starting XI) and scoring are the next phases —
 * shown here honestly as not built yet rather than as dead buttons.
 */
export function AuctionComplete({ room, me, onLeave }: { room: RoomView; me: string; onLeave: () => void }) {
  const members = [...room.members].sort((a, b) => (a.userId === me ? -1 : b.userId === me ? 1 : a.seat - b.seat));

  return (
    <main className="mx-auto min-h-dvh max-w-[1400px] px-4 pb-16 sm:px-6">
      <header className="flex h-16 items-center justify-between">
        <Logo />
        <div className="flex items-center gap-1">
          <SoundToggle />
          <Button variant="ghost" size="sm" onClick={onLeave}>
            Leave room
          </Button>
        </div>
      </header>

      <motion.section initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="mt-6 text-center">
        <Pill color={room.competition.accent}>{room.competition.name}</Pill>
        <h1 className="display mt-3 text-6xl font-extrabold sm:text-7xl">
          Auction <span className="text-volt">complete</span>
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-muted">Every manager has a full {room.rules.squadSize}-man squad. Here’s how the money went.</p>
      </motion.section>

      <div className="mx-auto mt-6 max-w-2xl rounded-2xl border border-cyan/30 bg-cyan/[.06] px-5 py-4 text-sm text-cyan-50">
        <span className="font-bold">Next: squad builder & scoring.</span> Picking a formation and starting XI, and the scoring that
        decides the winner, come in the next phases and aren’t built yet. Squads are saved.
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {members.map((m, i) => {
          const spent = m.squad.reduce((s, e) => s + e.price, 0);
          const avg = m.squad.length ? m.squad.reduce((s, e) => s + e.player.overall, 0) / m.squad.length : 0;
          const grouped = groupSquad(m.squad);
          const bargains = m.squad.filter((e) => e.via === 'AUCTION' && e.price <= e.estimatedValue * 0.85).length;
          const overpays = m.squad.filter((e) => e.price >= e.estimatedValue * 1.15).length;
          return (
            <motion.div
              key={m.userId}
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 + i * 0.08 }}
              className={`glass rounded-2xl p-5 ${m.userId === me ? 'ring-1 ring-volt/50' : ''}`}
            >
              <div className="flex items-center gap-3">
                <Avatar name={m.username} size={44} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-lg font-bold">
                    {m.username} {m.userId === me && <span className="text-xs text-muted">(you)</span>}
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted num">
                    spent {coins(spent)} · <Coin className="h-3 w-3" /> {coins(m.budget)} left
                  </div>
                </div>
                <div className="text-right">
                  <div className="display text-3xl font-extrabold leading-none num">{avg.toFixed(1)}</div>
                  <div className="text-[10px] uppercase tracking-wider text-muted">avg ovr</div>
                </div>
              </div>
              <div className="mt-3 flex gap-2 text-xs">
                <span className="rounded-full bg-emerald-400/10 px-2 py-0.5 font-semibold text-emerald-300">{bargains} bargains</span>
                <span className="rounded-full bg-danger/10 px-2 py-0.5 font-semibold text-rose-300">{overpays} overpays</span>
              </div>
              <div className="mt-4 space-y-2.5">
                {GROUP_ORDER.map((g) => (
                  <div key={g}>
                    <div className="label mb-1 !text-[10px]">
                      {GROUP_LABEL[g]} · {grouped[g].length}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {grouped[g].map((e) => (
                        <span
                          key={e.player.id}
                          className="rounded-md bg-white/[.05] px-2 py-0.5 text-xs"
                          title={`${e.player.name} — paid ${e.price}, est. ${e.estimatedValue}${e.via === 'AUTO' ? ' (auto-assigned)' : ''}`}
                        >
                          <span className="font-bold">{e.player.overall}</span> {e.player.shortName}
                          <span className="ml-1 text-dim">{e.price}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          );
        })}
      </div>
    </main>
  );
}

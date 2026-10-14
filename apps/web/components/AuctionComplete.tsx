'use client';
import { motion } from 'motion/react';
import { ChatButton } from './ChatPanel';
import { summarizeLineup, type PlayerCard, type RoomView } from '@fa/shared';
import { coins } from '@/lib/format';
import { PlayerAvatar } from './PlayerAvatar';
import { EvaluatingBanner } from './Results';
import { MiniPitch } from './squad/Pitch';
import { Avatar, Button, Coin, Logo, Pill, SoundToggle } from './ui';

/** Lineups revealed (FINAL_EVALUATION) while the server scores the squads. */
export function AuctionComplete({ room, me, onLeave }: { room: RoomView; me: string; onLeave: () => void }) {
  const members = [...room.members].sort((a, b) => (a.userId === me ? -1 : b.userId === me ? 1 : a.seat - b.seat));

  return (
    <main className="mx-auto min-h-dvh max-w-[1400px] px-4 pb-16 sm:px-6">
      <header className="flex h-16 items-center justify-between">
        <Logo />
        <div className="flex items-center gap-1">
          <ChatButton />
            <SoundToggle />
          <Button variant="ghost" size="sm" onClick={onLeave}>
            Leave room
          </Button>
        </div>
      </header>

      <motion.section initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="mt-6 text-center">
        <Pill color={room.competition.accent}>{room.competition.name}</Pill>
        <h1 className="display mt-3 text-6xl font-extrabold sm:text-7xl">
          Lineups <span className="text-volt">revealed</span>
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-muted">Every manager has named their XI. Here’s how each squad lines up.</p>
      </motion.section>

      <EvaluatingBanner until={room.resultsAt} />

      <div className="mt-8 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {members.map((m, i) => {
          const lineup = room.lineups?.[m.userId];
          const players = new Map<string, PlayerCard>(m.squad.map((e) => [e.player.id, e.player]));
          const squad = [...players.values()];
          const summary = lineup ? summarizeLineup(lineup, squad) : null;
          const bench = lineup ? squad.filter((p) => !lineup.slots.includes(p.id)) : [];
          const spent = m.squad.reduce((s, e) => s + e.price, 0);
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
                {lineup && (
                  <div className="text-right">
                    <div className="display text-2xl font-extrabold leading-none">{lineup.formationId}</div>
                    {lineup.auto && <div className="text-[10px] uppercase tracking-wider text-amber-200">auto-completed</div>}
                  </div>
                )}
              </div>

              {lineup && (
                <div className="mx-auto mt-4 max-w-[300px]">
                  <MiniPitch formationId={lineup.formationId} slots={lineup.slots} players={players} />
                </div>
              )}

              {summary && (
                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <MiniStat label="XI avg" value={summary.averageOverall.toFixed(1)} />
                  <MiniStat label="Effective" value={summary.effectiveOverall.toFixed(1)} />
                  <MiniStat label="In position" value={`${summary.fit.NATURAL + summary.fit.SECONDARY}/11`} />
                </div>
              )}

              {bench.length > 0 && (
                <div className="mt-4">
                  <div className="label mb-1.5 !text-[10px]">Bench</div>
                  <div className="flex flex-wrap gap-1.5">
                    {bench.map((p) => (
                      <span key={p.id} className="inline-flex items-center gap-1.5 rounded-full bg-white/[.05] py-0.5 pl-0.5 pr-2 text-xs">
                        <PlayerAvatar player={p} size={20} />
                        <span className="font-bold">{p.overall}</span> {p.shortName}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-4 flex gap-2 text-xs">
                <span className="rounded-full bg-emerald-400/10 px-2 py-0.5 font-semibold text-emerald-300">{bargains} bargains</span>
                <span className="rounded-full bg-danger/10 px-2 py-0.5 font-semibold text-rose-300">{overpays} overpays</span>
              </div>
            </motion.div>
          );
        })}
      </div>
    </main>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/[.04] py-1.5">
      <div className="display text-xl font-extrabold num">{value}</div>
      <div className="text-[9px] font-semibold uppercase tracking-wider text-muted">{label}</div>
    </div>
  );
}

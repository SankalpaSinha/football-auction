'use client';
import { useEffect, useMemo, useState } from 'react';
import { ChatButton } from './ChatPanel';
import { ReactionButton } from './Reactions';
import Link from 'next/link';
import { sound } from '@/lib/sound';
import { EarnedBadges } from './Achievements';
import { AllSquads } from './SquadViews';
import { serverNow } from '@/lib/store';
import { AnimatePresence, motion } from 'motion/react';
import {
  OBJECTIVES,
  SCORING_CONFIG,
  TACTICS,
  type FormationSlot,
  type MatchReport,
  type PlayerCard,
  type RankedScore,
  type RoomView,
  type ScoreComponent,
} from '@fa/shared';
import { PlayerAvatar } from './PlayerAvatar';
import { MiniPitch } from './squad/Pitch';
import { Avatar, Button, Coin, Logo, Pill, SoundToggle } from './ui';
import { Bracket, cellsFromTournament } from './cup/Bracket';
import { liveState } from './cup/Tournament';
import { emit } from '@/lib/socket';
import { useGame } from '@/lib/store';
import { api } from '@/lib/api';
import type { RivalryRecord } from '@fa/shared';

const COMPONENT_LABEL: Record<ScoreComponent, string> = {
  quality: 'Player quality',
  positionFit: 'Position fit',
  tactics: 'Tactical fit',
  synergy: 'Synergy',
  chemistry: 'Chemistry',
  balance: 'Squad balance',
  depth: 'Depth',
  efficiency: 'Budget efficiency',
};

const MEDAL = ['🥇', '🥈', '🥉'];

export function Results({ room, me, onLeave }: { room: RoomView; me: string; onLeave: () => void }) {
  const results = room.results!;
  const rankings = results.rankings;
  const winner = rankings[0];
  const nameOf = (id: string) => room.members.find((m) => m.userId === id)?.username ?? 'Manager';
  const [selected, setSelected] = useState(rankings.find((r) => r.userId === me)?.userId ?? winner.userId);
  // Arriving late (refresh / reconnect)? Skip the show. After a cup the order was decided live — no countdown.
  const late = !!room.tournament || serverNow() - results.evaluatedAt > 20_000;
  const [shown, setShown] = useState(late ? rankings.length : 0);
  const done = shown >= rankings.length;

  useEffect(() => {
    if (done) return;
    const t = setTimeout(() => setShown((n) => n + 1), shown === 0 ? 700 : rankings.length - shown === 1 ? 1600 : 1100);
    return () => clearTimeout(t);
  }, [shown, done, rankings.length]);

  const players = useMemo(() => {
    const m = new Map<string, PlayerCard>();
    for (const mem of room.members) for (const e of mem.squad) m.set(e.player.id, e.player);
    return m;
  }, [room.members]);

  // Drum-roll tick per podium step, fanfare when the winner appears.
  useEffect(() => {
    if (late || shown === 0) return;
    if (shown < rankings.length) sound.tick(false);
    else if (winner.userId === me) sound.winner();
    else sound.complete();
  }, [shown, late, rankings.length, winner.userId, me]);

  const sel = rankings.find((r) => r.userId === selected)!;

  return (
    <main className="mx-auto min-h-dvh max-w-[1300px] px-4 pb-16 sm:px-6">
      <header className="flex h-16 items-center justify-between">
        <Logo />
        <div className="flex items-center gap-1">
          <ReactionButton canTaunt={room.members.some((m) => m.userId === me)} />
          <ChatButton />
            <SoundToggle />
          <Button variant="ghost" size="sm" onClick={onLeave}>
            Leave room
          </Button>
        </div>
      </header>

      {!done ? (
        <PodiumCountdown rankings={rankings} shown={shown} nameOf={nameOf} me={me} onSkip={() => setShown(rankings.length)} />
      ) : (
        <WinnerHero room={room} winner={winner} name={nameOf(winner.userId)} isMe={winner.userId === me} animate={!late || !!room.tournament} />
      )}

      <AnimatePresence>
        {done && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: late ? 0 : 1.6 }}>
            <NextGame room={room} me={me} />
            {(results.achievements[me]?.length ?? 0) > 0 && (
              <div className="glass mt-6 rounded-2xl p-5">
                <EarnedBadges keys={results.achievements[me]} title="🏅 Your achievements this game" />
              </div>
            )}
            <Analysis report={results.report} commentary={results.commentary} nameOf={nameOf} players={players} />

            <div className="mt-6 grid gap-6 lg:grid-cols-[380px_1fr]">
              <div className="glass h-fit rounded-2xl p-4">
                <div className="label mb-3">Final standings</div>
                <ol className="space-y-2">
                  {rankings.map((r, i) => (
                    <li key={r.userId}>
                      <button
                        onClick={() => setSelected(r.userId)}
                        className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
                          selected === r.userId ? 'border-volt/60 bg-volt/[.08]' : 'border-white/5 bg-white/[.02] hover:bg-white/[.05]'
                        }`}
                      >
                        <span className="display w-7 text-center text-xl font-extrabold">{MEDAL[i] ?? r.rank}</span>
                        <Avatar name={nameOf(r.userId)} size={34} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-bold">
                            {nameOf(r.userId)} {r.userId === me && <span className="text-xs text-muted">(you)</span>}
                          </span>
                          <span className="text-xs text-muted">
                            {r.cupFinish ? (
                              <>
                                <b className={r.cupFinish === 'Champion' ? 'text-gold' : 'text-ink/80'}>{r.cupFinish}</b> · squad {r.total.toFixed(1)} (#{r.squadRank})
                              </>
                            ) : (
                              <>
                                {room.lineups?.[r.userId]?.formationId} · spent {r.spent}
                              </>
                            )}
                          </span>
                        </span>
                        <span className="text-right">
                          <span className="display block text-3xl font-extrabold leading-none num">{r.cupFinish ? `#${r.rank}` : r.total.toFixed(1)}</span>
                          {results.ratingChanges && (
                            <EloDelta delta={results.ratingChanges.find((c) => c.userId === r.userId)?.delta ?? 0} />
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
                <p className="mt-4 text-xs text-dim">
                  {room.tournament
                    ? 'The cup decides the final standings. Squad scores come from a fixed formula (the same squad always gets the same score) and set the seeding. Tap a manager to see their breakdown.'
                    : 'Scores come from a fixed formula on the server — the same squad always gets the same score. Tap a manager to see their breakdown.'}
                </p>
                {room.gameId && (
                  <Link href={`/match/${room.gameId}`} className="mt-3 inline-block text-sm font-semibold text-volt hover:underline">
                    Full match page — squads & auction log →
                  </Link>
                )}
              </div>

              <ManagerReport
                key={sel.userId}
                score={sel}
                name={nameOf(sel.userId)}
                verdict={results.report.verdicts[sel.userId]}
                lineup={room.lineups?.[sel.userId]}
                players={players}
                elo={(() => {
                  const c = results.ratingChanges?.find((x) => x.userId === sel.userId);
                  return c ? { before: c.before, after: c.after } : null;
                })()}
              />
            </div>

            {room.tournament && <CupRecap room={room} me={me} nameOf={nameOf} />}
            {room.season && <SeasonTable room={room} me={me} />}
            <Rivalries room={room} />

            <section className="mt-10">
              <h2 className="display mb-3 text-3xl font-extrabold">All squads</h2>
              <AllSquads
                me={me}
                managers={rankings.map((r) => {
                  const m = room.members.find((x) => x.userId === r.userId);
                  return {
                    userId: r.userId,
                    username: nameOf(r.userId),
                    squad: m?.squad ?? [],
                    lineup: room.lineups?.[r.userId] ?? null,
                    budgetLeft: m?.budget ?? null,
                    rank: r.rank,
                    total: r.total,
                  };
                })}
              />
            </section>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}

function PodiumCountdown({
  rankings,
  shown,
  nameOf,
  me,
  onSkip,
}: {
  rankings: RankedScore[];
  shown: number;
  nameOf: (id: string) => string;
  me: string;
  onSkip: () => void;
}) {
  const n = rankings.length;
  return (
    <section className="mt-4 rounded-3xl border border-white/10 bg-white/[.02] px-4 py-10 text-center sm:py-14">
      <div className="label !text-gold">Final standings</div>
      <h1 className="display mt-2 text-4xl font-extrabold sm:text-6xl">And the results are…</h1>
      <ol className="mx-auto mt-8 flex max-w-xl flex-col-reverse gap-2">
        {[...rankings].reverse().map((r, i) => {
          const visible = i < shown;
          return (
            <li key={r.userId} className="h-14">
              <AnimatePresence mode="wait">
                {visible ? (
                  <motion.div
                    key="in"
                    initial={{ opacity: 0, x: -40, scale: 0.95 }}
                    animate={{ opacity: 1, x: 0, scale: 1 }}
                    className={`flex h-14 items-center gap-3 rounded-xl border px-4 ${r.userId === me ? 'border-volt/50 bg-volt/[.07]' : 'border-white/10 bg-white/[.03]'}`}
                  >
                    <span className="display w-8 text-2xl font-extrabold text-muted">{r.rank}</span>
                    <Avatar name={nameOf(r.userId)} size={32} />
                    <span className="flex-1 truncate text-left font-bold">{nameOf(r.userId)}</span>
                    <span className="display text-3xl font-extrabold num">{r.total.toFixed(1)}</span>
                  </motion.div>
                ) : (
                  <motion.div key="out" className="flex h-14 items-center gap-3 rounded-xl border border-dashed border-white/10 px-4 text-dim">
                    <span className="display w-8 text-2xl font-extrabold">{n - i}</span>
                    <span className="flex-1 text-left">?</span>
                  </motion.div>
                )}
              </AnimatePresence>
            </li>
          );
        })}
      </ol>
      <Button variant="ghost" size="sm" className="mt-6" onClick={onSkip}>
        Skip
      </Button>
    </section>
  );
}

function WinnerHero({ room, winner, name, isMe, animate }: { room: RoomView; winner: RankedScore; name: string; isMe: boolean; animate: boolean }) {
  const d = animate ? 1 : 0;
  return (
    <section
      className="relative mt-4 overflow-hidden rounded-3xl border border-gold/30 px-6 py-10 text-center sm:py-14"
      style={{ background: 'radial-gradient(ellipse at 50% 0%, rgba(245,197,66,.25), transparent 65%), rgba(255,255,255,.02)' }}
    >
      {animate && <Confetti />}
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="label !text-gold">
        {room.competition.name}
        {room.competition.seasonLabel !== room.competition.name && ` · ${room.competition.seasonLabel}`}
      </motion.div>
      <motion.div
        initial={animate ? { scale: 0.3, opacity: 0, rotate: -20 } : false}
        animate={{ scale: 1, opacity: 1, rotate: 0 }}
        transition={{ type: 'spring', stiffness: 160, damping: 12, delay: 0.2 * d }}
        className="mt-3 text-6xl sm:text-7xl"
      >
        🏆
      </motion.div>
      <div className="display mt-2 text-xl font-bold tracking-[0.3em] text-gold">{room.tournament ? 'Cup winner' : 'Winner'}</div>
      <motion.h1
        initial={animate ? { opacity: 0, y: 30, scale: 0.9 } : false}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ delay: 0.5 * d, type: 'spring', stiffness: 120 }}
        className="display mt-1 break-all text-[clamp(2.4rem,11vw,6rem)] font-extrabold leading-[0.95]"
      >
        {name}
      </motion.h1>
      {room.tournament ? (
        <FinalLine room={room} winnerId={winner.userId} />
      ) : (
        <div className="display mt-2 text-5xl font-extrabold text-gold num sm:text-6xl">
          {animate ? <CountUp to={winner.total} delay={800} /> : winner.total.toFixed(1)}
        </div>
      )}
      {isMe && <p className="mt-3 font-semibold text-volt">That’s you. Champion manager.</p>}
      {room.season?.finished && room.season.championId && (
        <p className="mt-2 text-sm font-bold text-gold">
          👑 Season champion: {room.season.table.find((r) => r.userId === room.season!.championId)?.username}
        </p>
      )}
    </section>
  );
}

function Confetti() {
  const bits = Array.from({ length: 60 }, (_, i) => i);
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {bits.map((i) => {
        const left = (i * 37) % 100;
        const delay = (i % 12) * 0.08;
        const dur = 2.2 + (i % 5) * 0.35;
        return (
          <motion.span
            key={i}
            initial={{ y: -40, opacity: 1, rotate: 0 }}
            animate={{ y: 520, opacity: 0, rotate: 540 }}
            transition={{ duration: dur, delay, ease: 'easeIn' }}
            className="absolute top-0 h-3 w-1.5 rounded-sm"
            style={{ left: `${left}%`, background: ['#f5c542', '#c8ff2e', '#2ee6ff', '#ff6b8a', '#ffffff'][i % 5] }}
          />
        );
      })}
    </div>
  );
}

export function Analysis({
  report,
  commentary,
  nameOf,
  players,
}: {
  report: MatchReport;
  commentary?: NonNullable<RoomView['results']>['commentary'];
  nameOf: (id: string) => string;
  players: Map<string, PlayerCard>;
}) {
  return (
    <section className="mt-6 grid gap-6 lg:grid-cols-[1.2fr_1fr]">
      <div className="glass rounded-2xl p-5">
        <div className="label">Match analysis</div>
        <h2 className="display mt-1 text-3xl font-extrabold">{report.headline}</h2>
        <p className="mt-3 leading-relaxed text-ink/90">{report.summary}</p>
        {commentary?.status === 'pending' && (
          <div className="mt-4 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[.03] px-4 py-3 text-sm text-muted">
            <span className="h-2 w-2 animate-pulse rounded-full bg-cyan" /> The pundit is writing…
          </div>
        )}
        {commentary?.status === 'ready' && commentary.text && (
          <motion.blockquote initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mt-4 rounded-xl border border-cyan/30 bg-cyan/[.06] px-4 py-3">
            <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-cyan">🎙️ Pundit · AI-generated</div>
            <p className="leading-relaxed">{commentary.text}</p>
            <div className="mt-2 text-[11px] text-dim">The AI explains the result — the scores above decide it.</div>
          </motion.blockquote>
        )}
      </div>
      <div className="glass rounded-2xl p-5">
        <div className="label mb-3">Awards</div>
        <ul className="grid gap-2 sm:grid-cols-2">
          {report.awards.map((a, i) => {
            const p = a.playerId ? players.get(a.playerId) : undefined;
            return (
              <motion.li
                key={a.key}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.1 + i * 0.06 }}
                className="flex items-center gap-3 rounded-xl bg-white/[.04] px-3 py-2.5"
              >
                {p ? <PlayerAvatar player={p} size={36} /> : <span className="grid h-9 w-9 place-items-center text-xl">{a.emoji}</span>}
                <div className="min-w-0">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-muted">
                    {p ? `${a.emoji} ` : ''}
                    {a.title}
                  </div>
                  <div className="truncate text-sm font-bold">{nameOf(a.userId)}</div>
                  <div className="line-clamp-2 text-xs text-muted">{a.detail}</div>
                </div>
              </motion.li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

export function ManagerReport({
  score,
  name,
  verdict,
  lineup,
  players,
  elo,
}: {
  score: RankedScore;
  name: string;
  verdict?: string;
  lineup?: { formationId: string; slots: (string | null)[]; custom?: FormationSlot[] | null } | null;
  players: Map<string, PlayerCard>;
  elo?: { before: number; after: number } | null;
}) {
  const best = score.bestPlayerId ? players.get(score.bestPlayerId) : undefined;
  const bestBuy = score.bestBuy ? players.get(score.bestBuy.playerId) : undefined;
  const worstBuy = score.worstBuy ? players.get(score.worstBuy.playerId) : undefined;
  const strengths = score.notes.filter((n) => n.kind === 'strength').slice(0, 3);
  const weaknesses = score.notes.filter((n) => n.kind === 'weakness').slice(0, 4);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="glass rounded-2xl p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="display text-3xl font-extrabold">
          {name} <span className="text-muted">#{score.rank}</span>
        </h2>
        <span className="display text-4xl font-extrabold text-volt num">{score.total.toFixed(1)}</span>
      </div>
      {elo && (
        <p className="mt-1 text-sm">
          ELO {elo.before} → <span className="font-bold">{elo.after}</span>{' '}
          <EloDelta delta={elo.after - elo.before} />
        </p>
      )}
      {verdict && <p className="mt-2 text-sm text-muted">{verdict}</p>}

      <div className="mt-5 grid gap-6 md:grid-cols-[1fr_240px]">
        <div>
          <div className="label mb-2">Score breakdown</div>
          <ul className="space-y-2.5">
            {(Object.keys(SCORING_CONFIG.weights) as ScoreComponent[]).map((k, i) => {
              const v = score.breakdown[k];
              // Games played before a component existed have no value for it.
              if (v === undefined) return null;
              const color = v >= 85 ? '#c8ff2e' : v >= 65 ? '#2ee6ff' : '#ff4d5e';
              return (
                <li key={k}>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="font-semibold">
                      {COMPONENT_LABEL[k]} <span className="text-xs font-normal text-dim">{Math.round(SCORING_CONFIG.weights[k] * 100)}%</span>
                    </span>
                    <span className="display text-lg font-bold num">{v.toFixed(1)}</span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-white/[.06]">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${v}%` }}
                      transition={{ delay: 0.1 + i * 0.07, duration: 0.6, ease: 'easeOut' }}
                      className="h-full rounded-full"
                      style={{ background: color }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
          {(score.objectives?.length ?? 0) > 0 && (
            <div className="mt-4 rounded-xl border border-white/10 bg-white/[.03] p-3">
              <div className="flex items-baseline justify-between text-sm">
                <span className="font-semibold">🕵️ Secret objectives</span>
                <span className="display text-lg font-bold text-volt num">+{score.objectiveBonus}</span>
              </div>
              <ul className="mt-1.5 space-y-1 text-xs">
                {score.objectives.map((o) => (
                  <li key={o.id} className={o.done ? 'text-emerald-200' : 'text-dim'}>
                    {o.done ? '✓' : '✗'} <b>{OBJECTIVES[o.id]?.label ?? o.id}</b> · {OBJECTIVES[o.id]?.text}
                    {o.progress && <span className="ml-1 text-dim num">({o.progress})</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-4 flex items-baseline justify-between border-t border-white/10 pt-3">
            <span className="display text-lg font-bold">Final score</span>
            <span className="display text-3xl font-extrabold text-volt num">{score.total.toFixed(1)}</span>
          </div>

          {score.tactics.length > 0 && (
            <div className="mt-5">
              <div className="label mb-2">
                Tactic · {TACTICS[score.tacticId]?.label ?? 'Balanced'}
                {score.tacticId && score.tacticId !== 'BALANCED' && score.styleMatch && (
                  <span className="ml-1 normal-case tracking-normal text-dim">
                    ({score.styleMatch.liked}/{score.styleMatch.of} starters suit it)
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {score.tactics.map((t) => (
                  <div key={t.key} className="rounded-lg bg-white/[.04] px-3 py-2" title={`${t.value} vs ${t.target} target`}>
                    <div className="text-[11px] text-muted">{t.label}</div>
                    <div className={`display text-xl font-bold num ${t.score >= 90 ? 'text-volt' : t.score < 70 ? 'text-rose-300' : ''}`}>
                      {t.value || '—'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(score.synergies?.length ?? 0) > 0 && (
            <div className="mt-5">
              <div className="label mb-2">Synergy combos</div>
              <ul className="flex flex-wrap gap-1.5">
                {score.synergies.map((h) => (
                  <li key={h.key} className="rounded-full bg-white/[.05] px-2.5 py-1 text-xs" title={`+${h.points} combo points`}>
                    ⚙️ <b>{h.label}</b>{' '}
                    <span className="text-muted">
                      {players.get(h.players[0])?.shortName ?? '?'} + {players.get(h.players[1])?.shortName ?? '?'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-4">
          {lineup && (
            <div>
              <div className="label mb-2">
                {lineup.formationId} · chemistry {(score.breakdown.chemistry ?? 0).toFixed(0)}
              </div>
              <MiniPitch formationId={lineup.formationId} custom={lineup.custom} slots={lineup.slots} players={players} />
            </div>
          )}
        </div>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        {best && <Highlight tone="gold" title="Best player" player={best} line={`${best.overall} OVR · ${best.position}`} />}
        {bestBuy && score.bestBuy && (
          <Highlight
            tone="green"
            title="🟢 Best buy"
            player={bestBuy}
            line={
              <>
                paid <Coin className="inline h-3 w-3" /> {score.bestBuy.price} · est. {score.bestBuy.value}
              </>
            }
          />
        )}
        {worstBuy && score.worstBuy ? (
          <Highlight
            tone="red"
            title="🔴 Biggest overpay"
            player={worstBuy}
            line={
              <>
                paid <Coin className="inline h-3 w-3" /> {score.worstBuy.price} · est. {score.worstBuy.value}
              </>
            }
          />
        ) : (
          <div className="rounded-xl border border-white/10 bg-white/[.02] p-3 text-sm text-muted">No overpays — disciplined bidding.</div>
        )}
      </div>

      {(strengths.length > 0 || weaknesses.length > 0) && (
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div>
            <div className="label mb-2 !text-emerald-300">Strengths</div>
            <ul className="space-y-1.5 text-sm">
              {strengths.length ? strengths.map((n) => <li key={n.text}>✓ {n.text}</li>) : <li className="text-dim">Solid all round, nothing stand-out.</li>}
            </ul>
          </div>
          <div>
            <div className="label mb-2 !text-rose-300">Weaknesses</div>
            <ul className="space-y-1.5 text-sm">
              {weaknesses.length ? weaknesses.map((n) => <li key={n.text}>✗ {n.text}</li>) : <li className="text-dim">No obvious weak spots.</li>}
            </ul>
          </div>
        </div>
      )}
    </motion.div>
  );
}

function Highlight({ tone, title, player, line }: { tone: 'gold' | 'green' | 'red'; title: string; player: PlayerCard; line: React.ReactNode }) {
  const ring = { gold: 'border-gold/40 bg-gold/[.06]', green: 'border-emerald-400/40 bg-emerald-400/[.06]', red: 'border-danger/40 bg-danger/[.06]' }[tone];
  return (
    <div className={`flex items-center gap-3 rounded-xl border p-3 ${ring}`}>
      <PlayerAvatar player={player} size={44} />
      <div className="min-w-0">
        <div className="text-[11px] font-bold uppercase tracking-wider text-muted">{title}</div>
        <div className="truncate font-bold">{player.name}</div>
        <div className="text-xs text-muted">{line}</div>
      </div>
    </div>
  );
}

function CountUp({ to, delay = 0 }: { to: number; delay?: number }) {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now() + delay;
    const loop = (t: number) => {
      const p = Math.min(1, Math.max(0, (t - start) / 1200));
      setV(to * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [to, delay]);
  return <>{v.toFixed(1)}</>;
}

export function EvaluatingBanner({ until }: { until: number | null }) {
  return (
    <div className="mx-auto mt-6 flex max-w-2xl items-center gap-3 rounded-2xl border border-gold/40 bg-gold/[.08] px-5 py-4 text-sm">
      <span className="h-3 w-3 animate-ping rounded-full bg-gold" />
      <span>
        <span className="font-bold text-gold">Rating the squads…</span> quality, position fit, tactics, synergy, chemistry, balance, depth and secret objectives
        set the seeds for the cup.
        {until ? ' Kick-off in a moment!' : ''}
      </span>
      <Pill color="#f5c542" className="ml-auto">
        Deterministic
      </Pill>
    </div>
  );
}

export function EloDelta({ delta }: { delta: number }) {
  const cls = delta > 0 ? 'text-emerald-300' : delta < 0 ? 'text-rose-300' : 'text-muted';
  return <span className={`text-xs font-bold num ${cls}`}>{delta > 0 ? `+${delta}` : delta === 0 ? '±0' : delta} ELO</span>;
}

/** "Beat Ben 2–1 in the final (4–3 on pens)". */
function FinalLine({ room, winnerId }: { room: RoomView; winnerId: string }) {
  const t = room.tournament!;
  const final = t.matches.filter((m) => m.round === t.rounds.length - 1).at(-1);
  if (!final) return null;
  const other = final.home.userId === winnerId ? final.away.userId : final.home.userId;
  const name = room.members.find((m) => m.userId === other)?.username ?? 'their rival';
  const w = final.home.userId === winnerId ? [final.home.goals, final.away.goals] : [final.away.goals, final.home.goals];
  const p = final.pens ? (final.home.userId === winnerId ? final.pens : [final.pens[1], final.pens[0]]) : null;
  return (
    <p className="display mt-3 text-2xl font-bold text-ink/90 sm:text-3xl">
      beat {name} <span className="text-gold num">{w[0]}–{w[1]}</span> in the final{p ? ` (${p[0]}–${p[1]} on pens)` : ''}
    </p>
  );
}

/** Host: another game in this room (the next game of the season). Everyone else waits. */
function NextGame({ room, me }: { room: RoomView; me: string }) {
  const toast = useGame((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const isMember = room.members.some((m) => m.userId === me);
  if (!isMember) return null;
  const s = room.season;
  const label = s && !s.finished ? `Next game (${s.played + 1} of ${s.length}) →` : s?.finished ? 'Start a new season →' : 'Play again →';
  async function go() {
    setBusy(true);
    const r = await emit('room:rematch');
    setBusy(false);
    if (!r.ok) toast('error', r.error);
  }
  return (
    <div className="mt-6 flex flex-col items-center gap-2 rounded-2xl border border-volt/30 bg-volt/[.05] px-5 py-4 text-center sm:flex-row sm:text-left">
      <div className="min-w-0 flex-1">
        <div className="display text-xl font-extrabold">{s && !s.finished ? `Season: game ${s.played} of ${s.length} done` : 'Fancy another?'}</div>
        <div className="text-sm text-muted">
          {room.hostId === me ? 'Same room, same friends — everyone readies up again.' : 'The host can start another game in this room.'}
        </div>
      </div>
      {room.hostId === me ? (
        <Button onClick={go} disabled={busy}>
          {label}
        </Button>
      ) : (
        <span className="text-sm font-semibold text-muted">Waiting for the host…</span>
      )}
    </div>
  );
}

function CupRecap({ room, me, nameOf }: { room: RoomView; me: string; nameOf: (id: string) => string }) {
  const t = room.tournament!;
  const now = serverNow();
  const cells = cellsFromTournament(t, (id) => ({ score: liveState(t.matches.find((m) => m.id === id)!, now).score, live: null }));
  return (
    <section className="mt-10">
      <h2 className="display mb-3 text-3xl font-extrabold">The cup</h2>
      <div className="glass rounded-2xl p-4">
        <Bracket rounds={t.rounds} cells={cells} seeds={t.seeds} nameOf={nameOf} me={me} />
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          {t.matches.map((m) => {
            const goals = m.events.filter((e) => e.kind === 'GOAL' || e.kind === 'PEN_GOAL');
            const scorers = (side: 0 | 1) =>
              goals
                .filter((g) => g.side === side)
                .map((g) => `${room.members.flatMap((x) => x.squad).find((e) => e.player.id === g.playerId)?.player.shortName ?? '?'} ${g.minute}'`)
                .join(', ');
            return (
              <li key={m.id} className="rounded-xl bg-white/[.03] px-3 py-2.5 text-sm">
                <div className="text-[10px] font-bold uppercase tracking-wider text-muted">{t.rounds[m.round]}</div>
                <div className="flex items-center justify-between gap-2 font-semibold">
                  <span className="truncate">{nameOf(m.home.userId)}</span>
                  <span className="display text-lg font-extrabold num">
                    {m.home.goals}–{m.away.goals}
                    {m.pens && <span className="ml-1 text-xs text-muted">({m.pens[0]}–{m.pens[1]} p)</span>}
                  </span>
                  <span className="truncate text-right">{nameOf(m.away.userId)}</span>
                </div>
                {goals.length > 0 && (
                  <div className="mt-0.5 flex justify-between gap-3 text-[11px] text-muted">
                    <span className="truncate">{scorers(0)}</span>
                    <span className="truncate text-right">{scorers(1)}</span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

function SeasonTable({ room, me }: { room: RoomView; me: string }) {
  const s = room.season!;
  return (
    <section className="mt-10">
      <h2 className="display mb-3 text-3xl font-extrabold">
        Season table <span className="text-muted">· {s.played}/{s.length} games</span>
      </h2>
      <div className="glass overflow-hidden rounded-2xl">
        <table className="w-full text-sm">
          <thead className="bg-white/[.03] text-left text-[11px] uppercase tracking-wider text-muted">
            <tr>
              <th className="px-4 py-2">#</th>
              <th className="px-2 py-2">Manager</th>
              <th className="px-2 py-2 text-right">Played</th>
              <th className="px-2 py-2 text-right">Wins</th>
              <th className="px-4 py-2 text-right">Pts</th>
            </tr>
          </thead>
          <tbody>
            {s.table.map((r, i) => (
              <tr key={r.userId} className={`border-t border-white/5 ${r.userId === me ? 'bg-volt/[.06]' : ''}`}>
                <td className="px-4 py-2 font-bold">{s.finished && i === 0 ? '👑' : i + 1}</td>
                <td className="px-2 py-2 font-semibold">{r.username}</td>
                <td className="px-2 py-2 text-right num">{r.played}</td>
                <td className="px-2 py-2 text-right num">{r.wins}</td>
                <td className="display px-4 py-2 text-right text-lg font-extrabold num">{r.points}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="border-t border-white/5 px-4 py-2 text-[11px] text-dim">Points per game: 10 for the winner, then 7, 5, 4, 3, 2, 1.</p>
      </div>
    </section>
  );
}

/** Head-to-head between the managers in this room, across every game they've played together. */
export function Rivalries({ room }: { room: RoomView }) {
  const [rows, setRows] = useState<RivalryRecord[] | null>(null);
  const ids = room.members.map((m) => m.userId).sort().join(',');
  useEffect(() => {
    let live = true;
    api
      .rivalries(ids.split(','))
      .then((r) => live && setRows(r.rivalries))
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, [ids, room.results?.evaluatedAt]);
  const name = (id: string) => room.members.find((m) => m.userId === id)?.username ?? '?';
  const shown = (rows ?? []).filter((r) => r.aWins + r.bWins > 0).sort((a, b) => b.aWins + b.bWins - (a.aWins + a.bWins));
  if (!shown.length) return null;
  return (
    <section className="mt-10">
      <h2 className="display mb-3 text-3xl font-extrabold">Rivalries</h2>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {shown.slice(0, 9).map((r) => {
          const lead = r.aWins === r.bWins ? null : r.aWins > r.bWins ? r.a : r.b;
          return (
            <div key={`${r.a}|${r.b}`} className="glass flex items-center gap-3 rounded-2xl px-4 py-3">
              <span className={`min-w-0 flex-1 truncate font-bold ${lead === r.a ? 'text-volt' : ''}`}>{name(r.a)}</span>
              <span className="display text-2xl font-extrabold num">
                {r.aWins}–{r.bWins}
              </span>
              <span className={`min-w-0 flex-1 truncate text-right font-bold ${lead === r.b ? 'text-volt' : ''}`}>{name(r.b)}</span>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-dim">Who finished higher, across every game you’ve played together.</p>
    </section>
  );
}

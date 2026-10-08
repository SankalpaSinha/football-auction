'use client';
import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { SCORING_CONFIG, type PlayerCard, type RankedScore, type RoomView, type ScoreComponent } from '@fa/shared';
import { PlayerAvatar } from './PlayerAvatar';
import { MiniPitch } from './squad/Pitch';
import { Avatar, Button, Coin, Logo, Pill, SoundToggle } from './ui';

const COMPONENT_LABEL: Record<ScoreComponent, string> = {
  quality: 'Player quality',
  positionFit: 'Position fit',
  tactics: 'Tactics',
  chemistry: 'Chemistry',
  balance: 'Squad balance',
  depth: 'Depth',
  efficiency: 'Budget efficiency',
};

const MEDAL = ['🥇', '🥈', '🥉'];

export function Results({ room, me, onLeave }: { room: RoomView; me: string; onLeave: () => void }) {
  const rankings = room.results!.rankings;
  const winner = rankings[0];
  const nameOf = (id: string) => room.members.find((m) => m.userId === id)?.username ?? 'Manager';
  const [selected, setSelected] = useState(rankings.find((r) => r.userId === me)?.userId ?? winner.userId);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setRevealed(true), 2200);
    return () => clearTimeout(t);
  }, []);

  const players = useMemo(() => {
    const m = new Map<string, PlayerCard>();
    for (const mem of room.members) for (const e of mem.squad) m.set(e.player.id, e.player);
    return m;
  }, [room.members]);

  const sel = rankings.find((r) => r.userId === selected)!;

  return (
    <main className="mx-auto min-h-dvh max-w-[1300px] px-4 pb-16 sm:px-6">
      <header className="flex h-16 items-center justify-between">
        <Logo />
        <div className="flex items-center gap-1">
          <SoundToggle />
          <Button variant="ghost" size="sm" onClick={onLeave}>
            Leave room
          </Button>
        </div>
      </header>

      {/* winner reveal */}
      <section className="relative mt-4 overflow-hidden rounded-3xl border border-gold/30 px-6 py-10 text-center sm:py-14" style={{ background: 'radial-gradient(ellipse at 50% 0%, rgba(245,197,66,.25), transparent 65%), rgba(255,255,255,.02)' }}>
        <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="label !text-gold">
          {room.competition.name} · {room.competition.seasonLabel}
        </motion.div>
        <motion.div
          initial={{ scale: 0.3, opacity: 0, rotate: -20 }}
          animate={{ scale: 1, opacity: 1, rotate: 0 }}
          transition={{ type: 'spring', stiffness: 160, damping: 12, delay: 0.2 }}
          className="mt-3 text-6xl sm:text-7xl"
        >
          🏆
        </motion.div>
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.6 }} className="display mt-2 text-xl font-bold tracking-[0.3em] text-gold">
          Winner
        </motion.div>
        <motion.h1
          initial={{ opacity: 0, y: 30, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ delay: 0.9, type: 'spring', stiffness: 120 }}
          className="display mt-1 text-6xl font-extrabold sm:text-8xl"
        >
          {nameOf(winner.userId)}
        </motion.h1>
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.2 }} className="display mt-2 text-5xl font-extrabold text-gold num sm:text-6xl">
          <CountUp to={winner.total} delay={1200} />
        </motion.div>
        {winner.userId === me && (
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.8 }} className="mt-3 font-semibold text-volt">
            That’s you. Champion manager.
          </motion.p>
        )}
      </section>

      <AnimatePresence>
        {revealed && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mt-8 grid gap-6 lg:grid-cols-[380px_1fr]">
            {/* ranking */}
            <div className="glass h-fit rounded-2xl p-4">
              <div className="label mb-3">Final ranking</div>
              <ol className="space-y-2">
                {rankings.map((r, i) => (
                  <motion.li key={r.userId} initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.12 }}>
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
                          {room.lineups?.[r.userId]?.formationId} · spent {r.spent}
                        </span>
                      </span>
                      <span className="display text-3xl font-extrabold num">{r.total.toFixed(1)}</span>
                    </button>
                  </motion.li>
                ))}
              </ol>
              <p className="mt-4 text-xs text-dim">
                Scores are calculated by the server with a fixed formula — the same squad always gets the same score. AI match commentary arrives
                in Phase 5.
              </p>
            </div>

            {/* selected manager */}
            <ManagerReport key={sel.userId} score={sel} name={nameOf(sel.userId)} room={room} players={players} />
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}

function ManagerReport({ score, name, room, players }: { score: RankedScore; name: string; room: RoomView; players: Map<string, PlayerCard> }) {
  const lineup = room.lineups?.[score.userId];
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

      <div className="mt-5 grid gap-6 md:grid-cols-[1fr_240px]">
        <div>
          <div className="label mb-2">Score breakdown</div>
          <ul className="space-y-2.5">
            {(Object.keys(SCORING_CONFIG.weights) as ScoreComponent[]).map((k, i) => {
              const v = score.breakdown[k];
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
          <div className="mt-4 flex items-baseline justify-between border-t border-white/10 pt-3">
            <span className="display text-lg font-bold">Final score</span>
            <span className="display text-3xl font-extrabold text-volt num">{score.total.toFixed(1)}</span>
          </div>

          {score.tactics.length > 0 && (
            <div className="mt-5">
              <div className="label mb-2">Tactical profile</div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {score.tactics.map((t) => (
                  <div key={t.key} className="rounded-lg bg-white/[.04] px-3 py-2" title={`${t.value} vs ${t.target} target`}>
                    <div className="text-[11px] text-muted">{t.label}</div>
                    <div className={`display text-xl font-bold num ${t.score >= 90 ? 'text-volt' : t.score < 70 ? 'text-rose-300' : ''}`}>{t.value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-4">
          {lineup && (
            <div>
              <div className="label mb-2">
                {lineup.formationId} · chemistry {score.breakdown.chemistry.toFixed(0)}
              </div>
              <MiniPitch formationId={lineup.formationId} slots={lineup.slots} players={players} />
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
        <span className="font-bold text-gold">Evaluating squads…</span> quality, position fit, tactics, chemistry, balance and depth.
        {until ? ' Results in a moment.' : ''}
      </span>
      <Pill color="#f5c542" className="ml-auto">
        Deterministic
      </Pill>
    </div>
  );
}

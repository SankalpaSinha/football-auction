'use client';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  SHOUTS,
  TACTICS,
  TEAM_TALKS,
  statsFromEvents,
  type MatchEvent,
  type MatchView,
  type PlayerCard,
  type RoomView,
  type Shout,
  type TeamTalk,
} from '@fa/shared';
import { emit } from '@/lib/socket';
import { serverNow, useGame } from '@/lib/store';
import { ChatButton } from '../ChatPanel';
import { ExitButton } from '../ExitButton';
import { ReactionButton } from '../Reactions';
import { Avatar, Logo, Pill, SoundToggle } from '../ui';
import { Bracket, cellsFromTournament } from './Bracket';

/** Server-synced "now", re-rendered several times a second. */
export function useServerNow(ms = 200) {
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    const t = setInterval(() => setNow(serverNow()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** What's been shown of a match so far (the server runs a few seconds ahead). */
export function liveState(m: MatchView, now: number) {
  const finished = m.status === 'FINISHED';
  const shown = finished ? m.events : m.events.filter((e) => (e.at ?? 0) <= now);
  const last = shown[shown.length - 1];
  const score: [number, number] = finished ? [m.home.goals, m.away.goals] : last ? [last.score[0], last.score[1]] : [0, 0];
  const kicks = (m.shootout ?? []).filter((k) => finished || k.at <= now);
  const pens: [number, number] = [0, 0];
  for (const k of kicks) if (k.scored) pens[k.side]++;
  let minute = 0;
  if (m.clock) minute = Math.min(m.clock.phaseEndMinute, m.clock.phaseMinute + Math.max(0, Math.floor((now - m.clock.phaseStartedAt) / m.clock.msPerMinute)));
  const extra = m.events.some((e) => e.minute > 90) || m.status === 'EXTRA_TIME' || m.status === 'PENALTIES' || !!m.pens;
  const label =
    m.status === 'SCHEDULED'
      ? 'KO'
      : m.status === 'HALF_TIME'
        ? 'HT'
        : m.status === 'PENALTIES'
          ? 'PENS'
          : finished
            ? m.pens
              ? 'FT · pens'
              : extra
                ? 'AET'
                : 'FT'
            : `${Math.max(1, minute)}'`;
  return { shown, score, kicks, pens, minute, label, finished };
}

export function Tournament({ room, me }: { room: RoomView; me: string }) {
  const t = room.tournament!;
  const now = useServerNow();
  const self = room.members.find((m) => m.userId === me);
  const nameOf = (id: string) => room.members.find((m) => m.userId === id)?.username ?? 'Manager';
  const players = useMemo(() => {
    const map = new Map<string, PlayerCard>();
    for (const m of room.members) for (const e of m.squad) map.set(e.player.id, e.player);
    return map;
  }, [room.members]);

  const roundMatches = t.matches.filter((m) => m.round === t.currentRound);
  const mine = roundMatches.find((m) => m.home.userId === me || m.away.userId === me);
  const [picked, setPicked] = useState<string | null>(null);
  const focus = t.matches.find((m) => m.id === picked) ?? mine ?? roundMatches.find((m) => m.status !== 'FINISHED') ?? roundMatches[0] ?? t.matches[t.matches.length - 1];
  // A new round: follow your own match again.
  useEffect(() => setPicked(null), [t.currentRound]);

  const kickoffIn = t.nextKickoffAt ? Math.max(0, Math.ceil((t.nextKickoffAt - now) / 1000)) : 0;
  const nextRound = t.currentRound + 1 < t.rounds.length ? t.rounds[t.currentRound + 1] : null;
  const out = !!self && t.bracket.some((b) => b.winnerId && !b.bye && (b.homeId === me || b.awayId === me) && b.winnerId !== me);
  const cells = cellsFromTournament(t, (id) => {
    const m = t.matches.find((x) => x.id === id)!;
    const s = liveState(m, now);
    return { score: s.score, live: s.finished ? null : m.status === 'SCHEDULED' ? null : s.label };
  });

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-white/5 bg-night/70 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-[1300px] items-center gap-3 px-3 sm:px-5">
          <Logo compact />
          <Pill color={room.competition.accent}>{room.competition.shortName}</Pill>
          <span className="display hidden text-lg font-extrabold sm:inline">🏆 The Cup</span>
          <span className="truncate text-sm font-semibold text-volt">{t.currentRound >= 0 ? t.rounds[t.currentRound] : 'The draw'}</span>
          <div className="ml-auto flex items-center gap-1">
            {self && <ExitButton room={room} />}
            <ReactionButton canTaunt={!!self} />
            <ChatButton />
            <SoundToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-[1300px] flex-1 gap-4 p-3 sm:p-5 lg:grid-cols-[1fr_340px]">
        <section className="flex min-w-0 flex-col gap-4">
          <AnimatePresence>
            {t.nextKickoffAt && kickoffIn > 0 && !t.championId && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="flex items-center gap-3 rounded-2xl border border-volt/40 bg-volt/[.07] px-4 py-3"
              >
                <span className="text-2xl">⏱️</span>
                <div className="min-w-0 flex-1">
                  <div className="display text-xl font-extrabold">
                    {t.currentRound < 0 ? t.rounds[0] : nextRound} kick off in {kickoffIn}s
                  </div>
                  <div className="text-xs text-muted">
                    {t.currentRound < 0
                      ? 'Seeded by squad score: the best-built squads were kept apart and get any byes.'
                      : 'Winners go through. Draws go to extra time, then penalties.'}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {out && t.currentRound >= 0 && !t.championId && (
            <div className="rounded-2xl border border-white/10 bg-white/[.03] px-4 py-2.5 text-sm text-muted">
              You’re out of the cup — stick around and cheer (or heckle) the rest 👀
            </div>
          )}

          {focus ? (
            <LiveMatch key={focus.id} match={focus} room={room} me={me} now={now} nameOf={nameOf} players={players} />
          ) : (
            <div className="glass grid min-h-64 place-items-center rounded-3xl p-6 text-center">
              <div>
                <div className="text-5xl">🏆</div>
                <div className="display mt-2 text-3xl font-extrabold">The draw is made</div>
                <p className="mt-1 text-sm text-muted">Squads are seeded by their score. Kick-off in a moment.</p>
              </div>
            </div>
          )}

          {roundMatches.length > 1 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {roundMatches
                .filter((m) => m.id !== focus?.id)
                .map((m) => (
                  <MiniMatch key={m.id} match={m} now={now} nameOf={nameOf} me={me} onClick={() => setPicked(m.id)} />
                ))}
            </div>
          )}
        </section>

        <aside className="flex flex-col gap-4">
          <div className="glass rounded-2xl p-4">
            <div className="label mb-3">Bracket</div>
            <Bracket rounds={t.rounds} cells={cells} seeds={t.seeds} nameOf={nameOf} me={me} current={t.currentRound} onPick={setPicked} />
          </div>
          <div className="glass rounded-2xl p-4 text-xs text-muted">
            <div className="label mb-2">How the cup works</div>
            <ul className="space-y-1.5">
              <li>⚽ Matches are played from your squad: fit, tactics and synergy, not just ratings.</li>
              <li>🧠 Tactics clash: Counter-Attack beats the High Press, the press beats Tiki-Taka, Tiki-Taka picks the lock of the bus…</li>
              <li>📢 Two touchline shouts per match, and a team talk at half-time.</li>
              <li>🥅 Level after 90? Extra time, then penalties.</li>
            </ul>
          </div>
        </aside>
      </main>

      <AnimatePresence>{t.championId && <Ceremony championId={t.championId} name={nameOf(t.championId)} isMe={t.championId === me} />}</AnimatePresence>
    </div>
  );
}

function sideName(m: MatchView, side: 0 | 1, nameOf: (id: string) => string) {
  return nameOf(side === 0 ? m.home.userId : m.away.userId);
}

function MiniMatch({ match: m, now, nameOf, me, onClick }: { match: MatchView; now: number; nameOf: (id: string) => string; me: string; onClick: () => void }) {
  const s = liveState(m, now);
  return (
    <button onClick={onClick} className="glass flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition hover:bg-white/[.07]">
      <span className={`w-14 shrink-0 text-[10px] font-bold uppercase tracking-wider ${s.finished ? 'text-muted' : 'text-volt'}`}>{s.finished ? s.label : `● ${s.label}`}</span>
      <span className="min-w-0 flex-1 text-sm">
        {([0, 1] as const).map((side) => (
          <span key={side} className={`flex items-center justify-between gap-2 ${m.winnerId && m.winnerId !== (side === 0 ? m.home.userId : m.away.userId) ? 'opacity-50' : ''}`}>
            <span className={`truncate font-semibold ${(side === 0 ? m.home.userId : m.away.userId) === me ? 'text-volt' : ''}`}>{sideName(m, side, nameOf)}</span>
            <span className="display text-lg font-extrabold num">
              {s.score[side]}
              {(m.status === 'PENALTIES' || m.pens) && <span className="ml-1 text-xs text-muted">({s.pens[side]})</span>}
            </span>
          </span>
        ))}
      </span>
    </button>
  );
}

const EVENT_ICON: Partial<Record<MatchEvent['kind'], string>> = {
  GOAL: '⚽',
  PEN_GOAL: '⚽',
  PEN_MISS: '❌',
  CHANCE: '💨',
  SAVE: '🧤',
  WOODWORK: '🥅',
  YELLOW: '🟨',
  RED: '🟥',
  SHOUT: '📢',
  TALK: '🗣️',
  INFO: '⏱️',
};

function LiveMatch({
  match: m,
  room,
  me,
  now,
  nameOf,
  players,
}: {
  match: MatchView;
  room: RoomView;
  me: string;
  now: number;
  nameOf: (id: string) => string;
  players: Map<string, PlayerCard>;
}) {
  const toast = useGame((s) => s.toast);
  const s = liveState(m, now);
  const mySide: 0 | 1 | null = m.home.userId === me ? 0 : m.away.userId === me ? 1 : null;
  const myView = mySide === null ? null : mySide === 0 ? m.home : m.away;
  const live = m.status === 'FIRST_HALF' || m.status === 'SECOND_HALF' || m.status === 'EXTRA_TIME';
  const [busy, setBusy] = useState(false);
  const stats = [statsFromEvents(s.shown, 0, m.home.stats.possession), statsFromEvents(s.shown, 1, m.home.stats.possession)];
  const momentum = m.momentum.length ? m.momentum.slice(-2).reduce((a, b) => a + b, 0) / Math.min(2, m.momentum.length) : 0;
  const goalFlash = s.shown.length > 0 && (s.shown[s.shown.length - 1].kind === 'GOAL' || s.shown[s.shown.length - 1].kind === 'PEN_GOAL') && now - (s.shown[s.shown.length - 1].at ?? 0) < 2500;
  const motm = m.motm ? players.get(m.motm) : undefined;

  async function shout(id: Shout) {
    setBusy(true);
    const r = await emit('match:shout', { shout: id });
    setBusy(false);
    if (!r.ok) toast('error', r.error);
  }

  return (
    <div className="glass relative overflow-hidden rounded-3xl">
      {/* scoreboard */}
      <div className="relative px-4 pb-4 pt-5 sm:px-6" style={{ background: 'radial-gradient(ellipse at 50% -20%, rgba(200,255,46,.12), transparent 70%)' }}>
        <div className="mb-2 flex items-center justify-center gap-2 text-[11px] font-bold uppercase tracking-[0.2em] text-muted">
          <span>{room.tournament!.rounds[m.round]}</span>
          {mySide !== null && <span className="rounded-full bg-volt/15 px-2 py-0.5 text-volt">your match</span>}
        </div>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-4">
          <TeamBlock match={m} side={0} nameOf={nameOf} me={me} />
          <div className="text-center">
            <motion.div
              key={`${s.score[0]}-${s.score[1]}`}
              initial={{ scale: 1.5, opacity: 0.4 }}
              animate={{ scale: 1, opacity: 1 }}
              className={`display text-5xl font-extrabold leading-none num sm:text-7xl ${goalFlash ? 'text-volt' : ''}`}
            >
              {s.score[0]}–{s.score[1]}
            </motion.div>
            {(m.status === 'PENALTIES' || m.pens) && (
              <div className="mt-1 text-sm font-bold text-amber-200 num">
                pens {s.pens[0]}–{s.pens[1]}
              </div>
            )}
            <div className={`mt-1.5 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-bold ${s.finished ? 'bg-white/10 text-muted' : 'bg-danger/20 text-rose-200'}`}>
              {!s.finished && m.status !== 'HALF_TIME' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-danger" />}
              {s.label}
            </div>
            {m.halfTime && m.status !== 'FIRST_HALF' && <div className="mt-1 text-[10px] text-dim num">HT {m.halfTime[0]}–{m.halfTime[1]}</div>}
          </div>
          <TeamBlock match={m} side={1} nameOf={nameOf} me={me} />
        </div>

        {/* momentum */}
        <div className="mt-4">
          <div className="mb-1 flex justify-between text-[10px] font-bold uppercase tracking-wider text-dim">
            <span>Momentum</span>
            <span>{m.home.stats.possession}% possession {100 - m.home.stats.possession}%</span>
          </div>
          <div className="relative h-2.5 overflow-hidden rounded-full bg-white/[.06]">
            <motion.div
              className="absolute inset-y-0 rounded-full"
              animate={{ left: momentum >= 0 ? `${50 - momentum * 50}%` : '50%', right: momentum >= 0 ? '50%' : `${50 + momentum * 50}%` }}
              transition={{ type: 'spring', stiffness: 80, damping: 18 }}
              style={{ background: momentum >= 0 ? '#c8ff2e' : '#2ee6ff' }}
            />
            <div className="absolute inset-y-0 left-1/2 w-px bg-white/30" />
          </div>
        </div>

        {m.edges.length > 0 && (
          <div className="mt-3 flex flex-wrap justify-center gap-1.5">
            {m.edges.map((e) => (
              <span key={e} className="rounded-full border border-cyan/30 bg-cyan/[.08] px-2.5 py-1 text-[11px] font-semibold text-cyan">
                🧠 {e}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* your touchline */}
      {myView && live && (
        <div className="flex flex-wrap items-center gap-2 border-t border-white/5 px-4 py-3 sm:px-6">
          <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted">Touchline</span>
          {(['ALL_OUT', 'PARK_IT'] as Shout[]).map((id) => (
            <button
              key={id}
              disabled={busy || !myView.shoutsLeft.includes(id)}
              onClick={() => shout(id)}
              title={SHOUTS[id].blurb}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-white/10 bg-white/[.05] px-3 text-sm font-bold transition hover:bg-white/10 active:scale-95 disabled:opacity-30"
            >
              {SHOUTS[id].emoji} {SHOUTS[id].label}
            </button>
          ))}
          <span className="text-[11px] text-dim">15 minutes each · once per match</span>
        </div>
      )}

      {/* penalties */}
      {(m.status === 'PENALTIES' || (m.shootout && m.shootout.length > 0)) && (
        <div className="border-t border-white/5 px-4 py-3 sm:px-6">
          <div className="label mb-2 !text-amber-200">Penalty shootout</div>
          {([0, 1] as const).map((side) => (
            <div key={side} className="mb-1 flex items-center gap-2">
              <span className="w-24 truncate text-sm font-semibold">{sideName(m, side, nameOf)}</span>
              <div className="flex flex-wrap gap-1">
                {s.kicks
                  .filter((k) => k.side === side)
                  .map((k, i) => (
                    <motion.span
                      key={i}
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      title={players.get(k.playerId)?.name}
                      className={`grid h-6 w-6 place-items-center rounded-full text-xs font-bold ${k.scored ? 'bg-volt text-night' : 'bg-danger/70 text-white'}`}
                    >
                      {k.scored ? '✓' : '✕'}
                    </motion.span>
                  ))}
              </div>
            </div>
          ))}
          {s.kicks.length > 0 && (
            <p className="mt-1 text-xs text-muted">
              {(() => {
                const k = s.kicks[s.kicks.length - 1];
                const who = players.get(k.playerId)?.shortName ?? 'He';
                return k.scored ? `${who} scores!` : `${who} misses!`;
              })()}
            </p>
          )}
        </div>
      )}

      {/* full time */}
      {s.finished && m.winnerId && (
        <div className="flex flex-wrap items-center gap-3 border-t border-white/5 bg-volt/[.05] px-4 py-3 sm:px-6">
          <span className="text-2xl">{m.winnerId === me ? '🎉' : mySide !== null ? '😔' : '🏁'}</span>
          <div className="min-w-0 flex-1">
            <div className="display text-xl font-extrabold">{m.winnerId === me ? (room.tournament!.rounds.length - 1 === m.round ? 'You win the cup!' : 'You’re through!') : room.tournament!.rounds.length - 1 === m.round ? `${nameOf(m.winnerId)} wins the cup` : `${nameOf(m.winnerId)} goes through`}</div>
            {motm && (
              <div className="text-xs text-muted">
                ⭐ Man of the match: <b className="text-ink">{motm.name}</b>
              </div>
            )}
          </div>
        </div>
      )}

      {/* stats */}
      <div className="grid grid-cols-3 gap-px border-t border-white/5 bg-white/5 text-center text-xs">
        {[
          ['Shots', stats[0].shots, stats[1].shots],
          ['On target', stats[0].onTarget, stats[1].onTarget],
          ['xG', stats[0].xg.toFixed(1), stats[1].xg.toFixed(1)],
        ].map(([label, h, a]) => (
          <div key={label as string} className="bg-deep/80 py-2">
            <div className="display text-lg font-extrabold num">
              {h} <span className="text-dim">–</span> {a}
            </div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</div>
          </div>
        ))}
      </div>

      {/* commentary */}
      <ol className="scrollbar-thin max-h-72 space-y-1 overflow-y-auto border-t border-white/5 px-3 py-3 sm:px-5">
        <AnimatePresence initial={false}>
          {[...s.shown].reverse().map((e, i) => {
            const big = e.kind === 'GOAL' || e.kind === 'PEN_GOAL' || e.kind === 'RED';
            const ours = mySide !== null && e.side === mySide;
            return (
              <motion.li
                key={`${e.minute}-${e.kind}-${e.text}-${s.shown.length - i}`}
                initial={{ opacity: 0, x: -12, backgroundColor: big ? 'rgba(200,255,46,.18)' : 'rgba(255,255,255,0)' }}
                animate={{ opacity: 1, x: 0, backgroundColor: 'rgba(255,255,255,0)' }}
                transition={{ duration: 0.6 }}
                className={`flex gap-2 rounded-lg px-2 py-1 text-sm ${big ? 'font-bold' : 'text-ink/85'}`}
              >
                <span className="w-9 shrink-0 text-right text-xs font-bold text-muted num">{e.kind === 'TALK' || e.kind === 'INFO' ? '' : `${e.minute}'`}</span>
                {/* Shouts, team talks and cards carry their own emoji. */}
                {!['SHOUT', 'TALK', 'YELLOW', 'RED', 'INFO'].includes(e.kind) && <span className="shrink-0">{EVENT_ICON[e.kind] ?? '•'}</span>}
                <span className={`min-w-0 ${e.side !== null ? (ours ? 'text-volt' : mySide !== null ? 'text-rose-200' : '') : 'text-muted'}`}>
                  {e.side !== null && e.kind !== 'TALK' && e.kind !== 'SHOUT' && <span className="mr-1 text-xs font-bold text-dim">{sideName(m, e.side, nameOf)}:</span>}
                  {e.text}
                </span>
              </motion.li>
            );
          })}
        </AnimatePresence>
        {s.shown.length === 0 && <li className="py-4 text-center text-sm text-dim">{m.status === 'SCHEDULED' ? 'Waiting for kick-off…' : 'Kick-off!'}</li>}
      </ol>

      <AnimatePresence>{myView && m.status === 'HALF_TIME' && <TeamTalkSheet match={m} side={mySide!} now={now} />}</AnimatePresence>
      <AnimatePresence>{goalFlash && <GoalFlash event={s.shown[s.shown.length - 1]} mine={mySide !== null && s.shown[s.shown.length - 1].side === mySide} against={mySide !== null && s.shown[s.shown.length - 1].side !== mySide} />}</AnimatePresence>
    </div>
  );
}

function TeamBlock({ match: m, side, nameOf, me }: { match: MatchView; side: 0 | 1; nameOf: (id: string) => string; me: string }) {
  const v = side === 0 ? m.home : m.away;
  const name = nameOf(v.userId);
  return (
    <div className="flex min-w-0 flex-col items-center gap-1.5 text-center">
      <Avatar name={name} size={44} ring={v.userId === me ? '#c8ff2e' : undefined} />
      <div className={`w-full truncate display text-lg font-extrabold leading-tight sm:text-2xl ${v.userId === me ? 'text-volt' : ''}`}>{name}</div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
        #{v.seed} · {v.formationId}
      </div>
      <div className="rounded-full bg-white/[.06] px-2 py-0.5 text-[10px] font-bold text-ink/80">{TACTICS[v.tacticId]?.label ?? 'Balanced'}</div>
      {v.talk && m.status !== 'HALF_TIME' && <div className="text-[10px] text-cyan">{TEAM_TALKS[v.talk].emoji} {TEAM_TALKS[v.talk].label}</div>}
    </div>
  );
}

function TeamTalkSheet({ match: m, side, now }: { match: MatchView; side: 0 | 1; now: number }) {
  const toast = useGame((s) => s.toast);
  const v = side === 0 ? m.home : m.away;
  const [busy, setBusy] = useState(false);
  const left = m.halfTimeEndsAt ? Math.max(0, Math.ceil((m.halfTimeEndsAt - now) / 1000)) : 0;
  const ht = m.halfTime ?? [0, 0];
  const lead = ht[side] - ht[1 - side];

  async function talk(t: TeamTalk) {
    setBusy(true);
    const r = await emit('match:talk', { talk: t });
    setBusy(false);
    if (!r.ok) toast('error', r.error);
  }

  // Portal: the glass card's backdrop blur would trap a fixed overlay inside it (and off-screen on phones).
  if (typeof document === 'undefined') return null;
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-end justify-center bg-night/80 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-sm sm:items-center"
    >
      <motion.div initial={{ y: 30 }} animate={{ y: 0 }} className="w-full max-w-md rounded-3xl border border-white/10 bg-deep p-5 shadow-2xl">
        <div className="flex items-baseline justify-between">
          <div className="label !text-volt">Half-time · {ht[0]}–{ht[1]}</div>
          <span className="display text-2xl font-extrabold num">{left}s</span>
        </div>
        <h3 className="display mt-1 text-3xl font-extrabold">Team talk</h3>
        <p className="mt-1 text-sm text-muted">
          {lead > 0 ? 'You’re ahead. Kill the game, or go for more?' : lead < 0 ? 'You’re behind. Time to gamble?' : 'All square. What’s the plan?'} Your opponent won’t see your choice until the second half.
        </p>
        {v.talk ? (
          <div className="mt-4 rounded-2xl border border-volt/40 bg-volt/10 px-4 py-3 text-center font-bold text-volt">
            {TEAM_TALKS[v.talk].emoji} “{TEAM_TALKS[v.talk].label}” — waiting for the second half…
          </div>
        ) : (
          <div className="mt-4 grid gap-2">
            {(['ATTACK', 'CALM', 'TIGHT'] as TeamTalk[]).map((t) => (
              <button
                key={t}
                disabled={busy}
                onClick={() => talk(t)}
                className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[.04] px-4 py-3 text-left transition hover:bg-white/[.09] active:scale-[0.99]"
              >
                <span className="text-2xl">{TEAM_TALKS[t].emoji}</span>
                <span>
                  <span className="display block text-lg font-extrabold">{TEAM_TALKS[t].label}</span>
                  <span className="text-xs text-muted">{TEAM_TALKS[t].blurb}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </motion.div>
    </motion.div>,
    document.body,
  );
}

function GoalFlash({ event, mine, against }: { event: MatchEvent; mine: boolean; against: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.6 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 1.2 }}
      transition={{ type: 'spring', stiffness: 260, damping: 16 }}
      className="pointer-events-none absolute inset-x-0 top-16 z-[5] flex justify-center"
    >
      <div
        className={`display rounded-2xl px-6 py-2 text-4xl font-extrabold shadow-2xl sm:text-6xl ${
          mine ? 'bg-volt text-night' : against ? 'bg-danger/90 text-white' : 'bg-white text-night'
        }`}
      >
        {event.kind === 'PEN_GOAL' ? 'PENALTY GOAL!' : 'GOAL!'}
      </div>
    </motion.div>
  );
}

function Ceremony({ championId, name, isMe }: { championId: string; name: string; isMe: boolean }) {
  return (
    <motion.div
      key={championId}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 grid place-items-center overflow-hidden bg-night/90 px-6 text-center backdrop-blur-md"
    >
      <Sparks />
      <div>
        <motion.div
          initial={{ y: 120, scale: 0.4, rotate: -20 }}
          animate={{ y: 0, scale: 1, rotate: 0 }}
          transition={{ type: 'spring', stiffness: 120, damping: 10 }}
          className="text-[7rem] leading-none drop-shadow-[0_0_50px_rgba(245,197,66,.7)] sm:text-[10rem]"
        >
          🏆
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }}>
          <div className="display mt-4 text-xl font-bold tracking-[0.3em] text-gold">Cup winner</div>
          <div className="display mt-1 break-all text-[clamp(2.6rem,12vw,6rem)] font-extrabold leading-none">{isMe ? 'You!' : name}</div>
          <p className="mt-3 text-muted">{isMe ? 'Lift it high, champion.' : `${name} lifts the cup.`}</p>
        </motion.div>
      </div>
    </motion.div>
  );
}

function Sparks() {
  return (
    <div className="pointer-events-none absolute inset-0">
      {Array.from({ length: 50 }, (_, i) => {
        const left = (i * 41) % 100;
        return (
          <motion.span
            key={i}
            initial={{ y: -30, opacity: 1, rotate: 0 }}
            animate={{ y: '105vh', opacity: 0.2, rotate: 600 }}
            transition={{ duration: 2.4 + (i % 6) * 0.3, delay: (i % 10) * 0.12, ease: 'easeIn' }}
            className="absolute top-0 h-3 w-1.5 rounded-sm"
            style={{ left: `${left}%`, background: ['#f5c542', '#c8ff2e', '#2ee6ff', '#ff6b8a', '#ffffff'][i % 5] }}
          />
        );
      })}
    </div>
  );
}

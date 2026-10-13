'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import type { CompetitionSummary, GameMode } from '@fa/shared';
import { api, type LiveGame, type PublicRoom } from '@/lib/api';
import { emit, ensureConnected } from '@/lib/socket';
import { useGame } from '@/lib/store';
import { Button, Pill } from './ui';

/** One-click matchmaking: join the best open public room, or open one. */
export function PlayNow() {
  const router = useRouter();
  const session = useGame((s) => s.session)!;
  const toast = useGame((s) => s.toast);
  const [comps, setComps] = useState<CompetitionSummary[]>([]);
  const [competitionId, setCompetitionId] = useState('');
  const [busy, setBusy] = useState<GameMode | null>(null);

  useEffect(() => {
    api
      .competitions()
      .then((r) => setComps(r.competitions))
      .catch(() => {});
  }, []);

  async function play(mode: GameMode) {
    setBusy(mode);
    try {
      if (!(await ensureConnected(session.token))) throw new Error('Cannot reach the game server.');
      const r = await emit<{ code: string; created: boolean }>('match:quick', { mode, ...(competitionId ? { competitionId } : {}) });
      if (!r.ok) throw new Error(r.error);
      if (r.data!.created) toast('info', 'No open room matched — opened a public one. Others can join from “Play now”.');
      router.push(`/room/${r.data!.code}`);
    } catch (e) {
      toast('error', (e as Error).message);
      setBusy(null);
    }
  }

  return (
    <section className="relative overflow-hidden rounded-3xl border border-volt/25 p-6 sm:p-8" style={{ background: 'linear-gradient(120deg, rgba(200,255,46,.12), rgba(46,230,255,.06) 60%, transparent)' }}>
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="label text-volt">Matchmaking</p>
          <h2 className="display text-4xl font-extrabold">Play now</h2>
          <p className="mt-1 max-w-md text-sm text-muted">Jump into the best open public room — or open one that others can find. Ranked games move your ELO.</p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <select
            value={competitionId}
            onChange={(e) => setCompetitionId(e.target.value)}
            className="h-12 rounded-xl border border-white/10 bg-night px-3 text-sm font-semibold outline-none focus:border-volt/60"
            aria-label="Preferred competition"
          >
            <option value="">Any competition</option>
            {comps.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <Button size="lg" variant="secondary" disabled={!!busy} onClick={() => play('CASUAL')}>
            {busy === 'CASUAL' ? 'Finding…' : 'Casual'}
          </Button>
          <Button size="lg" disabled={!!busy} onClick={() => play('RANKED')}>
            {busy === 'RANKED' ? 'Finding…' : 'Ranked ⚡'}
          </Button>
        </div>
      </div>
    </section>
  );
}

/** Live list of open public lobbies. */
export function PublicRooms() {
  const [rooms, setRooms] = useState<PublicRoom[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .publicRooms()
        .then((r) => alive && setRooms(r.rooms))
        .catch(() => alive && setRooms([]));
    void load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <section className="mt-6">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="display text-2xl font-extrabold">Open public rooms</h2>
        <span className="text-xs text-dim">refreshes every 5s</span>
      </div>
      {rooms === null ? (
        <div className="h-16 animate-pulse rounded-2xl bg-white/5" />
      ) : rooms.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 px-5 py-5 text-sm text-muted">
          No open public rooms right now. Press <span className="font-semibold text-ink">Play now</span> to open one, or create a public room below.
        </div>
      ) : (
        <ul className="grid gap-2 md:grid-cols-2">
          <AnimatePresence initial={false}>
            {rooms.map((r) => (
              <motion.li key={r.code} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <Link href={`/room/${r.code}`} className="glass flex items-center gap-3 rounded-2xl px-4 py-3 transition hover:bg-white/[.07]">
                  <span className="h-10 w-1.5 rounded-full" style={{ background: r.competition.accent }} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-bold">{r.name}</span>
                      {r.mode === 'RANKED' && <Pill color="#c8ff2e">Ranked · ~{r.avgElo}</Pill>}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {r.competition.name} · host {r.host} · {r.lotDurationSec}s timer
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="display block text-xl font-extrabold num">
                      {r.members}/{r.maxPlayers}
                    </span>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-volt">Join →</span>
                  </span>
                </Link>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </section>
  );
}

const PHASE_LABEL: Record<string, string> = {
  STARTING: 'Starting',
  AUCTION: 'Auction live',
  PLAYER_SOLD: 'Auction live',
  SQUAD_BUILDING: 'Picking lineups',
  FINAL_EVALUATION: 'Scoring',
  RESULTS: 'Results',
};

/** Public games in progress, open to spectators. */
export function LiveGames() {
  const [games, setGames] = useState<LiveGame[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .liveGames()
        .then((r) => alive && setGames(r.games))
        .catch(() => {});
    void load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (!games.length) return null;
  return (
    <section className="mt-6">
      <h2 className="display mb-3 flex items-center gap-2 text-2xl font-extrabold">
        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-danger" /> Live now
      </h2>
      <ul className="grid gap-2 md:grid-cols-2">
        {games.map((g) => (
          <li key={g.code}>
            <Link href={`/room/${g.code}?watch=1`} className="glass flex items-center gap-3 rounded-2xl px-4 py-3 transition hover:bg-white/[.07]">
              <span className="h-10 w-1.5 rounded-full" style={{ background: g.competition.accent }} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate font-bold">{g.managers.join(' vs ')}</span>
                  {g.mode === 'RANKED' && <Pill color="#c8ff2e">Ranked</Pill>}
                </span>
                <span className="block truncate text-xs text-muted">
                  {g.competition.name} · {PHASE_LABEL[g.phase] ?? g.phase}
                  {g.lotsOpened ? ` · lot ${g.lotsOpened}` : ''} · 👀 {g.spectators}
                </span>
              </span>
              <span className="text-[11px] font-bold uppercase tracking-wider text-cyan">Watch →</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { motion } from 'motion/react';
import type { GameMode, LeaderboardRow } from '@fa/shared';
import { MobileNav, SiteHeader } from '@/components/SiteHeader';
import { Avatar } from '@/components/ui';
import { api } from '@/lib/api';
import { useGame } from '@/lib/store';

const MEDAL = ['🥇', '🥈', '🥉'];

export default function LeaderboardPage() {
  const me = useGame((s) => s.session?.user.username);
  const [mode, setMode] = useState<GameMode>('RANKED');
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true; // ignore responses for a tab that is no longer selected
    setRows(null);
    setError(null);
    api
      .leaderboard(mode)
      .then((r) => current && setRows(r.rows))
      .catch((e) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [mode]);

  return (
    <main className="mx-auto min-h-dvh max-w-6xl px-4 pb-16 sm:px-6">
      <SiteHeader />
      <MobileNav />
      <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label">Global</p>
          <h1 className="display text-5xl font-extrabold">Leaderboard</h1>
        </div>
        <div className="inline-flex rounded-xl bg-white/[.05] p-1">
          {(['RANKED', 'CASUAL'] as GameMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`h-9 rounded-lg px-4 text-sm font-bold uppercase tracking-wider transition ${mode === m ? 'bg-volt text-night' : 'text-muted hover:text-ink'}`}
            >
              {m === 'RANKED' ? 'Ranked ⚡' : 'Casual'}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-2 text-sm text-muted">
        {mode === 'RANKED'
          ? 'Sorted by ELO. Ratings move after every ranked game — beat stronger managers and bigger rooms to climb faster.'
          : 'Casual games don’t touch ELO. Sorted by wins, then average squad score.'}
      </p>

      <div className="glass mt-6 overflow-hidden rounded-2xl">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-[11px] uppercase tracking-wider text-muted">
              <th className="px-4 py-3">Rank</th>
              <th className="px-2 py-3">Manager</th>
              {mode === 'RANKED' && <th className="px-2 py-3 text-right">ELO</th>}
              <th className="px-2 py-3 text-right">Games</th>
              <th className="px-2 py-3 text-right">Wins</th>
              <th className="hidden px-2 py-3 text-right md:table-cell">Podiums</th>
              <th className="hidden px-2 py-3 text-right sm:table-cell">Win %</th>
              <th className="hidden px-2 py-3 text-right md:table-cell">Avg score</th>
              <th className="hidden px-4 py-3 text-right lg:table-cell">Best score</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((r, i) => (
              <motion.tr
                key={r.userId}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: Math.min(i, 20) * 0.02 }}
                className={`border-b border-white/5 last:border-0 ${r.username === me ? 'bg-volt/[.07]' : 'hover:bg-white/[.03]'}`}
              >
                <td className="display px-4 py-2.5 text-xl font-extrabold">{MEDAL[i] ?? r.rank}</td>
                <td className="px-2 py-2.5">
                  <Link href={`/u/${r.username}`} className="flex items-center gap-2.5 font-semibold hover:text-volt">
                    <Avatar name={r.username} size={28} />
                    <span className="truncate">{r.username}</span>
                    {r.username === me && <span className="text-xs text-muted">(you)</span>}
                  </Link>
                </td>
                {mode === 'RANKED' && <td className="display px-2 py-2.5 text-right text-xl font-extrabold text-volt num">{r.elo}</td>}
                <td className="px-2 py-2.5 text-right num">{r.games}</td>
                <td className="px-2 py-2.5 text-right num">{r.wins}</td>
                <td className="hidden px-2 py-2.5 text-right num md:table-cell">{r.podiums}</td>
                <td className="hidden px-2 py-2.5 text-right num sm:table-cell">{r.winRate}%</td>
                <td className="hidden px-2 py-2.5 text-right num md:table-cell">{r.avgScore.toFixed(1)}</td>
                <td className="hidden px-4 py-2.5 text-right num lg:table-cell">{r.highestScore.toFixed(1)}</td>
              </motion.tr>
            ))}
          </tbody>
        </table>
        {rows === null && !error && <div className="h-40 animate-pulse bg-white/[.02]" />}
        {error && <p className="px-4 py-6 text-sm text-rose-300">{error}</p>}
        {rows?.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-muted">
            No {mode === 'RANKED' ? 'ranked' : 'casual'} games finished yet — be the first on the board.
          </p>
        )}
      </div>
    </main>
  );
}

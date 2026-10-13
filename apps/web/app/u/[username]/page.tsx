'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { ProfileView, StatsBlock } from '@fa/shared';
import { AchievementGrid } from '@/components/Achievements';
import { FormationBars, ScoreTrend } from '@/components/ProfileCharts';
import { EloDelta } from '@/components/Results';
import { MobileNav, SiteHeader } from '@/components/SiteHeader';
import { Avatar, Pill } from '@/components/ui';
import { api } from '@/lib/api';
import { useGame } from '@/lib/store';

const PLACE = ['🥇', '🥈', '🥉'];

export default function ProfilePage() {
  const { username } = useParams<{ username: string }>();
  const me = useGame((s) => s.session?.user.username);
  const [p, setP] = useState<ProfileView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setP(null);
    setError(null);
    api
      .profile(decodeURIComponent(username))
      .then(setP)
      .catch((e) => setError(e.message));
  }, [username]);

  return (
    <main className="mx-auto min-h-dvh max-w-6xl px-4 pb-16 sm:px-6">
      <SiteHeader />
      <MobileNav />
      {error && <p className="mt-10 text-center text-rose-300">{error}</p>}
      {!p && !error && <div className="mt-8 h-48 animate-pulse rounded-3xl bg-white/[.03]" />}
      {p && (
        <>
          <section className="mt-6 flex flex-col gap-6 rounded-3xl border border-white/10 bg-white/[.02] p-6 sm:flex-row sm:items-center sm:p-8">
            <Avatar name={p.username} size={88} />
            <div className="min-w-0 flex-1">
              <p className="label">Manager{p.username === me ? ' · you' : ''}</p>
              <h1 className="display truncate text-5xl font-extrabold sm:text-6xl">{p.username}</h1>
              <p className="mt-1 text-sm text-muted">
                Member since {new Date(p.memberSince).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
                {p.favoriteCompetition && <> · loves {p.favoriteCompetition.name}</>}
                {p.favoriteFormation && <> · plays {p.favoriteFormation}</>}
              </p>
            </div>
            <div className="flex gap-6 text-center">
              <div>
                <div className="display text-5xl font-extrabold text-volt num">{p.ranked.elo}</div>
                <div className="label">ELO</div>
              </div>
              <div>
                <div className="display text-5xl font-extrabold num">{p.ranked.globalRank ? `#${p.ranked.globalRank}` : '—'}</div>
                <div className="label">Global rank</div>
              </div>
            </div>
          </section>

          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <StatsCard title="Ranked ⚡" s={p.ranked} />
            <StatsCard title="Casual" s={p.casual} />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-[1.6fr_1fr]">
            <div className="glass rounded-2xl p-5">
              <div className="label mb-3">Squad score · last {p.trend.length} games</div>
              <ScoreTrend trend={p.trend} />
            </div>
            <div className="glass rounded-2xl p-5">
              <div className="label mb-3">Transfer habits</div>
              <dl className="grid grid-cols-3 gap-2 text-center">
                {[
                  ['Avg spend', String(p.spending.avgSpent)],
                  ['Bargains', String(p.spending.bargains)],
                  ['Overpays', String(p.spending.overpays)],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-xl bg-white/[.04] px-2 py-2.5">
                    <dd className="display text-2xl font-extrabold num">{v}</dd>
                    <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted">{k}</dt>
                  </div>
                ))}
              </dl>
              <ul className="mt-3 space-y-1.5 text-sm">
                {p.spending.biggestBargain && (
                  <li>
                    🟢 Best bargain: <span className="font-semibold">{p.spending.biggestBargain.playerName}</span>{' '}
                    <span className="text-muted">
                      — {p.spending.biggestBargain.price} for ~{p.spending.biggestBargain.value}
                    </span>
                  </li>
                )}
                {p.spending.recordSigning && (
                  <li>
                    💰 Record signing: <span className="font-semibold">{p.spending.recordSigning.playerName}</span>{' '}
                    <span className="text-muted">— {p.spending.recordSigning.price}</span>
                  </li>
                )}
              </ul>
              <div className="label mb-2 mt-4">Formations</div>
              <FormationBars formations={p.formations} />
            </div>
          </div>

          <section className="mt-8">
            <AchievementGrid unlocked={p.achievements} />
          </section>

          <section className="mt-8">
            <h2 className="display mb-3 text-2xl font-extrabold">Recent matches</h2>
            {p.recent.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-white/10 px-5 py-5 text-sm text-muted">No finished games yet.</p>
            ) : (
              <ul className="space-y-2">
                {p.recent.map((m) => (
                  <li key={m.gameId}>
                    <Link href={`/match/${m.gameId}`} className="glass flex items-center gap-4 rounded-2xl px-4 py-3 transition hover:bg-white/[.07]">
                      <span className="display w-10 text-center text-2xl font-extrabold">{PLACE[m.rank - 1] ?? `#${m.rank}`}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate font-bold">{m.competition.name} auction</span>
                          {m.mode === 'RANKED' && <Pill color="#c8ff2e">Ranked</Pill>}
                        </span>
                        <span className="text-xs text-muted">
                          {m.players} players · {ordinal(m.rank)} place · {new Date(m.endedAt).toLocaleDateString()}
                        </span>
                      </span>
                      <span className="text-right">
                        <span className="display block text-2xl font-extrabold num">{m.score.toFixed(1)}</span>
                        {m.eloDelta !== null && <EloDelta delta={m.eloDelta} />}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function StatsCard({ title, s }: { title: string; s: StatsBlock }) {
  const tiles: [string, string][] = [
    ['Games', String(s.games)],
    ['Wins', String(s.wins)],
    ['Podiums', String(s.podiums)],
    ['Win rate', `${s.winRate}%`],
    ['Avg score', s.games ? s.avgScore.toFixed(1) : '—'],
    ['Best score', s.games ? s.highestScore.toFixed(1) : '—'],
  ];
  return (
    <div className="glass rounded-2xl p-5">
      <div className="label mb-3">{title}</div>
      <div className="grid grid-cols-3 gap-2">
        {tiles.map(([k, v]) => (
          <div key={k} className="rounded-xl bg-white/[.04] px-3 py-2.5 text-center">
            <div className="display text-2xl font-extrabold num">{v}</div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{k}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] ?? 'th'}`;

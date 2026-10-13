'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { GROUP_ORDER, POSITION_GROUP, verdictFor, type MatchDetailView, type PlayerCard } from '@fa/shared';
import { PlayerAvatar } from '@/components/PlayerAvatar';
import { Analysis, EloDelta, ManagerReport } from '@/components/Results';
import { MobileNav, SiteHeader } from '@/components/SiteHeader';
import { Avatar, Pill } from '@/components/ui';
import { api } from '@/lib/api';

const MEDAL = ['🥇', '🥈', '🥉'];
const VERDICT_STYLE = { BARGAIN: 'text-emerald-300', FAIR: 'text-muted', OVERPAY: 'text-rose-300' } as const;

export default function MatchPage() {
  const { id } = useParams<{ id: string }>();
  const [m, setM] = useState<MatchDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<'squads' | 'auction'>('squads');

  useEffect(() => {
    api
      .match(id)
      .then((d) => {
        setM(d);
        setSelected(d.rankings[0]?.userId ?? null);
      })
      .catch((e) => setError(e.message));
  }, [id]);

  const players = useMemo(() => {
    const map = new Map<string, PlayerCard>();
    for (const mgr of m?.managers ?? []) for (const e of mgr.squad) map.set(e.player.id, e.player);
    return map;
  }, [m]);

  const nameOf = (uid: string) => m?.managers.find((x) => x.userId === uid)?.username ?? 'Manager';

  return (
    <main className="mx-auto min-h-dvh max-w-[1300px] px-4 pb-16 sm:px-6">
      <SiteHeader />
      <MobileNav />
      {error && <p className="mt-10 text-center text-rose-300">{error}</p>}
      {!m && !error && <div className="mt-8 h-48 animate-pulse rounded-3xl bg-white/[.03]" />}
      {m && (
        <>
          <section
            className="mt-6 rounded-3xl border border-white/10 p-6 sm:p-8"
            style={{ background: `linear-gradient(120deg, ${m.competition.accent}2a, transparent 60%)` }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Pill color={m.competition.accent}>{m.competition.name}</Pill>
              <Pill color="#8b94a8">{m.competition.seasonLabel}</Pill>
              {m.mode === 'RANKED' ? <Pill color="#c8ff2e">Ranked</Pill> : <Pill color="#2ee6ff">Casual</Pill>}
            </div>
            <h1 className="display mt-3 text-4xl font-extrabold sm:text-5xl">{m.report.headline}</h1>
            <p className="mt-1 text-sm text-muted">
              {m.roomName} · {m.managers.length} managers · {m.startingBudget.toLocaleString()} budget ·{' '}
              {new Date(m.endedAt ?? m.startedAt).toLocaleString()}
            </p>
          </section>

          <div className="mt-6 grid gap-6 lg:grid-cols-[360px_1fr]">
            <div className="glass h-fit rounded-2xl p-4">
              <div className="label mb-3">Final ranking</div>
              <ol className="space-y-2">
                {m.rankings.map((r, i) => {
                  const mgr = m.managers.find((x) => x.userId === r.userId)!;
                  return (
                    <li key={r.userId}>
                      <button
                        onClick={() => setSelected(r.userId)}
                        className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
                          selected === r.userId ? 'border-volt/60 bg-volt/[.08]' : 'border-white/5 bg-white/[.02] hover:bg-white/[.05]'
                        }`}
                      >
                        <span className="display w-7 text-center text-xl font-extrabold">{MEDAL[i] ?? r.rank}</span>
                        <Avatar name={mgr.username} size={32} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-bold">{mgr.username}</span>
                          <span className="text-xs text-muted">
                            {mgr.lineup?.formationId} · spent {r.spent}
                          </span>
                        </span>
                        <span className="text-right">
                          <span className="display block text-2xl font-extrabold leading-none num">{r.total.toFixed(1)}</span>
                          {mgr.eloBefore !== null && mgr.eloAfter !== null && <EloDelta delta={mgr.eloAfter - mgr.eloBefore} />}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
              <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                {m.managers.map((x) => (
                  <Link key={x.userId} href={`/u/${x.username}`} className="text-muted hover:text-volt">
                    {x.username}’s profile →
                  </Link>
                ))}
              </div>
            </div>
            <div className="min-w-0">
              {selected && (
                <ManagerReport
                  key={selected}
                  score={m.rankings.find((r) => r.userId === selected)!}
                  name={nameOf(selected)}
                  verdict={m.report.verdicts[selected]}
                  lineup={m.managers.find((x) => x.userId === selected)?.lineup}
                  players={players}
                  elo={(() => {
                    const x = m.managers.find((y) => y.userId === selected);
                    return x && x.eloBefore !== null && x.eloAfter !== null ? { before: x.eloBefore, after: x.eloAfter } : null;
                  })()}
                />
              )}
            </div>
          </div>

          <Analysis report={m.report} nameOf={nameOf} players={players} />

          <div className="mt-8 flex gap-1">
            {(['squads', 'auction'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`h-9 rounded-lg px-4 text-sm font-bold uppercase tracking-wider ${tab === t ? 'bg-white/10 text-ink' : 'text-muted hover:text-ink'}`}
              >
                {t === 'squads' ? 'Squads & purchases' : `Auction log (${m.lots.length})`}
              </button>
            ))}
          </div>

          {tab === 'squads' ? (
            <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {m.rankings.map((r) => {
                const mgr = m.managers.find((x) => x.userId === r.userId)!;
                const starters = new Set(mgr.lineup?.slots.filter(Boolean) as string[]);
                const sorted = [...mgr.squad].sort(
                  (a, b) =>
                    GROUP_ORDER.indexOf(POSITION_GROUP[a.player.position]) - GROUP_ORDER.indexOf(POSITION_GROUP[b.player.position]) ||
                    b.player.overall - a.player.overall,
                );
                return (
                  <div key={r.userId} className="glass rounded-2xl p-4">
                    <div className="mb-2 flex items-baseline justify-between">
                      <span className="font-bold">
                        {MEDAL[r.rank - 1] ?? `#${r.rank}`} {mgr.username}
                      </span>
                      <span className="text-xs text-muted">
                        spent {r.spent} · {mgr.budgetLeft} left
                      </span>
                    </div>
                    <table className="w-full table-fixed text-xs">
                      <colgroup>
                        <col className="w-7" />
                        <col className="w-9" />
                        <col />
                        <col className="w-8" />
                        <col className="w-9" />
                        <col className="w-16" />
                      </colgroup>
                      <tbody>
                        {sorted.map((e) => {
                          const v = e.via === 'AUTO' ? null : verdictFor(e.price, e.estimatedValue);
                          return (
                            <tr key={e.player.id} className="border-b border-white/5 last:border-0">
                              <td className="py-1 pr-2">
                                <PlayerAvatar player={e.player} size={22} />
                              </td>
                              <td className="w-8 py-1 font-bold text-muted">{e.player.position}</td>
                              <td className="truncate py-1 pr-2" title={e.player.name}>
                                {e.player.shortName}
                                {!starters.has(e.player.id) && <span className="ml-1 text-dim">(bench)</span>}
                              </td>
                              <td className="py-1 pr-2 text-right font-bold num">{e.player.overall}</td>
                              <td className="py-1 pr-2 text-right num">{e.price}</td>
                              <td className={`py-1 text-right text-[10px] font-bold uppercase ${v ? VERDICT_STYLE[v] : 'text-cyan'}`}>
                                {v ?? 'auto'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="glass mt-3 overflow-hidden rounded-2xl">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-left text-[11px] uppercase tracking-wider text-muted">
                    <th className="px-4 py-2.5">#</th>
                    <th className="px-2 py-2.5">Player</th>
                    <th className="px-2 py-2.5">Result</th>
                    <th className="px-2 py-2.5 text-right">Price</th>
                    <th className="hidden px-2 py-2.5 text-right sm:table-cell">Est. value</th>
                    <th className="hidden px-4 py-2.5 text-right sm:table-cell">Bids</th>
                  </tr>
                </thead>
                <tbody>
                  {m.lots.map((l) => {
                    const v = l.price !== null && l.outcome === 'SOLD' ? verdictFor(l.price, l.estimatedValue) : null;
                    return (
                      <tr key={l.lotNumber} className="border-b border-white/5 last:border-0">
                        <td className="px-4 py-2 text-muted num">{l.lotNumber}</td>
                        <td className="px-2 py-2 font-medium">{l.playerName}</td>
                        <td className="px-2 py-2">
                          {l.outcome === 'UNSOLD' ? (
                            <span className="text-dim">Unsold</span>
                          ) : (
                            <span>
                              {l.outcome === 'AUTO_ASSIGNED' ? 'Auto → ' : 'Sold → '}
                              <span className="font-semibold">{l.winner}</span>
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right num">
                          {l.price ?? '—'} {v && <span className={`ml-1 text-[10px] font-bold uppercase ${VERDICT_STYLE[v]}`}>{v}</span>}
                        </td>
                        <td className="hidden px-2 py-2 text-right text-muted num sm:table-cell">{l.estimatedValue}</td>
                        <td className="hidden px-4 py-2 text-right text-muted num sm:table-cell">{l.bids}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </main>
  );
}

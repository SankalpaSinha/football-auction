'use client';
import { advance, buildBracket, type CupSummary, type TournamentView } from '@fa/shared';

export interface BracketCell {
  round: number;
  slot: number;
  homeId: string | null;
  awayId: string | null;
  bye: boolean;
  score: [number, number] | null;
  pens: [number, number] | null;
  winnerId: string | null;
  /** Live minute label while it's being played ("67'", "HT", "PENS"). */
  live: string | null;
  matchId: string | null;
}

/** Bracket cells from the live cup view. `liveLabel` gives each running match's clock. */
export function cellsFromTournament(t: TournamentView, score: (matchId: string) => { score: [number, number]; live: string | null }): BracketCell[] {
  return t.bracket.map((b) => {
    const m = b.matchId ? t.matches.find((x) => x.id === b.matchId) : undefined;
    const s = m ? score(m.id) : null;
    return {
      round: b.round,
      slot: b.slot,
      homeId: b.homeId,
      awayId: b.awayId,
      bye: b.bye,
      score: s ? s.score : null,
      pens: m?.status === 'FINISHED' ? m.pens : null,
      winnerId: b.winnerId,
      live: s?.live ?? null,
      matchId: b.matchId,
    };
  });
}

/** Rebuild the bracket from a saved cup (match page). */
export function cellsFromSummary(summary: CupSummary): BracketCell[] {
  const seeded = Object.keys(summary.seeds).sort((a, b) => summary.seeds[a] - summary.seeds[b]);
  const bracket = buildBracket(seeded);
  const cells: BracketCell[] = bracket.map((b) => ({ ...b, score: null, pens: null, live: null }));
  for (let r = 0; r < summary.rounds.length; r++) {
    for (const c of cells.filter((x) => x.round === r)) {
      const m = summary.matches.find((x) => x.round === r && x.homeId === c.homeId && x.awayId === c.awayId);
      if (m) {
        c.score = m.score;
        c.pens = m.pens;
        c.winnerId = m.winnerId;
      }
    }
    // Same advancing rule as the server.
    advance(cells as unknown as Parameters<typeof advance>[0], r);
  }
  return cells;
}

export function Bracket({
  rounds,
  cells,
  seeds,
  nameOf,
  me,
  current,
  onPick,
}: {
  rounds: string[];
  cells: BracketCell[];
  seeds: Record<string, number>;
  nameOf: (id: string) => string;
  me?: string;
  /** Round being played (highlighted). */
  current?: number;
  onPick?: (matchId: string) => void;
}) {
  return (
    <div className="scrollbar-thin -mx-1 overflow-x-auto px-1 pb-1">
      <div className="flex min-w-max gap-3">
        {rounds.map((name, r) => (
          <div key={name} className="flex w-[210px] shrink-0 flex-col">
            <div className={`label mb-2 ${current === r ? '!text-volt' : ''}`}>{name}</div>
            <div className="flex flex-1 flex-col justify-around gap-2">
              {cells
                .filter((c) => c.round === r)
                .map((c) => (
                  <button
                    key={`${c.round}-${c.slot}`}
                    disabled={!c.matchId || !onPick}
                    onClick={() => c.matchId && onPick?.(c.matchId)}
                    className={`rounded-xl border text-left transition ${c.live ? 'border-volt/50 bg-volt/[.06]' : 'border-white/10 bg-white/[.03]'} ${c.matchId && onPick ? 'hover:bg-white/[.07]' : ''}`}
                  >
                    {([0, 1] as const).map((side) => {
                      const id = side === 0 ? c.homeId : c.awayId;
                      const won = !!c.winnerId && id === c.winnerId && !c.bye;
                      const lost = !!c.winnerId && !!id && id !== c.winnerId;
                      return (
                        <div
                          key={side}
                          className={`flex items-center gap-2 px-2.5 py-1.5 text-sm ${side === 0 ? 'border-b border-white/5' : ''} ${lost ? 'opacity-45' : ''}`}
                        >
                          <span className="w-4 text-[10px] font-bold text-dim num">{id ? seeds[id] : ''}</span>
                          <span className={`min-w-0 flex-1 truncate ${won ? 'font-extrabold text-ink' : 'font-semibold'} ${id && id === me ? 'text-volt' : ''}`}>
                            {id ? nameOf(id) : c.bye ? <span className="text-dim">bye</span> : <span className="text-dim">—</span>}
                          </span>
                          {c.score && (
                            <span className={`display text-base font-extrabold num ${won ? 'text-volt' : ''}`}>
                              {c.score[side]}
                              {c.pens && <span className="ml-0.5 text-[10px] text-muted">({c.pens[side]})</span>}
                            </span>
                          )}
                        </div>
                      );
                    })}
                    {c.live && <div className="border-t border-white/5 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-volt">● {c.live}</div>}
                    {c.bye && c.winnerId && <div className="border-t border-white/5 px-2.5 py-1 text-[10px] text-dim">Straight through</div>}
                  </button>
                ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

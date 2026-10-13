import { SCORING_CONFIG, type RankedScore, type ScoreComponent } from './scoring';
import type { PlayerCard, SquadEntry } from './types';

/**
 * Deterministic written analysis of a finished game, built only from the
 * scoring output. It explains the result — it never changes it.
 */

export interface Award {
  key: string;
  emoji: string;
  title: string;
  userId: string;
  playerId?: string;
  detail: string;
}

export interface MatchReport {
  headline: string;
  summary: string;
  awards: Award[];
  verdicts: Record<string, string>;
}

export const COMPONENT_NAMES: Record<ScoreComponent, string> = {
  quality: 'player quality',
  positionFit: 'position fit',
  tactics: 'tactical fit',
  chemistry: 'chemistry',
  balance: 'squad balance',
  depth: 'bench depth',
  efficiency: 'budget efficiency',
};

const LINE_NAMES = { def: 'defence', mid: 'midfield', att: 'attack', gk: 'goalkeeper' } as const;

export function buildMatchReport(
  rankings: RankedScore[],
  managers: { userId: string; username: string; squad: SquadEntry[] }[],
): MatchReport {
  const name = (id: string) => managers.find((m) => m.userId === id)?.username ?? 'A manager';
  const players = new Map<string, PlayerCard>();
  for (const m of managers) for (const e of m.squad) players.set(e.player.id, e.player);
  const pname = (id?: string | null) => (id ? (players.get(id)?.name ?? 'a player') : 'a player');

  const [first, second] = rankings;
  const w = SCORING_CONFIG.weights;

  // --- headline + summary
  let headline = `${name(first.userId)} wins with ${first.total.toFixed(1)}`;
  const sentences: string[] = [];
  if (second) {
    const margin = first.total - second.total;
    headline +=
      margin < 1 ? ` — by a whisker over ${name(second.userId)}` : margin >= 5 ? ' — a commanding victory' : ` ahead of ${name(second.userId)}`;
    // Which weighted component opened the biggest gap between 1st and 2nd?
    const deltas = (Object.keys(w) as ScoreComponent[])
      .map((k) => ({ k, d: w[k] * (first.breakdown[k] - second.breakdown[k]) }))
      .sort((a, b) => b.d - a.d);
    const decisive = deltas[0];
    sentences.push(
      `${name(first.userId)} finished ${margin.toFixed(1)} point${margin.toFixed(1) === '1.0' ? '' : 's'} clear of ${name(second.userId)}` +
        (decisive && decisive.d > 0
          ? `, and the real difference was ${COMPONENT_NAMES[decisive.k]} (${first.breakdown[decisive.k].toFixed(0)} vs ${second.breakdown[decisive.k].toFixed(0)}).`
          : '.'),
    );
    const behind = deltas[deltas.length - 1];
    if (behind && behind.d < -0.5) {
      sentences.push(
        `${name(second.userId)} actually had the better ${COMPONENT_NAMES[behind.k]}, but it wasn’t enough to close the gap.`,
      );
    }
  } else {
    sentences.push(`${name(first.userId)} scored ${first.total.toFixed(1)}.`);
  }

  // Strongest line in the room
  for (const line of ['att', 'mid', 'def'] as const) {
    const best = [...rankings].sort((a, b) => b.lines[line] - a.lines[line])[0];
    if (best.userId === first.userId && rankings.length > 1) {
      sentences.push(`Their ${LINE_NAMES[line]} was the strongest in the room (${best.lines[line].toFixed(1)} role rating).`);
      break;
    }
  }
  const weak = first.notes.find((n) => n.kind === 'weakness');
  if (weak) sentences.push(`Not flawless, though: ${lowerFirst(weak.text)}.`);

  // --- awards (room-wide)
  const awards: Award[] = [];
  const all = managers.flatMap((m) => m.squad.filter((e) => e.via === 'AUCTION').map((e) => ({ m, e })));
  if (all.length) {
    const bargain = [...all].sort((a, b) => b.e.estimatedValue - b.e.price - (a.e.estimatedValue - a.e.price) || a.e.player.id.localeCompare(b.e.player.id))[0];
    if (bargain.e.estimatedValue > bargain.e.price) {
      awards.push({
        key: 'bargain',
        emoji: '🟢',
        title: 'Biggest bargain',
        userId: bargain.m.userId,
        playerId: bargain.e.player.id,
        detail: `${bargain.e.player.name} for ${bargain.e.price} (worth ~${bargain.e.estimatedValue})`,
      });
    }
    const overpay = [...all].sort((a, b) => b.e.price - b.e.estimatedValue - (a.e.price - a.e.estimatedValue) || a.e.player.id.localeCompare(b.e.player.id))[0];
    if (overpay.e.price > overpay.e.estimatedValue) {
      awards.push({
        key: 'overpay',
        emoji: '🔴',
        title: 'Biggest overpay',
        userId: overpay.m.userId,
        playerId: overpay.e.player.id,
        detail: `${overpay.e.player.name} for ${overpay.e.price} (worth ~${overpay.e.estimatedValue})`,
      });
    }
    const dearest = [...all].sort((a, b) => b.e.price - a.e.price || a.e.player.id.localeCompare(b.e.player.id))[0];
    awards.push({
      key: 'record',
      emoji: '💰',
      title: 'Record signing',
      userId: dearest.m.userId,
      playerId: dearest.e.player.id,
      detail: `${dearest.e.player.name} for ${dearest.e.price}`,
    });
  }
  const star = managers
    .flatMap((m) => m.squad.map((e) => ({ m, p: e.player })))
    .sort((a, b) => b.p.overall - a.p.overall || a.p.id.localeCompare(b.p.id))[0];
  if (star) {
    awards.push({ key: 'star', emoji: '⭐', title: 'Best player', userId: star.m.userId, playerId: star.p.id, detail: `${star.p.name} (${star.p.overall} OVR)` });
  }
  const top = (k: ScoreComponent) => [...rankings].sort((a, b) => b.breakdown[k] - a.breakdown[k] || a.rank - b.rank)[0];
  const chem = top('chemistry');
  const strongest = chem.links.filter((l) => l.strength === 'STRONG').length;
  awards.push({
    key: 'chemistry',
    emoji: '🔗',
    title: 'Best chemistry',
    userId: chem.userId,
    detail: `${chem.breakdown.chemistry.toFixed(0)} chemistry · ${strongest} strong link${strongest === 1 ? '' : 's'}`,
  });
  const tac = top('tactics');
  awards.push({ key: 'tactics', emoji: '🧠', title: 'Tactical mastermind', userId: tac.userId, detail: `${tac.breakdown.tactics.toFixed(0)} tactics score` });
  const bench = top('depth');
  awards.push({ key: 'depth', emoji: '🪑', title: 'Deepest bench', userId: bench.userId, detail: `${bench.breakdown.depth.toFixed(0)} depth score` });
  const thrift = [...rankings].sort((a, b) => a.spent - b.spent || a.rank - b.rank)[0];
  awards.push({ key: 'thrift', emoji: '🧾', title: 'Most frugal', userId: thrift.userId, detail: `spent only ${thrift.spent}` });

  // --- one-line verdict per manager
  const verdicts: Record<string, string> = {};
  for (const r of rankings) {
    const comps = (Object.keys(w) as ScoreComponent[]).filter((k) => k !== 'efficiency');
    const best = [...comps].sort((a, b) => r.breakdown[b] - r.breakdown[a])[0];
    const worst = [...comps].sort((a, b) => r.breakdown[a] - r.breakdown[b])[0];
    const weakness = r.notes.find((n) => n.kind === 'weakness');
    verdicts[r.userId] =
      `Best at ${COMPONENT_NAMES[best]} (${r.breakdown[best].toFixed(0)}); ` +
      (weakness ? `weak spot: ${lowerFirst(weakness.text)}.` : `weakest area was ${COMPONENT_NAMES[worst]} (${r.breakdown[worst].toFixed(0)}).`) +
      (r.bestPlayerId ? ` Star man: ${pname(r.bestPlayerId)}.` : '');
  }

  return { headline, summary: sentences.join(' '), awards, verdicts };
}

/** Lower-case a note's first letter to embed it mid-sentence — unless it starts with a name. */
const TEMPLATE_STARTS = ['Thin', 'Lopsided', 'Unbalanced', 'Defensive', 'Pace', 'Midfield', 'Protection', 'Attacking', 'Creativity'];
const lowerFirst = (s: string) => (TEMPLATE_STARTS.some((w) => s.startsWith(w + ' ')) ? s[0].toLowerCase() + s.slice(1) : s);

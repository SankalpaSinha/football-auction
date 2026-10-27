import { cupPlayerLines, type CupSummary } from './cup';
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

/** Optional extra facts from the game (older saved games have none). */
export interface ReportExtras {
  /** How many times each manager lost the top bid to someone else. */
  outbid?: Record<string, number>;
  /** Players taken with a Steal card. */
  steals?: { userId: string; fromId: string; playerId: string; price: number }[];
  cup?: CupSummary | null;
  startingBudget?: number;
}

export const COMPONENT_NAMES: Record<ScoreComponent, string> = {
  quality: 'player quality',
  positionFit: 'position fit',
  tactics: 'tactical fit',
  synergy: 'synergy',
  chemistry: 'chemistry',
  balance: 'squad balance',
  depth: 'bench depth',
  efficiency: 'budget efficiency',
};

/** Older saved games have no value for newer components — read those as 0. */
const comp = (r: RankedScore, k: ScoreComponent) => r.breakdown[k] ?? 0;

const LINE_NAMES = { def: 'defence', mid: 'midfield', att: 'attack', gk: 'goalkeeper' } as const;

export function buildMatchReport(
  rankings: RankedScore[],
  managers: { userId: string; username: string; squad: SquadEntry[] }[],
  extras: ReportExtras = {},
): MatchReport {
  const name = (id: string) => managers.find((m) => m.userId === id)?.username ?? 'A manager';
  const players = new Map<string, PlayerCard>();
  for (const m of managers) for (const e of m.squad) players.set(e.player.id, e.player);
  const pname = (id?: string | null) => (id ? (players.get(id)?.name ?? 'a player') : 'a player');

  const [first, second] = rankings;
  const w = SCORING_CONFIG.weights;
  const cup = extras.cup ?? null;

  // --- headline + summary
  let headline = `${name(first.userId)} wins with ${first.total.toFixed(1)}`;
  const sentences: string[] = [];
  const final = cup?.matches.filter((m) => m.round === cup.rounds.length - 1).at(-1);
  if (cup && final && cup.championId) {
    const champ = cup.championId;
    const other = final.homeId === champ ? final.awayId : final.homeId;
    const [g1, g2] = final.homeId === champ ? final.score : [final.score[1], final.score[0]];
    const pens = final.pens ? (final.homeId === champ ? final.pens : [final.pens[1], final.pens[0]]) : null;
    headline = `🏆 ${name(champ)} lifts the cup — ${g1}–${g2}${pens ? ` (${pens[0]}–${pens[1]} on penalties)` : ''} against ${name(other)} in the final`;
    const bestSquad = [...rankings].sort((a, b) => b.total - a.total)[0];
    if (bestSquad.userId === champ) {
      sentences.push(`The best-built squad (${bestSquad.total.toFixed(1)}) went all the way.`);
    } else {
      const champScore = rankings.find((r) => r.userId === champ);
      sentences.push(
        `${name(bestSquad.userId)} had the strongest squad on paper (${bestSquad.total.toFixed(1)})` +
          (champScore ? `, but ${name(champ)} (${champScore.total.toFixed(1)}) won it on the pitch.` : '.'),
      );
    }
  }
  if (cup) {
    // The cup decides the order: tell the champion's road to the final.
    const champ = cup.championId;
    const path = champ
      ? cup.matches.filter((m) => m.homeId === champ || m.awayId === champ).map((m) => name(m.homeId === champ ? m.awayId : m.homeId))
      : [];
    if (path.length > 1) {
      const before = path.slice(0, -1);
      const list = before.length > 1 ? `${before.slice(0, -1).join(', ')} and ${before.at(-1)}` : before[0];
      sentences.push(`On the way to the final they knocked out ${list}.`);
    }
  } else if (second) {
    const margin = first.total - second.total;
    headline +=
      margin < 1 ? ` — by a whisker over ${name(second.userId)}` : margin >= 5 ? ' — a commanding victory' : ` ahead of ${name(second.userId)}`;
    // Which weighted component opened the biggest gap between 1st and 2nd?
    const deltas = (Object.keys(w) as ScoreComponent[])
      .map((k) => ({ k, d: w[k] * (comp(first, k) - comp(second, k)) }))
      .sort((a, b) => b.d - a.d);
    const decisive = deltas[0];
    sentences.push(
      `${name(first.userId)} finished ${margin.toFixed(1)} point${margin.toFixed(1) === '1.0' ? '' : 's'} clear of ${name(second.userId)}` +
        (decisive && decisive.d > 0
          ? `, and the real difference was ${COMPONENT_NAMES[decisive.k]} (${comp(first, decisive.k).toFixed(0)} vs ${comp(second, decisive.k).toFixed(0)}).`
          : '.'),
    );
    const bonus = (first.objectiveBonus ?? 0) - (second.objectiveBonus ?? 0);
    if (Math.abs(bonus) >= 3) {
      const ahead = bonus > 0 ? first : second;
      const done = (ahead.objectives ?? []).filter((o) => o.done).length;
      const worth = `${done} secret objective${done === 1 ? '' : 's'} (+${ahead.objectiveBonus})`;
      sentences.push(
        ahead === first
          ? `${name(first.userId)}'s ${worth} helped seal it.`
          : `${name(second.userId)} completed ${worth}, but it wasn’t enough.`,
      );
    }
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
  const top = (k: ScoreComponent) => [...rankings].sort((a, b) => comp(b, k) - comp(a, k) || a.rank - b.rank)[0];
  const chem = top('chemistry');
  const strongest = chem.links.filter((l) => l.strength === 'STRONG').length;
  awards.push({
    key: 'chemistry',
    emoji: '🔗',
    title: 'Best chemistry',
    userId: chem.userId,
    detail: `${comp(chem, 'chemistry').toFixed(0)} chemistry · ${strongest} strong link${strongest === 1 ? '' : 's'}`,
  });
  const sys = [...rankings].sort((a, b) => (b.synergies?.length ?? 0) - (a.synergies?.length ?? 0) || a.rank - b.rank)[0];
  if (sys.synergies?.length) {
    awards.push({
      key: 'synergy',
      emoji: '⚙️',
      title: 'Best system',
      userId: sys.userId,
      detail: `${sys.synergies.length} synergy combo${sys.synergies.length === 1 ? '' : 's'}`,
    });
  }
  const tac = top('tactics');
  awards.push({ key: 'tactics', emoji: '🧠', title: 'Tactical mastermind', userId: tac.userId, detail: `${comp(tac, 'tactics').toFixed(0)} tactical fit` });
  const bench = top('depth');
  awards.push({ key: 'depth', emoji: '🪑', title: 'Deepest bench', userId: bench.userId, detail: `${comp(bench, 'depth').toFixed(0)} depth score` });
  const thrift = [...rankings].sort((a, b) => a.spent - b.spent || a.rank - b.rank)[0];
  awards.push({ key: 'thrift', emoji: '🧾', title: 'Most frugal', userId: thrift.userId, detail: `spent only ${thrift.spent}` });

  // --- awards from the auction and the cup
  const outbid = Object.entries(extras.outbid ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (outbid && outbid[1] >= 3) {
    awards.push({ key: 'outbid', emoji: '😤', title: 'Most outbid', userId: outbid[0], detail: `lost the top bid ${outbid[1]} times` });
  }
  const steal = (extras.steals ?? []).slice().sort((a, b) => b.price - a.price)[0];
  if (steal) {
    awards.push({ key: 'thief', emoji: '🦹', title: 'Daylight robbery', userId: steal.userId, playerId: steal.playerId, detail: `stole ${pname(steal.playerId)} from ${name(steal.fromId)} for ${steal.price}` });
  }
  if (cup) {
    const lines = cupPlayerLines(cup);
    const boot = [...lines].sort((a, b) => b[1].goals - a[1].goals || b[1].assists - a[1].assists || a[0].localeCompare(b[0]))[0];
    if (boot && boot[1].goals > 0) {
      awards.push({ key: 'golden_boot', emoji: '👟', title: 'Golden Boot', userId: boot[1].userId, playerId: boot[0], detail: `${pname(boot[0])} · ${boot[1].goals} goal${boot[1].goals === 1 ? '' : 's'}` });
    }
    // Sleeper hit: the cheapest signing who made the biggest difference in the cup.
    const price = new Map<string, number>();
    for (const m of managers) for (const e of m.squad) price.set(e.player.id, e.price);
    const budget = extras.startingBudget ?? 1000;
    const sleeper = [...lines]
      .map(([id, l]) => ({ id, l, impact: l.goals * 3 + l.assists * 2 + l.motm * 3, cost: price.get(id) ?? budget }))
      .filter((x) => x.impact >= 3 && x.cost <= budget * 0.06)
      .sort((a, b) => b.impact / Math.max(1, b.cost) - a.impact / Math.max(1, a.cost) || a.id.localeCompare(b.id))[0];
    if (sleeper) {
      const bits = [sleeper.l.goals && `${sleeper.l.goals}G`, sleeper.l.assists && `${sleeper.l.assists}A`, sleeper.l.motm && `${sleeper.l.motm}× MOTM`].filter(Boolean);
      awards.push({ key: 'sleeper', emoji: '💤', title: 'Sleeper hit', userId: sleeper.l.userId, playerId: sleeper.id, detail: `${pname(sleeper.id)} cost ${sleeper.cost} · ${bits.join(' · ')}` });
    }
  }

  // --- one-line verdict per manager
  const verdicts: Record<string, string> = {};
  for (const r of rankings) {
    const comps = (Object.keys(w) as ScoreComponent[]).filter((k) => k !== 'efficiency' && r.breakdown[k] !== undefined);
    const best = [...comps].sort((a, b) => comp(r, b) - comp(r, a))[0];
    const worst = [...comps].sort((a, b) => comp(r, a) - comp(r, b))[0];
    const weakness = r.notes.find((n) => n.kind === 'weakness');
    verdicts[r.userId] =
      `Best at ${COMPONENT_NAMES[best]} (${comp(r, best).toFixed(0)}); ` +
      (weakness ? `weak spot: ${lowerFirst(weakness.text)}.` : `weakest area was ${COMPONENT_NAMES[worst]} (${comp(r, worst).toFixed(0)}).`) +
      (r.bestPlayerId ? ` Star man: ${pname(r.bestPlayerId)}.` : '');
  }

  return { headline, summary: sentences.join(' '), awards, verdicts };
}

/** Lower-case a note's first letter to embed it mid-sentence — unless it starts with a name. */
const TEMPLATE_STARTS = [
  'Thin', 'Lopsided', 'Unbalanced', 'Defensive', 'Pace', 'Midfield', 'Protection', 'Attacking', 'Creativity',
  'No', 'Only', 'Passing', 'Close', 'Playing', 'Solid', 'Clinical', 'Stamina', 'Pressing', 'Winning', 'Delivery', 'Presence', 'Physicality',
];
const lowerFirst = (s: string) => (TEMPLATE_STARTS.some((w) => s.startsWith(w + ' ')) ? s[0].toLowerCase() + s.slice(1) : s);

import { positionFit, type FitLevel } from './fit';
import { isObjectiveId, OBJECTIVES, type ObjectiveId } from './objectives';
import { isStarPlayer } from './stars';
import { COMBOS, DEFAULT_TACTIC, isTacticId, playstyleOf, TACTICS, type ComboId, type PlaystyleId, type Tactic, type TacticId } from './playstyles';
import { FORMATIONS, resolveFormation, type Formation } from './formations';
import type { LineupInput } from './lineup';
import { POSITION_GROUP, type Position, type PositionGroup } from './positions';
import type { OutfieldStats, PlayerCard, SquadEntry } from './types';

/**
 * Deterministic squad scoring. Same squad + lineup → same score, always.
 * Every number that shapes the result lives in SCORING_CONFIG.
 */

type Attr = keyof OutfieldStats;

export const SCORING_CONFIG = {
  weights: {
    quality: 0.3,
    positionFit: 0.15,
    tactics: 0.15,
    synergy: 0.12,
    chemistry: 0.1,
    balance: 0.08,
    depth: 0.05,
    efficiency: 0.05,
  },
  /** Ratings above `above` count only `factor` per point — stacking superstars has diminishing returns. */
  starSoftening: { above: 83, factor: 0.5 },
  tacticFit: {
    /** Share from the tactic's attribute demands vs from starters whose playstyle suits it. */
    demandShare: 0.6,
    /** Share of the XI playing a liked playstyle that earns full marks. */
    styleTarget: 0.55,
    /** Style score for the Balanced tactic (it likes no playstyle in particular). */
    balancedStyle: 70,
    /** Demand score when the formation has nobody in the positions a tactic relies on. */
    missingDemand: 35,
  },
  synergy: {
    /** Combo points (after the quality factor) that make a perfect 100. */
    target: 15,
    /** A combo's pair averaging this OVR or less gets `minStrength`; `full` or more gets 100%. */
    floor: 65,
    full: 80,
    minStrength: 0.3,
  },
  /** Bonus points per completed secret objective (added on top of the weighted total). */
  objectivePoints: 3,
  /** Maps an average role rating to 0–100: `base` at `anchor`, `slope` points per rating point. */
  ratingScale: { anchor: 70, base: 40, slope: 3 },
  /** How much the overall rating (vs the role-specific attribute mix) counts, by fit. */
  overallBlend: { inPosition: 0.6, outOfPosition: 0.3 },
  roleProfiles: {
    GK: {},
    CB: { defending: 0.45, physical: 0.3, pace: 0.12, passing: 0.08, dribbling: 0.03, shooting: 0.02 },
    LB: { pace: 0.25, defending: 0.3, passing: 0.15, dribbling: 0.12, physical: 0.15, shooting: 0.03 },
    RB: { pace: 0.25, defending: 0.3, passing: 0.15, dribbling: 0.12, physical: 0.15, shooting: 0.03 },
    LWB: { pace: 0.3, defending: 0.2, passing: 0.2, dribbling: 0.15, physical: 0.15 },
    RWB: { pace: 0.3, defending: 0.2, passing: 0.2, dribbling: 0.15, physical: 0.15 },
    CDM: { defending: 0.35, passing: 0.25, physical: 0.25, dribbling: 0.1, pace: 0.05 },
    CM: { passing: 0.35, dribbling: 0.2, defending: 0.15, physical: 0.15, shooting: 0.1, pace: 0.05 },
    CAM: { passing: 0.3, dribbling: 0.3, shooting: 0.25, pace: 0.1, physical: 0.05 },
    LM: { pace: 0.25, dribbling: 0.25, passing: 0.25, shooting: 0.1, defending: 0.1, physical: 0.05 },
    RM: { pace: 0.25, dribbling: 0.25, passing: 0.25, shooting: 0.1, defending: 0.1, physical: 0.05 },
    LW: { pace: 0.3, dribbling: 0.3, shooting: 0.2, passing: 0.15, physical: 0.05 },
    RW: { pace: 0.3, dribbling: 0.3, shooting: 0.2, passing: 0.15, physical: 0.05 },
    CF: { shooting: 0.35, dribbling: 0.25, passing: 0.2, pace: 0.15, physical: 0.05 },
    ST: { shooting: 0.45, pace: 0.2, dribbling: 0.15, physical: 0.15, passing: 0.05 },
  } as Record<Position, Partial<Record<Attr, number>>>,
  goalkeeperProfile: { diving: 0.25, handling: 0.2, reflexes: 0.25, positioning: 0.2, kicking: 0.07, speed: 0.03 },
  chemistry: {
    sameClub: 2,
    sameNation: 1,
    sameLeague: 1,
    maxLinkPoints: 3,
    /** Share of chemistry from links vs players being in position. */
    linkShare: 0.7,
    /** Max pitch distance (in % units, x scaled by pitch width) for two slots to be linked. */
    linkDistance: 27,
  },
  balance: {
    ranges: { GK: [1, 3], DEF: [5, 7], MID: [5, 7], ATT: [3, 6] } as Record<PositionGroup, [number, number]>,
    perPlayerOutside: 8,
    /** Gap between the strongest and weakest outfield line (role rating) tolerated before penalties. */
    lineGapTolerance: 4,
    perGapPoint: 3,
  },
  efficiency: { base: 50, perDoubling: 50 },
  /** Verdict thresholds per component for the written notes. */
  notes: { weak: 65, strong: 88 },
};

export type ScoreComponent = keyof typeof SCORING_CONFIG.weights;

export interface ChemistryLink {
  a: number;
  b: number;
  points: number;
  strength: 'STRONG' | 'MEDIUM' | 'WEAK';
}

export interface ScoreContext {
  tactic?: TacticId;
  /** The manager's secret objectives. */
  objectives?: ObjectiveId[];
  startingBudget?: number;
  /** Coins left at the end of the auction (for budget objectives). */
  budgetLeft?: number;
  /** Players per squad in this game (Blitz squads are smaller). Defaults to 18. */
  squadSize?: number;
}

export interface SynergyHit {
  key: ComboId;
  label: string;
  players: [string, string];
  points: number;
}

export interface SquadScore {
  /** Weighted components + objective bonus. */
  total: number;
  breakdown: Record<ScoreComponent, number>;
  lines: { gk: number; def: number; mid: number; att: number };
  tacticId: TacticId;
  /** The chosen tactic's demands and how well the XI meets them. */
  tactics: { key: string; label: string; score: number; value: number; target: number }[];
  /** Starters playing a playstyle the tactic is built around. */
  styleMatch: { liked: number; of: number };
  synergies: SynergyHit[];
  objectives: { id: ObjectiveId; done: boolean }[];
  objectiveBonus: number;
  links: ChemistryLink[];
  notes: { kind: 'strength' | 'weakness'; text: string }[];
  bestPlayerId: string | null;
  bestBuy: { playerId: string; price: number; value: number } | null;
  worstBuy: { playerId: string; price: number; value: number } | null;
  spent: number;
}

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const round1 = (v: number) => Math.round(v * 10) / 10;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function scaleRating(r: number) {
  const s = SCORING_CONFIG.ratingScale;
  return clamp(s.base + (r - s.anchor) * s.slope);
}

function attr(p: PlayerCard, a: Attr): number {
  // Goalkeepers playing outfield have no outfield stats — treat them as very poor.
  return p.outfield ? p.outfield[a] : 20;
}

/** Above the threshold each rating point is worth less (diminishing returns on stars). */
export function softenRating(r: number) {
  const { above, factor } = SCORING_CONFIG.starSoftening;
  return r <= above ? r : above + (r - above) * factor;
}

/** A starter only brings their playstyle to the team when playing somewhere they can. */
const PLAYS_STYLE: FitLevel[] = ['NATURAL', 'SECONDARY', 'COMPATIBLE'];

/** How good a player is in a specific role (0–99), before position-fit penalties. */
export function roleRating(p: PlayerCard, role: Position): number {
  const fit = positionFit(p, role);
  if (fit.level === 'EXTREME') return p.overall * fit.factor;
  let composite: number;
  if (role === 'GK') {
    const g = p.goalkeeping!;
    const w = SCORING_CONFIG.goalkeeperProfile;
    composite =
      g.diving * w.diving + g.handling * w.handling + g.reflexes * w.reflexes + g.positioning * w.positioning + g.kicking * w.kicking + g.speed * w.speed;
  } else {
    const profile = SCORING_CONFIG.roleProfiles[role];
    let total = 0;
    let weight = 0;
    for (const [k, w] of Object.entries(profile) as [Attr, number][]) {
      total += attr(p, k) * w;
      weight += w;
    }
    composite = weight ? total / weight : p.overall;
  }
  const inPos = fit.level === 'NATURAL' || fit.level === 'SECONDARY';
  const b = inPos ? SCORING_CONFIG.overallBlend.inPosition : SCORING_CONFIG.overallBlend.outOfPosition;
  return b * p.overall + (1 - b) * composite;
}

/** Chemistry links between neighbouring slots, precomputed per formation. */
const LINK_CACHE = new Map<string, [number, number][]>();
export function formationLinks(f: Formation): [number, number][] {
  const cached = LINK_CACHE.get(f.id);
  if (cached) return cached;
  const max = SCORING_CONFIG.chemistry.linkDistance;
  const d = (i: number, j: number) => Math.hypot((f.slots[i].x - f.slots[j].x) * 0.68, f.slots[i].y - f.slots[j].y);
  const pairs = new Set<string>();
  f.slots.forEach((_, i) => {
    const near = f.slots
      .map((_, j) => j)
      .filter((j) => j !== i)
      .sort((a, b) => d(i, a) - d(i, b));
    // Every slot gets at least its two nearest neighbours, plus anything within range.
    near.forEach((j, rank) => {
      if (rank < 2 || d(i, j) <= max) pairs.add(i < j ? `${i}-${j}` : `${j}-${i}`);
    });
  });
  const links = [...pairs].map((k) => k.split('-').map(Number) as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  // Custom formations each get their own entry; keep the cache bounded.
  if (LINK_CACHE.size > 500) LINK_CACHE.clear();
  LINK_CACHE.set(f.id, links);
  return links;
}

export function linkPoints(a: PlayerCard, b: PlayerCard): number {
  const c = SCORING_CONFIG.chemistry;
  let pts = 0;
  if (a.club.id === b.club.id) pts += c.sameClub;
  if (a.nation.code === b.nation.code) pts += c.sameNation;
  if (a.league === b.league) pts += c.sameLeague;
  return Math.min(c.maxLinkPoints, pts);
}

export function chemistryLinks(lineup: LineupInput, byId: Map<string, PlayerCard>): ChemistryLink[] {
  const f = resolveFormation(lineup);
  if (!f) return [];
  return formationLinks(f).flatMap(([a, b]) => {
    const pa = lineup.slots[a] ? byId.get(lineup.slots[a]!) : undefined;
    const pb = lineup.slots[b] ? byId.get(lineup.slots[b]!) : undefined;
    if (!pa || !pb) return [];
    const points = linkPoints(pa, pb);
    return [{ a, b, points, strength: points >= 2 ? 'STRONG' : points === 1 ? 'MEDIUM' : 'WEAK' } as ChemistryLink];
  });
}

/**
 * Score one manager's squad. `squad` is every acquisition (18 by default) (prices included);
 * `lineup` must be complete (11 slots).
 */
export function scoreSquad(squad: SquadEntry[], lineup: LineupInput, ctx: ScoreContext = {}): SquadScore {
  const f = resolveFormation(lineup);
  if (!f) throw new Error(`Unknown formation ${lineup.formationId}`);
  const cfg = SCORING_CONFIG;
  const byId = new Map(squad.map((e) => [e.player.id, e.player]));
  const starters = lineup.slots.map((id, i) => ({ slot: f.slots[i], player: id ? byId.get(id) : undefined }));
  const filled = starters.filter((s): s is { slot: (typeof f.slots)[number]; player: PlayerCard } => !!s.player);
  const benchPlayers = squad.map((e) => e.player).filter((p) => !lineup.slots.includes(p.id));
  const notes: SquadScore['notes'] = [];

  const tacticId: TacticId = isTacticId(ctx.tactic) ? ctx.tactic : isTacticId(lineup.tactic) ? lineup.tactic : DEFAULT_TACTIC;
  const tactic: Tactic = TACTICS[tacticId];

  // --- quality: role-specific rating of each starter (empty slots count as 0), stars softened
  const ratings = starters.map((s) => (s.player ? roleRating(s.player, s.slot.role) : 0));
  const quality = scaleRating(avg(ratings.map(softenRating)));

  // --- position fit
  const fits = starters.map((s) => (s.player ? positionFit(s.player, s.slot.role) : { level: 'EXTREME' as const, factor: 0 }));
  const positionFitScore = clamp(avg(fits.map((x) => x.factor)) * 100);
  starters.forEach((s, i) => {
    if (s.player && (fits[i].level === 'OUT_OF_POSITION' || fits[i].level === 'EXTREME')) {
      notes.push({ kind: 'weakness', text: `${s.player.shortName} is out of position at ${s.slot.role}` });
    }
  });

  // Playstyles the XI actually brings (players out of position don't play their style).
  const styled = starters.map((s, i) =>
    s.player && PLAYS_STYLE.includes(fits[i].level) ? { slot: s.slot, player: s.player, style: playstyleOf(s.player) } : null,
  );

  // --- tactics: the chosen tactic's attribute demands + how many starters suit it
  const tf = cfg.tacticFit;
  const tactics: SquadScore['tactics'] = [];
  tactic.demands.forEach((d, i) => {
    const group = filled.filter((s) => d.roles.includes(s.slot.role));
    if (!group.length) {
      // Balanced adapts to any shape; a specific tactic without its key positions doesn't work.
      if (tacticId === 'BALANCED') return;
      tactics.push({ key: `d${i}`, label: d.label, value: 0, target: d.target, score: tf.missingDemand });
      notes.push({ kind: 'weakness', text: `${tactic.label} needs players for “${d.label.toLowerCase()}” — this formation has none` });
      return;
    }
    const value = avg(group.map((s) => attr(s.player, d.attr)));
    const ratio = Math.min(1, value / d.target);
    tactics.push({ key: `d${i}`, label: d.label, value: round1(value), target: d.target, score: round1(100 * ratio * ratio) });
  });
  const likes = tactic.likes;
  const liked = styled.filter((x) => x && likes.includes(x.style)).length;
  const styleScore = tacticId === 'BALANCED' ? tf.balancedStyle : clamp((100 * liked) / f.slots.length / tf.styleTarget);
  const tacticsScore = clamp(tf.demandShare * avg(tactics.map((t) => t.score)) + (1 - tf.demandShare) * styleScore);

  // --- synergy: playstyles that work together (best pair per combo, weighted by the pair's quality)
  const sc = cfg.synergy;
  const synergies: SynergyHit[] = [];
  for (const [key, combo] of Object.entries(COMBOS) as [ComboId, (typeof COMBOS)[ComboId]][]) {
    let best: { pts: number; a: string; b: string } | null = null;
    for (const x of styled) {
      if (!x || !(combo.a as readonly PlaystyleId[]).includes(x.style)) continue;
      for (const y of styled) {
        if (!y || y === x || !(combo.b as readonly PlaystyleId[]).includes(y.style)) continue;
        if ('sameSide' in combo && combo.sameSide && !sameFlank(x.slot.x, y.slot.x)) continue;
        const pairOvr = (x.player.overall + y.player.overall) / 2;
        const strength = Math.max(sc.minStrength, Math.min(1, (pairOvr - sc.floor) / (sc.full - sc.floor)));
        const pts = combo.points * strength;
        if (!best || pts > best.pts) best = { pts, a: x.player.id, b: y.player.id };
      }
    }
    if (best) synergies.push({ key, label: combo.label, players: [best.a, best.b], points: round1(best.pts) });
  }
  const synergy = clamp((100 * synergies.reduce((t, h) => t + h.points, 0)) / sc.target);

  // --- chemistry
  const links = chemistryLinks(lineup, byId);
  const linkAvg = avg(links.map((l) => l.points)) / cfg.chemistry.maxLinkPoints;
  const chemistry = clamp(100 * (cfg.chemistry.linkShare * linkAvg + (1 - cfg.chemistry.linkShare) * avg(fits.map((x) => x.factor))));

  // --- balance: squad shape + line gaps
  const counts: Record<PositionGroup, number> = { GK: 0, DEF: 0, MID: 0, ATT: 0 };
  for (const e of squad) counts[POSITION_GROUP[e.player.position]]++;
  let balancePenalty = 0;
  for (const [g, range] of Object.entries(cfg.balance.ranges) as [PositionGroup, [number, number]][]) {
    const [lo, hi] = scaledRange(g, range, ctx.squadSize ?? 18);
    const outside = counts[g] < lo ? lo - counts[g] : counts[g] > hi ? counts[g] - hi : 0;
    balancePenalty += outside * cfg.balance.perPlayerOutside;
    if (outside && counts[g] < lo) notes.push({ kind: 'weakness', text: `Thin squad: only ${counts[g]} ${g === 'GK' ? 'goalkeeper' : g.toLowerCase()} option${counts[g] === 1 ? '' : 's'}` });
    if (outside && counts[g] > hi) notes.push({ kind: 'weakness', text: `Lopsided squad: ${counts[g]} ${g === 'GK' ? 'goalkeepers' : g.toLowerCase() + ' players'}` });
  }
  const lineOf = (g: PositionGroup) => avg(starters.filter((s) => s.player && POSITION_GROUP[s.slot.role] === g).map((s) => roleRating(s.player!, s.slot.role)));
  const lines = { gk: round1(lineOf('GK')), def: round1(lineOf('DEF')), mid: round1(lineOf('MID')), att: round1(lineOf('ATT')) };
  const outfieldLines = [lines.def, lines.mid, lines.att].filter((x) => x > 0);
  const gap = outfieldLines.length ? Math.max(...outfieldLines) - Math.min(...outfieldLines) : 0;
  balancePenalty += Math.max(0, gap - cfg.balance.lineGapTolerance) * cfg.balance.perGapPoint;
  if (gap > cfg.balance.lineGapTolerance + 2) {
    const weakest = lines.def === Math.min(...outfieldLines) ? 'defence' : lines.mid === Math.min(...outfieldLines) ? 'midfield' : 'attack';
    notes.push({ kind: 'weakness', text: `Unbalanced XI — the ${weakest} is far weaker than the rest` });
  }
  const balance = clamp(100 - balancePenalty);

  // --- depth: bench quality + cover (squads with no bench at all — Blitz — are all scored the same)
  const benchQuality = scaleRating(avg(benchPlayers.map((p) => p.overall)));
  const benchGroups = new Set(benchPlayers.map((p) => POSITION_GROUP[p.position]));
  const cover = (['GK', 'DEF', 'MID', 'ATT'] as PositionGroup[]).filter((g) => benchGroups.has(g)).length / 4;
  const depth = benchPlayers.length === 0 && (ctx.squadSize ?? 18) <= 11 ? 50 : clamp(0.7 * benchQuality + 30 * cover);

  // --- budget efficiency
  const spent = squad.reduce((s, e) => s + e.price, 0);
  const value = squad.reduce((s, e) => s + e.estimatedValue, 0);
  const ratio = value / Math.max(1, spent);
  const efficiency = clamp(cfg.efficiency.base + cfg.efficiency.perDoubling * Math.log2(ratio));

  const breakdown: Record<ScoreComponent, number> = {
    quality: round1(quality),
    positionFit: round1(positionFitScore),
    tactics: round1(tacticsScore),
    synergy: round1(synergy),
    chemistry: round1(chemistry),
    balance: round1(balance),
    depth: round1(depth),
    efficiency: round1(efficiency),
  };
  // --- secret objectives (bonus points on top)
  const objectiveIds = (ctx.objectives ?? []).filter(isObjectiveId);
  const objectives = objectiveIds.map((id) => ({
    id,
    done: objectiveDone(id, { starters: filled, fits, styled, squad, synergies, tacticsScore, ctx }),
  }));
  const objectiveBonus = objectives.filter((o) => o.done).length * cfg.objectivePoints;

  const total = round1(
    (Object.keys(cfg.weights) as ScoreComponent[]).reduce((s, k) => s + cfg.weights[k] * breakdown[k], 0) + objectiveBonus,
  );

  for (const t of tactics) {
    if (t.value === 0) continue;
    if (t.score < cfg.notes.weak) notes.push({ kind: 'weakness', text: `${t.label} is lacking (${t.value} vs ${t.target} needed)` });
    else if (t.value >= t.target + 3) notes.push({ kind: 'strength', text: `${t.label}: excellent (${t.value})` });
  }
  if (tacticId !== 'BALANCED') {
    if (liked >= 6) notes.push({ kind: 'strength', text: `${liked} starters are made for ${tactic.label}` });
    else if (liked <= 2) notes.push({ kind: 'weakness', text: `Only ${liked} starter${liked === 1 ? '' : 's'} suit${liked === 1 ? 's' : ''} ${tactic.label}` });
  }
  const topCombo = [...synergies].sort((a, b) => b.points - a.points)[0];
  if (synergies.length >= 3 && topCombo) notes.push({ kind: 'strength', text: `${synergies.length} synergy combos, led by ${topCombo.label.toLowerCase()}` });
  else if (synergies.length === 0) notes.push({ kind: 'weakness', text: 'No synergy combos — the XI doesn’t play as a unit' });
  const labels: Record<ScoreComponent, string> = {
    quality: 'Player quality',
    positionFit: 'Everyone in position',
    tactics: 'Tactical fit',
    synergy: 'Synergy',
    chemistry: 'Chemistry',
    balance: 'Squad balance',
    depth: 'Bench depth',
    efficiency: 'Smart spending',
  };
  for (const k of Object.keys(breakdown) as ScoreComponent[]) {
    if (breakdown[k] >= cfg.notes.strong && !['positionFit', 'tactics', 'synergy', 'balance', 'efficiency'].includes(k)) notes.push({ kind: 'strength', text: `${labels[k]} (${breakdown[k]})` });
  }

  let bestPlayerId: string | null = null;
  let bestRating = -1;
  starters.forEach((s, i) => {
    if (s.player && ratings[i] > bestRating) {
      bestRating = ratings[i];
      bestPlayerId = s.player.id;
    }
  });
  const bought = squad.filter((e) => e.via === 'AUCTION');
  const byDelta = [...bought].sort(
    (a, b) => b.estimatedValue - b.price - (a.estimatedValue - a.price) || a.player.id.localeCompare(b.player.id),
  );
  const pack = (e?: SquadEntry) => (e ? { playerId: e.player.id, price: e.price, value: e.estimatedValue } : null);
  const worst = byDelta[byDelta.length - 1];

  return {
    total,
    breakdown,
    lines,
    tacticId,
    tactics,
    styleMatch: { liked, of: f.slots.length },
    synergies,
    objectives,
    objectiveBonus,
    links,
    notes,
    bestPlayerId,
    bestBuy: pack(byDelta[0]),
    worstBuy: worst && worst.price > worst.estimatedValue ? pack(worst) : null,
    spent,
  };
}

/** Balance ranges are written for 18-man squads; smaller squads scale them down. */
function scaledRange(g: PositionGroup, [lo, hi]: [number, number], squadSize: number): [number, number] {
  if (squadSize >= 18) return [lo, hi];
  const k = squadSize / 18;
  const min = g === 'GK' ? 1 : Math.max(1, Math.round(lo * k));
  return [min, Math.max(min, Math.ceil(hi * k))];
}

const sameFlank = (x1: number, x2: number) => (x1 <= 50 && x2 <= 50) || (x1 >= 50 && x2 >= 50);

function objectiveDone(
  id: ObjectiveId,
  d: {
    starters: { slot: { role: Position }; player: PlayerCard }[];
    fits: { level: FitLevel }[];
    styled: ({ style: PlaystyleId } | null)[];
    squad: SquadEntry[];
    synergies: SynergyHit[];
    tacticsScore: number;
    ctx: ScoreContext;
  },
): boolean {
  const xi = d.starters.map((s) => s.player);
  const most = (key: (p: PlayerCard) => string) => {
    const c = new Map<string, number>();
    for (const p of xi) c.set(key(p), (c.get(key(p)) ?? 0) + 1);
    return Math.max(0, ...c.values());
  };
  switch (id) {
    case 'CLUB_TRIO':
      return most((p) => p.club.id) >= 3;
    case 'NATION_FOUR':
      return most((p) => p.nation.code) >= 4;
    case 'YOUTH':
      return xi.length === 11 && avg(xi.map((p) => p.age)) <= 25;
    case 'VETERANS':
      return xi.filter((p) => p.age >= 31).length >= 3;
    case 'FRUGAL':
      return d.ctx.startingBudget !== undefined && d.ctx.budgetLeft !== undefined && d.ctx.budgetLeft >= 0.25 * d.ctx.startingBudget;
    case 'BARGAINS':
      return d.squad.filter((e) => e.via === 'AUCTION' && e.price < 0.5 * e.estimatedValue).length >= 3;
    case 'NO_SUPERSTARS':
      return xi.length === 11 && xi.every((p) => !isStarPlayer(p));
    case 'ALL_IN_POSITION':
      return d.fits.length === 11 && d.fits.every((x) => x.level === 'NATURAL' || x.level === 'SECONDARY');
    case 'COMBOS':
      return d.synergies.length >= 3;
    case 'TACTIC_FIT':
      // Same rounding as the displayed value.
      return round1(d.tacticsScore) >= 85;
    case 'LEFT_FOOTERS':
      return xi.filter((p) => p.preferredFoot === 'Left').length >= 3;
    case 'VARIETY':
      return new Set(xi.map((p) => playstyleOf(p))).size >= 8;
  }
}

/** Objective label lookup (for UIs). */
export const objectiveText = (id: ObjectiveId) => OBJECTIVES[id].text;

export interface RankedScore extends SquadScore {
  userId: string;
  /** Final position (after the cup, when one was played). */
  rank: number;
  /** Position by squad score alone (the cup seed). */
  squadRank?: number;
  /** How far they got in the cup ("Champion", "Semi-finalist"…). */
  cupFinish?: string;
}

/** Rank managers. Ties: higher quality, then position fit, then fewer coins spent, then user id. */
export function rankScores(scores: { userId: string; score: SquadScore }[]): RankedScore[] {
  const sorted = [...scores].sort(
    (a, b) =>
      b.score.total - a.score.total ||
      b.score.breakdown.quality - a.score.breakdown.quality ||
      b.score.breakdown.positionFit - a.score.breakdown.positionFit ||
      a.score.spent - b.score.spent ||
      a.userId.localeCompare(b.userId),
  );
  return sorted.map((s, i) => ({ ...s.score, userId: s.userId, rank: i + 1 }));
}

// Warm the link cache so the first evaluation is not special.
for (const f of FORMATIONS) formationLinks(f);

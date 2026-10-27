import { playstyleOf, TACTICS, type PlaystyleId, type TacticId } from './playstyles';
import type { Position } from './positions';
import type { SquadScore } from './scoring';
import type { MatchEvent, PlayerCard, Shout, TeamTalk } from './types';

/**
 * Match engine for the cup. A match is played minute by minute from the two
 * squads' scores, so the better-built squad (fit, tactics and synergy, not just
 * big names) is the favourite — but football happens: a weaker side can win.
 *
 * Everything is driven by a seeded 0–1 random source, so the server can replay
 * a match exactly. Live inputs (team talks, touchline shouts) change the odds
 * for the minutes that follow.
 */

export const MATCH_CONFIG = {
  /** Goals per team per 90 minutes when two equal sides meet. */
  baseGoals: 1.3,
  /** Per point of squad-score difference (log scale). 10 points ≈ ×1.7 goals. */
  powerWeight: 0.055,
  /** Per rating point of attack-vs-defence and midfield edges (log scale). */
  lineWeight: 0.02,
  minGoals: 0.2,
  maxGoals: 4.5,
  /** Non-goal chances per goal (saves, misses, woodwork). */
  chancesPerGoal: 2.2,
  yellowsPerTeam: 1.5,
  redsPerTeam: 0.03,
  pensPerTeam: 0.11,
  penConversion: 0.78,
  assistedShare: 0.78,
  /** Effect of a red card on the side that got it / their opponent. */
  redCard: { own: 0.68, opp: 1.22 },
  talks: {
    ATTACK: { own: 1.28, opp: 1.15 },
    CALM: { own: 1, opp: 1 },
    TIGHT: { own: 0.78, opp: 0.7 },
  } satisfies Record<TeamTalk, { own: number; opp: number }>,
  shouts: {
    ALL_OUT: { own: 1.5, opp: 1.3 },
    PARK_IT: { own: 0.5, opp: 0.45 },
  } satisfies Record<Shout, { own: number; opp: number }>,
  /** Match minutes a shout lasts. */
  shoutMinutes: 15,
  /** Extra-time legs are tired legs. */
  extraTimeFactor: 0.85,
};

export const TEAM_TALKS: Record<TeamTalk, { label: string; emoji: string; blurb: string }> = {
  ATTACK: { label: 'Go for it', emoji: '⚔️', blurb: 'More goals at both ends.' },
  CALM: { label: 'Keep calm', emoji: '🧘', blurb: 'Carry on as you are.' },
  TIGHT: { label: 'Keep it tight', emoji: '🧱', blurb: 'Fewer goals at both ends.' },
};

export const SHOUTS: Record<Shout, { label: string; emoji: string; blurb: string }> = {
  ALL_OUT: { label: 'All-out attack', emoji: '📢', blurb: 'For 15 minutes: throw everyone forward.' },
  PARK_IT: { label: 'Park it', emoji: '🚌', blurb: 'For 15 minutes: everyone behind the ball.' },
};

/** Style of play: own goals × and opponent goals × (every match). */
const STYLE: Partial<Record<TacticId, { own: number; opp: number; possession: number }>> = {
  TIKI_TAKA: { own: 1, opp: 0.96, possession: 9 },
  HIGH_PRESS: { own: 1.08, opp: 1.05, possession: 3 },
  COUNTER_ATTACK: { own: 1, opp: 0.97, possession: -7 },
  WING_PLAY: { own: 1.03, opp: 1.02, possession: 0 },
  PARK_THE_BUS: { own: 0.8, opp: 0.8, possession: -11 },
};

/** Rock-paper-scissors between tactics: the attacker's goals × against that defending tactic. */
const EDGES: { a: TacticId; b: TacticId; factor: number; text: string }[] = [
  { a: 'COUNTER_ATTACK', b: 'HIGH_PRESS', factor: 1.2, text: 'Counter-Attack hits the High Press on the break' },
  { a: 'COUNTER_ATTACK', b: 'TIKI_TAKA', factor: 1.1, text: 'Counter-Attack feeds on Tiki-Taka’s high line' },
  { a: 'HIGH_PRESS', b: 'TIKI_TAKA', factor: 1.16, text: 'The High Press forces Tiki-Taka into mistakes' },
  { a: 'TIKI_TAKA', b: 'PARK_THE_BUS', factor: 1.18, text: 'Tiki-Taka patiently picks the lock of the bus' },
  { a: 'WING_PLAY', b: 'PARK_THE_BUS', factor: 1.14, text: 'Wing Play goes round the packed box' },
  { a: 'WING_PLAY', b: 'HIGH_PRESS', factor: 1.1, text: 'Wing Play goes round the press' },
  { a: 'HIGH_PRESS', b: 'WING_PLAY', factor: 0.92, text: '' },
  { a: 'COUNTER_ATTACK', b: 'PARK_THE_BUS', factor: 0.85, text: 'Nothing to counter against the bus' },
];

export interface CupTeam {
  userId: string;
  name: string;
  seed: number;
  score: Pick<SquadScore, 'total' | 'lines' | 'tacticId'>;
  formationId: string;
  /** The starting XI with the role each one plays. */
  xi: { player: PlayerCard; role: Position }[];
}

export interface SideMods {
  talk: TeamTalk | null;
  /** Active shout and the minute it runs until. */
  shout: { id: Shout; until: number } | null;
}

export interface SideStats {
  shots: number;
  onTarget: number;
  xg: number;
  saves: number;
  yellow: number;
  red: number;
}

interface PlayerLine {
  goals: number;
  assists: number;
  saves: number;
  yellow: number;
  red: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

const SCORE_WEIGHT: Record<Position, number> = {
  ST: 1, CF: 0.9, LW: 0.62, RW: 0.62, CAM: 0.5, LM: 0.32, RM: 0.32, CM: 0.24, CDM: 0.1,
  LWB: 0.12, RWB: 0.12, LB: 0.08, RB: 0.08, CB: 0.1, GK: 0,
};
const ASSIST_WEIGHT: Record<Position, number> = {
  CAM: 1, LW: 0.8, RW: 0.8, CM: 0.75, LM: 0.75, RM: 0.75, LWB: 0.55, RWB: 0.55, LB: 0.5, RB: 0.5,
  ST: 0.45, CF: 0.55, CDM: 0.35, CB: 0.12, GK: 0.03,
};
const CARD_WEIGHT: Record<Position, number> = {
  CB: 1, CDM: 1.1, LB: 0.8, RB: 0.8, LWB: 0.7, RWB: 0.7, CM: 0.8, LM: 0.5, RM: 0.5, CAM: 0.45,
  LW: 0.35, RW: 0.35, ST: 0.45, CF: 0.4, GK: 0.08,
};

/** How a goal by this kind of player reads. */
const GOAL_LINES: Partial<Record<PlaystyleId, string[]>> = {
  TARGET_MAN: ['rises highest and heads it in', 'bullies his marker and powers a header home'],
  POACHER: ['pounces from close range', 'is in the right place again — tap-in'],
  PACE_FORWARD: ['races clear and slots it home', 'leaves the defence for dead and finishes'],
  FALSE_NINE: ['drops deep, plays a one-two and finishes', 'drifts into space and passes it into the net'],
  INSIDE_FORWARD: ['cuts inside and curls it into the far corner', 'jinks past two and bends it in'],
  SHADOW_STRIKER: ['arrives late in the box and fires in', 'ghosts in unmarked and buries it'],
  WIDE_CROSSER: ['sneaks in at the back post', 'finishes off a lovely team move'],
  ADVANCED_PLAYMAKER: ['threads through and finishes calmly', 'dances through and chips the keeper'],
  BOX_TO_BOX: ['drives forward and smashes it in', 'bursts into the box and finishes low'],
  DEEP_PLAYMAKER: ['lets fly from 25 yards — what a strike!', 'curls in a free kick'],
  BALL_WINNER: ['wins it high up and smashes it home', 'thumps one in from distance'],
  STOPPER: ['heads in from a corner', 'bundles it over the line from a set piece'],
  BALL_PLAYING_DEFENDER: ['steps up and drills one in from the edge', 'heads home a corner'],
  OVERLAPPING_FULLBACK: ['overlaps and finishes at the near post', 'gallops forward and scores!'],
  DEFENSIVE_FULLBACK: ['scores a rare one from a set piece', 'pokes it in after a goalmouth scramble'],
};

export function tacticalEdges(home: TacticId, away: TacticId): { factor: [number, number]; notes: string[] } {
  const factor: [number, number] = [1, 1];
  const notes: string[] = [];
  for (const e of EDGES) {
    if (e.a === home && e.b === away) {
      factor[0] *= e.factor;
      if (e.text) notes.push(e.text);
    }
    if (e.a === away && e.b === home) {
      factor[1] *= e.factor;
      if (e.text) notes.push(e.text);
    }
  }
  return { factor, notes };
}

/** Expected goals for each side over 90 minutes, before live modifiers. */
export function expectedGoals(home: CupTeam, away: CupTeam): [number, number] {
  const c = MATCH_CONFIG;
  const { factor } = tacticalEdges(home.score.tacticId, away.score.tacticId);
  const one = (a: CupTeam, b: CupTeam, edge: number) => {
    const diff = a.score.total - b.score.total;
    const lines = (a.score.lines.att - b.score.lines.def) * 0.5 + (a.score.lines.mid - b.score.lines.mid) * 0.25;
    const style = (STYLE[a.score.tacticId]?.own ?? 1) * (STYLE[b.score.tacticId]?.opp ?? 1);
    return clamp(c.baseGoals * Math.exp(c.powerWeight * diff + c.lineWeight * lines) * style * edge, c.minGoals, c.maxGoals);
  };
  return [one(home, away, factor[0]), one(away, home, factor[1])];
}

/** Share of the ball the home side has (percent). */
export function expectedPossession(home: CupTeam, away: CupTeam): number {
  const p = 50 + (home.score.lines.mid - away.score.lines.mid) * 1.2 + (STYLE[home.score.tacticId]?.possession ?? 0) - (STYLE[away.score.tacticId]?.possession ?? 0);
  return Math.round(clamp(p, 28, 72));
}

/**
 * One match. Call playMinutes() for each stretch of the game in order; the
 * server decides when (and passes the live team talks and shouts).
 */
export class MatchSim {
  readonly teams: [CupTeam, CupTeam];
  goals: [number, number] = [0, 0];
  pens: [number, number] | null = null;
  readonly stats: [SideStats, SideStats];
  readonly events: MatchEvent[] = [];
  /** One value per 5 minutes, -1 (away on top) … 1 (home on top). */
  readonly momentum: number[] = [];
  readonly possession: number;
  readonly edges: string[];
  readonly shootout: { side: 0 | 1; playerId: string; scored: boolean }[] = [];
  minute = 0;
  private readonly base: [number, number];
  private readonly lines = new Map<string, PlayerLine>();
  private readonly off = new Set<string>();
  private reds: [number, number] = [0, 0];
  private window = 0;
  private htScore: [number, number] | null = null;

  constructor(
    home: CupTeam,
    away: CupTeam,
    private readonly rand: () => number,
  ) {
    this.teams = [home, away];
    this.base = expectedGoals(home, away);
    this.possession = expectedPossession(home, away);
    this.edges = tacticalEdges(home.score.tacticId, away.score.tacticId).notes;
    const z = (): SideStats => ({ shots: 0, onTarget: 0, xg: 0, saves: 0, yellow: 0, red: 0 });
    this.stats = [z(), z()];
    for (const t of this.teams) for (const s of t.xi) this.lines.set(s.player.id, { goals: 0, assists: 0, saves: 0, yellow: 0, red: false });
  }

  get halfTimeScore() {
    return this.htScore;
  }

  /** Expected goals per 90 for each side right now, with every live modifier. */
  rates(mods: [SideMods, SideMods], extraTime = false): [number, number] {
    const c = MATCH_CONFIG;
    const r: [number, number] = [this.base[0], this.base[1]];
    for (const side of [0, 1] as const) {
      const other = (1 - side) as 0 | 1;
      const talk = mods[side].talk;
      if (talk && this.minute >= 45) {
        r[side] *= c.talks[talk].own;
        r[other] *= c.talks[talk].opp;
      }
      const shout = mods[side].shout;
      if (shout && this.minute < shout.until) {
        r[side] *= c.shouts[shout.id].own;
        r[other] *= c.shouts[shout.id].opp;
      }
      for (let i = 0; i < this.reds[side]; i++) {
        r[side] *= c.redCard.own;
        r[other] *= c.redCard.opp;
      }
    }
    // The side behind late on throws men forward.
    if (this.minute >= 70 && this.goals[0] !== this.goals[1]) {
      const behind = this.goals[0] < this.goals[1] ? 0 : 1;
      r[behind] *= 1.18;
      r[1 - behind] *= 1.06;
    }
    if (extraTime) {
      r[0] *= c.extraTimeFactor;
      r[1] *= c.extraTimeFactor;
    }
    return r;
  }

  /** Play minutes (minute, to]. Returns the events that happened. */
  playMinutes(to: number, mods: [SideMods, SideMods], extraTime = false): MatchEvent[] {
    const c = MATCH_CONFIG;
    const out: MatchEvent[] = [];
    while (this.minute < to) {
      this.minute++;
      const m = this.minute;
      const r = this.rates(mods, extraTime);
      for (const side of [0, 1] as const) {
        const perMin = r[side] / 90;
        const roll = this.rand();
        if (roll < perMin * (1 - c.pensPerTeam / Math.max(0.5, r[side]))) {
          out.push(this.goal(side, m));
        } else if (roll < perMin) {
          out.push(...this.penalty(side, m));
        } else if (roll < perMin * (1 + c.chancesPerGoal)) {
          out.push(this.chance(side, m));
        }
        const cardRoll = this.rand();
        const press = this.teams[side].score.tacticId === 'HIGH_PRESS' ? 1.3 : this.teams[side].score.tacticId === 'PARK_THE_BUS' ? 1.2 : 1;
        if (cardRoll < (c.redsPerTeam / 90) * press) out.push(this.card(side, m, true));
        else if (cardRoll < ((c.redsPerTeam + c.yellowsPerTeam) / 90) * press) out.push(this.card(side, m, false));
      }
      if (m === 45) this.htScore = [...this.goals];
      this.trackMomentum(r, out);
    }
    this.events.push(...out);
    return out;
  }

  private trackMomentum(r: [number, number], recent: MatchEvent[]) {
    if (this.minute % 5 !== 0) return;
    const fresh = recent.filter((e) => e.minute > this.minute - 5);
    let v = (r[0] - r[1]) / (r[0] + r[1]) + (this.possession - 50) / 80;
    for (const e of fresh) {
      if (e.side === null) continue;
      const sign = e.side === 0 ? 1 : -1;
      if (e.kind === 'GOAL' || e.kind === 'PEN_GOAL') v += 0.45 * sign;
      else if (e.kind === 'CHANCE' || e.kind === 'WOODWORK' || e.kind === 'SAVE') v += 0.15 * sign;
      else if (e.kind === 'RED') v -= 0.3 * sign;
    }
    v += (this.rand() - 0.5) * 0.3;
    this.momentum.push(round2(clamp(v, -1, 1)));
  }

  private onPitch(side: 0 | 1) {
    return this.teams[side].xi.filter((s) => !this.off.has(s.player.id));
  }

  private keeper(side: 0 | 1) {
    return this.onPitch(side).find((s) => s.role === 'GK')?.player ?? this.onPitch(side)[0]?.player;
  }

  private pickWeighted<T>(items: T[], weight: (t: T) => number): T | undefined {
    const ws = items.map((t) => Math.max(0, weight(t)));
    const total = ws.reduce((a, b) => a + b, 0);
    if (total <= 0) return items[0];
    let x = this.rand() * total;
    for (let i = 0; i < items.length; i++) {
      x -= ws[i];
      if (x <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  private shooter(side: 0 | 1, exclude?: string) {
    const pool = this.onPitch(side).filter((s) => s.player.id !== exclude);
    return this.pickWeighted(pool, (s) => SCORE_WEIGHT[s.role] * Math.pow((s.player.outfield?.shooting ?? 25) / 75, 3))!.player;
  }

  private assister(side: 0 | 1, scorer: string) {
    const pool = this.onPitch(side).filter((s) => s.player.id !== scorer);
    return this.pickWeighted(pool, (s) => ASSIST_WEIGHT[s.role] * Math.pow((s.player.outfield?.passing ?? 40) / 75, 2))?.player;
  }

  private goal(side: 0 | 1, minute: number): MatchEvent {
    const scorer = this.shooter(side);
    const assisted = this.rand() < MATCH_CONFIG.assistedShare;
    const assist = assisted ? this.assister(side, scorer.id) : undefined;
    this.goals[side]++;
    this.stats[side].shots++;
    this.stats[side].onTarget++;
    const xg = round2(0.15 + this.rand() * 0.55);
    this.stats[side].xg += xg;
    this.lines.get(scorer.id)!.goals++;
    if (assist) this.lines.get(assist.id)!.assists++;
    const options = GOAL_LINES[playstyleOf(scorer)] ?? ['finishes well'];
    const how = options[Math.floor(this.rand() * options.length)];
    return {
      minute,
      side,
      kind: 'GOAL',
      playerId: scorer.id,
      assistId: assist?.id,
      text: `GOAL! ${scorer.shortName} ${how}${assist ? ` (${assist.shortName} with the assist)` : ''}`,
      score: [...this.goals],
      xg,
      onTarget: true,
    };
  }

  private penalty(side: 0 | 1, minute: number): MatchEvent[] {
    const taker = [...this.onPitch(side)].sort((a, b) => (b.player.outfield?.shooting ?? 0) - (a.player.outfield?.shooting ?? 0))[0].player;
    const gk = this.keeper((1 - side) as 0 | 1);
    this.stats[side].shots++;
    this.stats[side].xg += 0.76;
    if (this.rand() < MATCH_CONFIG.penConversion) {
      this.goals[side]++;
      this.stats[side].onTarget++;
      this.lines.get(taker.id)!.goals++;
      return [
        { minute, side, kind: 'PEN_GOAL', playerId: taker.id, text: `PENALTY… scored! ${taker.shortName} sends the keeper the wrong way`, score: [...this.goals], xg: 0.76, onTarget: true },
      ];
    }
    const saved = this.rand() < 0.6;
    if (saved && gk) {
      this.stats[side].onTarget++;
      this.stats[(1 - side) as 0 | 1].saves++;
      this.lines.get(gk.id)!.saves++;
    }
    return [
      {
        minute,
        side,
        kind: 'PEN_MISS',
        playerId: taker.id,
        text: saved && gk ? `PENALTY… saved! ${gk.shortName} denies ${taker.shortName}` : `PENALTY… missed! ${taker.shortName} blazes it over`,
        score: [...this.goals],
        xg: 0.76,
        onTarget: !!(saved && gk),
      },
    ];
  }

  private chance(side: 0 | 1, minute: number): MatchEvent {
    const who = this.shooter(side);
    const gk = this.keeper((1 - side) as 0 | 1);
    const x = this.rand();
    this.stats[side].shots++;
    if (x < 0.55 && gk) {
      const xg = round2(0.08 + this.rand() * 0.25);
      this.stats[side].onTarget++;
      this.stats[side].xg += xg;
      this.stats[(1 - side) as 0 | 1].saves++;
      this.lines.get(gk.id)!.saves++;
      const lines = [`Great save! ${gk.shortName} keeps out ${who.shortName}`, `${gk.shortName} tips ${who.shortName}’s shot round the post`];
      return { minute, side, kind: 'SAVE', playerId: who.id, text: lines[Math.floor(this.rand() * lines.length)], score: [...this.goals], xg, onTarget: true };
    }
    if (x < 0.62) {
      const xg = round2(0.2 + this.rand() * 0.2);
      this.stats[side].xg += xg;
      return { minute, side, kind: 'WOODWORK', playerId: who.id, text: `Off the woodwork! ${who.shortName} so close`, score: [...this.goals], xg, onTarget: false };
    }
    const xg = round2(0.04 + this.rand() * 0.3);
    this.stats[side].xg += xg;
    const lines = [`${who.shortName} fires just wide`, `${who.shortName} skies it from a good position`, `Chance! ${who.shortName}’s effort is blocked`];
    return { minute, side, kind: 'CHANCE', playerId: who.id, text: lines[Math.floor(this.rand() * lines.length)], score: [...this.goals], xg, onTarget: false };
  }

  private card(side: 0 | 1, minute: number, straightRed: boolean): MatchEvent {
    const outfield = this.onPitch(side).filter((s) => s.role !== 'GK' || this.onPitch(side).length === 1);
    // Booked players usually calm down: most cards go to someone not yet on a yellow.
    const unbooked = outfield.filter((s) => this.lines.get(s.player.id)!.yellow === 0);
    const pool = !straightRed && unbooked.length && this.rand() < 0.8 ? unbooked : outfield;
    const who = this.pickWeighted(pool, (s) => CARD_WEIGHT[s.role] * ((s.player.outfield?.physical ?? 60) + (s.player.outfield?.defending ?? 50)) / 140)!.player;
    const line = this.lines.get(who.id)!;
    line.yellow++;
    const red = straightRed || line.yellow >= 2;
    if (!red) {
      this.stats[side].yellow++;
      return { minute, side, kind: 'YELLOW', playerId: who.id, text: `🟨 ${who.shortName} is booked`, score: [...this.goals] };
    }
    line.red = true;
    this.off.add(who.id);
    this.reds[side]++;
    this.stats[side].red++;
    return {
      minute,
      side,
      kind: 'RED',
      playerId: who.id,
      text: straightRed ? `🟥 RED CARD! ${who.shortName} is sent off` : `🟥 Second yellow — ${who.shortName} is off!`,
      score: [...this.goals],
    };
  }

  /** Note a team talk or shout in the match log. */
  note(side: 0 | 1, kind: 'TALK' | 'SHOUT', text: string): MatchEvent {
    const e: MatchEvent = { minute: this.minute, side, kind, text, score: [...this.goals] };
    this.events.push(e);
    return e;
  }

  // ------------------------------------------------------------ shootout

  /** Takers in order: best finishers first, the keeper last. */
  private takers(side: 0 | 1) {
    return [...this.onPitch(side)].sort(
      (a, b) => (a.role === 'GK' ? 1 : 0) - (b.role === 'GK' ? 1 : 0) || (b.player.outfield?.shooting ?? 30) - (a.player.outfield?.shooting ?? 30),
    );
  }

  /** Take the next kick of the shootout. Returns the kick, or null when it's decided. */
  nextKick(): { side: 0 | 1; playerId: string; scored: boolean } | null {
    if (this.shootoutWinner() !== null) return null;
    this.pens ??= [0, 0];
    const side: 0 | 1 = this.shootout.length % 2 === 0 ? 0 : 1;
    const taken = this.shootout.filter((k) => k.side === side).length;
    const order = this.takers(side);
    const taker = order[taken % order.length].player;
    const gk = this.keeper((1 - side) as 0 | 1);
    const shooting = taker.outfield?.shooting ?? 40;
    const keeping = gk?.goalkeeping ? (gk.goalkeeping.diving + gk.goalkeeping.reflexes) / 2 : 60;
    const p = clamp(0.63 + (shooting - 70) * 0.007 - (keeping - 75) * 0.004, 0.5, 0.9);
    const scored = this.rand() < p;
    if (scored) this.pens[side]++;
    else if (gk) this.lines.get(gk.id)!.saves++;
    const kick = { side, playerId: taker.id, scored };
    this.shootout.push(kick);
    return kick;
  }

  /** Who won the shootout (or null while it's still going). */
  shootoutWinner(): 0 | 1 | null {
    if (!this.pens) return null;
    const [h, a] = this.pens;
    const kh = this.shootout.filter((k) => k.side === 0).length;
    const ka = this.shootout.filter((k) => k.side === 1).length;
    if (kh <= 5 && ka <= 5) {
      if (h > a + (5 - ka)) return 0;
      if (a > h + (5 - kh)) return 1;
      if (kh === 5 && ka === 5 && h !== a) return h > a ? 0 : 1;
      return null;
    }
    // Sudden death: after both have taken the same number.
    if (kh === ka && h !== a) return h > a ? 0 : 1;
    return null;
  }

  winnerSide(): 0 | 1 | null {
    if (this.goals[0] !== this.goals[1]) return this.goals[0] > this.goals[1] ? 0 : 1;
    return this.shootoutWinner();
  }

  /** Man of the match: goals, assists and saves, with a nudge for the winners and clean sheets. */
  motm(): string | null {
    const win = this.winnerSide();
    let best: { id: string; v: number } | null = null;
    this.teams.forEach((t, side) => {
      const conceded = this.goals[1 - side];
      for (const s of t.xi) {
        const l = this.lines.get(s.player.id)!;
        let v = 6 + l.goals * 1.3 + l.assists * 0.8 + l.saves * 0.25 - (l.red ? 2 : 0) - l.yellow * 0.2 + s.player.overall / 100;
        if (conceded === 0 && (s.role === 'GK' || ['CB', 'LB', 'RB', 'LWB', 'RWB'].includes(s.role))) v += 0.6;
        if (win === side) v += 0.4;
        if (!best || v > best.v) best = { id: s.player.id, v };
      }
    });
    return (best as { id: string; v: number } | null)?.id ?? null;
  }

  /** Per-player contributions (for the golden boot and awards). */
  playerLines(): Map<string, PlayerLine> {
    return this.lines;
  }

  sideStats(side: 0 | 1) {
    const s = this.stats[side];
    return {
      shots: s.shots,
      onTarget: s.onTarget,
      possession: side === 0 ? this.possession : 100 - this.possession,
      xg: round2(s.xg),
      saves: s.saves,
      yellow: s.yellow,
      red: s.red,
    };
  }
}

/** One line describing each side's tactic for the pre-match card. */
export const tacticLabel = (id: TacticId) => TACTICS[id]?.label ?? 'Balanced';

/** Live match stats from the events shown so far (both the server view and the client use this). */
export function statsFromEvents(events: MatchEvent[], side: 0 | 1, possession: number) {
  let shots = 0;
  let onTarget = 0;
  let xg = 0;
  let saves = 0;
  let yellow = 0;
  let red = 0;
  for (const e of events) {
    if (e.side === side) {
      if (e.xg !== undefined) {
        shots++;
        xg += e.xg;
        if (e.onTarget) onTarget++;
      }
      if (e.kind === 'YELLOW') yellow++;
      if (e.kind === 'RED') red++;
    } else if (e.side !== null && (e.kind === 'SAVE' || (e.kind === 'PEN_MISS' && e.onTarget))) {
      saves++;
    }
  }
  return { shots, onTarget, possession: side === 0 ? possession : 100 - possession, xg: round2(xg), saves, yellow, red };
}

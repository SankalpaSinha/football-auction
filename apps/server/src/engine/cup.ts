import {
  advance,
  buildBracket,
  cupFinish,
  cupPlacements,
  MatchSim,
  roundNames,
  SHOUTS,
  statsFromEvents,
  TEAM_TALKS,
  MATCH_CONFIG,
  type BracketSlotView,
  type CupSummary,
  type CupTeam,
  type GameEvent,
  type GameRules,
  type MatchEvent,
  type MatchStatus,
  type MatchView,
  type Shout,
  type SideMods,
  type TeamTalk,
  type TournamentView,
} from '@fa/shared';
import type { Clock, TimerHandle } from './clock';
import { fail } from './errors';
import { createRng } from './rng';

export interface CupHooks {
  onChange(): void;
  onEvent(e: GameEvent): void;
  onFeed(text: string, userId?: string): void;
  /** The trophy has been lifted. */
  onFinish(summary: CupSummary): void;
}

export interface CupOptions {
  /** Best squad first (seed 1). */
  teams: CupTeam[];
  rules: GameRules;
  clock: Clock;
  seed: string;
  /** Connected and looking at the game (half-time waits for nobody else). */
  isPresent(userId: string): boolean;
  hooks: CupHooks;
}

/** Match minutes simulated per step (the engine runs one step ahead of what's shown). */
const BLOCK = 5;
/** After both managers have picked a team talk, the second half starts this soon. */
const TALKS_IN_MS = 1_500;

class LiveMatch {
  status: MatchStatus = 'SCHEDULED';
  readonly sim: MatchSim;
  readonly mods: [SideMods, SideMods] = [
    { talk: null, shout: null },
    { talk: null, shout: null },
  ];
  readonly shoutsLeft: [Set<Shout>, Set<Shout>] = [new Set(['ALL_OUT', 'PARK_IT']), new Set(['ALL_OUT', 'PARK_IT'])];
  /** Every simulated event with the time it is shown. */
  readonly timeline: MatchEvent[] = [];
  readonly momentum: { at: number; v: number }[] = [];
  readonly kicks: { side: 0 | 1; playerId: string; scored: boolean; at: number }[] = [];
  clock: MatchView['clock'] = null;
  halfTimeEndsAt: number | null = null;
  winnerId: string | null = null;
  motm: string | null = null;
  timer: TimerHandle | null = null;

  constructor(
    readonly id: string,
    readonly round: number,
    readonly slot: number,
    readonly home: CupTeam,
    readonly away: CupTeam,
    rand: () => number,
  ) {
    this.sim = new MatchSim(home, away, rand);
  }

  sideOf(userId: string): 0 | 1 | null {
    return this.home.userId === userId ? 0 : this.away.userId === userId ? 1 : null;
  }

  get live() {
    return this.status === 'FIRST_HALF' || this.status === 'SECOND_HALF' || this.status === 'EXTRA_TIME';
  }
}

/**
 * The cup after the squad builder: a knockout bracket seeded by squad score.
 * Every match of a round kicks off together and is played in real time
 * (about 18 seconds a half) with half-time team talks, touchline shouts,
 * extra time and penalties.
 */
export class Cup {
  private readonly rules: GameRules;
  private readonly clock: Clock;
  private readonly hooks: CupHooks;
  private readonly teams = new Map<string, CupTeam>();
  private readonly seeds: Record<string, number> = {};
  private readonly bracket: BracketSlotView[];
  private readonly rounds: string[];
  private readonly matches: LiveMatch[] = [];
  private currentRound = -1;
  private nextKickoffAt: number | null = null;
  private championId: string | null = null;
  private timers = new Set<{ handle: TimerHandle; at: number; fn: () => void }>();
  private instant = false;
  private finished = false;
  private disposed = false;

  constructor(private readonly opts: CupOptions) {
    this.rules = opts.rules;
    this.clock = opts.clock;
    this.hooks = opts.hooks;
    opts.teams.forEach((t, i) => {
      this.teams.set(t.userId, t);
      this.seeds[t.userId] = i + 1;
    });
    this.bracket = buildBracket(opts.teams.map((t) => t.userId));
    this.rounds = roundNames(opts.teams.length);
  }

  get isFinished() {
    return this.finished;
  }

  start() {
    this.nextKickoffAt = this.clock.now() + this.rules.roundIntroMs;
    const byes = this.bracket.filter((b) => b.round === 0 && b.bye && b.winnerId);
    for (const b of byes) this.hooks.onFeed(`${this.name(b.winnerId!)} gets a bye into the ${this.rounds[1] ?? 'next round'}`, b.winnerId!);
    this.after(this.rules.roundIntroMs, () => this.startRound(0));
    this.hooks.onChange();
  }

  /** Play the rest of the cup immediately (everyone left; the result still counts). */
  fastForward() {
    if (this.finished || this.disposed) return;
    this.instant = true;
    // Run whatever was waiting, earliest first; anything they schedule runs at once.
    for (;;) {
      const next = [...this.timers].sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.timers.delete(next);
      next.handle.cancel();
      next.fn();
    }
  }

  dispose() {
    this.disposed = true;
    for (const t of this.timers) t.handle.cancel();
    this.timers.clear();
  }

  private after(ms: number, fn: () => void) {
    if (this.disposed) return;
    if (this.instant) return fn();
    const entry = { handle: null as unknown as TimerHandle, at: this.clock.now() + ms, fn };
    entry.handle = this.clock.setTimeout(() => {
      this.timers.delete(entry);
      fn();
    }, Math.max(0, ms));
    this.timers.add(entry);
    return entry;
  }

  private name(userId: string) {
    return this.teams.get(userId)?.name ?? 'A manager';
  }

  // ------------------------------------------------------------- rounds

  private startRound(r: number) {
    this.currentRound = r;
    this.nextKickoffAt = null;
    const slots = this.bracket.filter((b) => b.round === r);
    const rand = (slot: number) => createRng(`${this.opts.seed}:cup:${r}:${slot}`);
    for (const b of slots) {
      if (b.bye || !b.homeId || !b.awayId) continue;
      const m = new LiveMatch(`r${r}s${b.slot}`, r, b.slot, this.teams.get(b.homeId)!, this.teams.get(b.awayId)!, rand(b.slot));
      b.matchId = m.id;
      this.matches.push(m);
    }
    const live = this.matches.filter((m) => m.round === r);
    if (live.length === 0) return this.endRound(r);
    this.hooks.onFeed(`⚽ ${this.rounds[r]} kick off!`);
    this.hooks.onEvent({ type: 'KICKOFF', round: r });
    for (const m of live) this.kickoff(m);
    this.hooks.onChange();
  }

  private endRound(r: number) {
    advance(this.bracket, r);
    if (r >= this.rounds.length - 1) return this.crown();
    this.nextKickoffAt = this.instant ? null : this.clock.now() + this.rules.roundBreakMs;
    this.after(this.rules.roundBreakMs, () => this.startRound(r + 1));
    this.hooks.onChange();
  }

  private crown() {
    const final = this.bracket.find((b) => b.round === this.rounds.length - 1)!;
    this.championId = final.winnerId;
    if (this.championId) {
      this.hooks.onFeed(`🏆 ${this.name(this.championId)} wins the cup!`, this.championId);
      this.hooks.onEvent({ type: 'CHAMPION', userId: this.championId });
    }
    this.hooks.onChange();
    this.after(this.rules.ceremonyMs, () => {
      this.finished = true;
      this.hooks.onFinish(this.summary());
    });
  }

  // ------------------------------------------------------------- a match

  private kickoff(m: LiveMatch) {
    this.startPhase(m, 'FIRST_HALF', 0, 45, this.rules.matchMinuteMs);
  }

  private startPhase(m: LiveMatch, status: MatchStatus, from: number, to: number, msPerMinute: number) {
    m.status = status;
    m.clock = { phaseStartedAt: this.clock.now(), phaseMinute: from, phaseEndMinute: to, msPerMinute };
    this.step(m);
  }

  /** Simulate the next few minutes (shown over the coming seconds), then come back. */
  private step(m: LiveMatch) {
    const c = m.clock!;
    if (m.sim.minute >= c.phaseEndMinute) return this.endPhase(m);
    const to = Math.min(c.phaseEndMinute, m.sim.minute + BLOCK);
    const extra = m.status === 'EXTRA_TIME';
    const events = m.sim.playMinutes(to, m.mods, extra);
    const before = m.timeline.length;
    for (const e of events) {
      e.at = Math.round(c.phaseStartedAt + (e.minute - c.phaseMinute - 0.5) * c.msPerMinute);
      m.timeline.push(e);
    }
    const momentum = m.sim.momentum.slice(m.momentum.length);
    for (const [i, v] of momentum.entries()) {
      const minute = (m.momentum.length + i + 1) * BLOCK;
      m.momentum.push({ at: Math.round(c.phaseStartedAt + (minute - c.phaseMinute) * c.msPerMinute), v });
    }
    // Score news for the feed and sounds, when it's shown.
    for (const e of m.timeline.slice(before)) {
      if (e.kind === 'GOAL' || e.kind === 'PEN_GOAL') {
        const scorerSide = e.side!;
        const userId = scorerSide === 0 ? m.home.userId : m.away.userId;
        this.after(Math.max(0, (e.at ?? 0) - this.clock.now()), () => {
          this.hooks.onEvent({ type: 'GOAL', matchId: m.id, userId });
          this.hooks.onChange();
        });
      }
    }
    const nextAt = c.phaseStartedAt + (to - c.phaseMinute) * c.msPerMinute;
    m.timer = this.after(Math.max(0, nextAt - this.clock.now()), () => this.step(m))?.handle ?? null;
    this.hooks.onChange();
  }

  private endPhase(m: LiveMatch) {
    const knockout = true;
    const level = m.sim.goals[0] === m.sim.goals[1];
    if (m.status === 'FIRST_HALF') {
      m.status = 'HALF_TIME';
      m.clock = { phaseStartedAt: this.clock.now(), phaseMinute: 45, phaseEndMinute: 45, msPerMinute: this.rules.matchMinuteMs };
      m.halfTimeEndsAt = this.clock.now() + this.rules.halfTimeMs;
      this.hooks.onEvent({ type: 'HALF_TIME', round: m.round });
      m.timer = this.after(this.rules.halfTimeMs, () => this.secondHalf(m))?.handle ?? null;
      this.checkTalks(m);
      return this.hooks.onChange();
    }
    if (m.status === 'SECOND_HALF' && level && knockout) {
      m.timeline.push({ minute: 90, side: null, kind: 'INFO', text: '⏱️ Extra time — 30 more minutes', score: [...m.sim.goals], at: this.clock.now() });
      return this.startPhase(m, 'EXTRA_TIME', 90, 120, this.rules.extraMinuteMs);
    }
    if (m.status === 'EXTRA_TIME' && level) return this.startShootout(m);
    this.finishMatch(m);
  }

  private secondHalf(m: LiveMatch) {
    if (m.status !== 'HALF_TIME') return;
    m.halfTimeEndsAt = null;
    for (const side of [0, 1] as const) {
      const talk = m.mods[side].talk ?? 'CALM';
      m.mods[side].talk = talk;
      const t = TEAM_TALKS[talk];
      const team = side === 0 ? m.home : m.away;
      const e = m.sim.note(side, 'TALK', `${t.emoji} ${team.name}: “${t.label}”`);
      m.timeline.push({ ...e, at: this.clock.now() });
    }
    this.startPhase(m, 'SECOND_HALF', 45, 90, this.rules.matchMinuteMs);
  }

  private startShootout(m: LiveMatch) {
    m.status = 'PENALTIES';
    m.clock = null;
    this.hooks.onFeed(`Penalties! ${this.name(m.home.userId)} v ${this.name(m.away.userId)}`);
    const kick = () => {
      const k = m.sim.nextKick();
      if (!k) return this.finishMatch(m);
      m.kicks.push({ ...k, at: this.clock.now() });
      this.hooks.onChange();
      m.timer = this.after(this.rules.penaltyKickMs, kick)?.handle ?? null;
    };
    m.timer = this.after(this.rules.penaltyKickMs, kick)?.handle ?? null;
    this.hooks.onChange();
  }

  private finishMatch(m: LiveMatch) {
    m.status = 'FINISHED';
    m.clock = null;
    m.timer = null;
    const side = m.sim.winnerSide() ?? 0;
    m.winnerId = side === 0 ? m.home.userId : m.away.userId;
    m.motm = m.sim.motm();
    const slot = this.bracket.find((b) => b.round === m.round && b.slot === m.slot)!;
    slot.winnerId = m.winnerId;
    const [h, a] = m.sim.goals;
    const pens = m.sim.pens ? ` (${m.sim.pens[0]}–${m.sim.pens[1]} pens)` : '';
    this.hooks.onFeed(`FT: ${this.name(m.home.userId)} ${h}–${a} ${this.name(m.away.userId)}${pens}`, m.winnerId);
    this.hooks.onEvent({ type: 'FULL_TIME', matchId: m.id, winnerId: m.winnerId });
    if (this.matches.filter((x) => x.round === m.round).every((x) => x.status === 'FINISHED')) return this.endRound(m.round);
    this.hooks.onChange();
  }

  // ------------------------------------------------------------- inputs

  private matchOf(userId: string) {
    return this.matches.find((m) => m.round === this.currentRound && m.status !== 'FINISHED' && m.sideOf(userId) !== null);
  }

  /** Half-time team talk. */
  talk(userId: string, talk: TeamTalk) {
    const m = this.matchOf(userId) ?? fail('NOT_IN_MATCH');
    if (m.status !== 'HALF_TIME') fail('TALK_CLOSED');
    m.mods[m.sideOf(userId)!].talk = talk;
    this.checkTalks(m);
    this.hooks.onChange();
  }

  /** Both managers have chosen (or the other one isn't there): start the second half soon. */
  private checkTalks(m: LiveMatch) {
    if (m.status !== 'HALF_TIME' || m.halfTimeEndsAt === null) return;
    const ready = ([0, 1] as const).every((s) => m.mods[s].talk !== null || !this.opts.isPresent(s === 0 ? m.home.userId : m.away.userId));
    if (!ready) return;
    const soon = this.clock.now() + TALKS_IN_MS;
    if (m.halfTimeEndsAt <= soon) return;
    m.halfTimeEndsAt = soon;
    m.timer?.cancel();
    m.timer = this.after(TALKS_IN_MS, () => this.secondHalf(m))?.handle ?? null;
  }

  /** Touchline shout: changes the odds for the next 15 minutes. */
  shout(userId: string, shout: Shout) {
    const m = this.matchOf(userId) ?? fail('NOT_IN_MATCH');
    if (!m.live || !m.clock) fail('TALK_CLOSED', 'You can shout while the ball is in play.');
    const side = m.sideOf(userId)!;
    if (!m.shoutsLeft[side].has(shout)) fail('NO_SHOUT');
    m.shoutsLeft[side].delete(shout);
    const c = m.clock;
    const shownMinute = Math.min(c.phaseEndMinute, c.phaseMinute + Math.floor((this.clock.now() - c.phaseStartedAt) / c.msPerMinute));
    m.mods[side].shout = { id: shout, until: Math.max(m.sim.minute, shownMinute) + MATCH_CONFIG.shoutMinutes };
    const s = SHOUTS[shout];
    const team = side === 0 ? m.home : m.away;
    const e = m.sim.note(side, 'SHOUT', `${s.emoji} ${team.name}: “${s.label}!”`);
    m.timeline.push({ ...e, minute: shownMinute, at: this.clock.now() });
    this.hooks.onChange();
  }

  // ------------------------------------------------------------- views

  view(viewerId?: string): TournamentView {
    const now = this.clock.now();
    return {
      rounds: this.rounds,
      currentRound: this.currentRound,
      nextKickoffAt: this.nextKickoffAt,
      bracket: this.bracket.map((b) => ({ ...b })),
      matches: this.matches.map((m) => this.matchView(m, now, viewerId)),
      championId: this.championId,
      seeds: { ...this.seeds },
    };
  }

  private matchView(m: LiveMatch, now: number, viewerId?: string): MatchView {
    const shown = m.timeline.filter((e) => (e.at ?? 0) <= now);
    const score = shown.length ? shown[shown.length - 1].score : [0, 0];
    const finished = m.status === 'FINISHED';
    const viewerSide = viewerId ? m.sideOf(viewerId) : null;
    const side = (s: 0 | 1) => {
      const team = s === 0 ? m.home : m.away;
      // Team talks stay secret until the second half starts.
      const reveal = m.status !== 'HALF_TIME';
      return {
        userId: team.userId,
        seed: this.seeds[team.userId],
        formationId: team.formationId,
        tacticId: team.score.tacticId,
        goals: finished ? m.sim.goals[s] : score[s],
        stats: statsFromEvents(finished ? m.timeline : shown, s, m.sim.possession),
        shoutsLeft: [...m.shoutsLeft[s]],
        talk: reveal ? m.mods[s].talk : viewerSide === s ? m.mods[s].talk : null,
        talkChosen: m.mods[s].talk !== null,
      };
    };
    return {
      id: m.id,
      round: m.round,
      slot: m.slot,
      status: m.status,
      home: side(0),
      away: side(1),
      clock: m.clock,
      halfTimeEndsAt: m.halfTimeEndsAt,
      // Everything simulated so far, each with the time to show it (clients hide the next few seconds).
      events: m.timeline,
      momentum: m.momentum.filter((x) => x.at <= now || finished).map((x) => x.v),
      shootout: m.kicks.length || m.status === 'PENALTIES' ? m.kicks.filter((k) => k.at <= now || finished) : null,
      pens: m.sim.pens ? (finished ? [...m.sim.pens] : this.pensShown(m, now)) : null,
      halfTime: m.sim.halfTimeScore && (m.status !== 'FIRST_HALF') ? [...m.sim.halfTimeScore] : null,
      winnerId: m.winnerId,
      motm: m.motm,
      edges: m.sim.edges,
    };
  }

  private pensShown(m: LiveMatch, now: number): [number, number] {
    const p: [number, number] = [0, 0];
    for (const k of m.kicks) if (k.at <= now && k.scored) p[k.side]++;
    return p;
  }

  summary(): CupSummary {
    return {
      rounds: this.rounds,
      championId: this.championId,
      placements: cupPlacements(this.bracket, this.seeds),
      seeds: { ...this.seeds },
      matches: this.matches
        .filter((m) => m.status === 'FINISHED')
        .map((m) => ({
          round: m.round,
          homeId: m.home.userId,
          awayId: m.away.userId,
          score: [...m.sim.goals] as [number, number],
          halfTime: (m.sim.halfTimeScore ?? [0, 0]) as [number, number],
          pens: m.sim.pens ? ([...m.sim.pens] as [number, number]) : null,
          winnerId: m.winnerId!,
          motm: m.motm ? { playerId: m.motm, userId: m.home.xi.some((s) => s.player.id === m.motm) ? m.home.userId : m.away.userId } : null,
          goals: m.sim.events
            .filter((e) => e.kind === 'GOAL' || e.kind === 'PEN_GOAL')
            .map((e) => ({ playerId: e.playerId!, side: e.side as 0 | 1, minute: e.minute, pen: e.kind === 'PEN_GOAL', assistId: e.assistId })),
        })),
    };
  }

  /** "Champion", "Semi-finalist"… for each manager. */
  finishFor(userId: string) {
    return cupFinish(this.bracket, userId, this.rounds);
  }
}

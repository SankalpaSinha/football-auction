import { randomUUID } from 'node:crypto';
import {
  DEFAULT_FORMATION,
  autoPick,
  buildMatchReport,
  computeEloChanges,
  ELO_CONFIG,
  type EloChange,
  rankScores,
  type MatchReport,
  scoreSquad,
  type RankedScore,
  getFormation,
  validateLineup,
  type LineupInput,
  type LineupView,
} from '@fa/shared';
import type {
  FeedItem,
  FeedKind,
  GameEvent,
  GameRules,
  MemberView,
  PlayerCard,
  RoomPhase,
  RoomSettings,
  RoomView,
  SessionUser,
} from '@fa/shared';
import { Auction, type Participant } from './auction';
import type { Clock, TimerHandle } from './clock';
import { fail } from './errors';
import { seededRandomOrder, type AuctionOrderStrategy } from './ordering';
import { newSeed } from './rng';
import type { GameStore } from './store';
import type { Commentator } from '../services/commentary';

export interface CompetitionInfo {
  id: string;
  name: string;
  shortName: string;
  accent: string;
  seasonLabel: string;
}

export interface RoomDeps {
  clock: Clock;
  rules: GameRules;
  store: GameStore;
  orderStrategy?: AuctionOrderStrategy;
  /** Fixed seed for reproducible tests. */
  seed?: string;
  onChange(room: Room): void;
  onEvent(room: Room, event: GameEvent): void;
  onClosed(room: Room, reason: string): void;
  onMemberRemoved(room: Room, userId: string): void;
  /** Optional AI pundit; absent or disabled → written analysis only. */
  commentator?: Commentator;
  log?: (msg: string, err?: unknown) => void;
}

interface Member {
  userId: string;
  username: string;
  seat: number;
  ready: boolean;
  connected: boolean;
  disconnectedAt: number | null;
  removalTimer: TimerHandle | null;
}

const LOBBY_PHASES: RoomPhase[] = ['WAITING_FOR_PLAYERS', 'LOBBY'];

interface LineupState extends LineupView {}
const FEED_LIMIT = 60;

/**
 * A room and its state machine:
 *
 *   WAITING_FOR_PLAYERS ⇄ LOBBY → STARTING → AUCTION ⇄ PLAYER_SOLD → SQUAD_BUILDING → …
 *
 * Every mutation goes through a method that checks the current phase first.
 */
export class Room {
  readonly id = randomUUID();
  readonly createdAt: number;
  phase: RoomPhase = 'WAITING_FOR_PLAYERS';
  hostId: string;
  gameId: string | null = null;
  closed = false;

  private members = new Map<string, Member>();
  private feed: FeedItem[] = [];
  private feedSeq = 0;
  private version = 0;
  private startsAt: number | null = null;
  private startTimer: TimerHandle | null = null;
  private hostTimer: TimerHandle | null = null;
  private abandonTimer: TimerHandle | null = null;
  private auction: Auction | null = null;
  private participants: Participant[] = [];
  private lineups = new Map<string, LineupState>();
  private squadEndsAt: number | null = null;
  private squadTimer: TimerHandle | null = null;
  private evaluationTimer: TimerHandle | null = null;
  private resultsAt: number | null = null;
  private rankings: RankedScore[] | null = null;
  private evaluatedAt: number | null = null;
  private report: MatchReport | null = null;
  private ratings: Record<string, { elo: number; games: number }> | null = null;
  private ratingChanges: EloChange[] | null = null;
  private commentary: { status: 'disabled' | 'pending' | 'ready' | 'unavailable'; text: string | null } = {
    status: 'disabled',
    text: null,
  };
  private persistChain: Promise<void> = Promise.resolve();

  constructor(
    readonly code: string,
    readonly name: string,
    readonly settings: RoomSettings,
    readonly competition: CompetitionInfo,
    private readonly pool: PlayerCard[],
    host: SessionUser,
    private readonly deps: RoomDeps,
  ) {
    this.createdAt = deps.clock.now();
    this.hostId = host.id;
    this.persist(() =>
      deps.store.roomCreated({ id: this.id, code, name, hostUserId: host.id, settings }),
    );
    this.join(host);
  }

  // ------------------------------------------------------------- queries

  hasMember(userId: string) {
    return this.members.has(userId);
  }

  memberIds() {
    return [...this.members.keys()];
  }

  get memberCount() {
    return this.members.size;
  }

  get isLobby() {
    return LOBBY_PHASES.includes(this.phase);
  }

  /** While the game is live a manager cannot hop into another room. */
  get isLive() {
    return (
      this.phase === 'STARTING' ||
      this.phase === 'AUCTION' ||
      this.phase === 'PLAYER_SOLD' ||
      this.phase === 'SQUAD_BUILDING'
    );
  }

  // ------------------------------------------------------------ membership

  join(user: SessionUser) {
    this.assertOpen();
    const existing = this.members.get(user.id);
    if (existing) {
      this.setConnected(user.id, true);
      return;
    }
    if (!this.isLobby) fail('GAME_IN_PROGRESS');
    if (this.members.size >= this.settings.maxPlayers) fail('ROOM_FULL');

    const taken = new Set([...this.members.values()].map((m) => m.seat));
    let seat = 0;
    while (taken.has(seat)) seat++;
    this.members.set(user.id, {
      userId: user.id,
      username: user.username,
      seat,
      ready: false,
      connected: true,
      disconnectedAt: null,
      removalTimer: null,
    });
    if (!this.members.has(this.hostId)) this.hostId = user.id;
    this.pushFeed('JOIN', `${user.username} joined`, user.id);
    this.persist(() => this.deps.store.memberJoined(this.id, user.id, seat));
    this.updateLobbyPhase();
    this.changed();
  }

  leave(userId: string) {
    const m = this.members.get(userId) ?? fail('NOT_IN_ROOM');
    if (this.phase === 'STARTING') this.cancelStart('a manager left');
    if (!this.isLobby) {
      // Mid-game: the squad and budget stay; the manager can come back.
      this.setConnected(userId, false);
      return;
    }
    this.removeMember(m, `${m.username} left`);
  }

  setConnected(userId: string, connected: boolean) {
    const m = this.members.get(userId);
    if (!m || m.connected === connected) return;
    const now = this.deps.clock.now();
    m.connected = connected;
    m.disconnectedAt = connected ? null : now;
    m.removalTimer?.cancel();
    m.removalTimer = null;

    if (connected) {
      this.pushFeed('RECONNECT', `${m.username} reconnected`, userId);
      this.abandonTimer?.cancel();
      this.abandonTimer = null;
      if (this.hostId === userId) {
        this.hostTimer?.cancel();
        this.hostTimer = null;
      }
    } else {
      this.pushFeed('DISCONNECT', `${m.username} disconnected`, userId);
      if (this.phase === 'STARTING') this.cancelStart(`${m.username} disconnected`);
      if (this.isLobby) {
        m.removalTimer = this.deps.clock.setTimeout(() => {
          if (!m.connected && this.members.get(userId) === m && this.isLobby) {
            this.removeMember(m, `${m.username} timed out`);
          }
        }, this.deps.rules.lobbyDisconnectGraceMs);
      }
      if (this.hostId === userId) {
        this.hostTimer?.cancel();
        this.hostTimer = this.deps.clock.setTimeout(() => {
          this.hostTimer = null;
          if (this.hostId === userId && !this.members.get(userId)?.connected) this.transferHost();
        }, this.deps.rules.hostTransferGraceMs);
      }
      if ([...this.members.values()].every((x) => !x.connected)) {
        this.abandonTimer?.cancel();
        this.abandonTimer = this.deps.clock.setTimeout(() => {
          if ([...this.members.values()].every((x) => !x.connected)) {
            this.close(this.isLive ? 'ABANDONED' : this.isLobby ? 'CLOSED' : 'FINISHED', 'everyone left');
          }
        }, this.deps.rules.abandonAfterMs);
      }
    }
    this.auction?.connectivityChanged();
    this.changed();
  }

  setReady(userId: string, ready: boolean) {
    const m = this.members.get(userId) ?? fail('NOT_IN_ROOM');
    if (!this.isLobby) fail('WRONG_PHASE');
    if (m.ready === ready) return;
    m.ready = ready;
    this.changed();
  }

  // --------------------------------------------------------------- start

  /** Whether the host could press start right now, and if not why. */
  startBlocker(): string | null {
    if (this.phase !== 'LOBBY') return 'NOT_ENOUGH_PLAYERS';
    const ms = [...this.members.values()];
    if (ms.length < this.deps.rules.minPlayers) return 'NOT_ENOUGH_PLAYERS';
    if (ms.some((m) => !m.connected)) return 'PLAYERS_DISCONNECTED';
    if (ms.some((m) => m.userId !== this.hostId && !m.ready)) return 'NOT_ALL_READY';
    return null;
  }

  start(userId: string) {
    this.assertOpen();
    if (!this.members.has(userId)) fail('NOT_IN_ROOM');
    if (userId !== this.hostId) fail('NOT_HOST');
    if (!this.isLobby) fail('WRONG_PHASE');
    const blocker = this.startBlocker();
    if (blocker) fail(blocker as 'NOT_ENOUGH_PLAYERS');

    const n = this.members.size;
    const gks = this.pool.filter((p) => p.position === 'GK').length;
    if (this.pool.length < n * this.deps.rules.squadSize || gks < n * this.deps.rules.minGoalkeepers) {
      fail('POOL_TOO_SMALL');
    }

    this.phase = 'STARTING';
    this.startsAt = this.deps.clock.now() + this.deps.rules.startCountdownMs;
    this.pushFeed('INFO', 'Auction starting…');
    this.deps.onEvent(this, { type: 'GAME_STARTING', startsAt: this.startsAt });
    this.startTimer = this.deps.clock.setTimeout(() => this.beginAuction(), this.deps.rules.startCountdownMs);
    this.changed();
  }

  private cancelStart(reason: string) {
    this.startTimer?.cancel();
    this.startTimer = null;
    this.startsAt = null;
    this.phase = 'LOBBY';
    this.pushFeed('INFO', `Start cancelled — ${reason}`);
    this.updateLobbyPhase();
  }

  private beginAuction() {
    this.startTimer = null;
    this.startsAt = null;
    const rules = this.deps.rules;
    const strategy = this.deps.orderStrategy ?? seededRandomOrder;
    const seed = this.deps.seed ?? newSeed();
    const order = strategy.order(this.pool, seed);
    this.gameId = randomUUID();

    this.participants = [...this.members.values()]
      .sort((a, b) => a.seat - b.seat)
      .map((m) => ({
        userId: m.userId,
        username: m.username,
        startingBudget: this.settings.startingBudget,
        budget: this.settings.startingBudget,
        squad: [],
      }));

    const gameId = this.gameId;
    if (this.settings.mode === 'RANKED') {
      this.deps.store
        .ratingsFor(this.participants.map((p) => p.userId), 'RANKED')
        .then((r) => (this.ratings = r))
        .catch((err) => this.deps.log?.('could not load ratings', err));
    }
    this.persist(() =>
      this.deps.store.gameStarted({
        gameId,
        roomId: this.id,
        seed,
        mode: this.settings.mode,
        orderStrategy: strategy.id,
        poolSize: order.length,
        config: {
          rules,
          lotDurationSec: this.settings.lotDurationSec,
          antiSnipe: this.settings.antiSnipe,
          startingBudget: this.settings.startingBudget,
        },
        participants: this.participants.map((p) => ({ userId: p.userId, budget: p.budget })),
      }),
    );

    this.auction = new Auction({
      order,
      participants: this.participants,
      rules,
      lotDurationMs: this.settings.lotDurationSec * 1000,
      antiSnipe: this.settings.antiSnipe,
      clock: this.deps.clock,
      isConnected: (id) => this.members.get(id)?.connected ?? false,
      hooks: {
        onChange: () => {
          if (this.auction && !this.auction.isComplete) {
            this.phase = this.auction.isRevealing ? 'PLAYER_SOLD' : 'AUCTION';
          }
          this.changed();
        },
        onEvent: (e) => this.deps.onEvent(this, e),
        onFeed: (kind, text, extra) => this.pushFeed(kind, text, extra?.userId, extra?.amount),
        onLotClosed: (lot) => {
          const snapshot = this.participants.map((p) => ({ ...p, squad: [...p.squad] }));
          this.persist(() => this.deps.store.lotClosed(gameId, lot, snapshot));
        },
        onComplete: () => {
          const snapshot = this.participants.map((p) => ({ ...p, squad: [...p.squad] }));
          this.persist(() => this.deps.store.auctionCompleted(gameId, snapshot));
          this.beginSquadBuilding();
        },
      },
    });
    this.phase = 'AUCTION';
    this.auction.start();
  }

  // ------------------------------------------------------------- auction

  bid(userId: string, lotNumber: number, amount: number) {
    this.assertInAuction(userId);
    this.auction!.bid(userId, lotNumber, amount);
  }

  skip(userId: string, lotNumber: number) {
    this.assertInAuction(userId);
    this.auction!.skip(userId, lotNumber);
  }

  private assertInAuction(userId: string) {
    this.assertOpen();
    if (!this.members.has(userId)) fail('NOT_IN_ROOM');
    if (!this.auction || (this.phase !== 'AUCTION' && this.phase !== 'PLAYER_SOLD')) fail('WRONG_PHASE');
  }

  // ------------------------------------------------------ squad building

  private beginSquadBuilding() {
    this.phase = 'SQUAD_BUILDING';
    for (const p of this.participants) {
      this.lineups.set(p.userId, {
        formationId: DEFAULT_FORMATION,
        slots: getFormation(DEFAULT_FORMATION)!.slots.map(() => null),
        locked: false,
        auto: false,
      });
    }
    this.squadEndsAt = this.deps.clock.now() + this.deps.rules.squadBuildingMs;
    this.squadTimer = this.deps.clock.setTimeout(() => this.finalizeLineups(), this.deps.rules.squadBuildingMs);
    this.pushFeed('INFO', 'Squad builder open — pick a formation and your starting XI');
    this.changed();
  }

  private squadOf(userId: string) {
    return (this.participants.find((p) => p.userId === userId) ?? fail('NOT_PARTICIPANT')).squad.map((e) => e.player);
  }

  private requireLineup(userId: string): LineupState {
    this.assertOpen();
    if (!this.members.has(userId)) fail('NOT_IN_ROOM');
    if (this.phase !== 'SQUAD_BUILDING') fail('WRONG_PHASE');
    return this.lineups.get(userId) ?? fail('NOT_PARTICIPANT');
  }

  /** Save work in progress (partial lineups allowed). Used for auto-complete at the deadline. */
  saveLineupDraft(userId: string, input: LineupInput) {
    const state = this.requireLineup(userId);
    if (state.locked) fail('LINEUP_LOCKED');
    const err = validateLineup(input, this.squadOf(userId), false);
    if (err) fail(err);
    state.formationId = input.formationId;
    state.slots = [...input.slots];
    this.changed();
  }

  lockLineup(userId: string, input: LineupInput) {
    const state = this.requireLineup(userId);
    if (state.locked) fail('LINEUP_LOCKED');
    const err = validateLineup(input, this.squadOf(userId), true);
    if (err) fail(err);
    state.formationId = input.formationId;
    state.slots = [...input.slots];
    state.locked = true;
    const name = this.members.get(userId)!.username;
    this.pushFeed('LOCK', `${name} locked in a ${input.formationId}`, userId);
    this.deps.onEvent(this, { type: 'LINEUP_LOCKED', userId });
    if ([...this.lineups.values()].every((l) => l.locked)) this.finalizeLineups();
    else this.changed();
  }

  unlockLineup(userId: string) {
    const state = this.requireLineup(userId);
    if (!state.locked) return;
    state.locked = false;
    this.changed();
  }

  /** Deadline (or everyone locked): auto-complete unfinished lineups and reveal them all. */
  private finalizeLineups() {
    if (this.phase !== 'SQUAD_BUILDING') return;
    this.squadTimer?.cancel();
    this.evaluationTimer?.cancel();
    this.squadTimer = null;
    for (const [userId, state] of this.lineups) {
      if (state.locked) continue;
      state.slots = autoPick(this.squadOf(userId), state.formationId, state.slots);
      state.locked = true;
      state.auto = true;
      this.pushFeed('AUTO', `${this.members.get(userId)?.username ?? 'A manager'}'s lineup was auto-completed`, userId);
    }
    this.squadEndsAt = null;
    this.phase = 'FINAL_EVALUATION';
    const gameId = this.gameId!;
    const final = [...this.lineups].map(([userId, l]) => ({ userId, formationId: l.formationId, slots: [...l.slots] as string[] }));
    this.persist(() => this.deps.store.lineupsFinalized(gameId, final));
    this.pushFeed('INFO', 'All lineups are in — evaluating squads…');
    this.deps.onEvent(this, { type: 'LINEUPS_REVEALED' });
    this.evaluate();
    this.changed();
  }

  /** Deterministic scoring. Computed now, shown after a short pause. */
  private evaluate() {
    const scores = this.participants.map((p) => {
      const l = this.lineups.get(p.userId)!;
      return { userId: p.userId, score: scoreSquad(p.squad, { formationId: l.formationId, slots: l.slots }) };
    });
    this.rankings = rankScores(scores);
    if (this.settings.mode === 'RANKED') {
      this.ratingChanges = computeEloChanges(
        this.rankings.map((r) => ({
          userId: r.userId,
          rank: r.rank,
          elo: this.ratings?.[r.userId]?.elo ?? ELO_CONFIG.initial,
          games: this.ratings?.[r.userId]?.games ?? 0,
        })),
      );
    }
    this.report = buildMatchReport(
      this.rankings,
      this.participants.map((p) => ({ userId: p.userId, username: p.username, squad: p.squad })),
    );
    this.requestCommentary();
    this.evaluatedAt = this.deps.clock.now();
    this.resultsAt = this.evaluatedAt + this.deps.rules.evaluationMs;
    const gameId = this.gameId!;
    const rankings = this.rankings;
    const ratingChanges = this.ratingChanges;
    this.persist(() => this.deps.store.gameFinished(gameId, rankings, ratingChanges));
    this.evaluationTimer = this.deps.clock.setTimeout(() => this.showResults(), this.deps.rules.evaluationMs);
  }

  /** Fire-and-forget: the results never wait for (or depend on) the AI paragraph. */
  private requestCommentary() {
    const c = this.deps.commentator;
    if (!c?.enabled || !this.rankings || !this.report) return;
    this.commentary = { status: 'pending', text: null };
    const usernames = Object.fromEntries(this.participants.map((p) => [p.userId, p.username]));
    const playerNames = Object.fromEntries(this.participants.flatMap((p) => p.squad.map((e) => [e.player.id, e.player.name])));
    const formations = Object.fromEntries([...this.lineups].map(([id, l]) => [id, l.formationId]));
    c.generate({
      competition: `${this.competition.name} ${this.competition.seasonLabel}`,
      rankings: this.rankings,
      usernames,
      playerNames,
      formations,
      report: this.report,
    })
      .then((text) => {
        if (this.closed) return;
        this.commentary = text ? { status: 'ready', text } : { status: 'unavailable', text: null };
        this.changed();
      })
      .catch((err) => {
        this.deps.log?.('commentary failed', err);
        this.commentary = { status: 'unavailable', text: null };
        if (!this.closed) this.changed();
      });
  }

  private showResults() {
    this.evaluationTimer = null;
    this.resultsAt = null;
    this.phase = 'RESULTS';
    const winner = this.rankings![0];
    const name = this.members.get(winner.userId)?.username ?? 'A manager';
    this.pushFeed('INFO', `🏆 ${name} wins with ${winner.total}`, winner.userId);
    this.deps.onEvent(this, { type: 'RESULTS', winnerId: winner.userId });
    this.changed();
  }

  // --------------------------------------------------------------- host

  private transferHost() {
    const next = [...this.members.values()]
      .filter((m) => m.userId !== this.hostId && m.connected)
      .sort((a, b) => a.seat - b.seat)[0];
    if (!next) return;
    this.hostId = next.userId;
    this.pushFeed('HOST', `${next.username} is now the host`, next.userId);
    this.persist(() => this.deps.store.hostChanged(this.id, next.userId));
    this.changed();
  }

  private removeMember(m: Member, text: string) {
    m.removalTimer?.cancel();
    this.members.delete(m.userId);
    this.pushFeed('LEAVE', text, m.userId);
    this.persist(() => this.deps.store.memberLeft(this.id, m.userId));
    this.deps.onMemberRemoved(this, m.userId);
    if (this.members.size === 0) {
      this.close('CLOSED', 'room empty');
      return;
    }
    if (this.hostId === m.userId) {
      this.hostTimer?.cancel();
      this.hostTimer = null;
      const next =
        [...this.members.values()].filter((x) => x.connected).sort((a, b) => a.seat - b.seat)[0] ??
        [...this.members.values()].sort((a, b) => a.seat - b.seat)[0];
      this.hostId = next.userId;
      this.pushFeed('HOST', `${next.username} is now the host`, next.userId);
      this.persist(() => this.deps.store.hostChanged(this.id, next.userId));
    }
    this.updateLobbyPhase();
    this.changed();
  }

  // ----------------------------------------------------------- lifecycle

  close(status: 'FINISHED' | 'ABANDONED' | 'CLOSED', reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.startTimer?.cancel();
    this.hostTimer?.cancel();
    this.abandonTimer?.cancel();
    this.squadTimer?.cancel();
    for (const m of this.members.values()) m.removalTimer?.cancel();
    this.auction?.dispose();
    const gameId = this.gameId;
    this.persist(() => this.deps.store.roomClosed(this.id, status, gameId));
    this.deps.onClosed(this, reason);
  }

  private assertOpen() {
    if (this.closed) fail('ROOM_NOT_FOUND');
  }

  private updateLobbyPhase() {
    if (!this.isLobby) return;
    this.phase = this.members.size >= this.deps.rules.minPlayers ? 'LOBBY' : 'WAITING_FOR_PLAYERS';
  }

  private pushFeed(kind: FeedKind, text: string, userId?: string, amount?: number) {
    this.feed.push({ id: ++this.feedSeq, ts: this.deps.clock.now(), kind, text, userId, amount });
    if (this.feed.length > FEED_LIMIT) this.feed.splice(0, this.feed.length - FEED_LIMIT);
  }

  private changed() {
    this.version++;
    this.deps.onChange(this);
  }

  /** Serialise writes per room so the DB sees events in order; never block the game. */
  private persist(fn: () => Promise<void>) {
    this.persistChain = this.persistChain
      .then(fn)
      .catch((err) => this.deps.log?.(`[room ${this.code}] persistence failed`, err));
  }

  /** Resolves once queued writes have been attempted (tests / shutdown). */
  flush() {
    return this.persistChain;
  }

  // --------------------------------------------------------------- view

  /** Snapshot for one viewer — lineups stay private until they are revealed. */
  view(viewerId?: string): RoomView {
    const rules = this.deps.rules;
    const members: MemberView[] = [...this.members.values()]
      .sort((a, b) => a.seat - b.seat)
      .map((m) => {
        const p = this.participants.find((x) => x.userId === m.userId);
        return {
          userId: m.userId,
          username: m.username,
          seat: m.seat,
          isHost: m.userId === this.hostId,
          ready: m.userId === this.hostId || m.ready,
          connected: m.connected,
          budget: p ? p.budget : null,
          squad: p ? p.squad : [],
          maxBid: p && this.auction ? this.auction.maxBid(p) : null,
        };
      });
    return {
      id: this.id,
      gameId: this.gameId,
      code: this.code,
      name: this.name,
      phase: this.phase,
      hostId: this.hostId,
      settings: this.settings,
      competition: this.competition,
      rules: {
        squadSize: rules.squadSize,
        openingBid: rules.openingBid,
        minIncrement: rules.minIncrement,
        bidIncrements: rules.bidIncrements,
        minPlayers: rules.minPlayers,
      },
      members,
      startsAt: this.startsAt,
      auction: this.auction ? this.auction.view() : null,
      squadBuilding:
        this.phase === 'SQUAD_BUILDING' && this.squadEndsAt !== null
          ? {
              endsAt: this.squadEndsAt,
              locked: Object.fromEntries([...this.lineups].map(([id, l]) => [id, l.locked])),
              mine: viewerId && this.lineups.has(viewerId) ? { ...this.lineups.get(viewerId)! } : null,
            }
          : null,
      lineups:
        this.phase !== 'SQUAD_BUILDING' && this.lineups.size
          ? Object.fromEntries([...this.lineups].map(([id, l]) => [id, { ...l }]))
          : null,
      results:
        this.phase === 'RESULTS' && this.rankings && this.report
          ? {
              rankings: this.rankings,
              evaluatedAt: this.evaluatedAt!,
              report: this.report,
              commentary: this.commentary,
              ratingChanges: this.ratingChanges,
            }
          : null,
      resultsAt: this.phase === 'FINAL_EVALUATION' ? this.resultsAt : null,
      feed: this.feed.slice(-40),
      serverTime: this.deps.clock.now(),
      version: this.version,
    };
  }
}

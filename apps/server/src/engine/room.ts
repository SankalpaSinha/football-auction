import { randomUUID } from 'node:crypto';
import {
  DEFAULT_FORMATION,
  autoPick,
  buildMatchReport,
  computeEloChanges,
  cupAchievements,
  gameAchievements,
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
  DEFAULT_TACTIC,
  CUSTOM_FORMATION_ID,
  isStarPlayer,
  type PositionGroup,
  drawObjectives,
  type ObjectiveId,
  resolveFormation,
  rulesForFormat,
  SPENDING_OBJECTIVES,
  TAUNTS,
  type CupSummary,
  type CupTeam,
  type Reaction,
  type SeasonView,
  type Shout,
  type TauntId,
  type TeamTalk,
} from '@fa/shared';
import type {
  ChatMessage,
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
import { Cup } from './cup';
import { fail } from './errors';
import { seededRandomOrder, type AuctionOrderStrategy } from './ordering';
import { createRng, newSeed } from './rng';
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
  /** A manager was taken out of a running game (they can rejoin) — tell them why. */
  onKicked?(room: Room, userId: string, reason: string): void;
  onChat?(room: Room, msg: ChatMessage): void;
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
  away: boolean;
  awaySince: number | null;
  awayTimer: TimerHandle | null;
}

const LOBBY_PHASES: RoomPhase[] = ['WAITING_FOR_PLAYERS', 'LOBBY'];

interface LineupState extends LineupView {}
const FEED_LIMIT = 60;
const MAX_SPECTATORS = 50;
const CHAT_HISTORY = 100;
/** Season points by final position. */
const SEASON_POINTS = [10, 7, 5, 4, 3, 2, 1, 0];

/**
 * A room and its state machine:
 *
 *   WAITING_FOR_PLAYERS ⇄ LOBBY → STARTING → AUCTION ⇄ PLAYER_SOLD → SQUAD_BUILDING
 *     → FINAL_EVALUATION → TOURNAMENT → RESULTS (→ LOBBY again for a rematch / the next game of a season)
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
  /** The rules this room plays with (its format applied). */
  readonly rules: GameRules;

  private members = new Map<string, Member>();
  private spectators = new Set<string>();
  private chat: ChatMessage[] = [];
  private chatSeq = 0;
  private reactionSeq = 0;
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
  /** Ranked by squad score (the cup seeds). */
  private squadRankings: RankedScore[] | null = null;
  /** Final ranking (the cup decides it). */
  private rankings: RankedScore[] | null = null;
  private evaluatedAt: number | null = null;
  private report: MatchReport | null = null;
  private ratings: Record<string, { elo: number; games: number }> | null = null;
  private ratingChanges: EloChange[] | null = null;
  private achievements: Record<string, string[]> = {};
  private commentary: { status: 'disabled' | 'pending' | 'ready' | 'unavailable'; text: string | null } = {
    status: 'disabled',
    text: null,
  };
  private persistChain: Promise<void> = Promise.resolve();
  /** Each manager's secret objectives (drawn from the game seed when the auction starts). */
  private objectives = new Map<string, ObjectiveId[]>();
  private gameSeed = '';
  private cup: Cup | null = null;
  private season: {
    played: number;
    table: Map<string, { username: string; points: number; wins: number; played: number; lastRank: number }>;
    championId: string | null;
  } = { played: 0, table: new Map(), championId: null };

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
    this.rules = rulesForFormat(deps.rules, settings.format);
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

  // ---------------------------------------------------------------- chat

  /** Players in the room can chat in every phase; spectators can only read. */
  sendChat(userId: string, text: string): ChatMessage {
    this.assertOpen();
    const m = this.members.get(userId);
    if (!m) fail(this.spectators.has(userId) ? 'CHAT_SPECTATOR' : 'NOT_IN_ROOM');
    const msg: ChatMessage = { id: ++this.chatSeq, ts: this.deps.clock.now(), userId, username: m.username, text };
    this.chat.push(msg);
    if (this.chat.length > CHAT_HISTORY) this.chat.splice(0, this.chat.length - CHAT_HISTORY);
    this.deps.onChat?.(this, msg);
    return msg;
  }

  chatHistory(userId: string): ChatMessage[] {
    if (!this.members.has(userId) && !this.spectators.has(userId)) fail('NOT_IN_ROOM');
    return [...this.chat];
  }

  /** A floating emoji (anyone watching) or a touchline taunt (managers only). Not kept in state. */
  react(user: SessionUser, input: { emoji?: string; taunt?: TauntId }): Reaction {
    this.assertOpen();
    const m = this.members.get(user.id);
    if (!m && !this.spectators.has(user.id)) fail('NOT_IN_ROOM');
    if (!m && input.taunt) fail('CHAT_SPECTATOR');
    return {
      id: ++this.reactionSeq,
      userId: user.id,
      username: m?.username ?? user.username,
      ...(input.emoji ? { emoji: input.emoji } : {}),
      ...(input.taunt ? { taunt: TAUNTS[input.taunt] } : {}),
    };
  }

  /** Read-only viewers. They can never act: every action checks membership. */
  addSpectator(userId: string) {
    this.assertOpen();
    // A member who stepped out of the game may watch it; one who's playing doesn't need to.
    if (this.members.get(userId)?.connected) return;
    if (this.spectators.size >= MAX_SPECTATORS) fail('TOO_MANY_SPECTATORS');
    this.spectators.add(userId);
    this.changed();
  }

  removeSpectator(userId: string) {
    if (this.spectators.delete(userId)) this.changed();
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
      this.phase === 'SQUAD_BUILDING' ||
      this.phase === 'FINAL_EVALUATION' ||
      this.phase === 'TOURNAMENT'
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
      away: false,
      awaySince: null,
      awayTimer: null,
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

  /**
   * Exit button. Before the game it's a normal leave. Once the game has started the
   * manager keeps their squad and budget and simply goes offline (lots, votes and the
   * squad builder stop waiting for them); entering the room code again brings them back.
   */
  quit(userId: string) {
    this.assertOpen();
    const m = this.members.get(userId) ?? fail('NOT_IN_ROOM');
    if (this.isLobby || this.phase === 'STARTING') return this.leave(userId);
    this.pushFeed('LEAVE', `${m.username} left the game — they can rejoin with the room code`, userId);
    this.setConnected(userId, false, true);
  }

  setConnected(userId: string, connected: boolean, quiet = false) {
    const m = this.members.get(userId);
    if (!m || m.connected === connected) return;
    const now = this.deps.clock.now();
    m.connected = connected;
    this.clearAway(m);
    m.disconnectedAt = connected ? null : now;
    m.removalTimer?.cancel();
    m.removalTimer = null;

    if (connected) {
      this.pushFeed('RECONNECT', `${m.username} ${this.isLobby ? 'reconnected' : 'is back in the game'}`, userId);
      this.abandonTimer?.cancel();
      this.abandonTimer = null;
      if (this.hostId === userId) {
        this.hostTimer?.cancel();
        this.hostTimer = null;
      }
    } else {
      if (!quiet) this.pushFeed('DISCONNECT', `${m.username} disconnected`, userId);
      if (this.phase === 'STARTING') this.cancelStart(`${m.username} disconnected`);
      if (this.isLobby) {
        m.removalTimer = this.deps.clock.setTimeout(() => {
          if (!m.connected && this.members.get(userId) === m && this.isLobby) {
            this.removeMember(m, `${m.username} timed out`);
          }
        }, this.rules.lobbyDisconnectGraceMs);
      }
      if (this.hostId === userId) {
        this.hostTimer?.cancel();
        this.hostTimer = this.deps.clock.setTimeout(() => {
          this.hostTimer = null;
          if (this.hostId === userId && !this.members.get(userId)?.connected) this.transferHost();
        }, this.rules.hostTransferGraceMs);
      }
      if ([...this.members.values()].every((x) => !x.connected)) {
        this.abandonTimer?.cancel();
        this.abandonTimer = this.deps.clock.setTimeout(() => {
          this.abandonTimer = null;
          if (![...this.members.values()].every((x) => !x.connected)) return;
          if (this.phase === 'SQUAD_BUILDING' || this.phase === 'FINAL_EVALUATION' || this.phase === 'TOURNAMENT') {
            // The squads are complete: play the rest out instantly so the result still counts.
            this.finishNow();
            this.close('FINISHED', 'everyone left');
            return;
          }
          this.close(this.isLive ? 'ABANDONED' : this.isLobby ? 'CLOSED' : 'FINISHED', 'everyone left');
        }, this.rules.abandonAfterMs);
      }
    }
    this.auction?.connectivityChanged();
    this.checkSquadDeadline();
    this.changed();
  }

  /** The player's app went to the background (screen locked, switched app) or came back. */
  setAway(userId: string, away: boolean) {
    const m = this.members.get(userId);
    if (!m || !m.connected || m.away === away) return;
    const wasLongAway = this.longAway(m);
    if (away) {
      m.away = true;
      m.awaySince = this.deps.clock.now();
      m.awayTimer = this.deps.clock.setTimeout(() => {
        m.awayTimer = null;
        // Still away: from now on the auction treats them as offline.
        if (m.away && this.members.get(userId) === m) this.auction?.connectivityChanged();
        this.changed();
      }, this.rules.awayGraceMs);
    } else {
      this.clearAway(m);
      if (wasLongAway) this.auction?.connectivityChanged();
    }
    this.changed();
  }

  private longAway(m: Member) {
    return m.away && m.awaySince !== null && this.deps.clock.now() - m.awaySince >= this.rules.awayGraceMs;
  }

  private clearAway(m: Member) {
    m.away = false;
    m.awaySince = null;
    m.awayTimer?.cancel();
    m.awayTimer = null;
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
    if (ms.length < this.rules.minPlayers) return 'NOT_ENOUGH_PLAYERS';
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
    const rules = this.rules;
    const nonStars = this.pool.filter((p) => !isStarPlayer(p)).length;
    if (
      this.pool.length < n * rules.squadSize ||
      gks < n * rules.minGoalkeepers ||
      nonStars < n * (rules.squadSize - rules.starCap.max)
    ) {
      fail('POOL_TOO_SMALL');
    }

    this.phase = 'STARTING';
    this.startsAt = this.deps.clock.now() + this.rules.startCountdownMs;
    this.pushFeed('INFO', this.settings.format === 'DRAFT' ? 'Draft starting…' : 'Auction starting…');
    this.deps.onEvent(this, { type: 'GAME_STARTING', startsAt: this.startsAt });
    this.startTimer = this.deps.clock.setTimeout(() => this.beginAuction(), this.rules.startCountdownMs);
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
    const rules = this.rules;
    const strategy = this.deps.orderStrategy ?? seededRandomOrder;
    // Each game of a season gets its own seed (a fixed test seed still varies by game).
    const seed = this.deps.seed ? `${this.deps.seed}${this.season.played ? `:${this.season.played}` : ''}` : newSeed();
    this.gameSeed = seed;
    const order = strategy.order(this.pool, seed);
    this.gameId = randomUUID();
    const draft = this.settings.format === 'DRAFT';

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
    for (const p of this.participants) {
      this.objectives.set(p.userId, drawObjectives(createRng(`${seed}:objectives:${p.userId}`), undefined, draft ? SPENDING_OBJECTIVES : []));
    }
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
          format: this.settings.format,
          twists: this.settings.twists,
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
      format: this.settings.format,
      twists: this.settings.twists,
      rand: createRng(`${seed}:auction`),
      // Away for longer than the grace period counts as offline for the auction.
      isConnected: (id) => {
        const m = this.members.get(id);
        return !!m && m.connected && !this.longAway(m);
      },
      isPresent: (id) => {
        const m = this.members.get(id);
        return !!m && m.connected && !m.away;
      },
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
        onSatOut: (userId) => this.satOut(userId),
        onReleased: (userId, playerId, budget) => this.persist(() => this.deps.store.playerReleased(gameId, userId, playerId, budget)),
        onTraded: (record) => {
          const budgets = [record.fromId, record.toId].map((id) => ({
            userId: id,
            budget: this.participants.find((p) => p.userId === id)!.budget,
          }));
          this.persist(() => this.deps.store.tradeCompleted(gameId, record.moves, budgets));
        },
        onStolen: (record, budgets) => this.persist(() => this.deps.store.playerStolen(gameId, record, budgets)),
        onBudgets: (budgets) => this.persist(() => this.deps.store.budgetsChanged(gameId, budgets)),
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

  /** Sat out too many lots: out of the live auction (squad kept) until they rejoin with the code. */
  private satOut(userId: string) {
    const m = this.members.get(userId);
    if (!m || !m.connected) return;
    const why = `you sat out ${this.rules.inactiveLotsToRemove} lots in a row without bidding or skipping`;
    this.pushFeed('LEAVE', `${m.username} was taken out for inactivity — they keep their squad and can rejoin with the code`, userId);
    this.deps.onKicked?.(this, userId, why);
    this.setConnected(userId, false, true);
  }

  // ------------------------------------------------------------- auction

  bid(userId: string, lotNumber: number, amount: number) {
    this.assertInAuction(userId);
    this.auction!.bid(userId, lotNumber, amount);
  }

  sealedBid(userId: string, lotNumber: number, amount: number | null) {
    this.assertInAuction(userId);
    this.auction!.sealedBid(userId, lotNumber, amount);
  }

  skip(userId: string, lotNumber: number) {
    this.assertInAuction(userId);
    this.auction!.skip(userId, lotNumber);
  }

  pick(userId: string, playerId: string) {
    this.assertInAuction(userId);
    this.auction!.pick(userId, playerId);
  }

  freeze(userId: string, lotNumber: number, targetId: string) {
    this.assertInAuction(userId);
    this.auction!.freeze(userId, lotNumber, targetId);
  }

  steal(userId: string, lotNumber: number) {
    this.assertInAuction(userId);
    this.auction!.steal(userId, lotNumber);
  }

  refund(userId: string, playerId: string) {
    this.assertInAuction(userId);
    this.auction!.refund(userId, playerId);
  }

  /** Host only: choose which positions come up next (null = any). */
  setFocus(userId: string, group: PositionGroup | null) {
    this.assertInAuction(userId);
    if (userId !== this.hostId) fail('NOT_HOST');
    this.auction!.setFocus(group);
  }

  requestPause(userId: string) {
    this.assertInAuction(userId);
    this.auction!.requestPause(userId);
  }

  votePause(userId: string, agree: boolean) {
    this.assertInAuction(userId);
    this.auction!.votePause(userId, agree);
  }

  resumePause(userId: string) {
    this.assertInAuction(userId);
    this.auction!.resumeHold(userId);
  }

  release(userId: string, playerId: string) {
    this.assertInAuction(userId);
    this.auction!.release(userId, playerId);
  }

  proposeTrade(userId: string, input: { toId: string; give: string[]; take: string[]; coins: number }) {
    this.assertInAuction(userId);
    this.auction!.proposeTrade(userId, input);
  }

  respondTrade(userId: string, tradeId: string, accept: boolean) {
    this.assertInAuction(userId);
    this.auction!.respondTrade(userId, tradeId, accept);
  }

  cancelTrade(userId: string, tradeId: string) {
    this.assertInAuction(userId);
    this.auction!.cancelTrade(userId, tradeId);
  }

  /** Players still available — during free pick and the snake draft. */
  pickPool(userId: string) {
    this.assertOpen();
    if (!this.members.has(userId) && !this.spectators.has(userId)) fail('NOT_IN_ROOM');
    if (!this.auction || (!this.auction.inFreePick && !this.auction.inDraft)) fail('WRONG_PHASE');
    return this.auction.availablePlayers();
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
        tactic: DEFAULT_TACTIC,
        slots: getFormation(DEFAULT_FORMATION)!.slots.map(() => null),
        locked: false,
        auto: false,
      });
    }
    this.squadEndsAt = this.deps.clock.now() + this.rules.squadBuildingMs;
    this.squadTimer = this.deps.clock.setTimeout(() => this.finalizeLineups(), this.rules.squadBuildingMs);
    this.pushFeed('INFO', 'Squad builder open — pick a formation and your starting XI');
    this.checkSquadDeadline();
    this.changed();
  }

  /**
   * Once everyone still here has locked in, managers who've gone offline don't get
   * to hold the game up for the full ten minutes: their lineups are picked soon.
   */
  private checkSquadDeadline() {
    if (this.phase !== 'SQUAD_BUILDING' || this.squadEndsAt === null) return;
    const waiting = [...this.lineups].filter(([, l]) => !l.locked).map(([id]) => id);
    if (waiting.length === 0 || waiting.some((id) => this.members.get(id)?.connected)) return;
    const at = this.deps.clock.now() + this.rules.squadOfflineGraceMs;
    if (this.squadEndsAt <= at) return;
    this.squadEndsAt = at;
    this.squadTimer?.cancel();
    this.squadTimer = this.deps.clock.setTimeout(() => this.finalizeLineups(), this.rules.squadOfflineGraceMs);
    this.pushFeed('INFO', `Everyone here is locked in — lineups for managers who left are picked in ${Math.round(this.rules.squadOfflineGraceMs / 1000)}s`);
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
    state.custom = input.formationId === CUSTOM_FORMATION_ID ? input.custom!.map((s) => ({ ...s })) : null;
    state.slots = [...input.slots];
    if (input.tactic) state.tactic = input.tactic;
    this.changed();
  }

  lockLineup(userId: string, input: LineupInput) {
    const state = this.requireLineup(userId);
    if (state.locked) fail('LINEUP_LOCKED');
    const err = validateLineup(input, this.squadOf(userId), true);
    if (err) fail(err);
    state.formationId = input.formationId;
    state.custom = input.formationId === CUSTOM_FORMATION_ID ? input.custom!.map((s) => ({ ...s })) : null;
    state.slots = [...input.slots];
    if (input.tactic) state.tactic = input.tactic;
    state.locked = true;
    const name = this.members.get(userId)!.username;
    // Don't reveal the formation before everyone has locked in.
    this.pushFeed('LOCK', `${name} locked in their lineup`, userId);
    this.deps.onEvent(this, { type: 'LINEUP_LOCKED', userId });
    if ([...this.lineups.values()].every((l) => l.locked)) this.finalizeLineups();
    else {
      this.checkSquadDeadline();
      this.changed();
    }
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
      state.slots = autoPick(this.squadOf(userId), { formationId: state.formationId, custom: state.custom }, state.slots);
      state.locked = true;
      state.auto = true;
      this.pushFeed('AUTO', `${this.members.get(userId)?.username ?? 'A manager'}'s lineup was auto-completed`, userId);
    }
    this.squadEndsAt = null;
    this.phase = 'FINAL_EVALUATION';
    const gameId = this.gameId!;
    const final = [...this.lineups].map(([userId, l]) => ({
      userId,
      formationId: l.formationId,
      custom: l.custom ?? null,
      slots: [...l.slots] as string[],
    }));
    this.persist(() => this.deps.store.lineupsFinalized(gameId, final));
    this.pushFeed('INFO', 'All lineups are in — rating the squads for the cup draw…');
    this.deps.onEvent(this, { type: 'LINEUPS_REVEALED' });
    this.evaluate();
    this.changed();
  }

  /** Deterministic squad scores. They seed the cup, which starts after a short pause. */
  private evaluate() {
    const scores = this.participants.map((p) => {
      const l = this.lineups.get(p.userId)!;
      return {
        userId: p.userId,
        score: scoreSquad(
          p.squad,
          { formationId: l.formationId, slots: l.slots, tactic: l.tactic, custom: l.custom },
          {
            objectives: this.objectives.get(p.userId) ?? [],
            startingBudget: this.settings.startingBudget,
            budgetLeft: p.budget,
            squadSize: this.rules.squadSize,
          },
        ),
      };
    });
    this.squadRankings = rankScores(scores);
    this.evaluatedAt = this.deps.clock.now();
    this.resultsAt = this.evaluatedAt + this.rules.evaluationMs;
    this.evaluationTimer = this.deps.clock.setTimeout(() => this.startCup(), this.rules.evaluationMs);
  }

  private startCup() {
    this.evaluationTimer = null;
    this.resultsAt = null;
    if (this.phase !== 'FINAL_EVALUATION' || !this.squadRankings) return;
    const teams: CupTeam[] = this.squadRankings.map((r) => {
      const p = this.participants.find((x) => x.userId === r.userId)!;
      const l = this.lineups.get(r.userId)!;
      const f = resolveFormation(l)!;
      const byId = new Map(p.squad.map((e) => [e.player.id, e.player]));
      return {
        userId: r.userId,
        name: p.username,
        seed: r.rank,
        score: r,
        formationId: l.formationId === CUSTOM_FORMATION_ID ? f.name : l.formationId,
        xi: l.slots.map((id, i) => ({ player: byId.get(id!)!, role: f.slots[i].role })),
      };
    });
    this.cup = new Cup({
      teams,
      rules: this.rules,
      clock: this.deps.clock,
      seed: this.gameSeed,
      isPresent: (id) => {
        const m = this.members.get(id);
        return !!m && m.connected && !m.away;
      },
      hooks: {
        onChange: () => this.changed(),
        onEvent: (e) => this.deps.onEvent(this, e),
        onFeed: (text, userId) => this.pushFeed('INFO', text, userId),
        onFinish: (summary) => this.finishGame(summary),
      },
    });
    this.phase = 'TOURNAMENT';
    this.pushFeed('INFO', '🏆 The cup draw is made — the best squads are seeded first');
    this.cup.start();
    this.changed();
  }

  /** Half-time team talk. */
  talk(userId: string, talk: TeamTalk) {
    this.assertOpen();
    if (!this.members.has(userId)) fail('NOT_IN_ROOM');
    if (this.phase !== 'TOURNAMENT' || !this.cup) fail('NOT_IN_MATCH');
    this.cup.talk(userId, talk);
  }

  /** Touchline shout during a match. */
  shout(userId: string, shout: Shout) {
    this.assertOpen();
    if (!this.members.has(userId)) fail('NOT_IN_ROOM');
    if (this.phase !== 'TOURNAMENT' || !this.cup) fail('NOT_IN_MATCH');
    this.cup.shout(userId, shout);
  }

  /** Everyone left: finish the game straight away so it still counts. */
  private finishNow() {
    if (this.phase === 'SQUAD_BUILDING') this.finalizeLineups();
    if (this.phase === 'FINAL_EVALUATION') {
      this.evaluationTimer?.cancel();
      this.startCup();
    }
    if (this.phase === 'TOURNAMENT') this.cup?.fastForward();
  }

  /** The cup is over: final positions, ratings, badges, the write-up — then the results screen. */
  private finishGame(summary: CupSummary) {
    if (this.phase !== 'TOURNAMENT' || !this.squadRankings) return;
    const byUser = new Map(this.squadRankings.map((r) => [r.userId, r]));
    const order = summary.placements.filter((id) => byUser.has(id));
    for (const r of this.squadRankings) if (!order.includes(r.userId)) order.push(r.userId);
    this.rankings = order.map((id, i) => ({
      ...byUser.get(id)!,
      rank: i + 1,
      squadRank: byUser.get(id)!.rank,
      cupFinish: this.cup?.finishFor(id),
    }));
    const rankings = this.rankings;

    if (this.settings.mode === 'RANKED' && !this.ratings) {
      // Never guess ratings: without the real starting ratings this game doesn't move ELO.
      this.pushFeed('INFO', 'Ratings could not be loaded — ELO was not changed for this game');
    } else if (this.settings.mode === 'RANKED') {
      this.ratingChanges = computeEloChanges(
        rankings.map((r) => ({
          userId: r.userId,
          rank: r.rank,
          elo: this.ratings?.[r.userId]?.elo ?? ELO_CONFIG.initial,
          games: this.ratings?.[r.userId]?.games ?? 0,
        })),
      );
    }

    const seasonChampion = this.recordSeason(rankings);
    const achievements = gameAchievements({
      mode: this.settings.mode,
      startingBudget: this.settings.startingBudget,
      managers: this.participants.map((p) => {
        const l = this.lineups.get(p.userId)!;
        return {
          userId: p.userId,
          score: rankings.find((r) => r.userId === p.userId)!,
          squad: p.squad,
          lineup: { formationId: l.formationId, slots: l.slots, tactic: l.tactic, custom: l.custom },
          eloBefore: this.ratingChanges?.find((c) => c.userId === p.userId)?.before,
        };
      }),
    });
    const add = (userId: string, key: string) => {
      const keys = (achievements[userId] ??= []);
      if (!keys.includes(key)) keys.push(key);
    };
    for (const [userId, keys] of Object.entries(cupAchievements(summary))) for (const k of keys) add(userId, k);
    const stats = this.auction?.stats();
    for (const s of stats?.steals ?? []) add(s.userId, 'thief');
    for (const p of this.participants) {
      if (p.squad.some((e) => stats?.mysteryIds.has(e.player.id) && e.via === 'AUCTION' && e.player.overall >= 85)) add(p.userId, 'mystery_gem');
    }
    if (seasonChampion) add(seasonChampion, 'season_champion');
    this.achievements = achievements;

    this.report = buildMatchReport(
      rankings,
      this.participants.map((p) => ({ userId: p.userId, username: p.username, squad: p.squad })),
      { outbid: stats?.outbid, steals: stats?.steals, cup: summary, startingBudget: this.settings.startingBudget },
    );
    this.requestCommentary();
    const gameId = this.gameId!;
    const ratingChanges = this.ratingChanges;
    this.persist(() => this.deps.store.gameFinished(gameId, rankings, ratingChanges, achievements, summary));
    this.showResults();
  }

  /** Season mode: add this game's points. Returns the season champion if the season just ended. */
  private recordSeason(rankings: RankedScore[]): string | null {
    if (this.settings.seasonLength <= 1) return null;
    const s = this.season;
    s.played++;
    for (const r of rankings) {
      const username = this.participants.find((p) => p.userId === r.userId)?.username ?? 'Manager';
      const row = s.table.get(r.userId) ?? { username, points: 0, wins: 0, played: 0, lastRank: 99 };
      row.username = username;
      row.points += SEASON_POINTS[r.rank - 1] ?? 0;
      row.wins += r.rank === 1 ? 1 : 0;
      row.played++;
      row.lastRank = r.rank;
      s.table.set(r.userId, row);
    }
    if (s.played < this.settings.seasonLength) return null;
    s.championId = this.seasonTable()[0]?.userId ?? null;
    if (s.championId) this.pushFeed('INFO', `👑 ${s.table.get(s.championId)!.username} is the season champion!`, s.championId);
    return s.championId;
  }

  private seasonTable() {
    return [...this.season.table]
      .map(([userId, r]) => ({ userId, ...r }))
      .sort((a, b) => b.points - a.points || b.wins - a.wins || a.lastRank - b.lastRank || a.username.localeCompare(b.username));
  }

  private seasonView(): SeasonView | null {
    if (this.settings.seasonLength <= 1) return null;
    const s = this.season;
    return {
      length: this.settings.seasonLength,
      played: s.played,
      table: this.seasonTable().map(({ userId, username, points, wins, played }) => ({ userId, username, points, wins, played })),
      finished: s.played >= this.settings.seasonLength,
      championId: s.championId,
    };
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
    const name = this.members.get(winner.userId)?.username ?? this.participants.find((p) => p.userId === winner.userId)?.username ?? 'A manager';
    this.pushFeed('INFO', `🏆 ${name} wins the game`, winner.userId);
    this.deps.onEvent(this, { type: 'RESULTS', winnerId: winner.userId });
    this.changed();
  }

  // ------------------------------------------------------------ rematch

  /** Host: back to the lobby for another game (the next game of a season, or a fresh one). */
  rematch(userId: string) {
    this.assertOpen();
    if (!this.members.has(userId)) fail('NOT_IN_ROOM');
    if (userId !== this.hostId) fail('NOT_HOST');
    if (this.phase !== 'RESULTS') fail('WRONG_PHASE');
    const seasonOver = this.settings.seasonLength > 1 && this.season.played >= this.settings.seasonLength;
    if (seasonOver) this.season = { played: 0, table: new Map(), championId: null };
    this.auction?.dispose();
    this.auction = null;
    this.cup?.dispose();
    this.cup = null;
    this.participants = [];
    this.lineups.clear();
    this.squadTimer?.cancel();
    this.squadTimer = null;
    this.squadEndsAt = null;
    this.evaluationTimer?.cancel();
    this.evaluationTimer = null;
    this.resultsAt = null;
    this.squadRankings = null;
    this.rankings = null;
    this.evaluatedAt = null;
    this.report = null;
    this.ratings = null;
    this.ratingChanges = null;
    this.achievements = {};
    this.commentary = { status: 'disabled', text: null };
    this.objectives.clear();
    this.gameId = null;
    this.startsAt = null;
    this.phase = 'LOBBY';
    // Managers who already left don't hold a seat in the next game.
    for (const m of [...this.members.values()]) {
      m.ready = false;
      if (!m.connected) this.removeMember(m, `${m.username} left`, true);
    }
    if (this.closed) return;
    const next = this.settings.seasonLength > 1 ? ` — game ${this.season.played + 1} of ${this.settings.seasonLength}` : '';
    this.pushFeed('INFO', `${seasonOver ? 'New season! ' : ''}Back to the lobby for another game${next}`);
    this.updateLobbyPhase();
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

  private removeMember(m: Member, text: string, feed = true) {
    m.removalTimer?.cancel();
    this.clearAway(m);
    this.members.delete(m.userId);
    if (feed) this.pushFeed('LEAVE', text, m.userId);
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
    this.evaluationTimer?.cancel();
    for (const m of this.members.values()) {
      m.removalTimer?.cancel();
      m.awayTimer?.cancel();
    }
    this.auction?.dispose();
    this.cup?.dispose();
    const gameId = this.gameId;
    this.persist(() => this.deps.store.roomClosed(this.id, status, gameId));
    this.deps.onClosed(this, reason);
  }

  private assertOpen() {
    if (this.closed) fail('ROOM_NOT_FOUND');
  }

  private updateLobbyPhase() {
    if (!this.isLobby) return;
    this.phase = this.members.size >= this.rules.minPlayers ? 'LOBBY' : 'WAITING_FOR_PLAYERS';
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
    const rules = this.rules;
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
          away: m.connected && m.away,
          budget: p ? p.budget : null,
          squad: p ? p.squad : [],
          maxBid: p && this.auction ? this.auction.bidLimit(p) : null,
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
        inactiveLotsToRemove: rules.inactiveLotsToRemove,
        starCap: { ...rules.starCap },
        maxPrice: rules.maxPrice,
        reservePerSlot: rules.reservePerSlot,
      },
      myObjectives: viewerId && this.objectives.has(viewerId) ? [...this.objectives.get(viewerId)!] : null,
      members,
      spectators: this.spectators.size,
      startsAt: this.startsAt,
      auction: this.auction ? this.auction.view(viewerId) : null,
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
      tournament: this.cup ? this.cup.view(viewerId) : null,
      season: this.seasonView(),
      results:
        this.phase === 'RESULTS' && this.rankings && this.report
          ? {
              rankings: this.rankings,
              evaluatedAt: this.evaluatedAt!,
              report: this.report,
              commentary: this.commentary,
              ratingChanges: this.ratingChanges,
              achievements: this.achievements,
            }
          : null,
      resultsAt: this.phase === 'FINAL_EVALUATION' ? this.resultsAt : null,
      feed: this.feed.slice(-40),
      trades: viewerId && this.auction && !this.auction.isComplete ? this.auction.tradesFor(viewerId) : [],
      serverTime: this.deps.clock.now(),
      version: this.version,
    };
  }
}

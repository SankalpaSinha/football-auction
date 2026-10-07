import { randomUUID } from 'node:crypto';
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

  get memberCount() {
    return this.members.size;
  }

  get isLobby() {
    return LOBBY_PHASES.includes(this.phase);
  }

  /** While the auction is live a manager cannot hop into another room. */
  get isLive() {
    return this.phase === 'STARTING' || this.phase === 'AUCTION' || this.phase === 'PLAYER_SOLD';
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
          this.phase = 'SQUAD_BUILDING';
          const snapshot = this.participants.map((p) => ({ ...p, squad: [...p.squad] }));
          this.persist(() => this.deps.store.auctionCompleted(gameId, snapshot));
          this.changed();
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

  view(): RoomView {
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
      feed: this.feed.slice(-40),
      serverTime: this.deps.clock.now(),
      version: this.version,
    };
  }
}

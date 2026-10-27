import {
  DEFAULT_VALUATION,
  DEADLINE_SURCHARGE,
  estimateValue,
  isStarPlayer,
  MARKET_EVENT_IDS,
  MARKET_EVENTS,
  maxBidForCoins,
  mysteryCard,
  NO_TWISTS,
  POSITION_GROUP,
  POWER_CARDS,
  surchargedPrice,
  type PositionGroup,
  verdictFor,
  type AuctionView,
  type DraftView,
  type FeedKind,
  type GameEvent,
  type GameFormat,
  type GameRules,
  type LotKind,
  type LotOutcome,
  type LotResultView,
  type LotView,
  type MarketEventId,
  type PlayerCard,
  type PowerCardId,
  type SquadEntry,
  type TradeOffer,
  type Twists,
  type ValuationConfig,
} from '@fa/shared';
import { randomUUID } from 'node:crypto';
import type { Clock, TimerHandle } from './clock';
import { fail, GameError } from './errors';

export interface Participant {
  userId: string;
  username: string;
  startingBudget: number;
  budget: number;
  squad: SquadEntry[];
}

export interface BidRecord {
  userId: string;
  amount: number;
  at: number;
}

export interface LotRecord {
  lotNumber: number;
  player: PlayerCard;
  outcome: LotOutcome;
  winnerId: string | null;
  price: number | null;
  estimatedValue: number;
  openedAt: number | null;
  closedAt: number;
  bids: BidRecord[];
}

export interface StealRecord {
  lotNumber: number;
  userId: string;
  fromId: string;
  playerId: string;
  price: number;
}

export interface AuctionHooks {
  /** Something observable changed — rebroadcast state. */
  onChange(): void;
  onEvent(event: GameEvent): void;
  onFeed(kind: FeedKind, text: string, extra?: { userId?: string; amount?: number }): void;
  onLotClosed(record: LotRecord): void;
  onComplete(): void;
  /**
   * A manager sat out too many lots in a row. They keep their squad but are treated as
   * away (lots stop waiting for them) until they come back.
   */
  onSatOut?(userId: string): void;
  /** A manager let a player go; the player is back in the pool. `budget` is theirs afterwards (a Refund pays some back). */
  onReleased?(userId: string, playerId: string, budget: number): void;
  /** Players and coins changed hands. */
  onTraded?(record: TradeRecord): void;
  /** Someone used a Steal card. */
  onStolen?(record: StealRecord, budgets: { userId: string; budget: number }[]): void;
  /** Budgets changed outside a sale (sponsor money). */
  onBudgets?(budgets: { userId: string; budget: number }[]): void;
}

export interface TradeRecord {
  fromId: string;
  toId: string;
  coins: number;
  /** Every player that moved, with the price it now carries for its new manager. */
  moves: { playerId: string; toUserId: string; price: number }[];
}

export interface AuctionOptions {
  /** Players in the order they should come up (already shuffled). */
  order: PlayerCard[];
  participants: Participant[];
  rules: GameRules;
  lotDurationMs: number;
  antiSnipe: boolean;
  clock: Clock;
  isConnected(userId: string): boolean;
  /** Connected and actually looking at the game (not backgrounded). Defaults to isConnected. */
  isPresent?(userId: string): boolean;
  hooks: AuctionHooks;
  valuation?: ValuationConfig;
  format?: GameFormat;
  twists?: Twists;
  /** Seeded random source (market events, draft order). */
  rand?: () => number;
}

interface OpenLot {
  lotNumber: number;
  kind: LotKind;
  player: PlayerCard;
  reoffer: boolean;
  openedAt: number;
  endsAt: number;
  durationMs: number;
  currentBid: number | null;
  highestBidderId: string | null;
  skipped: Set<string>;
  bids: BidRecord[];
  extended: boolean;
  /** Managers who could bid when the lot opened (only they can be idle on it). */
  eligible: Set<string>;
  /** Frozen out by a Freeze card. */
  frozen: Set<string>;
  /** Sealed lots: each manager's one secret choice (null amount = pass). */
  sealed: Map<string, { amount: number | null; at: number }>;
  /** Opening bid for this lot (bargain hour lowers it). */
  opening: number;
  /** Winning bid × this = price (deadline day). */
  surcharge: number;
}

type Stage = 'IDLE' | 'LOT_OPEN' | 'REVEAL' | 'FREE_PICK' | 'DRAFT' | 'COMPLETE';

const GROUP_NAMES: Record<PositionGroup, string> = { GK: 'goalkeepers', DEF: 'defenders', MID: 'midfielders', ATT: 'attackers' };

/** Minimum time left on the clock when a paused lot resumes. */
const RESUME_MIN_MS = 5_000;
/** A draft pick never resumes (or reconnects) with less than this on the clock. */
const DRAFT_MIN_MS = 10_000;
/** Extra reveal time after a steal, so everyone sees it. */
const STEAL_REVEAL_MS = 2_200;

/**
 * Server-authoritative auction. Owns the lot queue, the clock for each lot,
 * bids, skips and squad/budget changes. Clients only ever send intents; every
 * rule is enforced here.
 */
export class Auction {
  private readonly rules: GameRules;
  private readonly clock: Clock;
  private readonly hooks: AuctionHooks;
  private readonly valuation: ValuationConfig;
  private readonly participants: Map<string, Participant>;
  private readonly poolSize: number;
  private readonly format: GameFormat;
  private readonly twists: Twists;
  private readonly rand: () => number;

  private queue: PlayerCard[];
  /** Offered once with no buyer — re-offered after the main queue. */
  private unsold: PlayerCard[] = [];
  /** Offered twice with no buyer — only used for auto-fill. */
  private leftover: PlayerCard[] = [];
  private reofferRound = false;
  /** Released/returned players: their next offer counts as a first offer, even in the re-offer round. */
  private returned = new Set<string>();

  private stage: Stage = 'IDLE';
  private lot: OpenLot | null = null;
  private lastResult: LotResultView | null = null;
  private timer: TimerHandle | null = null;
  private lotCounter = 0;
  private pausedRemainingMs: number | null = null;
  /** Fires when the only managers who still need players have been gone too long. */
  private absentTimer: TimerHandle | null = null;
  private freePick: { userId: string; endsAt: number } | null = null;
  private freePickTimer: TimerHandle | null = null;
  /** A pause every manager agreed to. Freezes the open lot (or the next one, if agreed during a reveal). */
  private hold: { by: string; until: number } | null = null;
  private holdTimer: TimerHandle | null = null;
  private pauseVote: { requestedBy: string; endsAt: number; yes: Set<string> } | null = null;
  private pauseVoteTimer: TimerHandle | null = null;
  private lastPauseRequest = new Map<string, number>();
  /** Lots in a row each manager let run out without acting. */
  private idleLots = new Map<string, number>();
  private readonly startingParticipants: number;
  private trades = new Map<string, TradeOffer & { timer: TimerHandle }>();
  /** Host's choice of which positions come up next (null = any). */
  private focus: PositionGroup | null = null;
  /** Power cards each manager still holds. */
  private cards = new Map<string, Set<PowerCardId>>();
  /** Market event in force: covers lots startLot..endLot. */
  private market: { id: MarketEventId; startLot: number; endLot: number } | null = null;
  private nextMarketLot: number;
  /** Snake draft state. */
  private draft: { order: string[]; pick: number; total: number; userId: string; endsAt: number; pausedRemainingMs: number | null } | null = null;
  /** Times each manager lost the top bid to someone else (for the awards). */
  private outbid = new Map<string, number>();
  private steals: StealRecord[] = [];
  /** Players who came up as mystery lots. */
  private mysteryIds = new Set<string>();

  constructor(private readonly opts: AuctionOptions) {
    this.rules = opts.rules;
    this.clock = opts.clock;
    this.hooks = opts.hooks;
    this.valuation = opts.valuation ?? DEFAULT_VALUATION;
    this.participants = new Map(opts.participants.map((p) => [p.userId, p]));
    this.queue = opts.order.slice();
    this.poolSize = opts.order.length;
    this.startingParticipants = opts.participants.length;
    this.format = opts.format ?? 'CLASSIC';
    // Twists are an auction thing: a draft has no lots to twist.
    this.twists = this.format === 'DRAFT' ? { ...NO_TWISTS } : (opts.twists ?? { ...NO_TWISTS });
    this.rand = opts.rand ?? Math.random;
    this.nextMarketLot = this.rules.marketEvery;
    if (this.twists.cards) for (const p of opts.participants) this.cards.set(p.userId, new Set(['FREEZE', 'STEAL', 'REFUND']));
  }

  // ------------------------------------------------------------------ public

  get isComplete() {
    return this.stage === 'COMPLETE';
  }

  get isRevealing() {
    return this.stage === 'REVEAL';
  }

  get isPaused() {
    return this.pausedRemainingMs !== null;
  }

  start() {
    if (this.stage !== 'IDLE') return;
    if (this.format === 'DRAFT') return this.startDraft();
    this.openNextLot();
  }

  bid(userId: string, lotNumber: number, amount: number) {
    const lot = this.requireOpenLot(lotNumber);
    const p = this.participants.get(userId) ?? fail('NOT_PARTICIPANT');
    if (lot.kind === 'SEALED') fail('SEALED_LOT');
    if (this.isPaused) fail('AUCTION_PAUSED');
    if (this.clock.now() >= lot.endsAt) fail('LOT_CLOSED');
    if (lot.frozen.has(userId)) fail('FROZEN');
    if (lot.skipped.has(userId)) fail('ALREADY_SKIPPED');
    if (lot.highestBidderId === userId) fail('ALREADY_HIGHEST');
    if (!Number.isInteger(amount) || amount <= 0) fail('BAD_REQUEST');
    this.assertCanAcquire(p, lot.player);
    if (amount < this.minNextBid(lot)) fail('BID_TOO_LOW', `Minimum bid is ${this.minNextBid(lot)}.`);
    this.assertAffordable(p, lot, amount);

    const now = this.clock.now();
    const previousBidderId = lot.highestBidderId;
    lot.currentBid = amount;
    lot.highestBidderId = userId;
    lot.bids.push({ userId, amount, at: now });
    this.idleLots.delete(userId);
    if (previousBidderId && previousBidderId !== userId) this.outbid.set(previousBidderId, (this.outbid.get(previousBidderId) ?? 0) + 1);

    const snipe = this.rules.antiSnipe;
    if (this.opts.antiSnipe && snipe.enabled && lot.endsAt - now <= snipe.thresholdMs) {
      lot.endsAt = now + snipe.extendToMs;
      lot.extended = true;
      this.scheduleLotTimer();
      this.hooks.onEvent({ type: 'EXTENDED', lotNumber: lot.lotNumber, endsAt: lot.endsAt });
      this.hooks.onFeed('EXTENDED', `Late bid! Clock reset to ${Math.round(snipe.extendToMs / 1000)}s`);
    }

    this.hooks.onFeed('BID', `${p.username} bid ${amount}`, { userId, amount });
    this.hooks.onEvent({ type: 'BID', lotNumber: lot.lotNumber, userId, amount, previousBidderId });
    if (!this.closeIfNobodyCanBid()) this.hooks.onChange();
  }

  /** Sealed lots: one secret bid (or null to pass). The highest bid wins when everyone has chosen or time runs out. */
  sealedBid(userId: string, lotNumber: number, amount: number | null) {
    const lot = this.requireOpenLot(lotNumber);
    const p = this.participants.get(userId) ?? fail('NOT_PARTICIPANT');
    if (lot.kind !== 'SEALED') fail('NOT_SEALED');
    if (this.isPaused) fail('AUCTION_PAUSED');
    if (this.clock.now() >= lot.endsAt) fail('LOT_CLOSED');
    if (lot.frozen.has(userId)) fail('FROZEN');
    if (lot.sealed.has(userId)) fail('ALREADY_DECIDED');
    if (amount !== null) {
      if (!Number.isInteger(amount) || amount <= 0) fail('BAD_REQUEST');
      this.assertCanAcquire(p, lot.player);
      if (amount < lot.opening) fail('BID_TOO_LOW', `Minimum bid is ${lot.opening}.`);
      this.assertAffordable(p, lot, amount);
    }
    lot.sealed.set(userId, { amount, at: this.clock.now() });
    this.idleLots.delete(userId);
    this.hooks.onFeed('INFO', `🔒 ${p.username} has made their choice`, { userId });
    if (!this.closeIfNobodyCanBid()) this.hooks.onChange();
  }

  skip(userId: string, lotNumber: number) {
    const lot = this.requireOpenLot(lotNumber);
    if (lot.kind === 'SEALED') return this.sealedBid(userId, lotNumber, null);
    const p = this.participants.get(userId) ?? fail('NOT_PARTICIPANT');
    if (lot.skipped.has(userId)) fail('ALREADY_SKIPPED');
    if (lot.highestBidderId === userId) fail('ALREADY_HIGHEST');
    lot.skipped.add(userId);
    this.idleLots.delete(userId);
    this.hooks.onFeed('SKIP', `${p.username} skipped`, { userId });
    if (!this.closeIfNobodyCanBid()) this.hooks.onChange();
  }

  /** Called by the room whenever a participant connects or disconnects. */
  connectivityChanged() {
    if (this.stage === 'FREE_PICK') return this.checkPickerPresence();
    if (this.stage === 'DRAFT') {
      this.checkPauseVote();
      return this.checkDraftPresence();
    }
    // Whoever left can't hold up a pause vote.
    if (this.checkPauseVote()) return;
    if (this.stage !== 'LOT_OPEN') return;
    // An agreed pause only ends when someone resumes it (or it times out).
    if (this.hold) return;
    if (this.isPaused) {
      if (this.anyActiveConnected()) this.resume();
      return;
    }
    if (!this.closeIfNobodyCanBid()) this.hooks.onChange();
  }

  dispose() {
    this.timer?.cancel();
    this.timer = null;
    this.holdTimer?.cancel();
    this.holdTimer = null;
    this.pauseVoteTimer?.cancel();
    this.pauseVoteTimer = null;
    this.clearTrades();
    this.absentTimer?.cancel();
    this.absentTimer = null;
    this.freePickTimer?.cancel();
    this.freePickTimer = null;
  }

  // ---------------------------------------------------------------- pause

  private get pausable() {
    return this.stage === 'LOT_OPEN' || this.stage === 'REVEAL' || this.stage === 'DRAFT';
  }

  /** Ask to pause. It only happens if every connected manager agrees. */
  requestPause(userId: string) {
    const p = this.participants.get(userId) ?? fail('NOT_PARTICIPANT');
    if (!this.pausable) fail('WRONG_PHASE');
    if (this.hold || this.isPaused) fail('AUCTION_PAUSED');
    if (this.pauseVote) fail('PAUSE_VOTE_OPEN');
    const now = this.clock.now();
    const last = this.lastPauseRequest.get(userId);
    if (last !== undefined && now - last < this.rules.pauseRequestCooldownMs) fail('PAUSE_COOLDOWN');
    this.lastPauseRequest.set(userId, now);
    this.pauseVote = { requestedBy: userId, endsAt: now + this.rules.pauseVoteMs, yes: new Set([userId]) };
    this.pauseVoteTimer = this.clock.setTimeout(() => {
      this.pauseVoteTimer = null;
      this.endPauseVote(false, 'not everyone answered');
    }, this.rules.pauseVoteMs);
    this.hooks.onFeed('INFO', `${p.username} asked to pause — everyone has to agree`, { userId });
    this.hooks.onEvent({ type: 'PAUSE_VOTE', userId });
    if (!this.checkPauseVote()) this.hooks.onChange();
  }

  votePause(userId: string, agree: boolean) {
    const p = this.participants.get(userId) ?? fail('NOT_PARTICIPANT');
    const vote = this.pauseVote ?? fail('NO_PAUSE_VOTE');
    if (!agree) return this.endPauseVote(false, `${p.username} said no`);
    vote.yes.add(userId);
    if (!this.checkPauseVote()) this.hooks.onChange();
  }

  /** Any manager can end an agreed pause. */
  resumeHold(userId: string) {
    const p = this.participants.get(userId) ?? fail('NOT_PARTICIPANT');
    if (!this.hold) fail('NOT_PAUSED');
    this.endHold(`${p.username} resumed the auction`);
  }

  /** Everyone who has to agree: every connected manager. */
  private pauseVoters() {
    return [...this.participants.values()].filter((p) => this.opts.isConnected(p.userId)).map((p) => p.userId);
  }

  /** Passes the vote once every connected manager has said yes. */
  private checkPauseVote(): boolean {
    const vote = this.pauseVote;
    if (!vote) return false;
    const voters = this.pauseVoters();
    if (voters.length === 0 || voters.some((id) => !vote.yes.has(id))) return false;
    this.endPauseVote(true);
    return true;
  }

  private endPauseVote(passed: boolean, reason?: string) {
    const vote = this.pauseVote;
    if (!vote) return;
    this.pauseVote = null;
    this.pauseVoteTimer?.cancel();
    this.pauseVoteTimer = null;
    if (!passed || !this.pausable) {
      this.hooks.onFeed('INFO', `No pause — ${reason ?? 'the auction moved on'}`);
      return this.hooks.onChange();
    }
    this.hold = { by: vote.requestedBy, until: this.clock.now() + this.rules.maxPauseMs };
    // An agreed pause supersedes the offline auto-pause countdown; resume() re-checks presence.
    this.absentTimer?.cancel();
    this.absentTimer = null;
    this.holdTimer = this.clock.setTimeout(() => {
      this.holdTimer = null;
      this.endHold('Pause time is up — auction resumed');
    }, this.rules.maxPauseMs);
    // During a reveal the next lot opens frozen instead.
    if (this.stage === 'LOT_OPEN' && !this.isPaused) this.freezeLot();
    if (this.stage === 'DRAFT') this.freezeDraft();
    this.hooks.onFeed('INFO', `Auction paused — everyone agreed (max ${Math.round(this.rules.maxPauseMs / 60_000)} min)`);
    this.hooks.onEvent({ type: 'PAUSED' });
    this.hooks.onChange();
  }

  private endHold(text: string) {
    if (!this.hold) return;
    this.clearHold();
    this.hooks.onEvent({ type: 'RESUMED' });
    if (this.stage === 'LOT_OPEN' && this.isPaused) return this.resume(text);
    if (this.stage === 'DRAFT' && this.draft && this.draft.pausedRemainingMs !== null) {
      this.hooks.onFeed('INFO', text);
      return this.resumeDraft();
    }
    this.hooks.onFeed('INFO', text);
    this.hooks.onChange();
  }

  private clearHold() {
    this.hold = null;
    this.holdTimer?.cancel();
    this.holdTimer = null;
    this.pauseVote = null;
    this.pauseVoteTimer?.cancel();
    this.pauseVoteTimer = null;
  }

  // ------------------------------------------------------------- power cards

  private requireCard(userId: string, card: PowerCardId) {
    if (!this.twists.cards || !this.cards.get(userId)?.has(card)) fail('NO_CARD');
  }

  private useCard(userId: string, card: PowerCardId) {
    this.cards.get(userId)?.delete(card);
  }

  /** ❄️ Freeze: one rival can't bid on the current player. */
  freeze(userId: string, lotNumber: number, targetId: string) {
    const lot = this.requireOpenLot(lotNumber);
    const p = this.participants.get(userId) ?? fail('NOT_PARTICIPANT');
    this.requireCard(userId, 'FREEZE');
    if (this.isPaused) fail('AUCTION_PAUSED');
    if (this.clock.now() >= lot.endsAt) fail('LOT_CLOSED');
    const target = this.participants.get(targetId);
    if (!target || target === p || lot.frozen.has(targetId) || this.slotsLeft(target) <= 0) fail('BAD_TARGET');
    if (lot.skipped.has(targetId)) fail('BAD_TARGET', `${target.username} already skipped this player.`);
    if (lot.sealed.has(targetId)) fail('BAD_TARGET', `${target.username} has already made their sealed choice.`);
    this.useCard(userId, 'FREEZE');
    lot.frozen.add(targetId);
    this.idleLots.delete(userId);
    this.hooks.onFeed('INFO', `❄️ ${p.username} froze ${target.username} out of this lot`, { userId });
    this.hooks.onEvent({ type: 'FROZEN', byId: userId, targetId });
    if (!this.closeIfNobodyCanBid()) this.hooks.onChange();
  }

  /** 🦹 Steal: right after a sale, pay the same price and take the player. */
  steal(userId: string, lotNumber: number) {
    const r = this.lastResult;
    const now = this.clock.now();
    if (this.stage !== 'REVEAL' || !r || r.lotNumber !== lotNumber || r.outcome !== 'SOLD' || !r.winnerId) fail('STEAL_CLOSED');
    if (r.stealUntil === null || now > r.stealUntil) fail('STEAL_CLOSED');
    const thief = this.participants.get(userId) ?? fail('NOT_PARTICIPANT');
    this.requireCard(userId, 'STEAL');
    if (userId === r.winnerId) fail('CANT_STEAL', 'He’s already yours!');
    const owner = this.participants.get(r.winnerId) ?? fail('STEAL_CLOSED');
    const entry = owner.squad.find((e) => e.player.id === r.player.id) ?? fail('STEAL_CLOSED');
    const player = entry.player;
    const price = entry.price;
    if (this.slotsLeft(thief) <= 0) fail('SQUAD_FULL');
    if (isStarPlayer(player) && this.starCount(thief) >= this.rules.starCap.max) fail('STAR_LIMIT');
    const shortfall = this.gkShortfall(thief);
    if (player.position !== 'GK' && shortfall > 0 && this.slotsLeft(thief) <= shortfall) fail('NEED_GOALKEEPER');
    if (price > this.maxBid(thief)) fail('CANT_STEAL', `You need ${price} coins to spare to match the price.`);
    const ownerAfter: Participant = { ...owner, budget: owner.budget + price, squad: owner.squad.filter((e) => e !== entry) };
    const thiefAfter: Participant = { ...thief, budget: thief.budget - price, squad: [...thief.squad, entry] };
    if (this.completable([ownerAfter, thiefAfter]) !== 'OK') fail('CANT_STEAL', 'That would leave a squad that can’t be completed.');

    this.useCard(userId, 'STEAL');
    owner.squad = ownerAfter.squad;
    owner.budget = ownerAfter.budget;
    thief.squad = thiefAfter.squad;
    thief.budget = thiefAfter.budget;
    r.winnerId = userId;
    r.stolenFrom = owner.userId;
    r.stealUntil = null;
    const record: StealRecord = { lotNumber, userId, fromId: owner.userId, playerId: player.id, price };
    this.steals.push(record);
    this.idleLots.delete(userId);
    this.hooks.onFeed('INFO', `🦹 STOLEN! ${thief.username} matched ${price} and took ${player.shortName} from ${owner.username}`, { userId, amount: price });
    this.hooks.onEvent({ type: 'STOLEN', byId: userId, fromId: owner.userId, playerId: player.id });
    this.hooks.onStolen?.(record, [
      { userId: owner.userId, budget: owner.budget },
      { userId: thief.userId, budget: thief.budget },
    ]);
    this.pruneTrades();
    // Give everyone a moment to see it.
    if (r.nextAt - now < STEAL_REVEAL_MS) {
      r.nextAt = now + STEAL_REVEAL_MS;
      this.timer?.cancel();
      this.timer = this.clock.setTimeout(() => this.openNextLot(), STEAL_REVEAL_MS);
    }
    this.hooks.onChange();
  }

  /** 💸 Refund: release a player and get half the price back. */
  refund(userId: string, playerId: string) {
    this.requireCard(userId, 'REFUND');
    this.release(userId, playerId, true);
  }

  // ------------------------------------------------- release and trades

  /** Trades and releases only happen during normal bidding (not free pick or a draft). */
  private assertDealsOpen() {
    if (this.stage !== 'LOT_OPEN' && this.stage !== 'REVEAL') fail('WRONG_PHASE');
  }

  /** Let a player go: the slot opens up and the player goes back into the pool. No refund — unless it's a Refund card (half back). */
  release(userId: string, playerId: string, refund = false) {
    this.assertDealsOpen();
    const p = this.participants.get(userId) ?? fail('NOT_PARTICIPANT');
    const entry = p.squad.find((e) => e.player.id === playerId) ?? fail('NOT_YOUR_PLAYER');
    const back = refund ? Math.floor(entry.price / 2) : 0;
    const after: Participant = { ...p, budget: p.budget + back, squad: p.squad.filter((e) => e !== entry) };
    if (after.budget < this.slotsLeft(after) * this.rules.reservePerSlot) fail('CANT_REFILL');
    this.assertStillCovers([after], entry.player.position === 'GK' ? 1 : 0);
    if (refund) this.useCard(userId, 'REFUND');
    p.squad = after.squad;
    p.budget = after.budget;
    this.returnToPool([entry.player]);
    this.idleLots.delete(userId);
    this.hooks.onFeed(
      'INFO',
      refund ? `💸 ${p.username} released ${entry.player.shortName} and got ${back} back` : `${p.username} released ${entry.player.shortName} (no refund)`,
      { userId },
    );
    this.hooks.onEvent({ type: 'RELEASED', userId, playerId });
    this.hooks.onReleased?.(userId, playerId, p.budget);
    this.pruneTrades();
    this.afterSquadChange();
  }

  proposeTrade(fromId: string, input: { toId: string; give: string[]; take: string[]; coins: number }) {
    this.assertDealsOpen();
    const from = this.participants.get(fromId) ?? fail('NOT_PARTICIPANT');
    const to = this.participants.get(input.toId) ?? fail('NOT_PARTICIPANT');
    if (from === to) fail('BAD_REQUEST');
    const give = [...new Set(input.give)];
    const take = [...new Set(input.take)];
    if (give.length + take.length === 0) fail('TRADE_EMPTY');
    const max = this.rules.maxTradePlayers;
    if (give.length > max || take.length > max) fail('BAD_REQUEST', `At most ${max} players each side.`);
    for (const t of this.trades.values()) if (t.fromId === fromId && t.toId === to.userId) fail('TRADE_PENDING');
    const now = this.clock.now();
    const offer: TradeOffer = {
      id: randomUUID(),
      fromId,
      toId: to.userId,
      give,
      take,
      coins: input.coins,
      createdAt: now,
      expiresAt: now + this.rules.tradeOfferMs,
    };
    this.checkTrade(offer);
    const timer = this.clock.setTimeout(() => {
      if (this.trades.delete(offer.id)) this.hooks.onChange();
    }, this.rules.tradeOfferMs);
    this.trades.set(offer.id, { ...offer, timer });
    this.idleLots.delete(fromId);
    this.hooks.onEvent({ type: 'TRADE_OFFER', fromId, toId: to.userId });
    this.hooks.onChange();
  }

  respondTrade(userId: string, tradeId: string, accept: boolean) {
    const t = this.trades.get(tradeId);
    if (!t || t.toId !== userId) fail('TRADE_NOT_FOUND');
    this.idleLots.delete(userId);
    if (!accept) {
      this.dropTrade(t.id);
      this.hooks.onEvent({ type: 'TRADE_DECLINED', fromId: t.fromId, toId: t.toId });
      return this.hooks.onChange();
    }
    this.assertDealsOpen();
    try {
      this.checkTrade(t);
    } catch (e) {
      this.dropTrade(t.id);
      this.hooks.onChange();
      throw e;
    }
    this.dropTrade(t.id);
    this.executeTrade(t);
  }

  cancelTrade(userId: string, tradeId: string) {
    const t = this.trades.get(tradeId);
    if (!t || t.fromId !== userId) fail('TRADE_NOT_FOUND');
    this.dropTrade(t.id);
    this.hooks.onChange();
  }

  /** Offers involving a manager (only they see them). */
  tradesFor(userId: string): TradeOffer[] {
    return [...this.trades.values()]
      .filter((t) => t.fromId === userId || t.toId === userId)
      .map(({ timer: _timer, ...t }) => ({ ...t, give: [...t.give], take: [...t.take] }));
  }

  private dropTrade(id: string) {
    this.trades.get(id)?.timer.cancel();
    this.trades.delete(id);
  }

  private clearTrades() {
    for (const t of this.trades.values()) t.timer.cancel();
    this.trades.clear();
  }

  /** Forget offers whose players or managers have gone elsewhere. */
  private pruneTrades() {
    for (const t of [...this.trades.values()]) {
      const from = this.participants.get(t.fromId);
      const to = this.participants.get(t.toId);
      const owns = (p: Participant | undefined, ids: string[]) => !!p && ids.every((id) => p.squad.some((e) => e.player.id === id));
      if (!owns(from, t.give) || !owns(to, t.take)) this.dropTrade(t.id);
    }
  }

  /** Both squads as they would be after the trade (throws if it breaks a rule). */
  private checkTrade(t: TradeOffer): { from: Participant; to: Participant; moved: SquadEntry[][] } {
    const from = this.participants.get(t.fromId) ?? fail('TRADE_INVALID', 'That manager has left the game.');
    const to = this.participants.get(t.toId) ?? fail('TRADE_INVALID', 'That manager has left the game.');
    const pick = (p: Participant, ids: string[]) =>
      ids.map((id) => p.squad.find((e) => e.player.id === id) ?? fail('TRADE_INVALID', `${p.username} no longer has that player.`));
    const out = pick(from, t.give);
    const back = pick(to, t.take);
    const fromAfter: Participant = {
      ...from,
      budget: from.budget - t.coins,
      squad: [...from.squad.filter((e) => !out.includes(e)), ...back],
    };
    const toAfter: Participant = {
      ...to,
      budget: to.budget + t.coins,
      squad: [...to.squad.filter((e) => !back.includes(e)), ...out],
    };
    for (const p of [fromAfter, toAfter]) {
      if (p.squad.length > this.rules.squadSize) fail('TRADE_INVALID', `${p.username} would have more than ${this.rules.squadSize} players.`);
      const cap = this.rules.starCap;
      if (this.starCount(p) > cap.max) fail('TRADE_INVALID', `${p.username} would have more than ${cap.max} star players.`);
      if (p.budget < this.slotsLeft(p) * this.rules.reservePerSlot) {
        fail('TRADE_INVALID', `${p.username} wouldn’t have enough coins left to complete their squad.`);
      }
    }
    this.assertStillCovers([fromAfter, toAfter]);
    return { from: fromAfter, to: toAfter, moved: [out, back] };
  }

  /**
   * Squad changes mid-lot must keep the game sound: every squad can still get a
   * keeper, and whoever holds the top bid can still pay for (and fit) the player.
   */
  private assertStillCovers(changed: Participant[], keepersReturning = 0) {
    const state = (p: Participant) => changed.find((c) => c.userId === p.userId) ?? p;
    let shortfall = 0;
    for (const original of this.participants.values()) {
      const p = state(original);
      const need = this.gkShortfall(p);
      if (need > 0 && this.slotsLeft(p) < need) fail('TRADE_INVALID', `${p.username} would be left without a goalkeeper.`);
      if (this.slotsLeft(p) > 0) shortfall += need;
    }
    const lot = this.lot;
    // The keeper on the block only helps if it isn't heading to someone who already has one.
    const topAfter = lot?.highestBidderId ? state(this.participants.get(lot.highestBidderId)!) : null;
    const lotKeeper =
      this.stage === 'LOT_OPEN' && lot?.player.position === 'GK' && (!topAfter || this.gkShortfall(topAfter) > 0) ? 1 : 0;
    if (shortfall > this.availableGoalkeepers() + lotKeeper + keepersReturning) fail('TRADE_INVALID', 'Not enough goalkeepers would be left for everyone.');
    // Every squad must stay completable within the star cap. The player on the block
    // goes to the top bidder, or stays available if nobody has bid.
    const open = this.stage === 'LOT_OPEN' ? lot : null;
    const states = [...changed];
    if (open?.highestBidderId) {
      const top = states.find((c) => c.userId === open.highestBidderId) ?? this.participants.get(open.highestBidderId)!;
      const withLot = { ...top, squad: [...top.squad, { player: open.player } as SquadEntry] };
      const i = states.findIndex((c) => c.userId === top.userId);
      if (i >= 0) states[i] = withLot;
      else states.push(withLot);
    }
    if (this.completable(states, undefined, open && !open.highestBidderId ? open.player : undefined) !== 'OK') {
      fail('TRADE_INVALID', 'That would leave a squad that can’t be completed within the rules.');
    }
    if (this.stage === 'LOT_OPEN' && lot?.highestBidderId && lot.currentBid !== null) {
      const top = changed.find((c) => c.userId === lot.highestBidderId);
      if (top) {
        const starBlocked = isStarPlayer(lot.player) && this.starCount(top) >= this.rules.starCap.max;
        const fits =
          this.slotsLeft(top) > 0 && !starBlocked && !(lot.player.position !== 'GK' && this.gkShortfall(top) >= this.slotsLeft(top));
        if (!fits || this.maxBid(top) < surchargedPrice(lot.currentBid, lot.surcharge)) {
          fail('TRADE_INVALID', `${top.username} holds the top bid and couldn’t take that player afterwards.`);
        }
      }
    }
  }

  private executeTrade(t: TradeOffer) {
    const from = this.participants.get(t.fromId)!;
    const to = this.participants.get(t.toId)!;
    const { from: fromAfter, to: toAfter, moved } = this.checkTrade(t);
    const [out, back] = moved;
    // What each side gave up (players at their price + coins) becomes the price of what it got.
    const reprice = (incoming: SquadEntry[], outgoing: SquadEntry[], coinsPaid: number) => {
      const basis = Math.max(0, outgoing.reduce((s, e) => s + e.price, 0) + coinsPaid);
      const weight = incoming.reduce((s, e) => s + Math.max(1, e.estimatedValue), 0);
      let left = basis;
      return incoming.map((e, i) => {
        const last = i === incoming.length - 1;
        const price = last ? left : Math.min(left, Math.round((basis * Math.max(1, e.estimatedValue)) / weight));
        left -= price;
        return { ...e, price, via: 'TRADE' as const };
      });
    };
    const toFrom = reprice(back, out, t.coins);
    const toTo = reprice(out, back, -t.coins);
    from.budget = fromAfter.budget;
    to.budget = toAfter.budget;
    from.squad = [...from.squad.filter((e) => !out.includes(e)), ...toFrom];
    to.squad = [...to.squad.filter((e) => !back.includes(e)), ...toTo];

    const names = (es: SquadEntry[]) => es.map((e) => e.player.shortName).join(', ');
    const parts = [
      out.length ? `${names(out)} → ${to.username}` : '',
      back.length ? `${names(back)} → ${from.username}` : '',
      t.coins > 0 ? `${from.username} pays ${t.coins}` : t.coins < 0 ? `${to.username} pays ${-t.coins}` : '',
    ].filter(Boolean);
    this.hooks.onFeed('INFO', `🤝 Trade: ${parts.join(' · ')}`, { userId: from.userId });
    this.hooks.onEvent({ type: 'TRADED', fromId: from.userId, toId: to.userId });
    this.hooks.onTraded?.({
      fromId: from.userId,
      toId: to.userId,
      coins: t.coins,
      moves: [
        ...toFrom.map((e) => ({ playerId: e.player.id, toUserId: from.userId, price: e.price })),
        ...toTo.map((e) => ({ playerId: e.player.id, toUserId: to.userId, price: e.price })),
      ],
    });
    this.pruneTrades();
    this.afterSquadChange();
  }

  /** A squad changed mid-lot: maybe nobody can bid any more. */
  private afterSquadChange() {
    if (this.stage === 'LOT_OPEN' && this.closeIfNobodyCanBid()) return;
    this.hooks.onChange();
  }

  // ------------------------------------------------------------- free pick

  get inFreePick() {
    return this.stage === 'FREE_PICK';
  }

  get inDraft() {
    return this.stage === 'DRAFT';
  }

  /** Everyone still available (free pick and the draft show this list). Best first. */
  availablePlayers(): PlayerCard[] {
    return [...this.queue, ...this.unsold, ...this.leftover].sort(
      (a, b) => b.overall - a.overall || a.id.localeCompare(b.id),
    );
  }

  /** Free pick (the last manager who still needs players) or a draft pick. */
  pick(userId: string, playerId: string) {
    if (this.stage === 'DRAFT') return this.draftPick(userId, playerId);
    if (this.stage !== 'FREE_PICK' || !this.freePick) fail('WRONG_PHASE');
    if (this.freePick.userId !== userId) fail('NOT_YOUR_PICK');
    const p = this.participants.get(userId) ?? fail('NOT_PARTICIPANT');
    const player = this.availablePlayers().find((c) => c.id === playerId) ?? fail('PLAYER_UNAVAILABLE');
    this.assertCanAcquire(p, player);
    this.takePick(p, player);
  }

  private startFreePick(p: Participant) {
    this.clearHold();
    this.clearTrades();
    this.stage = 'FREE_PICK';
    this.lot = null;
    this.lastResult = null;
    this.freePick = { userId: p.userId, endsAt: this.clock.now() + this.rules.freePickMs };
    this.scheduleFreePickTimer();
    this.hooks.onFeed(
      'INFO',
      `Everyone else is full — ${p.username} now picks their last ${this.slotsLeft(p)} player${this.slotsLeft(p) === 1 ? '' : 's'}`,
      { userId: p.userId },
    );
    this.checkPickerPresence();
    this.hooks.onChange();
  }

  private scheduleFreePickTimer() {
    this.freePickTimer?.cancel();
    const fp = this.freePick!;
    this.freePickTimer = this.clock.setTimeout(() => this.onFreePickTimeout(), fp.endsAt - this.clock.now());
  }

  /** Out of time: pick the best available player that fits for them and carry on. */
  private onFreePickTimeout() {
    this.freePickTimer = null;
    if (this.stage !== 'FREE_PICK' || !this.freePick) return;
    const p = this.participants.get(this.freePick.userId)!;
    const best = this.autoChoice(p);
    if (!best) {
      this.autoFill();
      return this.complete();
    }
    this.hooks.onFeed('AUTO', `Time’s up — ${best.shortName} picked for ${p.username}`, { userId: p.userId });
    this.takePick(p, best);
  }

  /** The best available player this manager may take, favouring the positions they're short of. */
  private autoChoice(p: Participant): PlayerCard | undefined {
    const pool = this.availablePlayers();
    const size = this.rules.squadSize;
    const target: Record<PositionGroup, number> = {
      GK: size <= 11 ? 1 : 2,
      DEF: Math.round((size * 6) / 18),
      MID: Math.round((size * 6) / 18),
      ATT: 0,
    };
    target.ATT = Math.max(1, size - target.GK - target.DEF - target.MID);
    const have: Record<PositionGroup, number> = { GK: 0, DEF: 0, MID: 0, ATT: 0 };
    for (const e of p.squad) have[POSITION_GROUP[e.player.position]]++;
    const groups = (['GK', 'DEF', 'MID', 'ATT'] as PositionGroup[]).sort((a, b) => target[b] - have[b] - (target[a] - have[a]));
    for (const g of groups) {
      if (target[g] - have[g] <= 0) break;
      const best = pool.find((c) => POSITION_GROUP[c.position] === g && this.canTake(p, c));
      if (best) return best;
    }
    return pool.find((c) => this.canTake(p, c));
  }

  private takePick(p: Participant, player: PlayerCard) {
    this.removeFromPool(player);
    const price = Math.min(this.rules.openingBid, p.budget);
    const estimatedValue = this.valueOf(player);
    const lotNumber = ++this.lotCounter;
    p.budget -= price;
    p.squad.push({ player, price, via: 'PICK', lotNumber, estimatedValue });
    this.hooks.onFeed('SOLD', `${p.username} picked ${player.shortName} for ${price}`, { userId: p.userId, amount: price });
    this.hooks.onEvent({ type: 'PICKED', userId: p.userId, playerId: player.id });
    this.hooks.onLotClosed({
      lotNumber,
      player,
      outcome: 'PICKED',
      winnerId: p.userId,
      price,
      estimatedValue,
      openedAt: null,
      closedAt: this.clock.now(),
      bids: [],
    });
    if (this.slotsLeft(p) <= 0) return this.complete();
    this.freePick = { userId: p.userId, endsAt: this.clock.now() + this.rules.freePickMs };
    this.scheduleFreePickTimer();
    this.hooks.onChange();
  }

  private removeFromPool(player: PlayerCard) {
    for (const list of [this.queue, this.unsold, this.leftover]) {
      const i = list.findIndex((c) => c.id === player.id);
      if (i >= 0) list.splice(i, 1);
    }
  }

  /** Picker offline too long → their remaining slots are auto-completed. */
  private checkPickerPresence() {
    if (this.stage !== 'FREE_PICK' || !this.freePick) return;
    if (this.opts.isConnected(this.freePick.userId)) {
      this.absentTimer?.cancel();
      this.absentTimer = null;
      return;
    }
    if (this.absentTimer) return;
    this.absentTimer = this.clock.setTimeout(() => {
      this.absentTimer = null;
      if (this.stage !== 'FREE_PICK' || !this.freePick || this.opts.isConnected(this.freePick.userId)) return;
      this.hooks.onFeed('INFO', 'The picker is away — their squad was completed automatically');
      this.autoFill();
      this.complete();
    }, this.rules.absentAutoFillMs);
  }

  // ---------------------------------------------------------- snake draft

  private draftPicker(k: number) {
    const d = this.draft!;
    const n = d.order.length;
    const i = k % n;
    return Math.floor(k / n) % 2 === 0 ? d.order[i] : d.order[n - 1 - i];
  }

  private startDraft() {
    const ids = [...this.participants.keys()];
    // Seeded shuffle for who picks first.
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    this.stage = 'DRAFT';
    this.draft = { order: ids, pick: 0, total: ids.length * this.rules.squadSize, userId: ids[0], endsAt: 0, pausedRemainingMs: null };
    const first = this.participants.get(ids[0])!;
    this.hooks.onFeed('INFO', `🐍 Snake draft — ${first.username} picks first. The order reverses every round.`, { userId: first.userId });
    this.nextDraftTurn();
  }

  private nextDraftTurn() {
    const d = this.draft!;
    while (d.pick < d.total && this.slotsLeft(this.participants.get(this.draftPicker(d.pick))!) <= 0) d.pick++;
    if (d.pick >= d.total || this.allSquadsFull()) return this.complete();
    if (!this.availablePlayers().some((c) => this.canTake(this.participants.get(this.draftPicker(d.pick))!, c))) {
      this.autoFill();
      return this.complete();
    }
    d.userId = this.draftPicker(d.pick);
    d.endsAt = this.clock.now() + this.opts.lotDurationMs;
    d.pausedRemainingMs = null;
    if (this.hold) this.freezeDraft();
    else {
      this.scheduleDraftTimer();
      this.checkDraftPresence(false);
    }
    this.hooks.onChange();
  }

  private scheduleDraftTimer() {
    this.timer?.cancel();
    const d = this.draft!;
    const pick = d.pick;
    this.timer = this.clock.setTimeout(() => this.onDraftTimeout(pick), Math.max(0, d.endsAt - this.clock.now()));
  }

  private freezeDraft() {
    const d = this.draft;
    if (!d || d.pausedRemainingMs !== null) return;
    d.pausedRemainingMs = Math.max(0, d.endsAt - this.clock.now());
    this.timer?.cancel();
    this.timer = null;
  }

  private resumeDraft() {
    const d = this.draft!;
    d.endsAt = this.clock.now() + Math.max(d.pausedRemainingMs ?? 0, DRAFT_MIN_MS);
    d.pausedRemainingMs = null;
    this.scheduleDraftTimer();
    this.checkDraftPresence(false);
    this.hooks.onChange();
  }

  /** An offline picker gets a few seconds, not the full clock; coming back restores some time. */
  private checkDraftPresence(notify = true) {
    const d = this.draft;
    if (this.stage !== 'DRAFT' || !d || d.pausedRemainingMs !== null) return;
    const now = this.clock.now();
    if (!this.opts.isConnected(d.userId)) {
      if (d.endsAt - now > this.rules.draftOfflinePickMs) {
        d.endsAt = now + this.rules.draftOfflinePickMs;
        this.scheduleDraftTimer();
      }
    } else if (d.endsAt - now < DRAFT_MIN_MS) {
      d.endsAt = now + DRAFT_MIN_MS;
      this.scheduleDraftTimer();
    }
    if (notify) this.hooks.onChange();
  }

  private onDraftTimeout(pick: number) {
    const d = this.draft;
    if (this.stage !== 'DRAFT' || !d || d.pick !== pick || d.pausedRemainingMs !== null) return;
    if (this.clock.now() < d.endsAt) return this.scheduleDraftTimer();
    const p = this.participants.get(d.userId)!;
    const choice = this.autoChoice(p);
    if (!choice) {
      this.autoFill();
      return this.complete();
    }
    this.hooks.onFeed('AUTO', `Time’s up — ${choice.shortName} picked for ${p.username}`, { userId: p.userId });
    this.takeDraftPick(p, choice);
  }

  private draftPick(userId: string, playerId: string) {
    const d = this.draft!;
    if (d.userId !== userId) fail('NOT_YOUR_PICK');
    if (d.pausedRemainingMs !== null) fail('AUCTION_PAUSED');
    const p = this.participants.get(userId) ?? fail('NOT_PARTICIPANT');
    const player = this.availablePlayers().find((c) => c.id === playerId) ?? fail('PLAYER_UNAVAILABLE');
    this.assertCanAcquire(p, player);
    this.takeDraftPick(p, player);
  }

  private takeDraftPick(p: Participant, player: PlayerCard) {
    const d = this.draft!;
    this.removeFromPool(player);
    const lotNumber = ++this.lotCounter;
    const estimatedValue = this.valueOf(player);
    p.squad.push({ player, price: 0, via: 'PICK', lotNumber, estimatedValue });
    const round = Math.floor(d.pick / d.order.length) + 1;
    this.hooks.onFeed('SOLD', `Round ${round}: ${p.username} takes ${player.shortName}`, { userId: p.userId });
    this.hooks.onEvent({ type: 'PICKED', userId: p.userId, playerId: player.id });
    this.hooks.onLotClosed({
      lotNumber,
      player,
      outcome: 'PICKED',
      winnerId: p.userId,
      price: 0,
      estimatedValue,
      openedAt: null,
      closedAt: this.clock.now(),
      bids: [],
    });
    d.pick++;
    this.nextDraftTurn();
  }

  // ----------------------------------------------------------------- money

  /** Highest price (in coins) a participant can currently pay (budget minus squad-completion reserve). */
  maxBid(p: Participant): number {
    const slots = this.slotsLeft(p);
    if (slots <= 0) return 0;
    return Math.max(0, p.budget - (slots - 1) * this.rules.reservePerSlot);
  }

  /** Highest bid a participant can make on this lot (surcharge and price cap applied). */
  private bidCap(p: Participant, lot: OpenLot | null): number {
    let a = maxBidForCoins(this.maxBid(p), lot?.surcharge ?? 1);
    if (this.rules.maxPrice !== null) a = Math.min(a, this.rules.maxPrice);
    return a;
  }

  /** What the UI shows as "max bid" right now. */
  bidLimit(p: Participant): number {
    return this.bidCap(p, this.stage === 'LOT_OPEN' ? this.lot : null);
  }

  private assertAffordable(p: Participant, lot: OpenLot, amount: number) {
    const cap = this.rules.maxPrice;
    if (cap !== null && amount > cap) fail('PRICE_CAP', `Players cost at most ${cap} coins in this mode.`);
    const price = surchargedPrice(amount, lot.surcharge);
    if (price > p.budget) fail('OVER_BUDGET');
    if (price > this.maxBid(p)) {
      fail('RESERVE_REQUIRED', `Keep enough to fill your squad — your max bid is ${this.bidCap(p, lot)}.`);
    }
  }

  private valueOf(player: PlayerCard) {
    return estimateValue(player, this.opts.participants[0]?.startingBudget ?? 1000, this.valuation, this.rules.maxPrice);
  }

  getParticipant(userId: string) {
    return this.participants.get(userId);
  }

  /** Facts for the awards and achievements. */
  stats() {
    return {
      outbid: Object.fromEntries(this.outbid),
      steals: [...this.steals],
      mysteryIds: new Set(this.mysteryIds),
    };
  }

  view(viewerId?: string): AuctionView {
    const lot = this.lot;
    const lotView: LotView | null = lot && {
      lotNumber: lot.lotNumber,
      kind: lot.kind,
      player: lot.kind === 'MYSTERY' ? mysteryCard(lot.lotNumber, lot.player.position, lot.player.nation) : lot.player,
      openedAt: lot.openedAt,
      endsAt: lot.endsAt,
      pausedRemainingMs: this.pausedRemainingMs,
      durationMs: lot.durationMs,
      currentBid: lot.currentBid,
      highestBidderId: lot.highestBidderId,
      minNextBid: this.minNextBid(lot),
      skippedBy: [...lot.skipped],
      bidCount: lot.bids.length,
      extended: lot.extended,
      reoffer: lot.reoffer,
      frozen: [...lot.frozen],
      surcharge: lot.surcharge,
      sealed:
        lot.kind === 'SEALED'
          ? {
              decided: [...lot.sealed.keys()],
              mine: viewerId && lot.sealed.has(viewerId) ? (lot.sealed.get(viewerId)!.amount ?? 'PASS') : null,
            }
          : null,
    };
    const d = this.draft;
    let draft: DraftView | null = null;
    if (this.stage === 'DRAFT' && d) {
      const upcoming: string[] = [];
      for (let k = d.pick + 1; k < d.total && upcoming.length < 6; k++) upcoming.push(this.draftPicker(k));
      draft = {
        userId: d.userId,
        endsAt: d.endsAt,
        pausedRemainingMs: d.pausedRemainingMs,
        pick: d.pick + 1,
        totalPicks: d.total,
        round: Math.floor(d.pick / d.order.length) + 1,
        upcoming,
      };
    }
    // Between lots, "current" is the lot about to open.
    const current = lot?.lotNumber ?? this.lotCounter + 1;
    const market =
      this.market && current <= this.market.endLot && this.stage !== 'COMPLETE'
        ? { id: this.market.id, lotsLeft: this.market.endLot - current + 1 }
        : null;
    return {
      poolSize: this.poolSize,
      lotsOpened: this.lotCounter,
      remainingInQueue: this.queue.length,
      unsoldWaiting: this.unsold.length,
      reofferRound: this.reofferRound,
      paused: this.isPaused || d?.pausedRemainingMs != null,
      focus: this.focus,
      hold: this.hold && { ...this.hold },
      pauseVote: this.pauseVote && {
        requestedBy: this.pauseVote.requestedBy,
        endsAt: this.pauseVote.endsAt,
        yes: [...this.pauseVote.yes],
        waitingOn: this.pauseVoters().filter((id) => !this.pauseVote!.yes.has(id)),
      },
      idleLots: Object.fromEntries(this.idleLots),
      lot: lotView,
      lastResult: this.stage === 'REVEAL' && this.lastResult ? { ...this.lastResult } : null,
      freePick:
        this.stage === 'FREE_PICK' && this.freePick
          ? {
              userId: this.freePick.userId,
              endsAt: this.freePick.endsAt,
              picksLeft: this.slotsLeft(this.participants.get(this.freePick.userId)!),
            }
          : null,
      cards: Object.fromEntries([...this.cards].map(([id, set]) => [id, [...set]])),
      market,
      draft,
    };
  }

  // ----------------------------------------------------------------- rules

  private slotsLeft(p: Participant) {
    return this.rules.squadSize - p.squad.length;
  }

  private starCount(p: Participant) {
    return p.squad.filter((s) => isStarPlayer(s.player)).length;
  }

  private gkCount(p: Participant) {
    return p.squad.filter((s) => s.player.position === 'GK').length;
  }

  private gkShortfall(p: Participant) {
    return Math.max(0, this.rules.minGoalkeepers - this.gkCount(p));
  }

  private minNextBid(lot: OpenLot) {
    return lot.currentBid === null ? lot.opening : lot.currentBid + this.rules.minIncrement;
  }

  /** Squad-composition rules that keep every squad completable. */
  private assertCanAcquire(p: Participant, player: PlayerCard) {
    const slots = this.slotsLeft(p);
    if (slots <= 0) fail('SQUAD_FULL');
    const cap = this.rules.starCap;
    if (isStarPlayer(player) && this.starCount(p) >= cap.max) {
      fail('STAR_LIMIT', `You already have ${cap.max} star players — that’s the limit.`);
    }
    const shortfall = this.gkShortfall(p);
    const isGk = player.position === 'GK';
    if (!isGk && shortfall > 0 && slots <= shortfall) fail('NEED_GOALKEEPER');
    if (isGk && shortfall === 0) {
      // Buying an extra keeper must not leave someone else unable to get one.
      let othersNeeding = 0;
      for (const other of this.participants.values()) {
        if (other !== p && this.slotsLeft(other) > 0) othersNeeding += this.gkShortfall(other);
      }
      if (this.availableGoalkeepers() < othersNeeding) fail('GOALKEEPER_LIMIT');
    }
    // Taking this player must leave every squad completable within the star cap.
    const after: Participant = { ...p, squad: [...p.squad, { player } as SquadEntry] };
    const verdict = this.completable([after], player.id);
    if (verdict !== 'OK') fail(verdict);
  }

  private canTake(p: Participant, player: PlayerCard) {
    try {
      this.assertCanAcquire(p, player);
      return true;
    } catch (e) {
      if (e instanceof GameError) return false;
      throw e;
    }
  }

  /**
   * Count-based check that every squad that still needs players can be completed
   * legally (star cap + keepers) from what's left in the pool. `changed` replaces
   * those managers' squads; `excludeId` is taken out of the pool, `extra` added.
   */
  private completable(changed: Participant[], excludeId?: string, extra?: PlayerCard): 'OK' | 'GOALKEEPER_LIMIT' | 'POOL_RESERVED' {
    const { max } = this.rules.starCap;
    const pool = { total: 0, nonStar: 0, gk: 0, nonStarGk: 0 };
    const add = (c: PlayerCard) => {
      const star = isStarPlayer(c);
      pool.total++;
      if (!star) pool.nonStar++;
      if (c.position === 'GK') {
        pool.gk++;
        if (!star) pool.nonStarGk++;
      }
    };
    for (const list of [this.queue, this.unsold, this.leftover]) for (const c of list) if (c.id !== excludeId) add(c);
    if (extra) add(extra);
    const need = { total: 0, nonStar: 0, gk: 0, nonStarGk: 0 };
    for (const original of this.participants.values()) {
      const p = changed.find((c) => c.userId === original.userId) ?? original;
      const slots = this.slotsLeft(p);
      if (slots <= 0) continue;
      const starRoom = Math.max(0, max - this.starCount(p));
      const gk = Math.min(slots, this.gkShortfall(p));
      need.total += slots;
      need.nonStar += Math.max(0, slots - starRoom);
      need.gk += gk;
      // Managers at the star cap can only take a keeper rated below it.
      if (starRoom === 0) need.nonStarGk += gk;
    }
    if (need.gk > pool.gk || need.nonStarGk > pool.nonStarGk) return 'GOALKEEPER_LIMIT';
    if (need.total > pool.total || need.nonStar > pool.nonStar) return 'POOL_RESERVED';
    return 'OK';
  }

  /** Goalkeepers still obtainable after the current lot. */
  private availableGoalkeepers() {
    const count = (list: PlayerCard[]) => list.filter((c) => c.position === 'GK').length;
    return count(this.queue) + count(this.unsold) + count(this.leftover);
  }

  private canBidNow(p: Participant, lot: OpenLot) {
    if (!this.opts.isConnected(p.userId)) return false;
    if (lot.frozen.has(p.userId)) return false;
    if (lot.kind === 'SEALED') return !lot.sealed.has(p.userId) && this.canAfford(p, lot);
    if (lot.skipped.has(p.userId) || lot.highestBidderId === p.userId) return false;
    return this.canAfford(p, lot);
  }

  /** Squad rules and budget allow this manager to raise the bid (ignores connection). */
  private canAfford(p: Participant, lot: OpenLot) {
    if (!this.canTake(p, lot.player)) return false;
    return this.bidCap(p, lot) >= this.minNextBid(lot);
  }

  private anyActiveConnected() {
    for (const p of this.participants.values()) {
      if (this.slotsLeft(p) > 0 && this.opts.isConnected(p.userId)) return true;
    }
    return false;
  }

  private anyAcquirable() {
    const candidates = [...this.queue, ...this.unsold];
    for (const p of this.participants.values()) {
      if (this.slotsLeft(p) <= 0) continue;
      for (const c of candidates) if (this.canTake(p, c)) return true;
    }
    return false;
  }

  private allSquadsFull() {
    for (const p of this.participants.values()) if (this.slotsLeft(p) > 0) return false;
    return true;
  }

  // ------------------------------------------------------------- lot flow

  private requireOpenLot(lotNumber: number): OpenLot {
    if (this.stage !== 'LOT_OPEN' || !this.lot) fail('NO_ACTIVE_LOT');
    if (this.lot.lotNumber !== lotNumber) fail('STALE_LOT');
    return this.lot;
  }

  /**
   * Ends the lot early when nobody else can (or wants to) bid: everyone
   * skipped, can't afford the next bid, or is disconnected. Pauses instead if
   * every manager who still needs players is offline.
   */
  private closeIfNobodyCanBid(): boolean {
    const lot = this.lot;
    if (this.stage !== 'LOT_OPEN' || !lot || this.isPaused) return false;
    const highestConnected = lot.highestBidderId !== null && this.opts.isConnected(lot.highestBidderId);
    if (!this.anyActiveConnected() && !highestConnected) {
      this.pause();
      return true;
    }
    for (const p of this.participants.values()) if (this.canBidNow(p, lot)) return false;
    this.closeLot();
    return true;
  }

  /** Stop the lot clock where it is. */
  private freezeLot() {
    const lot = this.lot!;
    this.pausedRemainingMs = Math.max(0, lot.endsAt - this.clock.now());
    this.timer?.cancel();
    this.timer = null;
  }

  private pause() {
    this.freezeLot();
    this.hooks.onFeed('INFO', 'Auction paused — waiting for managers to reconnect');
    this.absentTimer?.cancel();
    this.absentTimer = this.clock.setTimeout(() => this.onAbsentTimeout(), this.rules.absentAutoFillMs);
    this.hooks.onChange();
  }

  /** Still nobody back: complete the missing squads so the game can finish. */
  private onAbsentTimeout() {
    this.absentTimer = null;
    if (!this.isPaused || this.stage !== 'LOT_OPEN' || this.anyActiveConnected()) return;
    const lot = this.lot!;
    // The current lot goes back into the pool before auto-filling.
    (lot.reoffer ? this.leftover : this.unsold).push(lot.player);
    this.lot = null;
    this.pausedRemainingMs = null;
    this.hooks.onFeed('INFO', 'Absent managers’ squads were completed automatically');
    this.autoFill();
    this.complete();
  }

  private resume(text = 'Auction resumed') {
    this.absentTimer?.cancel();
    this.absentTimer = null;
    const lot = this.lot!;
    lot.endsAt = this.clock.now() + Math.max(this.pausedRemainingMs ?? 0, RESUME_MIN_MS);
    this.pausedRemainingMs = null;
    this.scheduleLotTimer();
    this.hooks.onFeed('INFO', text);
    if (!this.closeIfNobodyCanBid()) this.hooks.onChange();
  }

  private scheduleLotTimer() {
    this.timer?.cancel();
    const lot = this.lot!;
    const lotNumber = lot.lotNumber;
    this.timer = this.clock.setTimeout(() => this.onLotTimer(lotNumber), lot.endsAt - this.clock.now());
  }

  private onLotTimer(lotNumber: number) {
    const lot = this.lot;
    if (this.stage !== 'LOT_OPEN' || !lot || lot.lotNumber !== lotNumber || this.isPaused) return;
    if (this.clock.now() < lot.endsAt) return this.scheduleLotTimer();
    this.closeLot(true);
  }

  private pickNext(): { player: PlayerCard; reoffer: boolean } | null {
    if (this.queue.length === 0 && !this.reofferRound && this.unsold.length > 0) {
      this.queue = this.unsold;
      this.unsold = [];
      this.reofferRound = true;
      this.hooks.onFeed('INFO', `Unsold players return to the auction (${this.queue.length})`);
    }

    // An urgently needed keeper comes first — even ahead of the host's position filter.
    if (this.someoneUrgentlyNeedsGoalkeeper()) {
      const idx = this.queue.findIndex((c) => c.position === 'GK');
      if (idx >= 0) {
        const [gk] = this.queue.splice(idx, 1);
        return { player: gk, reoffer: this.reofferRound && !this.returned.delete(gk.id) };
      }
      // A keeper passed over once gets one more chance; twice-unsold ones wait for auto-fill.
      const j = this.unsold.findIndex((c) => c.position === 'GK');
      if (j >= 0) return { player: this.unsold.splice(j, 1)[0], reoffer: true };
    }

    if (this.focus) {
      const g = this.focus;
      const idx = this.queue.findIndex((c) => POSITION_GROUP[c.position] === g);
      if (idx >= 0) {
        const [p] = this.queue.splice(idx, 1);
        return { player: p, reoffer: this.reofferRound && !this.returned.delete(p.id) };
      }
      // None of that position left in this round: back to everyone.
      this.focus = null;
      const later = !this.reofferRound && this.unsold.some((c) => POSITION_GROUP[c.position] === g);
      this.hooks.onFeed(
        'INFO',
        later
          ? `No more ${GROUP_NAMES[g]} this round (unsold ones come back later) — back to all positions`
          : `No more ${GROUP_NAMES[g]} left — back to all positions`,
      );
    }

    const player = this.queue.shift();
    return player ? { player, reoffer: this.reofferRound && !this.returned.delete(player.id) } : null;
  }

  /** Host control: auction only this kind of player for now (null = any). Applies from the next lot. */
  setFocus(group: PositionGroup | null) {
    if (this.stage !== 'LOT_OPEN' && this.stage !== 'REVEAL') fail('WRONG_PHASE');
    if (this.focus === group) return;
    this.focus = group;
    this.hooks.onFeed('HOST', group ? `Host: ${GROUP_NAMES[group]} only from the next player` : 'Host: back to all positions');
    this.hooks.onChange();
  }

  private someoneUrgentlyNeedsGoalkeeper() {
    for (const p of this.participants.values()) {
      const shortfall = this.gkShortfall(p);
      if (shortfall > 0 && this.slotsLeft(p) <= this.rules.gkUrgencySlots + shortfall - 1) return true;
    }
    return false;
  }

  /** Start or end market events as the lot count moves on. */
  private updateMarket(n: number) {
    if (this.market && n > this.market.endLot) {
      this.market = null;
      this.hooks.onFeed('INFO', 'The market is back to normal');
    }
    if (this.market || !this.twists.events || this.rules.marketEvery <= 0 || n < this.nextMarketLot) return;
    // With a price cap, surcharges and 1-coin openers don't mean anything.
    const choices = MARKET_EVENT_IDS.filter((id) => this.rules.maxPrice === null || id === 'QUICK_FIRE' || id === 'SPONSOR');
    const id = choices[Math.floor(this.rand() * choices.length)];
    const lots = id === 'SPONSOR' ? 1 : Math.max(1, this.rules.marketLots);
    this.market = { id, startLot: n, endLot: n + lots - 1 };
    this.nextMarketLot = n + lots + this.rules.marketEvery;
    const ev = MARKET_EVENTS[id];
    if (id === 'SPONSOR') {
      const start = this.opts.participants[0]?.startingBudget ?? 1000;
      const bonus = this.rules.maxPrice !== null ? 3 : Math.max(10, Math.round((start * 0.05) / 5) * 5);
      for (const p of this.participants.values()) p.budget += bonus;
      this.hooks.onFeed('INFO', `${ev.emoji} ${ev.label}: every manager gets ${bonus} coins`);
      this.hooks.onBudgets?.([...this.participants.values()].map((p) => ({ userId: p.userId, budget: p.budget })));
    } else {
      this.hooks.onFeed('INFO', `${ev.emoji} ${ev.label} for ${lots} lots — ${ev.blurb}`);
    }
    this.hooks.onEvent({ type: 'MARKET', id });
  }

  private openNextLot() {
    this.timer = null;
    if (this.allSquadsFull()) return this.complete();
    // Nothing left that anyone is allowed to buy (e.g. last slot must be a keeper and
    // none remain to auction) — skip the dead lots and complete squads now.
    if (!this.anyAcquirable()) {
      this.autoFill();
      return this.complete();
    }
    // Only one manager still needs players: nobody can bid against them — let them pick.
    const needy = [...this.participants.values()].filter((p) => this.slotsLeft(p) > 0);
    if (needy.length === 1 && this.startingParticipants > 1) return this.startFreePick(needy[0]);
    const next = this.pickNext();
    if (!next) {
      this.autoFill();
      return this.complete();
    }
    const now = this.clock.now();
    const lotNumber = this.lotCounter + 1;
    this.updateMarket(lotNumber);
    const ev = this.market?.id;
    const r = this.rules;
    let kind: LotKind = 'NORMAL';
    if (this.twists.mystery && r.mysteryEvery > 0 && lotNumber % r.mysteryEvery === 0 && !next.reoffer && !isStarPlayer(next.player)) {
      kind = 'MYSTERY';
    } else if (this.twists.sealed && r.sealedEvery > 0 && lotNumber % r.sealedEvery === Math.floor(r.sealedEvery / 2)) {
      kind = 'SEALED';
    }
    const duration = ev === 'QUICK_FIRE' ? Math.max(8_000, Math.round(this.opts.lotDurationMs / 2)) : this.opts.lotDurationMs;
    this.lotCounter = lotNumber;
    this.lot = {
      lotNumber,
      kind,
      player: next.player,
      reoffer: next.reoffer,
      openedAt: now,
      endsAt: now + duration,
      durationMs: duration,
      currentBid: null,
      highestBidderId: null,
      skipped: new Set(),
      bids: [],
      extended: false,
      eligible: new Set(),
      frozen: new Set(),
      sealed: new Map(),
      opening: ev === 'BARGAIN_HOUR' ? 1 : r.openingBid,
      surcharge: ev === 'DEADLINE_DAY' ? DEADLINE_SURCHARGE : 1,
    };
    if (kind === 'MYSTERY') {
      this.mysteryIds.add(next.player.id);
      this.hooks.onFeed('INFO', `🎁 Mystery lot! Only the position and nation are known`);
    } else if (kind === 'SEALED') {
      this.hooks.onFeed('INFO', `🔒 Sealed bids for ${next.player.shortName} — one secret bid each, highest wins`);
    }
    for (const p of this.participants.values()) if (this.canAfford(p, this.lot)) this.lot.eligible.add(p.userId);
    this.stage = 'LOT_OPEN';
    this.lastResult = null;
    this.scheduleLotTimer();
    this.hooks.onEvent({ type: 'LOT_OPEN', lotNumber: this.lot.lotNumber });
    if (this.hold) {
      // Agreed pause during the reveal: the new lot waits, full clock intact.
      this.freezeLot();
      return this.hooks.onChange();
    }
    if (!this.closeIfNobodyCanBid()) this.hooks.onChange();
  }

  /** Sealed lot: the highest secret bid that is still valid wins (earliest wins a tie). */
  private sealedWinner(lot: OpenLot): { winner: { userId: string; amount: number } | null; all: { userId: string; amount: number }[] } {
    const bids = [...lot.sealed]
      .filter(([, v]) => v.amount !== null)
      .map(([userId, v]) => ({ userId, amount: v.amount!, at: v.at }))
      .sort((a, b) => b.amount - a.amount || a.at - b.at);
    lot.bids = bids.map((b) => ({ userId: b.userId, amount: b.amount, at: b.at }));
    const valid = bids.find((b) => {
      const p = this.participants.get(b.userId);
      return !!p && this.canTake(p, lot.player) && surchargedPrice(b.amount, lot.surcharge) <= this.maxBid(p);
    });
    return { winner: valid ? { userId: valid.userId, amount: valid.amount } : null, all: bids.map(({ userId, amount }) => ({ userId, amount })) };
  }

  /** `timedOut`: the clock ran out (rather than everyone skipping or being unable to bid). */
  private closeLot(timedOut = false) {
    const lot = this.lot!;
    this.timer?.cancel();
    this.timer = null;
    const now = this.clock.now();
    const p = lot.player;
    const estimatedValue = this.valueOf(p);

    let outcome: LotOutcome;
    let winnerId: string | null = null;
    let price: number | null = null;
    let sealedBids: { userId: string; amount: number }[] | null = null;
    let top: { userId: string; amount: number } | null = null;
    if (lot.kind === 'SEALED') {
      const s = this.sealedWinner(lot);
      top = s.winner;
      sealedBids = s.all;
    } else if (lot.highestBidderId && lot.currentBid !== null) {
      top = { userId: lot.highestBidderId, amount: lot.currentBid };
    }

    if (top) {
      // The winner is whoever holds the top bid on the server — connected or not.
      const winner = this.participants.get(top.userId)!;
      outcome = 'SOLD';
      winnerId = winner.userId;
      price = surchargedPrice(top.amount, lot.surcharge);
      winner.budget -= price;
      winner.squad.push({ player: p, price, via: 'AUCTION', lotNumber: lot.lotNumber, estimatedValue });
      const extra = price !== top.amount ? ` (bid ${top.amount} +20%)` : '';
      this.hooks.onFeed('SOLD', `${p.shortName} SOLD to ${winner.username} for ${price}${extra}`, {
        userId: winner.userId,
        amount: price,
      });
      this.hooks.onEvent({ type: 'SOLD', lotNumber: lot.lotNumber, userId: winner.userId, amount: price });
    } else {
      outcome = 'UNSOLD';
      // In the re-offer round, a first-time-unsold player goes round once more.
      (lot.reoffer ? this.leftover : this.reofferRound ? this.queue : this.unsold).push(p);
      this.hooks.onFeed('UNSOLD', lot.kind === 'MYSTERY' ? `Nobody took the mystery player — it was ${p.shortName}!` : `${p.shortName} went unsold`);
      this.hooks.onEvent({ type: 'UNSOLD', lotNumber: lot.lotNumber });
    }

    // A steal window opens when someone else still holds a Steal card.
    const canSteal =
      outcome === 'SOLD' &&
      this.twists.cards &&
      [...this.participants.values()].some((x) => x.userId !== winnerId && this.cards.get(x.userId)?.has('STEAL') && this.slotsLeft(x) > 0);
    const stealUntil = canSteal ? now + this.rules.stealWindowMs : null;
    const revealMs =
      outcome === 'SOLD' ? Math.max(this.rules.soldRevealMs, canSteal ? this.rules.stealWindowMs + 700 : 0) : this.rules.unsoldRevealMs;
    this.lastResult = {
      lotNumber: lot.lotNumber,
      kind: lot.kind,
      player: p,
      outcome,
      winnerId,
      price,
      estimatedValue,
      verdict: price === null ? null : verdictFor(price, estimatedValue, this.valuation),
      nextAt: now + revealMs,
      sealedBids,
      stealUntil,
      stolenFrom: null,
    };
    this.lot = null;
    this.stage = 'REVEAL';
    this.hooks.onLotClosed({
      lotNumber: lot.lotNumber,
      player: p,
      outcome,
      winnerId,
      price,
      estimatedValue,
      openedAt: lot.openedAt,
      closedAt: now,
      bids: lot.bids,
    });
    this.hooks.onChange();
    this.timer = this.clock.setTimeout(() => this.openNextLot(), revealMs);
    if (timedOut) this.trackIdle(lot);
  }

  /**
   * A lot that ran out its clock while others played, without a bid or skip from
   * a manager who could have bid, counts as idle for them. Acting resets it.
   * Too many idle lots in a row → they're sat out (their squad stays; they can rejoin).
   */
  private trackIdle(lot: OpenLot) {
    const acted = new Set([...lot.bids.map((b) => b.userId), ...lot.skipped, ...lot.sealed.keys(), ...lot.frozen]);
    // A lot nobody touched is a quiet moment for everyone, not one person's fault.
    if (acted.size === 0) return;
    const limit = this.rules.inactiveLotsToRemove;
    const out: Participant[] = [];
    for (const p of this.participants.values()) {
      if (acted.has(p.userId)) {
        this.idleLots.delete(p.userId);
        continue;
      }
      // Offline managers keep their squad and can come back; only connected ones can be idle.
      // Away (screen locked / app in the background) counts as offline here too.
      const present = this.opts.isPresent ? this.opts.isPresent(p.userId) : this.opts.isConnected(p.userId);
      if (!lot.eligible.has(p.userId) || this.slotsLeft(p) <= 0 || !present) continue;
      const n = (this.idleLots.get(p.userId) ?? 0) + 1;
      this.idleLots.set(p.userId, n);
      if (n >= limit) out.push(p);
      else if (n === limit - 1) {
        this.hooks.onFeed('INFO', `${p.username} has sat out ${n} lots — one more and they're taken out of the game`, { userId: p.userId });
      }
    }
    if (out.length === 0) return;
    for (const p of out) {
      this.idleLots.delete(p.userId);
      this.hooks.onEvent({ type: 'REMOVED', userId: p.userId });
      this.hooks.onSatOut?.(p.userId);
    }
    this.checkPauseVote();
    this.hooks.onChange();
  }

  private returnToPool(players: PlayerCard[]) {
    for (const p of players) {
      this.queue.push(p);
      if (this.reofferRound) this.returned.add(p.id);
    }
  }

  /**
   * Last resort when the pool runs dry: give each incomplete squad the
   * lowest-rated remaining players at the opening price (affordable thanks to
   * the budget reserve), goalkeepers first where needed.
   */
  private autoFill() {
    const remaining = [...this.queue, ...this.unsold, ...this.leftover].sort(
      (a, b) => a.overall - b.overall || a.id.localeCompare(b.id),
    );
    this.queue = [];
    this.unsold = [];
    this.leftover = [];
    const now = this.clock.now();
    const draft = this.format === 'DRAFT';

    const take = (wantGk: boolean, p: Participant) => {
      const capped = this.starCount(p) >= this.rules.starCap.max;
      const allowed = (c: PlayerCard) => !capped || !isStarPlayer(c);
      const isPos = (c: PlayerCard) => (c.position === 'GK') === wantGk;
      // A keeper is a must; for outfield slots the star cap matters more than the position.
      const order = wantGk
        ? [(c: PlayerCard) => isPos(c) && allowed(c), isPos, allowed]
        : [(c: PlayerCard) => isPos(c) && allowed(c), allowed, isPos];
      let idx = -1;
      for (const test of order) if ((idx = remaining.findIndex(test)) >= 0) break;
      if (idx < 0) idx = 0;
      const player = remaining.splice(idx, 1)[0];
      if (!player) throw new Error('Auction pool exhausted — pool size validation failed');
      return player;
    };
    const assign = (p: Participant, player: PlayerCard) => {
      const price = draft ? 0 : Math.min(this.rules.openingBid, p.budget);
      const estimatedValue = this.valueOf(player);
      const lotNumber = ++this.lotCounter;
      p.budget -= price;
      p.squad.push({ player, price, via: 'AUTO', lotNumber, estimatedValue });
      this.hooks.onFeed('AUTO', `${player.shortName} auto-assigned to ${p.username} for ${price}`, {
        userId: p.userId,
        amount: price,
      });
      this.hooks.onLotClosed({
        lotNumber,
        player,
        outcome: 'AUTO_ASSIGNED',
        winnerId: p.userId,
        price,
        estimatedValue,
        openedAt: null,
        closedAt: now,
        bids: [],
      });
    };

    // Managers with the least star room pick first, so the players who aren't stars go to
    // those who can't take anyone else. Keepers first for everyone who lacks one, then outfielders.
    const starRoom = (p: Participant) => this.rules.starCap.max - this.starCount(p);
    const order = [...this.participants.values()].sort((a, b) => starRoom(a) - starRoom(b));
    for (const p of order) {
      while (this.gkShortfall(p) > 0 && this.slotsLeft(p) > 0) assign(p, take(true, p));
    }
    for (const p of order) {
      while (this.slotsLeft(p) > 0) assign(p, take(false, p));
    }
  }

  private complete() {
    this.clearHold();
    this.clearTrades();
    this.timer?.cancel();
    this.timer = null;
    this.absentTimer?.cancel();
    this.absentTimer = null;
    this.freePickTimer?.cancel();
    this.freePickTimer = null;
    this.freePick = null;
    this.draft = null;
    this.lot = null;
    this.market = null;
    this.stage = 'COMPLETE';
    this.hooks.onFeed('INFO', `${this.format === 'DRAFT' ? 'Draft' : 'Auction'} complete — every squad has ${this.rules.squadSize} players`);
    this.hooks.onEvent({ type: 'AUCTION_COMPLETE' });
    this.hooks.onComplete();
  }
}

/** Card labels for feed text elsewhere. */
export const cardLabel = (id: PowerCardId) => `${POWER_CARDS[id].emoji} ${POWER_CARDS[id].label}`;

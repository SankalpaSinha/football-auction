import {
  DEFAULT_VALUATION,
  estimateValue,
  verdictFor,
  type AuctionView,
  type FeedKind,
  type GameEvent,
  type GameRules,
  type LotOutcome,
  type LotResultView,
  type LotView,
  type PlayerCard,
  type SquadEntry,
  type ValuationConfig,
} from '@fa/shared';
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

export interface AuctionHooks {
  /** Something observable changed — rebroadcast state. */
  onChange(): void;
  onEvent(event: GameEvent): void;
  onFeed(kind: FeedKind, text: string, extra?: { userId?: string; amount?: number }): void;
  onLotClosed(record: LotRecord): void;
  onComplete(): void;
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
  hooks: AuctionHooks;
  valuation?: ValuationConfig;
}

interface OpenLot {
  lotNumber: number;
  player: PlayerCard;
  reoffer: boolean;
  openedAt: number;
  endsAt: number;
  currentBid: number | null;
  highestBidderId: string | null;
  skipped: Set<string>;
  bids: BidRecord[];
  extended: boolean;
}

type Stage = 'IDLE' | 'LOT_OPEN' | 'REVEAL' | 'COMPLETE';

/** Minimum time left on the clock when a paused lot resumes. */
const RESUME_MIN_MS = 5_000;

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

  private queue: PlayerCard[];
  /** Offered once with no buyer — re-offered after the main queue. */
  private unsold: PlayerCard[] = [];
  /** Offered twice with no buyer — only used for auto-fill. */
  private leftover: PlayerCard[] = [];
  private reofferRound = false;

  private stage: Stage = 'IDLE';
  private lot: OpenLot | null = null;
  private lastResult: LotResultView | null = null;
  private timer: TimerHandle | null = null;
  private lotCounter = 0;
  private pausedRemainingMs: number | null = null;
  /** Fires when the only managers who still need players have been gone too long. */
  private absentTimer: TimerHandle | null = null;

  constructor(private readonly opts: AuctionOptions) {
    this.rules = opts.rules;
    this.clock = opts.clock;
    this.hooks = opts.hooks;
    this.valuation = opts.valuation ?? DEFAULT_VALUATION;
    this.participants = new Map(opts.participants.map((p) => [p.userId, p]));
    this.queue = opts.order.slice();
    this.poolSize = opts.order.length;
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
    this.openNextLot();
  }

  bid(userId: string, lotNumber: number, amount: number) {
    const lot = this.requireOpenLot(lotNumber);
    const p = this.participants.get(userId) ?? fail('NOT_PARTICIPANT');
    if (this.isPaused) fail('AUCTION_PAUSED');
    if (this.clock.now() >= lot.endsAt) fail('LOT_CLOSED');
    if (lot.skipped.has(userId)) fail('ALREADY_SKIPPED');
    if (lot.highestBidderId === userId) fail('ALREADY_HIGHEST');
    if (!Number.isInteger(amount) || amount <= 0) fail('BAD_REQUEST');
    this.assertCanAcquire(p, lot.player);
    if (amount < this.minNextBid(lot)) fail('BID_TOO_LOW', `Minimum bid is ${this.minNextBid(lot)}.`);
    if (amount > p.budget) fail('OVER_BUDGET');
    const max = this.maxBid(p);
    if (amount > max) fail('RESERVE_REQUIRED', `Keep enough to fill your squad — your max bid is ${max}.`);

    const now = this.clock.now();
    const previousBidderId = lot.highestBidderId;
    lot.currentBid = amount;
    lot.highestBidderId = userId;
    lot.bids.push({ userId, amount, at: now });

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

  skip(userId: string, lotNumber: number) {
    const lot = this.requireOpenLot(lotNumber);
    const p = this.participants.get(userId) ?? fail('NOT_PARTICIPANT');
    if (lot.skipped.has(userId)) fail('ALREADY_SKIPPED');
    if (lot.highestBidderId === userId) fail('ALREADY_HIGHEST');
    lot.skipped.add(userId);
    this.hooks.onFeed('SKIP', `${p.username} skipped`, { userId });
    if (!this.closeIfNobodyCanBid()) this.hooks.onChange();
  }

  /** Called by the room whenever a participant connects or disconnects. */
  connectivityChanged() {
    if (this.stage !== 'LOT_OPEN') return;
    if (this.isPaused) {
      if (this.anyActiveConnected()) this.resume();
      return;
    }
    if (!this.closeIfNobodyCanBid()) this.hooks.onChange();
  }

  dispose() {
    this.timer?.cancel();
    this.timer = null;
    this.absentTimer?.cancel();
    this.absentTimer = null;
  }

  /** Highest bid a participant may currently place (budget minus squad-completion reserve). */
  maxBid(p: Participant): number {
    const slots = this.slotsLeft(p);
    if (slots <= 0) return 0;
    return Math.max(0, p.budget - (slots - 1) * this.rules.reservePerSlot);
  }

  getParticipant(userId: string) {
    return this.participants.get(userId);
  }

  view(): AuctionView {
    const lot = this.lot;
    const lotView: LotView | null = lot && {
      lotNumber: lot.lotNumber,
      player: lot.player,
      openedAt: lot.openedAt,
      endsAt: lot.endsAt,
      pausedRemainingMs: this.pausedRemainingMs,
      currentBid: lot.currentBid,
      highestBidderId: lot.highestBidderId,
      minNextBid: this.minNextBid(lot),
      skippedBy: [...lot.skipped],
      bidCount: lot.bids.length,
      extended: lot.extended,
      reoffer: lot.reoffer,
    };
    return {
      poolSize: this.poolSize,
      lotsOpened: this.lotCounter,
      remainingInQueue: this.queue.length,
      unsoldWaiting: this.unsold.length,
      reofferRound: this.reofferRound,
      paused: this.isPaused,
      lot: lotView,
      lastResult: this.stage === 'REVEAL' ? this.lastResult : null,
    };
  }

  // ----------------------------------------------------------------- rules

  private slotsLeft(p: Participant) {
    return this.rules.squadSize - p.squad.length;
  }

  private gkCount(p: Participant) {
    return p.squad.filter((s) => s.player.position === 'GK').length;
  }

  private gkShortfall(p: Participant) {
    return Math.max(0, this.rules.minGoalkeepers - this.gkCount(p));
  }

  private minNextBid(lot: OpenLot) {
    return lot.currentBid === null ? this.rules.openingBid : lot.currentBid + this.rules.minIncrement;
  }

  /** Squad-composition rules that keep every squad completable. */
  private assertCanAcquire(p: Participant, player: PlayerCard) {
    const slots = this.slotsLeft(p);
    if (slots <= 0) fail('SQUAD_FULL');
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
  }

  /** Goalkeepers still obtainable after the current lot. */
  private availableGoalkeepers() {
    const count = (list: PlayerCard[]) => list.filter((c) => c.position === 'GK').length;
    return count(this.queue) + count(this.unsold) + count(this.leftover);
  }

  private canBidNow(p: Participant, lot: OpenLot) {
    if (!this.opts.isConnected(p.userId)) return false;
    if (lot.skipped.has(p.userId) || lot.highestBidderId === p.userId) return false;
    try {
      this.assertCanAcquire(p, lot.player);
    } catch (e) {
      if (e instanceof GameError) return false;
      throw e;
    }
    return this.maxBid(p) >= this.minNextBid(lot);
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
      for (const c of candidates) {
        try {
          this.assertCanAcquire(p, c);
          return true;
        } catch (e) {
          if (!(e instanceof GameError)) throw e;
        }
      }
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

  private pause() {
    const lot = this.lot!;
    this.pausedRemainingMs = Math.max(0, lot.endsAt - this.clock.now());
    this.timer?.cancel();
    this.timer = null;
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

  private resume() {
    this.absentTimer?.cancel();
    this.absentTimer = null;
    const lot = this.lot!;
    lot.endsAt = this.clock.now() + Math.max(this.pausedRemainingMs ?? 0, RESUME_MIN_MS);
    this.pausedRemainingMs = null;
    this.scheduleLotTimer();
    this.hooks.onFeed('INFO', 'Auction resumed');
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
    this.closeLot();
  }

  private pickNext(): { player: PlayerCard; reoffer: boolean } | null {
    if (this.queue.length === 0 && !this.reofferRound && this.unsold.length > 0) {
      this.queue = this.unsold;
      this.unsold = [];
      this.reofferRound = true;
      this.hooks.onFeed('INFO', `Unsold players return to the auction (${this.queue.length})`);
    }

    if (this.someoneUrgentlyNeedsGoalkeeper() && this.queue[0]?.position !== 'GK') {
      const idx = this.queue.findIndex((c) => c.position === 'GK');
      if (idx > 0) {
        const [gk] = this.queue.splice(idx, 1);
        return { player: gk, reoffer: this.reofferRound };
      }
      // A keeper passed over once gets one more chance; twice-unsold ones wait for auto-fill.
      const j = this.unsold.findIndex((c) => c.position === 'GK');
      if (j >= 0) return { player: this.unsold.splice(j, 1)[0], reoffer: true };
    }

    const player = this.queue.shift();
    return player ? { player, reoffer: this.reofferRound } : null;
  }

  private someoneUrgentlyNeedsGoalkeeper() {
    for (const p of this.participants.values()) {
      const shortfall = this.gkShortfall(p);
      if (shortfall > 0 && this.slotsLeft(p) <= this.rules.gkUrgencySlots + shortfall - 1) return true;
    }
    return false;
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
    const next = this.pickNext();
    if (!next) {
      this.autoFill();
      return this.complete();
    }
    const now = this.clock.now();
    this.lot = {
      lotNumber: ++this.lotCounter,
      player: next.player,
      reoffer: next.reoffer,
      openedAt: now,
      endsAt: now + this.opts.lotDurationMs,
      currentBid: null,
      highestBidderId: null,
      skipped: new Set(),
      bids: [],
      extended: false,
    };
    this.stage = 'LOT_OPEN';
    this.lastResult = null;
    this.scheduleLotTimer();
    this.hooks.onEvent({ type: 'LOT_OPEN', lotNumber: this.lot.lotNumber });
    if (!this.closeIfNobodyCanBid()) this.hooks.onChange();
  }

  private closeLot() {
    const lot = this.lot!;
    this.timer?.cancel();
    this.timer = null;
    const now = this.clock.now();
    const p = lot.player;
    const budget = this.opts.participants[0]?.startingBudget ?? 1000;
    const estimatedValue = estimateValue(p, budget, this.valuation);

    let outcome: LotOutcome;
    let winnerId: string | null = null;
    let price: number | null = null;

    if (lot.highestBidderId && lot.currentBid !== null) {
      // The winner is whoever holds the top bid on the server — connected or not.
      const winner = this.participants.get(lot.highestBidderId)!;
      outcome = 'SOLD';
      winnerId = winner.userId;
      price = lot.currentBid;
      winner.budget -= price;
      winner.squad.push({ player: p, price, via: 'AUCTION', lotNumber: lot.lotNumber, estimatedValue });
      this.hooks.onFeed('SOLD', `${p.shortName} SOLD to ${winner.username} for ${price}`, {
        userId: winner.userId,
        amount: price,
      });
      this.hooks.onEvent({ type: 'SOLD', lotNumber: lot.lotNumber, userId: winner.userId, amount: price });
    } else {
      outcome = 'UNSOLD';
      (lot.reoffer ? this.leftover : this.unsold).push(p);
      this.hooks.onFeed('UNSOLD', `${p.shortName} went unsold`);
      this.hooks.onEvent({ type: 'UNSOLD', lotNumber: lot.lotNumber });
    }

    const revealMs = outcome === 'SOLD' ? this.rules.soldRevealMs : this.rules.unsoldRevealMs;
    this.lastResult = {
      lotNumber: lot.lotNumber,
      player: p,
      outcome,
      winnerId,
      price,
      estimatedValue,
      verdict: price === null ? null : verdictFor(price, estimatedValue, this.valuation),
      nextAt: now + revealMs,
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
    const budget = this.opts.participants[0]?.startingBudget ?? 1000;

    const take = (wantGk: boolean) => {
      let idx = remaining.findIndex((c) => (c.position === 'GK') === wantGk);
      if (idx < 0) idx = 0;
      const player = remaining.splice(idx, 1)[0];
      if (!player) throw new Error('Auction pool exhausted — pool size validation failed');
      return player;
    };
    const assign = (p: Participant, player: PlayerCard) => {
      const price = Math.min(this.rules.openingBid, p.budget);
      const estimatedValue = estimateValue(player, budget, this.valuation);
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

    // Keepers first for everyone who lacks one, then outfielders.
    for (const p of this.participants.values()) {
      while (this.gkShortfall(p) > 0 && this.slotsLeft(p) > 0) assign(p, take(true));
    }
    for (const p of this.participants.values()) {
      while (this.slotsLeft(p) > 0) assign(p, take(false));
    }
  }

  private complete() {
    this.timer?.cancel();
    this.timer = null;
    this.absentTimer?.cancel();
    this.absentTimer = null;
    this.lot = null;
    this.stage = 'COMPLETE';
    this.hooks.onFeed('INFO', `Auction complete — every squad has ${this.rules.squadSize} players`);
    this.hooks.onEvent({ type: 'AUCTION_COMPLETE' });
    this.hooks.onComplete();
  }
}

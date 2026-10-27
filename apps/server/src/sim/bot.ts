import { io, type Socket } from 'socket.io-client';
import {
  autoPick,
  FORMATIONS,
  isStarPlayer,
  scoreSquad,
  TACTIC_IDS,
  type Ack,
  type ClientToServer,
  type RoomView,
  type ServerToClient,
  type TeamTalk,
} from '@fa/shared';

export interface BotOptions {
  /** 0..1 — how keen the bot is to bid at all. */
  aggression?: number;
  /** Delay range before acting on a lot, ms. */
  thinkMs?: [number, number];
  /** 0..1 — how often it plays power cards and touchline shouts when it can. */
  cardiness?: number;
  /** Ready up again whenever the room goes back to the lobby (rematches, seasons). */
  autoReady?: boolean;
  /** Reconnect after a dropped connection, like the browser does (tests leave this off). */
  reconnect?: boolean;
  log?: (msg: string) => void;
}

/** Answers the server may give to a bot's reasonable-looking action because of a race or a rule it doesn't predict. */
const EXPECTED = new Set([
  'PASS',
  'STALE_LOT',
  'NO_ACTIVE_LOT',
  'LOT_CLOSED',
  'BID_TOO_LOW',
  'GOALKEEPER_LIMIT',
  'POOL_RESERVED',
  'STAR_LIMIT',
  'NEED_GOALKEEPER',
  'FROZEN',
  'ALREADY_DECIDED',
  'ALREADY_SKIPPED',
  'ALREADY_HIGHEST',
  'AUCTION_PAUSED',
  'RESERVE_REQUIRED',
  'PRICE_CAP',
  'NOT_YOUR_PICK',
  'PLAYER_UNAVAILABLE',
  'WRONG_PHASE',
]);

/**
 * A scripted manager that talks to the real server over WebSockets exactly
 * like the browser does. Used by integration tests and `npm run sim`.
 */
export class Bot {
  socket!: Socket<ServerToClient, ClientToServer>;
  token = '';
  userId = '';
  state: RoomView | null = null;
  errors: string[] = [];
  /** Cards and shouts this bot played (for tests). */
  played: string[] = [];
  private actedOn = new Map<number, number>();
  private thinking = false;
  private lockingLineup = false;
  private talked = new Set<string>();
  private shouted = new Set<string>();
  private stealTried = new Set<number>();

  constructor(
    readonly base: string,
    readonly username: string,
    private readonly opts: BotOptions = {},
  ) {}

  async login() {
    const res = await fetch(`${this.base}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: this.username, password: `bot-${this.username}-pw` }),
    });
    let body = (await res.json()) as { user: { id: string }; token: string; error?: string; code?: string };
    if (res.status === 409) {
      // Name already registered (e.g. a fixed bot name) — sign in instead.
      const again = await fetch(`${this.base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: this.username, password: `bot-${this.username}-pw` }),
      });
      body = await again.json();
      if (!again.ok) throw new Error(`login ${this.username}: ${body.error}`);
    } else if (!res.ok) throw new Error(`login ${this.username}: ${body.error}`);
    this.token = body.token;
    this.userId = body.user.id;
    return this;
  }

  connect() {
    return new Promise<this>((resolve, reject) => {
      this.socket = io(this.base, { auth: { token: this.token }, transports: ['websocket'], reconnection: !!this.opts.reconnect });
      this.socket.on('room:state', (v) => {
        this.state = v;
        this.maybeAct();
      });
      this.socket.once('connect', () => resolve(this));
      this.socket.once('connect_error', reject);
    });
  }

  disconnect() {
    this.socket.disconnect();
  }

  emit<T = unknown>(event: keyof ClientToServer, payload: unknown = {}): Promise<Ack<T>> {
    return new Promise((resolve) => {
      (this.socket as unknown as { emit: (e: string, p: unknown, cb: (r: Ack<T>) => void) => void }).emit(event, payload, (r) =>
        resolve(r),
      );
    });
  }

  async must<T = unknown>(event: keyof ClientToServer, payload: unknown = {}) {
    const r = await this.emit<T>(event, payload);
    if (!r.ok) throw new Error(`${this.username} ${event}: ${r.code} ${r.error}`);
    return r.data as T;
  }

  get me() {
    return this.state?.members.find((m) => m.userId === this.userId);
  }

  /** Wait until the latest state satisfies a predicate. */
  waitFor(pred: (v: RoomView) => boolean, timeoutMs = 20_000) {
    return new Promise<RoomView>((resolve, reject) => {
      if (this.state && pred(this.state)) return resolve(this.state);
      const t = setTimeout(() => {
        this.socket.off('room:state', h);
        reject(new Error(`${this.username}: timed out waiting (phase ${this.state?.phase})`));
      }, timeoutMs);
      const h = (v: RoomView) => {
        if (pred(v)) {
          clearTimeout(t);
          this.socket.off('room:state', h);
          resolve(v);
        }
      };
      this.socket.on('room:state', h);
    });
  }

  private delay() {
    const [lo, hi] = this.opts.thinkMs ?? [20, 80];
    return lo + Math.random() * (hi - lo);
  }

  private note(code: string) {
    if (!EXPECTED.has(code)) this.errors.push(code);
  }

  /** Squad builder: pick a random formation, auto-pick the best XI, then the tactic that suits it best. */
  private maybeLockLineup(v: RoomView) {
    const mine = v.squadBuilding?.mine;
    if (!mine || mine.locked || this.lockingLineup || !this.me) return;
    this.lockingLineup = true;
    const formation = FORMATIONS[Math.floor(Math.random() * FORMATIONS.length)].id;
    const slots = autoPick(this.me.squad.map((e) => e.player), formation);
    const squad = this.me.squad;
    const tactic = [...TACTIC_IDS].sort(
      (a, b) => scoreSquad(squad, { formationId: formation, slots, tactic: b }).total - scoreSquad(squad, { formationId: formation, slots, tactic: a }).total,
    )[0];
    setTimeout(async () => {
      const r = await this.emit('squad:lock', { formationId: formation, slots, tactic });
      if (!r.ok) this.errors.push(r.code);
      this.lockingLineup = false;
    }, this.delay());
  }

  private picking = false;

  /** Free pick or a draft turn: take the best player we're allowed to. */
  private maybePick(v: RoomView) {
    const turn = v.auction?.freePick?.userId ?? v.auction?.draft?.userId;
    if (this.picking || turn !== this.userId) return;
    this.picking = true;
    setTimeout(async () => {
      const pool = await this.emit<{ players: { id: string }[] }>('auction:pool');
      if (pool.ok) {
        // A draft bot takes one of the top few, so drafts don't all look the same.
        const list = pool.data!.players;
        const start = v.auction?.draft ? Math.floor(Math.random() * Math.min(3, list.length)) : 0;
        for (const p of [...list.slice(start), ...list.slice(0, start)]) {
          const r = await this.emit('auction:pick', { playerId: p.id });
          if (r.ok) break;
          if (r.code === 'NOT_YOUR_PICK' || r.code === 'WRONG_PHASE') break;
        }
      }
      this.picking = false;
    }, this.delay());
  }

  /** The cup: pick a half-time team talk, and now and then a touchline shout. */
  private maybeCoach(v: RoomView) {
    const t = v.tournament;
    if (!t) return;
    const m = t.matches.find((x) => x.round === t.currentRound && (x.home.userId === this.userId || x.away.userId === this.userId));
    if (!m) return;
    const side = m.home.userId === this.userId ? m.home : m.away;
    if (m.status === 'HALF_TIME' && !side.talkChosen && !this.talked.has(m.id)) {
      this.talked.add(m.id);
      const talk = (['ATTACK', 'CALM', 'TIGHT'] as TeamTalk[])[Math.floor(Math.random() * 3)];
      setTimeout(async () => {
        const r = await this.emit('match:talk', { talk });
        if (!r.ok && r.code !== 'TALK_CLOSED' && r.code !== 'NOT_IN_MATCH') this.errors.push(r.code);
        else if (r.ok) this.played.push(`talk:${talk}`);
      }, this.delay());
    }
    const live = m.status === 'FIRST_HALF' || m.status === 'SECOND_HALF' || m.status === 'EXTRA_TIME';
    const key = `${m.id}:${m.status}`;
    if (live && side.shoutsLeft.length && !this.shouted.has(key) && Math.random() < (this.opts.cardiness ?? 0.3)) {
      this.shouted.add(key);
      const shout = side.shoutsLeft[0];
      setTimeout(async () => {
        const r = await this.emit('match:shout', { shout });
        if (r.ok) this.played.push(`shout:${shout}`);
        else if (!['TALK_CLOSED', 'NOT_IN_MATCH', 'NO_SHOUT'].includes(r.code)) this.errors.push(r.code);
      }, this.delay());
    }
  }

  /** After a sale, maybe use a Steal card. */
  private maybeSteal(v: RoomView) {
    const r = v.auction?.lastResult;
    if (!r || r.outcome !== 'SOLD' || !r.stealUntil || r.winnerId === this.userId || this.stealTried.has(r.lotNumber)) return;
    if (!v.auction?.cards[this.userId]?.includes('STEAL')) return;
    this.stealTried.add(r.lotNumber);
    if (Math.random() > (this.opts.cardiness ?? 0.3) * 0.5 || (r.player.overall < 80 && Math.random() < 0.7)) return;
    setTimeout(async () => {
      const res = await this.emit('card:steal', { lotNumber: r.lotNumber });
      if (res.ok) this.played.push('steal');
      else if (!['STEAL_CLOSED', 'CANT_STEAL', 'SQUAD_FULL', 'STAR_LIMIT', 'NEED_GOALKEEPER', 'NO_CARD'].includes(res.code)) this.errors.push(res.code);
    }, Math.min(400, this.delay()));
  }

  private readying = false;

  private maybeAct() {
    const v = this.state;
    if (this.opts.autoReady && v && (v.phase === 'LOBBY' || v.phase === 'WAITING_FOR_PLAYERS') && this.me && !this.me.ready && v.hostId !== this.userId && !this.readying) {
      this.readying = true;
      setTimeout(async () => {
        await this.emit('room:ready', { ready: true });
        this.readying = false;
      }, this.delay());
      return;
    }
    if (v?.phase === 'SQUAD_BUILDING') return this.maybeLockLineup(v);
    if (v?.phase === 'TOURNAMENT') return this.maybeCoach(v);
    if (v?.auction?.freePick || v?.auction?.draft) return this.maybePick(v);
    if (v?.phase === 'PLAYER_SOLD') return this.maybeSteal(v);
    const lot = v?.auction?.lot;
    const me = this.me;
    if (!v || v.phase !== 'AUCTION' || !lot || !me || this.thinking) return;
    if (lot.frozen.includes(this.userId)) return;
    if (lot.kind === 'SEALED' ? lot.sealed?.mine !== null : lot.skippedBy.includes(this.userId) || lot.highestBidderId === this.userId) return;
    if (me.squad.length >= v.rules.squadSize) return;
    const times = this.actedOn.get(lot.lotNumber) ?? 0;

    this.thinking = true;
    setTimeout(async () => {
      this.thinking = false;
      const cur = this.state?.auction?.lot;
      if (!cur || cur.lotNumber !== lot.lotNumber || this.state?.phase !== 'AUCTION' || cur.frozen.includes(this.userId)) {
        // State moved on while thinking — re-evaluate against the latest view.
        return this.maybeAct();
      }
      const sealed = cur.kind === 'SEALED';
      if (sealed ? cur.sealed?.mine !== null : cur.highestBidderId === this.userId || cur.skippedBy.includes(this.userId)) {
        return this.maybeAct();
      }
      const max = this.me?.maxBid ?? 0;
      const aggression = this.opts.aggression ?? 0.5;
      const cap = v.rules.starCap;
      const starCapped =
        isStarPlayer(cur.player) && (this.me?.squad ?? []).filter((e) => isStarPlayer(e.player)).length >= cap.max;
      // Mystery players show 0 overall: treat them as average.
      const rating = cur.kind === 'MYSTERY' ? 78 : cur.player.overall;
      const keen = !starCapped && Math.random() < aggression * (rating / 85) * Math.pow(0.55, times);
      this.actedOn.set(lot.lotNumber, times + 1);

      // Now and then freeze whoever's winning (or a rival) out of a player we want.
      const cards = this.state?.auction?.cards[this.userId] ?? [];
      if (keen && cards.includes('FREEZE') && Math.random() < (this.opts.cardiness ?? 0.3) * 0.25) {
        const rival = this.state!.members.find(
          (m) => m.userId !== this.userId && m.connected && !cur.frozen.includes(m.userId) && !cur.skippedBy.includes(m.userId) && m.squad.length < v.rules.squadSize && !(cur.sealed?.decided ?? []).includes(m.userId),
        );
        if (rival) {
          const f = await this.emit('card:freeze', { lotNumber: lot.lotNumber, targetId: rival.userId });
          if (f.ok) this.played.push('freeze');
          else if (!['BAD_TARGET', 'LOT_CLOSED', 'STALE_LOT', 'NO_ACTIVE_LOT', 'NO_CARD', 'AUCTION_PAUSED'].includes(f.code)) this.errors.push(f.code);
        }
      }

      if (sealed) {
        const amount = Math.min(max, cur.minNextBid + Math.floor(Math.random() * 4) * v.rules.minIncrement);
        let r: Ack = keen && amount >= cur.minNextBid ? await this.emit('auction:sealed', { lotNumber: lot.lotNumber, amount }) : { ok: false, code: 'PASS', error: '' };
        if (!r.ok) {
          this.note(r.code);
          r = await this.emit('auction:sealed', { lotNumber: lot.lotNumber, amount: null });
          if (!r.ok) this.note(r.code);
        }
        this.opts.log?.(`${this.username} ${keen ? `sealed ${amount}` : 'pass'}`);
        return this.maybeAct();
      }

      const amount = cur.minNextBid + (Math.random() < 0.3 ? v.rules.minIncrement : 0);
      let r: Ack = keen && amount <= max ? await this.emit('auction:bid', { lotNumber: lot.lotNumber, amount }) : { ok: false, code: 'PASS', error: '' };
      if (!r.ok) {
        this.note(r.code);
        r = await this.emit('auction:skip', { lotNumber: lot.lotNumber });
        if (!r.ok) this.note(r.code);
      }
      this.opts.log?.(`${this.username} ${keen ? `bid ${amount}` : 'skip'}`);
      this.maybeAct();
    }, this.delay());
  }
}

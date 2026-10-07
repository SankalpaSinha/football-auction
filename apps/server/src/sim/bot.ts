import { io, type Socket } from 'socket.io-client';
import type { Ack, ClientToServer, RoomView, ServerToClient } from '@fa/shared';

export interface BotOptions {
  /** 0..1 — how keen the bot is to bid at all. */
  aggression?: number;
  /** Delay range before acting on a lot, ms. */
  thinkMs?: [number, number];
  log?: (msg: string) => void;
}

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
  private actedOn = new Map<number, number>();
  private thinking = false;

  constructor(
    readonly base: string,
    readonly username: string,
    private readonly opts: BotOptions = {},
  ) {}

  async login() {
    const res = await fetch(`${this.base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: this.username }),
    });
    const body = (await res.json()) as { user: { id: string }; token: string; error?: string };
    if (!res.ok) throw new Error(`login ${this.username}: ${body.error}`);
    this.token = body.token;
    this.userId = body.user.id;
    return this;
  }

  connect() {
    return new Promise<this>((resolve, reject) => {
      this.socket = io(this.base, { auth: { token: this.token }, transports: ['websocket'], reconnection: false });
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

  private maybeAct() {
    const v = this.state;
    const lot = v?.auction?.lot;
    const me = this.me;
    if (!v || v.phase !== 'AUCTION' || !lot || !me || this.thinking) return;
    if (lot.skippedBy.includes(this.userId) || lot.highestBidderId === this.userId) return;
    if (me.squad.length >= v.rules.squadSize) return;
    const times = this.actedOn.get(lot.lotNumber) ?? 0;

    this.thinking = true;
    const [lo, hi] = this.opts.thinkMs ?? [20, 80];
    setTimeout(async () => {
      this.thinking = false;
      const cur = this.state?.auction?.lot;
      if (
        !cur ||
        cur.lotNumber !== lot.lotNumber ||
        this.state?.phase !== 'AUCTION' ||
        cur.highestBidderId === this.userId ||
        cur.skippedBy.includes(this.userId)
      ) {
        // State moved on while thinking — re-evaluate against the latest view.
        return this.maybeAct();
      }
      const max = this.me?.maxBid ?? 0;
      const aggression = this.opts.aggression ?? 0.5;
      const keen = Math.random() < aggression * (cur.player.overall / 85) * Math.pow(0.55, times);
      const amount = cur.minNextBid + (Math.random() < 0.3 ? v.rules.minIncrement : 0);
      this.actedOn.set(lot.lotNumber, times + 1);
      let r: Ack = keen && amount <= max ? await this.emit('auction:bid', { lotNumber: lot.lotNumber, amount }) : { ok: false, code: 'PASS', error: '' };
      if (!r.ok) {
        if (r.code !== 'PASS' && r.code !== 'STALE_LOT' && r.code !== 'NO_ACTIVE_LOT' && r.code !== 'LOT_CLOSED' && r.code !== 'BID_TOO_LOW') {
          this.errors.push(r.code);
        }
        r = await this.emit('auction:skip', { lotNumber: lot.lotNumber });
      }
      this.opts.log?.(`${this.username} ${keen ? `bid ${amount}` : 'skip'}`);
      this.maybeAct();
    }, lo + Math.random() * (hi - lo));
  }
}

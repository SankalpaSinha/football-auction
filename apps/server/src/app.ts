import { createServer, type Server as HttpServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import { Server, type Socket } from 'socket.io';
import {
  ERROR_MESSAGES,
  bidSchema,
  createRoomSchema,
  joinRoomSchema,
  lineupSchema,
  quickMatchSchema,
  pickSchema,
  chatSchema,
  readySchema,
  skipSchema,
  pauseVoteSchema,
  presenceSchema,
  focusSchema,
  releaseSchema,
  tradeProposeSchema,
  tradeRespondSchema,
  tradeCancelSchema,
  credentialsSchema,
  type Ack,
  type ClientToServer,
  type ErrorCode,
  type GameRules,
  type ServerToClient,
  type SessionUser,
} from '@fa/shared';
import type { ZodType } from 'zod';
import type { PlayerCatalog } from './data/catalog';
import type { Clock } from './engine/clock';
import { GameError } from './engine/errors';
import type { GameStore } from './engine/store';
import type { Commentator } from './services/commentary';
import type { StatsService } from './services/stats';
import { RateLimiter, TokenBucket } from './lib/rateLimit';
import { RoomManager, roomChannel, userChannel } from './realtime/roomManager';
import {
  hashToken,
  InvalidCredentialsError,
  LegacyAccountError,
  login,
  register,
  ServerBusyError,
  UsernameTakenError,
  type UserStore,
} from './services/users';

export interface AppDeps {
  catalog: PlayerCatalog;
  users: UserStore;
  store: GameStore;
  clock: Clock;
  rules: GameRules;
  /** List of allowed origins, `true` for any, `false` for same-origin only. */
  corsOrigins: string[] | boolean;
  /**
   * How many reverse-proxy hops to trust for the client IP (rate limits). 0 = none:
   * X-Forwarded-For is ignored, so clients can't spoof their IP.
   */
  trustProxy?: number;
  /** Account registrations allowed per IP per hour (tests raise this). */
  registrationsPerHour?: number;
  /** Production single-service mode: serves the built Next.js site for every non-API route. */
  webHandler?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>;
  maxRooms?: number;
  seed?: string;
  commentator?: Commentator;
  /** Profiles / leaderboard / match history — needs the database. */
  stats?: StatsService;
  log?: (msg: string, err?: unknown) => void;
}

type SocketData = { user: SessionUser; replaced?: boolean; tokenHash?: string };
type IO = Server<ClientToServer, ServerToClient, Record<string, never>, SocketData>;
type AppSocket = Socket<ClientToServer, ServerToClient, Record<string, never>, SocketData>;

const errorAck = (code: ErrorCode, message?: string): Ack<never> => ({
  ok: false,
  code,
  error: message ?? ERROR_MESSAGES[code],
});

export function createApp(deps: AppDeps) {
  const log = deps.log ?? ((msg, err) => console.error(msg, err ?? ''));
  const app = express();
  app.set('trust proxy', deps.trustProxy ?? 0);
  app.disable('x-powered-by');
  // Basic hardening headers (the bid buttons must never be clickjacked inside another site).
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  app.use(cors({ origin: deps.corsOrigins }));
  app.use(express.json({ limit: '8kb' }));
  // A general per-IP budget for the HTTP API (stats endpoints run several queries each).
  const apiLimiter = new RateLimiter(240, 60_000, () => deps.clock.now());
  app.use('/api', (req, res, next) => {
    if (req.path === '/health') return next();
    if (!apiLimiter.take(req.ip ?? 'unknown')) return void res.status(429).json(errorAck('RATE_LIMITED'));
    next();
  });

  const http: HttpServer = createServer(app);
  const io: IO = new Server(http, {
    cors: { origin: deps.corsOrigins },
    maxHttpBufferSize: 16 * 1024,
    perMessageDeflate: { threshold: 2048 },
    pingInterval: 10_000,
    pingTimeout: 8_000,
  });

  const manager = new RoomManager(io, {
    catalog: deps.catalog,
    store: deps.store,
    clock: deps.clock,
    rules: deps.rules,
    maxRooms: deps.maxRooms ?? 2000,
    seed: deps.seed,
    commentator: deps.commentator,
    log,
  });

  // --------------------------------------------------------------- REST

  const bearer = (h?: string) => (h?.startsWith('Bearer ') ? h.slice(7).trim() : null);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, rooms: manager.roomCount, time: deps.clock.now() });
  });

  const registerLimiter = new RateLimiter(deps.registrationsPerHour ?? 20, 60 * 60_000);
  const loginLimiter = new RateLimiter(10, 15 * 60_000);
  // Per-IP cap regardless of username (stops spraying many names from one address).
  const loginIpLimiter = new RateLimiter(40, 15 * 60_000);
  const roomLookupLimiter = new RateLimiter(60, 10 * 60_000);
  const fail500 = (res: express.Response, where: string, e: unknown) => {
    log(`${where} failed`, e);
    res.status(500).json({ ok: false, code: 'INTERNAL', error: 'Something went wrong.' });
  };

  app.post('/api/auth/register', async (req, res) => {
    const parsed = credentialsSchema.safeParse(req.body ?? {});
    if (!parsed.success) return void res.status(400).json(errorAck('BAD_REQUEST', parsed.error.issues[0]?.message));
    if (!registerLimiter.take(req.ip ?? 'unknown')) return void res.status(429).json(errorAck('RATE_LIMITED'));
    try {
      res.json(await register(deps.users, parsed.data.username, parsed.data.password));
    } catch (e) {
      if (e instanceof UsernameTakenError) {
        return void res.status(409).json({ ok: false, code: 'USERNAME_TAKEN', error: 'That username is taken — sign in instead?' });
      }
      fail500(res, 'register', e);
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    const parsed = credentialsSchema.safeParse(req.body ?? {});
    if (!parsed.success) return void res.status(400).json(errorAck('BAD_REQUEST', parsed.error.issues[0]?.message));
    const key = `${req.ip ?? 'unknown'}|${parsed.data.username.toLowerCase()}`;
    if (!loginIpLimiter.take(req.ip ?? 'unknown') || !loginLimiter.take(key)) {
      return void res.status(429).json({ ok: false, code: 'RATE_LIMITED', error: 'Too many attempts — try again in a few minutes.' });
    }
    try {
      res.json(await login(deps.users, parsed.data.username, parsed.data.password));
    } catch (e) {
      if (e instanceof InvalidCredentialsError) {
        return void res.status(401).json({ ok: false, code: 'INVALID_CREDENTIALS', error: 'Wrong username or password.' });
      }
      if (e instanceof LegacyAccountError) {
        return void res.status(409).json({
          ok: false,
          code: 'LEGACY_ACCOUNT',
          error: 'This name was created before passwords existed. Ask the server admin to set a password for it.',
        });
      }
      if (e instanceof ServerBusyError) return void res.status(503).json({ ok: false, code: 'BUSY', error: 'Server busy — try again.' });
      fail500(res, 'login', e);
    }
  });

  app.post('/api/auth/logout', async (req, res) => {
    const token = bearer(req.headers.authorization);
    if (token) {
      const user = await deps.users.findByToken(token).catch(() => null);
      await deps.users.deleteSession(token).catch((e) => log('logout failed', e));
      // End the live connection that used this session too.
      if (user) {
        for (const s of await io.in(userChannel(user.id)).fetchSockets()) {
          if (s.data.tokenHash === hashToken(token)) s.disconnect(true);
        }
      }
    }
    res.json({ ok: true });
  });

  app.get('/api/session', async (req, res) => {
    const token = bearer(req.headers.authorization);
    const user = token ? await deps.users.findByToken(token).catch(() => null) : null;
    if (!user) return void res.status(401).json(errorAck('UNAUTHENTICATED'));
    deps.users.touch(user.id).catch(() => {});
    res.json({ user, activeRoom: manager.roomOf(user.id)?.code ?? null });
  });

  app.get('/api/competitions', (_req, res) => {
    res.json({ competitions: deps.catalog.competitions(), rules: deps.rules });
  });

  const needStats = (res: express.Response) => {
    if (deps.stats) return deps.stats;
    res.status(503).json({ ok: false, code: 'NO_DATABASE', error: 'Stats need the database (STORAGE=db).' });
    return null;
  };

  app.get('/api/leaderboard', async (req, res) => {
    const stats = needStats(res);
    if (!stats) return;
    const mode = req.query.mode === 'CASUAL' ? 'CASUAL' : 'RANKED';
    try {
      res.json({ mode, rows: await stats.leaderboard(mode) });
    } catch (e) {
      fail500(res, 'leaderboard', e);
    }
  });

  app.get('/api/users/:username', async (req, res) => {
    const stats = needStats(res);
    if (!stats) return;
    try {
      const profile = await stats.profile(String(req.params.username).slice(0, 32));
      if (!profile) return void res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'No manager with that name.' });
      res.json(profile);
    } catch (e) {
      fail500(res, 'profile', e);
    }
  });

  app.get('/api/matches/:id', async (req, res) => {
    const stats = needStats(res);
    if (!stats) return;
    try {
      const match = await stats.match(String(req.params.id).slice(0, 64));
      if (!match) return void res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Match not found.' });
      res.json(match);
    } catch (e) {
      fail500(res, 'match', e);
    }
  });

  app.get('/api/rooms/live', (_req, res) => {
    res.json({ games: manager.liveGames() });
  });

  app.get('/api/rooms/public', (_req, res) => {
    res.json({ rooms: manager.publicLobbies() });
  });

  app.get('/api/rooms/:code', (req, res) => {
    // Codes are the invite to private rooms — don't let anyone enumerate them.
    if (!roomLookupLimiter.take(req.ip ?? 'unknown')) return void res.status(429).json(errorAck('RATE_LIMITED'));
    const room = manager.get(String(req.params.code).toUpperCase());
    if (!room) return void res.status(404).json(errorAck('ROOM_NOT_FOUND'));
    res.json({
      code: room.code,
      name: room.name,
      phase: room.phase,
      competition: room.competition,
      members: room.memberCount,
      maxPlayers: room.settings.maxPlayers,
    });
  });

  // ---------------------------------------------------------- sockets

  const userSockets = new Map<string, AppSocket>();

  const handshakeLimiter = new RateLimiter(60, 60_000, () => deps.clock.now());
  io.use(async (socket, next) => {
    const ip = deps.trustProxy
      ? String(socket.handshake.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(-deps.trustProxy)[0] ?? socket.handshake.address
      : socket.handshake.address;
    if (!handshakeLimiter.take(ip)) return next(new Error('RATE_LIMITED'));
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || token.length > 128) return next(new Error('UNAUTHENTICATED'));
    try {
      const user = await deps.users.findByToken(token);
      if (!user) return next(new Error('UNAUTHENTICATED'));
      socket.data.user = user;
      socket.data.tokenHash = hashToken(token);
      next();
    } catch (e) {
      // A database hiccup is not a bad session — don't make the client sign out.
      log('socket auth failed', e);
      next(new Error('SERVER_ERROR'));
    }
  });

  io.on('connection', (socket: AppSocket) => {
    const user = socket.data.user;

    // One live connection per manager: a new tab/refresh takes over.
    const previous = userSockets.get(user.id);
    if (previous && previous.id !== socket.id) {
      previous.data.replaced = true;
      previous.emit('session:replaced');
      previous.disconnect(true);
    }
    userSockets.set(user.id, socket);
    socket.join(userChannel(user.id));

    deps.store
      .ratingsFor([user.id], 'RANKED')
      .then((r) => manager.rememberElo(user.id, r[user.id].elo))
      .catch(() => {});

    manager.reattachSpectator(user.id);
    const room = manager.roomOf(user.id);
    if (room) {
      socket.join(roomChannel(room.code));
      room.setConnected(user.id, true);
      socket.emit('room:state', room.view(user.id));
    }

    const actions = new TokenBucket(15, 30, () => deps.clock.now());
    const bids = new TokenBucket(6, 10, () => deps.clock.now());
    const syncs = new TokenBucket(2, 8, () => deps.clock.now());
    const chats = new TokenBucket(1, 5, () => deps.clock.now());
    // Failed room lookups by code — guessing private codes gets cut off quickly.
    let codeMisses = 0;
    const lookup = <T>(fn: () => T): T => {
      if (codeMisses >= 20) throw new GameError('RATE_LIMITED');
      try {
        return fn();
      } catch (e) {
        if (e instanceof GameError && e.code === 'ROOM_NOT_FOUND') codeMisses++;
        throw e;
      }
    };

    function on<T>(
      event: keyof ClientToServer,
      schema: ZodType<T> | null,
      fn: (input: T) => unknown,
      bucket: TokenBucket = actions,
    ) {
      socket.on(event, (raw: unknown, ack: unknown) => {
        if (typeof ack !== 'function') return;
        const reply = ack as (r: Ack<unknown>) => void;
        if (!bucket.take()) return reply(errorAck('RATE_LIMITED'));
        let input = undefined as T;
        if (schema) {
          const parsed = schema.safeParse(raw ?? {});
          if (!parsed.success) return reply(errorAck('BAD_REQUEST', parsed.error.issues[0]?.message));
          input = parsed.data;
        }
        try {
          const data = fn(input);
          reply({ ok: true, data });
        } catch (e) {
          if (e instanceof GameError) return reply(errorAck(e.code, e.message));
          log(`[${event}] unexpected error`, e);
          reply({ ok: false, code: 'INTERNAL', error: 'Something went wrong.' });
        }
      });
    }

    on('room:create', createRoomSchema, (input) => {
      const r = manager.create(user, input);
      return { code: r.code };
    });

    on('room:join', joinRoomSchema, ({ code }) => {
      const r = lookup(() => manager.join(user, code));
      socket.emit('room:state', r.view(user.id));
      return { code: r.code };
    });

    on('room:leave', null, () => manager.leave(user.id));
    on('room:quit', null, () => manager.quit(user.id));

    on('room:spectate', joinRoomSchema, ({ code }) => {
      const { room: r, role } = lookup(() => manager.spectate(user, code));
      socket.emit('room:state', role === 'member' ? r.view(user.id) : r.view());
      return { code: r.code, role };
    });

    on('match:quick', quickMatchSchema, (prefs) => {
      const { room: r, created } = manager.quickMatch(user, prefs);
      socket.emit('room:state', r.view(user.id));
      return { code: r.code, created };
    });

    on('room:ready', readySchema, ({ ready }) => {
      const r = manager.roomOf(user.id);
      if (!r) throw new GameError('NOT_IN_ROOM');
      r.setReady(user.id, ready);
    });

    on('room:start', null, () => {
      const r = manager.roomOf(user.id);
      if (!r) throw new GameError('NOT_IN_ROOM');
      r.start(user.id);
    });

    on(
      'auction:bid',
      bidSchema,
      ({ lotNumber, amount }) => {
        const r = manager.roomOf(user.id);
        if (!r) throw new GameError('NOT_IN_ROOM');
        r.bid(user.id, lotNumber, amount);
      },
      bids,
    );

    on('auction:pick', pickSchema, ({ playerId }) => {
      const r = manager.roomOf(user.id);
      if (!r) throw new GameError('NOT_IN_ROOM');
      r.pick(user.id, playerId);
    });

    on('auction:pool', null, () => {
      const r = manager.roomOf(user.id) ?? manager.watchedRoom(user.id);
      if (!r) throw new GameError('NOT_IN_ROOM');
      return { players: r.pickPool(user.id) };
    });

    on(
      'chat:send',
      chatSchema,
      ({ text }) => {
        const r = manager.roomOf(user.id) ?? manager.watchedRoom(user.id);
        if (!r) throw new GameError('NOT_IN_ROOM');
        r.sendChat(user.id, text);
      },
      chats,
    );

    on('chat:history', null, () => {
      const r = manager.roomOf(user.id) ?? manager.watchedRoom(user.id);
      if (!r) throw new GameError('NOT_IN_ROOM');
      return { code: r.code, messages: r.chatHistory(user.id) };
    });

    on('auction:skip', skipSchema, ({ lotNumber }) => {
      const r = manager.roomOf(user.id);
      if (!r) throw new GameError('NOT_IN_ROOM');
      r.skip(user.id, lotNumber);
    });

    const inRoom = () => manager.roomOf(user.id) ?? (() => { throw new GameError('NOT_IN_ROOM'); })();
    on('auction:pause', null, () => inRoom().requestPause(user.id));
    on('auction:focus', focusSchema, ({ group }) => inRoom().setFocus(user.id, group));
    on('presence', presenceSchema, ({ away }) => manager.roomOf(user.id)?.setAway(user.id, away));
    on('auction:pause-vote', pauseVoteSchema, ({ agree }) => inRoom().votePause(user.id, agree));
    on('auction:resume', null, () => inRoom().resumePause(user.id));
    on('squad:release', releaseSchema, ({ playerId }) => inRoom().release(user.id, playerId));
    on('trade:propose', tradeProposeSchema, (t) => inRoom().proposeTrade(user.id, t));
    on('trade:respond', tradeRespondSchema, ({ tradeId, accept }) => inRoom().respondTrade(user.id, tradeId, accept));
    on('trade:cancel', tradeCancelSchema, ({ tradeId }) => inRoom().cancelTrade(user.id, tradeId));
    on('squad:draft', lineupSchema, (l) => inRoom().saveLineupDraft(user.id, l));
    on('squad:lock', lineupSchema, (l) => inRoom().lockLineup(user.id, l));
    on('squad:unlock', null, () => inRoom().unlockLineup(user.id));

    socket.on('time:sync', (_raw, ack) => {
      if (typeof ack === 'function' && syncs.take()) ack({ serverTime: deps.clock.now() });
    });

    socket.on('disconnect', () => {
      if (socket.data.replaced || userSockets.get(user.id) !== socket) return;
      userSockets.delete(user.id);
      manager.stopWatching(user.id);
      manager.setConnected(user.id, false);
    });
  });

  // Unknown API routes are JSON 404s; everything else is the website (production single-service mode).
  app.use('/api', (_req, res) => {
    res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Unknown endpoint.' });
  });
  if (deps.webHandler) {
    const handle = deps.webHandler;
    app.use((req, res) => {
      handle(req, res).catch((e) => {
        log('web handler failed', e);
        if (!res.headersSent) res.status(500).end('Something went wrong.');
      });
    });
  }

  return {
    app,
    http,
    io,
    manager,
    listen(port: number) {
      return new Promise<number>((resolve) => {
        http.listen(port, () => {
          const addr = http.address();
          resolve(typeof addr === 'object' && addr ? addr.port : port);
        });
      });
    },
    async close() {
      await manager.shutdown();
      io.close();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

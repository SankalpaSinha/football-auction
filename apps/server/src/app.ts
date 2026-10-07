import { createServer, type Server as HttpServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import { Server, type Socket } from 'socket.io';
import {
  ERROR_MESSAGES,
  bidSchema,
  createRoomSchema,
  joinRoomSchema,
  readySchema,
  skipSchema,
  usernameSchema,
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
import { RateLimiter, TokenBucket } from './lib/rateLimit';
import { RoomManager, roomChannel, userChannel } from './realtime/roomManager';
import { newToken, UsernameTakenError, type UserStore } from './services/users';

export interface AppDeps {
  catalog: PlayerCatalog;
  users: UserStore;
  store: GameStore;
  clock: Clock;
  rules: GameRules;
  corsOrigins: string[] | true;
  maxRooms?: number;
  seed?: string;
  log?: (msg: string, err?: unknown) => void;
}

type IO = Server<ClientToServer, ServerToClient, Record<string, never>, { user: SessionUser; replaced?: boolean }>;
type AppSocket = Socket<ClientToServer, ServerToClient, Record<string, never>, { user: SessionUser; replaced?: boolean }>;

const errorAck = (code: ErrorCode, message?: string): Ack<never> => ({
  ok: false,
  code,
  error: message ?? ERROR_MESSAGES[code],
});

export function createApp(deps: AppDeps) {
  const log = deps.log ?? ((msg, err) => console.error(msg, err ?? ''));
  const app = express();
  app.set('trust proxy', 1);
  app.use(cors({ origin: deps.corsOrigins }));
  app.use(express.json({ limit: '8kb' }));

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
    log,
  });

  // --------------------------------------------------------------- REST

  const bearer = (h?: string) => (h?.startsWith('Bearer ') ? h.slice(7).trim() : null);
  const sessionLimiter = new RateLimiter(20, 60 * 60_000);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, rooms: manager.roomCount, time: deps.clock.now() });
  });

  app.post('/api/session', async (req, res) => {
    try {
      const token = bearer(req.headers.authorization);
      const parsed = usernameSchema.safeParse(req.body?.username);
      if (!parsed.success) return void res.status(400).json(errorAck('BAD_REQUEST', parsed.error.issues[0]?.message));
      if (token) {
        const existing = await deps.users.findByToken(token);
        if (existing && existing.username.toLowerCase() === parsed.data.toLowerCase()) {
          return void res.json({ user: existing, token });
        }
      }
      if (!sessionLimiter.take(req.ip ?? 'unknown')) return void res.status(429).json(errorAck('RATE_LIMITED'));
      const fresh = newToken();
      const user = await deps.users.create(parsed.data, fresh);
      res.json({ user, token: fresh });
    } catch (e) {
      if (e instanceof UsernameTakenError) {
        return void res.status(409).json({ ok: false, code: 'USERNAME_TAKEN', error: 'That username is taken.' });
      }
      log('POST /api/session failed', e);
      res.status(500).json({ ok: false, code: 'INTERNAL', error: 'Something went wrong.' });
    }
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

  app.get('/api/rooms/:code', (req, res) => {
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

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || token.length > 128) return next(new Error('UNAUTHENTICATED'));
    try {
      const user = await deps.users.findByToken(token);
      if (!user) return next(new Error('UNAUTHENTICATED'));
      socket.data.user = user;
      next();
    } catch (e) {
      log('socket auth failed', e);
      next(new Error('UNAUTHENTICATED'));
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

    const room = manager.roomOf(user.id);
    if (room) {
      socket.join(roomChannel(room.code));
      room.setConnected(user.id, true);
      socket.emit('room:state', room.view());
    }

    const actions = new TokenBucket(15, 30, () => deps.clock.now());
    const bids = new TokenBucket(6, 10, () => deps.clock.now());

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
      const r = manager.join(user, code);
      socket.emit('room:state', r.view());
      return { code: r.code };
    });

    on('room:leave', null, () => manager.leave(user.id));

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

    on('auction:skip', skipSchema, ({ lotNumber }) => {
      const r = manager.roomOf(user.id);
      if (!r) throw new GameError('NOT_IN_ROOM');
      r.skip(user.id, lotNumber);
    });

    socket.on('time:sync', (_raw, ack) => {
      if (typeof ack === 'function') ack({ serverTime: deps.clock.now() });
    });

    socket.on('disconnect', () => {
      if (socket.data.replaced || userSockets.get(user.id) !== socket) return;
      userSockets.delete(user.id);
      manager.setConnected(user.id, false);
    });
  });

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

'use client';
import { io, type Socket } from 'socket.io-client';
import type { Ack, ClientToServer, ServerToClient } from '@fa/shared';
import { serverUrl } from './config';
import { sound } from './sound';
import { useGame } from './store';

type GameSocket = Socket<ServerToClient, ClientToServer>;

let socket: GameSocket | null = null;
let socketToken: string | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;

/** NTP-style offset estimate; keeps the best (lowest RTT) of a few samples. */
async function syncClock(s: GameSocket) {
  let best: { rtt: number; offset: number } | null = null;
  for (let i = 0; i < 4; i++) {
    const t0 = Date.now();
    const serverTime = await new Promise<number | null>((resolve) => {
      s.timeout(3000).emit('time:sync', {}, (err: unknown, r: { serverTime: number }) => resolve(err ? null : r.serverTime));
    });
    const t1 = Date.now();
    if (serverTime === null) continue;
    const rtt = t1 - t0;
    const offset = serverTime - (t0 + t1) / 2;
    if (!best || rtt < best.rtt) best = { rtt, offset };
  }
  if (best) useGame.getState().setClockOffset(best.offset);
}

export function connectSocket(token: string): GameSocket {
  if (socket && socketToken === token) {
    if (socket.disconnected) socket.connect();
    return socket;
  }
  socket?.disconnect();
  socketToken = token;
  const store = useGame.getState();
  store.setConnection('connecting');

  const s: GameSocket = io(serverUrl(), {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnectionDelay: 500,
    reconnectionDelayMax: 4000,
  });
  socket = s;

  s.on('connect', () => {
    useGame.getState().setConnection('connected');
    void syncClock(s);
  });
  s.on('disconnect', (reason) => {
    if (useGame.getState().connection === 'replaced') return;
    useGame.getState().setConnection(reason === 'io client disconnect' ? 'idle' : 'reconnecting');
  });
  s.io.on('reconnect_attempt', () => useGame.getState().setConnection('reconnecting'));
  s.on('connect_error', (err) => {
    useGame.getState().setConnection(err.message === 'UNAUTHENTICATED' ? 'error' : 'reconnecting');
  });
  s.on('room:state', (view) => useGame.getState().setRoom(view));
  s.on('room:event', (e) => {
    useGame.getState().pushEvent(e);
    sound.onEvent(e, useGame.getState().session?.user.id ?? '');
  });
  s.on('room:closed', ({ reason }) => {
    useGame.getState().setRoomClosed(reason);
  });
  s.on('session:replaced', () => {
    useGame.getState().setConnection('replaced');
    s.io.opts.reconnection = false;
  });

  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => s.connected && void syncClock(s), 30_000);
  return s;
}

export function getSocket() {
  return socket;
}

export function reclaimSession() {
  if (!socket) return;
  socket.io.opts.reconnection = true;
  useGame.getState().setConnection('connecting');
  socket.connect();
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
  socketToken = null;
}

export function emit<T = unknown>(event: keyof ClientToServer, payload: unknown = {}): Promise<Ack<T>> {
  const s = socket;
  if (!s || !s.connected) {
    return Promise.resolve({ ok: false, code: 'OFFLINE', error: 'Not connected to the game server.' });
  }
  return new Promise((resolve) => {
    (s.timeout(6000) as unknown as Socket).emit(event, payload, (err: unknown, r: Ack<T>) => {
      resolve(err ? { ok: false, code: 'TIMEOUT', error: 'The server did not respond.' } : r);
    });
  });
}

/** Connect (if needed) and resolve once the socket is live. */
export function ensureConnected(token: string, timeoutMs = 6000): Promise<boolean> {
  const s = connectSocket(token);
  if (s.connected) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(t);
      s.off('connect', onConnect);
      resolve(ok);
    };
    const onConnect = () => done(true);
    const t = setTimeout(() => done(false), timeoutMs);
    s.on('connect', onConnect);
  });
}

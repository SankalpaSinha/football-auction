import { randomInt } from 'node:crypto';
import type { CreateRoomInput, GameRules, RoomSettings, SessionUser } from '@fa/shared';
import type { Server } from 'socket.io';
import { maxPlayersForPool, type PlayerCatalog } from '../data/catalog';
import type { Clock } from '../engine/clock';
import { fail } from '../engine/errors';
import { Room } from '../engine/room';
import type { GameStore } from '../engine/store';
import { RateLimiter } from '../lib/rateLimit';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export const roomChannel = (code: string) => `room:${code}`;
export const userChannel = (userId: string) => `user:${userId}`;

export interface ManagerDeps {
  catalog: PlayerCatalog;
  store: GameStore;
  clock: Clock;
  rules: GameRules;
  maxRooms: number;
  seed?: string;
  log: (msg: string, err?: unknown) => void;
}

/** Owns every live room and the user → room index. */
export class RoomManager {
  private rooms = new Map<string, Room>();
  private userRoom = new Map<string, string>();
  private dirty = new Set<Room>();
  private flushScheduled = false;
  private createLimiter: RateLimiter;

  constructor(
    private readonly io: Server,
    private readonly deps: ManagerDeps,
  ) {
    this.createLimiter = new RateLimiter(5, 10 * 60_000, () => deps.clock.now());
  }

  get roomCount() {
    return this.rooms.size;
  }

  get(code: string) {
    return this.rooms.get(code);
  }

  roomOf(userId: string): Room | undefined {
    const code = this.userRoom.get(userId);
    return code ? this.rooms.get(code) : undefined;
  }

  create(user: SessionUser, input: CreateRoomInput): Room {
    if (input.mode === 'RANKED') fail('RANKED_UNAVAILABLE');
    if (input.isPublic) fail('PUBLIC_UNAVAILABLE');
    const meta = this.deps.catalog.meta(input.competitionId, input.seasonId) ?? fail('COMPETITION_UNAVAILABLE');
    const pool = this.deps.catalog.resolvePool(input.competitionId, input.seasonId) ?? fail('COMPETITION_UNAVAILABLE');
    const gks = pool.filter((p) => p.position === 'GK').length;
    if (input.maxPlayers > maxPlayersForPool(pool.length, gks)) fail('POOL_TOO_SMALL');
    if (this.rooms.size >= this.deps.maxRooms) fail('TOO_MANY_ROOMS', 'The server is full right now — try again soon.');
    if (!this.createLimiter.take(user.id)) fail('TOO_MANY_ROOMS');
    this.leaveCurrentRoomForSwitch(user.id, null);

    const settings: RoomSettings = {
      competitionId: input.competitionId,
      seasonId: input.seasonId,
      startingBudget: input.startingBudget,
      maxPlayers: input.maxPlayers,
      lotDurationSec: input.lotDurationSec,
      mode: input.mode,
      isPublic: input.isPublic,
      antiSnipe: input.antiSnipe,
    };

    const code = this.newCode();
    // Register before construction finishes broadcasting.
    this.userRoom.set(user.id, code);
    const room = new Room(code, input.name, settings, meta, pool, user, {
      clock: this.deps.clock,
      rules: this.deps.rules,
      store: this.deps.store,
      seed: this.deps.seed,
      log: this.deps.log,
      onChange: (r) => this.markDirty(r),
      onEvent: (r, e) => this.io.to(roomChannel(r.code)).emit('room:event', e),
      onClosed: (r, reason) => this.onClosed(r, reason),
      onMemberRemoved: (r, userId) => {
        if (this.userRoom.get(userId) === r.code) this.userRoom.delete(userId);
        this.io.in(userChannel(userId)).socketsLeave(roomChannel(r.code));
      },
    });
    this.rooms.set(code, room);
    this.io.in(userChannel(user.id)).socketsJoin(roomChannel(code));
    this.markDirty(room);
    return room;
  }

  join(user: SessionUser, code: string): Room {
    const room = this.rooms.get(code) ?? fail('ROOM_NOT_FOUND');
    if (!room.hasMember(user.id)) this.leaveCurrentRoomForSwitch(user.id, code);
    room.join(user);
    this.userRoom.set(user.id, code);
    this.io.in(userChannel(user.id)).socketsJoin(roomChannel(code));
    this.markDirty(room);
    return room;
  }

  leave(userId: string) {
    const room = this.roomOf(userId) ?? fail('NOT_IN_ROOM');
    room.leave(userId);
    // Mid-game the member stays in the room (squad intact) but is free to go elsewhere.
    if (this.userRoom.get(userId) === room.code) this.userRoom.delete(userId);
    this.io.in(userChannel(userId)).socketsLeave(roomChannel(room.code));
  }

  /** Before entering another room: leave a lobby, refuse while an auction is live. */
  private leaveCurrentRoomForSwitch(userId: string, targetCode: string | null) {
    const current = this.roomOf(userId);
    if (!current || current.code === targetCode) return;
    if (current.isLive && current.hasMember(userId)) fail('ALREADY_IN_GAME');
    if (current.hasMember(userId)) current.leave(userId);
    this.userRoom.delete(userId);
    this.io.in(userChannel(userId)).socketsLeave(roomChannel(current.code));
  }

  setConnected(userId: string, connected: boolean) {
    this.roomOf(userId)?.setConnected(userId, connected);
  }

  private onClosed(room: Room, reason: string) {
    this.rooms.delete(room.code);
    this.dirty.delete(room);
    for (const [userId, code] of this.userRoom) if (code === room.code) this.userRoom.delete(userId);
    this.io.to(roomChannel(room.code)).emit('room:closed', { code: room.code, reason });
    this.io.in(roomChannel(room.code)).socketsLeave(roomChannel(room.code));
  }

  /** Coalesce bursts of changes into one broadcast per room per tick. */
  private markDirty(room: Room) {
    this.dirty.add(room);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      const rooms = [...this.dirty];
      this.dirty.clear();
      // Each manager gets their own snapshot (their lineup draft is private).
      for (const r of rooms) {
        if (r.closed) continue;
        for (const userId of r.memberIds()) {
          if (this.userRoom.get(userId) === r.code) this.io.to(userChannel(userId)).emit('room:state', r.view(userId));
        }
      }
    });
  }

  private newCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  async shutdown() {
    await Promise.all([...this.rooms.values()].map((r) => r.flush()));
  }
}

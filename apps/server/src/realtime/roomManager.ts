import { randomInt } from 'node:crypto';
import { ELO_CONFIG, GAME_RULES, type CreateRoomInput, type GameMode, type GameRules, type RoomSettings, type SessionUser } from '@fa/shared';
import type { Server } from 'socket.io';
import { maxPlayersForPool, type PlayerCatalog } from '../data/catalog';
import type { Clock } from '../engine/clock';
import { fail } from '../engine/errors';
import { Room } from '../engine/room';
import type { GameStore } from '../engine/store';
import type { Commentator } from '../services/commentary';
import { RateLimiter } from '../lib/rateLimit';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export const roomChannel = (code: string) => `room:${code}`;
export const userChannel = (userId: string) => `user:${userId}`;
export const spectateChannel = (code: string) => `spectate:${code}`;

export interface PublicRoomInfo {
  code: string;
  name: string;
  mode: GameMode;
  competition: { id: string; name: string; accent: string; seasonLabel: string };
  members: number;
  maxPlayers: number;
  host: string;
  avgElo: number;
  lotDurationSec: number;
  createdAt: number;
}

export interface ManagerDeps {
  catalog: PlayerCatalog;
  store: GameStore;
  clock: Clock;
  rules: GameRules;
  maxRooms: number;
  seed?: string;
  commentator?: Commentator;
  log: (msg: string, err?: unknown) => void;
}

/** Owns every live room and the user → room index. */
export class RoomManager {
  private rooms = new Map<string, Room>();
  private userRoom = new Map<string, string>();
  /** userId → code of the room they are watching. */
  private watching = new Map<string, string>();
  private dirty = new Set<Room>();
  private flushScheduled = false;
  private createLimiter: RateLimiter;
  /** Last known ranked ELO per user (for lobby listings and matchmaking). */
  private elo = new Map<string, number>();

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
    if (input.mode === 'RANKED' && input.startingBudget !== GAME_RULES.defaultBudget) fail('RANKED_SETTINGS');
    // Ranked rooms are always public (harder to farm ELO against your own alt accounts).
    if (input.mode === 'RANKED') input = { ...input, isPublic: true };
    const meta = this.deps.catalog.meta(input.competitionId, input.seasonId) ?? fail('COMPETITION_UNAVAILABLE');
    const pool = this.deps.catalog.resolvePool(input.competitionId, input.seasonId) ?? fail('COMPETITION_UNAVAILABLE');
    if (input.maxPlayers > maxPlayersForPool(pool)) fail('POOL_TOO_SMALL');
    if (this.rooms.size >= this.deps.maxRooms) fail('TOO_MANY_ROOMS', 'The server is full right now — try again soon.');
    if (!this.createLimiter.take(user.id)) fail('TOO_MANY_ROOMS');
    this.leaveCurrentRoomForSwitch(user.id, null);
    this.stopWatching(user.id);

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
      commentator: this.deps.commentator,
      log: this.deps.log,
      onChange: (r) => this.markDirty(r),
      onEvent: (r, e) => {
        // Who is negotiating with whom stays between the two managers.
        if (e.type === 'TRADE_OFFER' || e.type === 'TRADE_DECLINED') {
          this.io.to([userChannel(e.fromId), userChannel(e.toId)]).emit('room:event', e);
          return;
        }
        this.io.to(roomChannel(r.code)).emit('room:event', e);
        if (e.type === 'RESULTS') {
          for (const c of r.view().results?.ratingChanges ?? []) this.elo.set(c.userId, c.after);
        }
      },
      onClosed: (r, reason) => this.onClosed(r, reason),
      onChat: (r, msg) => this.io.to(roomChannel(r.code)).emit('room:chat', { ...msg, code: r.code }),
      onKicked: (r, userId, reason) => this.io.in(userChannel(userId)).emit('room:removed', { code: r.code, reason }),
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
    // Validate before touching spectator state, so a refused join doesn't end watching.
    if (!room.hasMember(user.id)) {
      room.assertNotKicked(user.id);
      if (!room.isLobby) fail('GAME_IN_PROGRESS');
      if (room.memberCount >= room.settings.maxPlayers) fail('ROOM_FULL');
    }
    // Always detach from any other room first — even when rejoining a room you already
    // belong to — so a user is never "connected" in two rooms at once.
    this.leaveCurrentRoomForSwitch(user.id, code);
    this.stopWatching(user.id);
    room.join(user);
    this.userRoom.set(user.id, code);
    this.io.in(userChannel(user.id)).socketsJoin(roomChannel(code));
    this.markDirty(room);
    return room;
  }

  /** Watch a room read-only. A member asking to watch simply re-joins as themselves. */
  spectate(user: SessionUser, code: string): { room: Room; role: 'member' | 'spectator' } {
    const room = this.rooms.get(code) ?? fail('ROOM_NOT_FOUND');
    if (room.hasMember(user.id)) return { room: this.join(user, code), role: 'member' };
    this.leaveCurrentRoomForSwitch(user.id, null);
    this.stopWatching(user.id);
    room.addSpectator(user.id);
    this.watching.set(user.id, code);
    this.io.in(userChannel(user.id)).socketsJoin([roomChannel(code), spectateChannel(code)]);
    return { room, role: 'spectator' };
  }

  watchedRoom(userId: string): Room | undefined {
    const code = this.watching.get(userId);
    return code ? this.rooms.get(code) : undefined;
  }

  /** A new socket for someone already watching: put it back in the spectator channels. */
  reattachSpectator(userId: string) {
    const code = this.watching.get(userId);
    if (code && this.rooms.has(code)) this.io.in(userChannel(userId)).socketsJoin([roomChannel(code), spectateChannel(code)]);
  }

  stopWatching(userId: string) {
    const code = this.watching.get(userId);
    if (!code) return;
    this.watching.delete(userId);
    this.rooms.get(code)?.removeSpectator(userId);
    this.io.in(userChannel(userId)).socketsLeave([roomChannel(code), spectateChannel(code)]);
  }

  /** Public games in progress that can be watched. */
  liveGames() {
    return [...this.rooms.values()]
      .filter((r) => !r.closed && r.settings.isPublic && !r.isLobby)
      .map((r) => {
        const v = r.view();
        return {
          code: r.code,
          name: r.name,
          mode: r.settings.mode,
          phase: r.phase,
          competition: { id: r.competition.id, name: r.competition.name, accent: r.competition.accent, seasonLabel: r.competition.seasonLabel },
          managers: v.members.map((m) => m.username),
          spectators: v.spectators,
          lotsOpened: v.auction?.lotsOpened ?? 0,
        };
      });
  }

  leave(userId: string) {
    if (this.watching.has(userId)) return this.stopWatching(userId);
    const room = this.roomOf(userId) ?? fail('NOT_IN_ROOM');
    room.leave(userId);
    // Mid-game the member stays in the room (squad intact) but is free to go elsewhere.
    if (this.userRoom.get(userId) === room.code) this.userRoom.delete(userId);
    this.io.in(userChannel(userId)).socketsLeave(roomChannel(room.code));
  }

  /** Exit a game for good (see Room.quit), then detach like a normal leave. */
  quit(userId: string) {
    const room = this.roomOf(userId) ?? fail('NOT_IN_ROOM');
    room.quit(userId);
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

  rememberElo(userId: string, elo: number) {
    this.elo.set(userId, elo);
  }

  /** Open public lobbies with a free seat. */
  publicLobbies(): PublicRoomInfo[] {
    return [...this.rooms.values()]
      .filter((r) => !r.closed && r.settings.isPublic && r.isLobby && r.memberCount < r.settings.maxPlayers)
      .map((r) => {
        const ids = r.memberIds();
        const elos = ids.map((id) => this.elo.get(id) ?? ELO_CONFIG.initial);
        return {
          code: r.code,
          name: r.name,
          mode: r.settings.mode,
          competition: { id: r.competition.id, name: r.competition.name, accent: r.competition.accent, seasonLabel: r.competition.seasonLabel },
          members: ids.length,
          maxPlayers: r.settings.maxPlayers,
          host: r.view().members.find((m) => m.isHost)?.username ?? '',
          avgElo: Math.round(elos.reduce((a, b) => a + b, 0) / Math.max(1, elos.length)),
          lotDurationSec: r.settings.lotDurationSec,
          createdAt: r.createdAt,
        };
      })
      .sort((a, b) => b.members - a.members || a.createdAt - b.createdAt);
  }

  /**
   * "Play now": join the best open public lobby for these preferences, or
   * open a new public one. Prefers the requested competition, fuller rooms,
   * and (for ranked) the closest average ELO.
   */
  quickMatch(user: SessionUser, prefs: { mode: GameMode; competitionId?: string }): { room: Room; created: boolean } {
    const current = this.roomOf(user.id);
    if (current?.isLobby && current.settings.isPublic && current.settings.mode === prefs.mode) {
      return { room: current, created: false };
    }
    const myElo = this.elo.get(user.id) ?? ELO_CONFIG.initial;
    const candidates = this.publicLobbies()
      .filter((r) => r.mode === prefs.mode && r.code !== current?.code)
      .map((r) => ({
        r,
        score:
          (prefs.competitionId && r.competition.id !== prefs.competitionId ? 1000 : 0) +
          (prefs.mode === 'RANKED' ? Math.abs(r.avgElo - myElo) : 0) -
          r.members * 25,
      }))
      .sort((a, b) => a.score - b.score);
    for (const { r } of candidates) {
      try {
        return { room: this.join(user, r.code), created: false };
      } catch {
        // filled up or started in the meantime — try the next one
      }
    }
    const comps = this.deps.catalog.competitions();
    const comp = comps.find((c) => c.id === prefs.competitionId) ?? comps.find((c) => c.id === 'premier-league') ?? comps[0];
    if (!comp) fail('COMPETITION_UNAVAILABLE');
    const season = comp.seasons[comp.seasons.length - 1];
    const room = this.create(user, {
      name: `${user.username}'s ${prefs.mode === 'RANKED' ? 'ranked' : 'quick'} match`.slice(0, 32),
      competitionId: comp.id,
      seasonId: season.id,
      startingBudget: GAME_RULES.defaultBudget,
      maxPlayers: Math.min(4, season.maxPlayers),
      lotDurationSec: GAME_RULES.defaultLotDurationSec,
      mode: prefs.mode,
      isPublic: true,
      antiSnipe: true,
    });
    return { room, created: true };
  }

  setConnected(userId: string, connected: boolean) {
    this.roomOf(userId)?.setConnected(userId, connected);
  }

  private onClosed(room: Room, reason: string) {
    this.rooms.delete(room.code);
    this.dirty.delete(room);
    for (const [userId, code] of this.watching) if (code === room.code) this.watching.delete(userId);
    this.io.in(spectateChannel(room.code)).socketsLeave(spectateChannel(room.code));
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
        try {
        for (const userId of r.memberIds()) {
          if (this.userRoom.get(userId) === r.code) this.io.to(userChannel(userId)).emit('room:state', r.view(userId));
        }
        // Spectators share one public snapshot (no private lineups).
        this.io.to(spectateChannel(r.code)).emit('room:state', r.view());
        } catch (err) {
          this.deps.log(`[room ${r.code}] broadcast failed`, err);
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

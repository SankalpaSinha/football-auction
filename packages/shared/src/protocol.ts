import { z } from 'zod';
import { GAME_RULES } from './rules';
import type { GameEvent, RoomView } from './types';

export const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
export const ROOM_CODE_RE = /^[A-Z0-9]{6}$/;

export const usernameSchema = z
  .string()
  .trim()
  .regex(USERNAME_RE, 'Usernames are 3–16 characters: letters, numbers or underscore.');

export const roomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(ROOM_CODE_RE, 'Room codes are 6 letters/numbers.');

export const createRoomSchema = z.object({
  name: z.string().trim().min(1).max(32),
  competitionId: z.string().min(1).max(64),
  seasonId: z.string().min(1).max(16),
  startingBudget: z.number().int().refine((v) => GAME_RULES.budgetOptions.includes(v), 'Unsupported budget'),
  maxPlayers: z.number().int().min(GAME_RULES.minPlayers).max(GAME_RULES.maxPlayers),
  lotDurationSec: z
    .number()
    .int()
    .refine((v) => GAME_RULES.lotDurationOptions.includes(v), 'Unsupported timer'),
  mode: z.enum(['CASUAL', 'RANKED']).default('CASUAL'),
  isPublic: z.boolean().default(false),
  antiSnipe: z.boolean().default(true),
});
export type CreateRoomInput = z.infer<typeof createRoomSchema>;

export const joinRoomSchema = z.object({ code: roomCodeSchema });
export const readySchema = z.object({ ready: z.boolean() });
export const bidSchema = z.object({
  lotNumber: z.number().int().positive(),
  amount: z.number().int().positive().max(1_000_000),
});
export const skipSchema = z.object({ lotNumber: z.number().int().positive() });

/** Every client→server action is acknowledged with one of these. */
export type Ack<T = undefined> = { ok: true; data?: T } | { ok: false; error: string; code: string };

export interface ClientToServer {
  'room:create': (input: unknown, ack: (r: Ack<{ code: string }>) => void) => void;
  'room:join': (input: unknown, ack: (r: Ack<{ code: string }>) => void) => void;
  'room:leave': (input: unknown, ack: (r: Ack) => void) => void;
  'room:ready': (input: unknown, ack: (r: Ack) => void) => void;
  'room:start': (input: unknown, ack: (r: Ack) => void) => void;
  'auction:bid': (input: unknown, ack: (r: Ack) => void) => void;
  'auction:skip': (input: unknown, ack: (r: Ack) => void) => void;
  'time:sync': (input: unknown, ack: (r: { serverTime: number }) => void) => void;
}

export interface ServerToClient {
  'room:state': (view: RoomView) => void;
  'room:event': (event: GameEvent) => void;
  'room:closed': (info: { code: string; reason: string }) => void;
  'session:replaced': () => void;
}

export const ERROR_MESSAGES = {
  BAD_REQUEST: 'That request was malformed.',
  RATE_LIMITED: 'Slow down — too many actions.',
  UNAUTHENTICATED: 'Pick a username first.',
  ROOM_NOT_FOUND: 'No room with that code.',
  ROOM_FULL: 'That room is full.',
  GAME_IN_PROGRESS: 'That game has already started.',
  ALREADY_IN_GAME: 'You are already playing in another room.',
  NOT_IN_ROOM: 'You are not in this room.',
  NOT_HOST: 'Only the host can do that.',
  NOT_ENOUGH_PLAYERS: 'At least two players are needed.',
  NOT_ALL_READY: 'Everyone must be ready.',
  PLAYERS_DISCONNECTED: 'Wait for everyone to reconnect.',
  WRONG_PHASE: 'That is not possible right now.',
  COMPETITION_UNAVAILABLE: 'That competition/season is not available.',
  POOL_TOO_SMALL: 'This player pool is too small for that many players.',
  RANKED_UNAVAILABLE: 'Ranked mode is not available yet.',
  PUBLIC_UNAVAILABLE: 'Public rooms are not available yet.',
  TOO_MANY_ROOMS: 'You have created too many rooms recently.',
  // auction
  NO_ACTIVE_LOT: 'There is no player up for auction.',
  STALE_LOT: 'That player is no longer up for auction.',
  LOT_CLOSED: 'Bidding has closed for this player.',
  AUCTION_PAUSED: 'The auction is paused.',
  NOT_PARTICIPANT: 'You are not part of this auction.',
  ALREADY_SKIPPED: 'You skipped this player.',
  ALREADY_HIGHEST: 'You already hold the highest bid.',
  SQUAD_FULL: 'Your squad is full.',
  BID_TOO_LOW: 'Bid is below the minimum.',
  OVER_BUDGET: 'You cannot afford that bid.',
  RESERVE_REQUIRED: 'You must keep enough coins to complete your squad.',
  NEED_GOALKEEPER: 'Your last slot must be a goalkeeper.',
  GOALKEEPER_LIMIT: 'Other managers still need the remaining goalkeepers.',
} as const;
export type ErrorCode = keyof typeof ERROR_MESSAGES;

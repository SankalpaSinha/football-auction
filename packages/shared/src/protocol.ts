import { z } from 'zod';
import { TACTIC_IDS, type TacticId } from './playstyles';
import { POSITIONS } from './positions';
import { GAME_RULES } from './rules';
import type { ChatMessage, GameEvent, PlayerCard, RoomView } from './types';

export const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
export const ROOM_CODE_RE = /^[A-Z0-9]{6}$/;

export const usernameSchema = z
  .string()
  .trim()
  .regex(USERNAME_RE, 'Usernames are 3–16 characters: letters, numbers or underscore.');

export const passwordSchema = z
  .string()
  .min(6, 'Passwords need at least 6 characters.')
  .max(72, 'Passwords can be at most 72 characters.');

export const credentialsSchema = z.object({ username: usernameSchema, password: passwordSchema });

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

export const quickMatchSchema = z.object({
  mode: z.enum(['CASUAL', 'RANKED']).default('CASUAL'),
  competitionId: z.string().min(1).max(64).optional(),
});

export const joinRoomSchema = z.object({ code: roomCodeSchema });
export const readySchema = z.object({ ready: z.boolean() });
export const bidSchema = z.object({
  lotNumber: z.number().int().positive(),
  amount: z.number().int().positive().max(1_000_000),
});
export const skipSchema = z.object({ lotNumber: z.number().int().positive() });
export const CHAT_MAX_LENGTH = 200;
export const chatSchema = z.object({
  text: z
    .string()
    .max(CHAT_MAX_LENGTH * 2)
    // strip control characters, collapse whitespace
    .transform((t) => t.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_LENGTH))
    .refine((t) => t.length > 0, 'Type a message first.'),
});

const playerIdSchema = z.string().min(1).max(120);
export const releaseSchema = z.object({ playerId: playerIdSchema });
export const tradeProposeSchema = z.object({
  toId: z.string().min(1).max(64),
  give: z.array(playerIdSchema).max(5),
  take: z.array(playerIdSchema).max(5),
  coins: z.number().int().min(-100_000).max(100_000),
});
export const tradeRespondSchema = z.object({ tradeId: z.string().min(1).max(64), accept: z.boolean() });
export const tradeCancelSchema = z.object({ tradeId: z.string().min(1).max(64) });
export const focusSchema = z.object({ group: z.enum(['GK', 'DEF', 'MID', 'ATT']).nullable() });
export const presenceSchema = z.object({ away: z.boolean() });
export const pauseVoteSchema = z.object({ agree: z.boolean() });
export const pickSchema = z.object({ playerId: z.string().min(1).max(120) });
export const lineupSchema = z.object({
  formationId: z.string().min(1).max(16),
  slots: z.array(z.string().min(1).max(80).nullable()).max(11),
  tactic: z.enum(TACTIC_IDS as [TacticId, ...TacticId[]]).optional(),
  /** Custom formation (formationId 'custom'): 11 positions, keeper first. Checked again by the engine. */
  custom: z
    .array(z.object({ role: z.enum(POSITIONS), x: z.number().min(0).max(100), y: z.number().min(0).max(100) }))
    .length(11)
    .nullable()
    .optional(),
});

/** Every client→server action is acknowledged with one of these. */
export type Ack<T = undefined> = { ok: true; data?: T } | { ok: false; error: string; code: string };

export interface ClientToServer {
  'room:create': (input: unknown, ack: (r: Ack<{ code: string }>) => void) => void;
  'room:join': (input: unknown, ack: (r: Ack<{ code: string }>) => void) => void;
  'room:leave': (input: unknown, ack: (r: Ack) => void) => void;
  'room:quit': (input: unknown, ack: (r: Ack) => void) => void;
  'room:spectate': (input: unknown, ack: (r: Ack<{ code: string; role: 'member' | 'spectator' }>) => void) => void;
  'room:ready': (input: unknown, ack: (r: Ack) => void) => void;
  'room:start': (input: unknown, ack: (r: Ack) => void) => void;
  'auction:bid': (input: unknown, ack: (r: Ack) => void) => void;
  'auction:skip': (input: unknown, ack: (r: Ack) => void) => void;
  'auction:pick': (input: unknown, ack: (r: Ack) => void) => void;
  'auction:focus': (input: unknown, ack: (r: Ack) => void) => void;
  'presence': (input: unknown, ack: (r: Ack) => void) => void;
  'auction:pause': (input: unknown, ack: (r: Ack) => void) => void;
  'auction:pause-vote': (input: unknown, ack: (r: Ack) => void) => void;
  'auction:resume': (input: unknown, ack: (r: Ack) => void) => void;
  'squad:release': (input: unknown, ack: (r: Ack) => void) => void;
  'trade:propose': (input: unknown, ack: (r: Ack) => void) => void;
  'trade:respond': (input: unknown, ack: (r: Ack) => void) => void;
  'trade:cancel': (input: unknown, ack: (r: Ack) => void) => void;
  'auction:pool': (input: unknown, ack: (r: Ack<{ players: PlayerCard[] }>) => void) => void;
  'squad:draft': (input: unknown, ack: (r: Ack) => void) => void;
  'squad:lock': (input: unknown, ack: (r: Ack) => void) => void;
  'squad:unlock': (input: unknown, ack: (r: Ack) => void) => void;
  'match:quick': (input: unknown, ack: (r: Ack<{ code: string; created: boolean }>) => void) => void;
  'chat:send': (input: unknown, ack: (r: Ack) => void) => void;
  'chat:history': (input: unknown, ack: (r: Ack<{ code: string; messages: ChatMessage[] }>) => void) => void;
  'time:sync': (input: unknown, ack: (r: { serverTime: number }) => void) => void;
}

export interface ServerToClient {
  'room:state': (view: RoomView) => void;
  'room:event': (event: GameEvent) => void;
  'room:closed': (info: { code: string; reason: string }) => void;
  /** You were taken out of a game (e.g. for inactivity). */
  'room:removed': (info: { code: string; reason: string }) => void;
  'room:chat': (msg: ChatMessage & { code: string }) => void;
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
  RANKED_SETTINGS: 'Ranked games use the standard 1,000-coin budget.',
  TOO_MANY_ROOMS: 'You have created too many rooms recently.',
  TOO_MANY_SPECTATORS: 'This game has as many spectators as it can take.',
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
  NOT_YOUR_PICK: 'It isn’t your pick.',
  CHAT_SPECTATOR: 'Spectators can read the chat but not post.',
  PLAYER_UNAVAILABLE: 'That player is no longer available.',
  PAUSE_VOTE_OPEN: 'A pause vote is already running.',
  PAUSE_COOLDOWN: 'Wait a little before asking to pause again.',
  NO_PAUSE_VOTE: 'There is no pause vote right now.',
  NOT_PAUSED: 'The auction is not paused.',
  REMOVED_FROM_GAME: 'You were removed from this game.',
  TRADE_NOT_FOUND: 'That trade offer is no longer open.',
  TRADE_EMPTY: 'A trade needs at least one player.',
  TRADE_PENDING: 'You already have an offer out to that manager.',
  TRADE_INVALID: 'That trade is no longer possible.',
  POOL_RESERVED: 'Other managers still need the remaining players to complete their squads.',
  STAR_LIMIT: 'You already have the maximum number of star players.',
  CANT_REFILL: 'You couldn’t afford to fill the empty slot again.',
  // squad building
  INVALID_FORMATION: 'Unknown formation.',
  LINEUP_INCOMPLETE: 'Fill all 11 positions first.',
  LINEUP_DUPLICATE: 'A player can only fill one position.',
  NOT_YOUR_PLAYER: 'That player is not in your squad.',
  GOALKEEPER_REQUIRED: 'Put a goalkeeper in goal.',
  LINEUP_LOCKED: 'Your lineup is locked — unlock it to make changes.',
} as const;
export type ErrorCode = keyof typeof ERROR_MESSAGES;

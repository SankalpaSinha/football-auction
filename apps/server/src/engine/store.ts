import type { EloChange, GameMode, RankedScore, RoomSettings } from '@fa/shared';
import { ELO_CONFIG } from '@fa/shared';
import type { LotRecord, Participant } from './auction';

/**
 * Persistence port for the engine. The live game never waits on it; writes are
 * queued per room. Implementations: PrismaGameStore (PostgreSQL), NoopGameStore.
 */
export interface GameStore {
  roomCreated(r: {
    id: string;
    code: string;
    name: string;
    hostUserId: string;
    settings: RoomSettings;
  }): Promise<void>;
  memberJoined(roomId: string, userId: string, seat: number): Promise<void>;
  memberLeft(roomId: string, userId: string): Promise<void>;
  hostChanged(roomId: string, hostUserId: string): Promise<void>;
  gameStarted(g: {
    gameId: string;
    roomId: string;
    seed: string;
    mode: GameMode;
    orderStrategy: string;
    poolSize: number;
    config: unknown;
    participants: { userId: string; budget: number }[];
  }): Promise<void>;
  lotClosed(gameId: string, lot: LotRecord, participants: Participant[]): Promise<void>;
  auctionCompleted(gameId: string, participants: Participant[]): Promise<void>;
  lineupsFinalized(gameId: string, lineups: { userId: string; formationId: string; slots: string[] }[]): Promise<void>;
  gameFinished(
    gameId: string,
    rankings: RankedScore[],
    ratingChanges: EloChange[] | null,
    achievements: Record<string, string[]>,
  ): Promise<void>;
  /** Current rating per user for a mode (defaults for users who never played it). */
  ratingsFor(userIds: string[], mode: GameMode): Promise<Record<string, { elo: number; games: number }>>;
  roomClosed(roomId: string, status: 'FINISHED' | 'ABANDONED' | 'CLOSED', gameId: string | null): Promise<void>;
}

export class NoopGameStore implements GameStore {
  async roomCreated() {}
  async memberJoined() {}
  async memberLeft() {}
  async hostChanged() {}
  async gameStarted() {}
  async lotClosed() {}
  async auctionCompleted() {}
  async lineupsFinalized() {}
  async gameFinished() {}
  async ratingsFor(userIds: string[]) {
    return Object.fromEntries(userIds.map((id) => [id, { elo: ELO_CONFIG.initial, games: 0 }]));
  }
  async roomClosed() {}
}

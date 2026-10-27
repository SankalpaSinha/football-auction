import type { MatchReport } from './analysis';
import type { CupSummary } from './cup';
import type { RankedScore } from './scoring';
import type { GameMode, LotOutcome, SquadEntry } from './types';

export interface StatsBlock {
  games: number;
  wins: number;
  podiums: number;
  winRate: number;
  avgScore: number;
  highestScore: number;
}

export interface LeaderboardRow extends StatsBlock {
  rank: number;
  userId: string;
  username: string;
  elo: number;
}

export interface MatchSummary {
  gameId: string;
  mode: GameMode;
  competition: { id: string; name: string; seasonLabel: string };
  players: number;
  rank: number;
  score: number;
  eloDelta: number | null;
  endedAt: string;
}

export interface ProfileView {
  userId: string;
  username: string;
  memberSince: string;
  ranked: StatsBlock & { elo: number; globalRank: number | null };
  casual: StatsBlock;
  favoriteCompetition: { id: string; name: string } | null;
  favoriteFormation: string | null;
  recent: MatchSummary[];
  achievements: { key: string; unlockedAt: string }[];
  /** Oldest → newest. */
  trend: { score: number; rank: number; players: number; mode: GameMode; endedAt: string }[];
  spending: {
    avgSpent: number;
    bargains: number;
    overpays: number;
    signings: number;
    biggestBargain: { playerName: string; price: number; value: number } | null;
    recordSigning: { playerName: string; price: number } | null;
  };
  formations: { id: string; count: number }[];
  /** Head-to-head against the managers played most: who finished higher. */
  rivals: { username: string; wins: number; losses: number }[];
}

/** Head-to-head between two managers across every finished game they both played. */
export interface RivalryRecord {
  a: string;
  b: string;
  aWins: number;
  bWins: number;
}

export interface MatchDetailManager {
  userId: string;
  username: string;
  squad: SquadEntry[];
  budgetLeft: number;
  lineup: { formationId: string; slots: (string | null)[] } | null;
  eloBefore: number | null;
  eloAfter: number | null;
}


export interface MatchDetailView {
  gameId: string;
  mode: GameMode;
  roomName: string;
  competition: { id: string; name: string; seasonLabel: string; accent: string };
  startedAt: string;
  endedAt: string | null;
  startingBudget: number;
  rankings: RankedScore[];
  report: MatchReport;
  managers: MatchDetailManager[];
  /** The cup played after the auction (games before the cup existed have none). */
  cup: CupSummary | null;
  lots: {
    lotNumber: number;
    playerId: string;
    playerName: string;
    outcome: LotOutcome;
    winner: string | null;
    price: number | null;
    estimatedValue: number;
    bids: number;
  }[];
}

import type { Position } from './positions';
import type { Tier } from './rules';
import type { ValueVerdict } from './valuation';
import type { RankedScore } from './scoring';
import type { MatchReport } from './analysis';
import type { EloChange } from './elo';

// ---------------------------------------------------------------------------
// Player data (source-agnostic — the UI never knows where this came from)
// ---------------------------------------------------------------------------

export interface OutfieldStats {
  pace: number;
  shooting: number;
  passing: number;
  dribbling: number;
  defending: number;
  physical: number;
}

export interface GoalkeeperStats {
  diving: number;
  handling: number;
  kicking: number;
  reflexes: number;
  speed: number;
  positioning: number;
}

export interface NationRef {
  code: string;
  name: string;
  flag: string;
}

export interface ClubRef {
  id: string;
  name: string;
  shortName: string;
  colors: [string, string];
  logoUrl: string | null;
}

export interface PlayerCard {
  /** Season-specific id (PlayerStats id). */
  id: string;
  playerId: string;
  name: string;
  shortName: string;
  nation: NationRef;
  club: ClubRef;
  /** Domestic league competition id, e.g. "premier-league". */
  league: string;
  season: string;
  position: Position;
  secondaryPositions: Position[];
  overall: number;
  tier: Tier;
  outfield: OutfieldStats | null;
  goalkeeping: GoalkeeperStats | null;
  age: number;
  preferredFoot: 'Left' | 'Right';
  heightCm: number;
  imageUrl: string | null;
  /** Attribution for the photo (author · licence), required for CC-licensed images. */
  imageCredit: string | null;
}

export type CompetitionType = 'LEAGUE' | 'CLUB_CUP' | 'INTERNATIONAL' | 'GLOBAL';

export interface CompetitionSummary {
  id: string;
  name: string;
  shortName: string;
  type: CompetitionType;
  accent: string;
  seasons: { id: string; label: string; poolSize: number; goalkeepers: number; maxPlayers: number }[];
}

// ---------------------------------------------------------------------------
// Room / game views (what the server broadcasts)
// ---------------------------------------------------------------------------

export const ROOM_PHASES = [
  'WAITING_FOR_PLAYERS',
  'LOBBY',
  'STARTING',
  'AUCTION',
  'PLAYER_SOLD',
  'SQUAD_BUILDING',
  'FORMATION_SELECTION',
  'FINAL_EVALUATION',
  'RESULTS',
  'FINISHED',
] as const;
export type RoomPhase = (typeof ROOM_PHASES)[number];

export type GameMode = 'CASUAL' | 'RANKED';

export interface RoomSettings {
  competitionId: string;
  seasonId: string;
  startingBudget: number;
  maxPlayers: number;
  lotDurationSec: number;
  mode: GameMode;
  isPublic: boolean;
  antiSnipe: boolean;
}

/** AUCTION = won a lot · PICK = chosen in free pick · AUTO = auto-assigned. */
export type Acquisition = 'AUCTION' | 'PICK' | 'AUTO';

export interface SquadEntry {
  player: PlayerCard;
  price: number;
  via: Acquisition;
  lotNumber: number;
  estimatedValue: number;
}

export interface MemberView {
  userId: string;
  username: string;
  seat: number;
  isHost: boolean;
  ready: boolean;
  connected: boolean;
  /** Present once the auction has started. */
  budget: number | null;
  squad: SquadEntry[];
  /** Highest bid this member is currently allowed to make (budget reserve applied). */
  maxBid: number | null;
}

export type LotOutcome = 'SOLD' | 'UNSOLD' | 'AUTO_ASSIGNED' | 'PICKED';

export interface LotView {
  lotNumber: number;
  player: PlayerCard;
  openedAt: number;
  /** Server epoch ms. Clients render a countdown against their synced clock. */
  endsAt: number;
  /** Set while the auction is paused (everyone disconnected). */
  pausedRemainingMs: number | null;
  currentBid: number | null;
  highestBidderId: string | null;
  minNextBid: number;
  skippedBy: string[];
  bidCount: number;
  extended: boolean;
  /** Was this player already offered once without a buyer? */
  reoffer: boolean;
}

export interface LotResultView {
  lotNumber: number;
  player: PlayerCard;
  outcome: LotOutcome;
  winnerId: string | null;
  price: number | null;
  estimatedValue: number;
  verdict: ValueVerdict | null;
  /** Server epoch ms when the next lot opens. */
  nextAt: number;
}

export type FeedKind =
  | 'BID'
  | 'SKIP'
  | 'SOLD'
  | 'UNSOLD'
  | 'AUTO'
  | 'EXTENDED'
  | 'JOIN'
  | 'LEAVE'
  | 'DISCONNECT'
  | 'RECONNECT'
  | 'HOST'
  | 'LOCK'
  | 'INFO';

export interface FeedItem {
  id: number;
  ts: number;
  kind: FeedKind;
  text: string;
  userId?: string;
  amount?: number;
}

export interface AuctionView {
  /**
   * Set when only one manager still needs players: nobody can bid against them,
   * so they pick freely from the remaining pool at the opening price.
   */
  freePick: { userId: string; endsAt: number; picksLeft: number } | null;
  poolSize: number;
  lotsOpened: number;
  remainingInQueue: number;
  unsoldWaiting: number;
  reofferRound: boolean;
  paused: boolean;
  lot: LotView | null;
  lastResult: LotResultView | null;
}

export interface LineupView {
  formationId: string;
  /** Player (PlayerCard) id per formation slot; null = empty. */
  slots: (string | null)[];
  locked: boolean;
  /** Completed by the server at the deadline. */
  auto: boolean;
}

export interface SquadBuildingView {
  /** Server epoch ms deadline. */
  endsAt: number;
  /** userId → has locked in. */
  locked: Record<string, boolean>;
  /** The viewer's own lineup (other managers' lineups stay hidden until reveal). */
  mine: LineupView | null;
}

export interface RoomView {
  id: string;
  /** Set once the auction starts; used for the match-history link. */
  gameId: string | null;
  code: string;
  name: string;
  phase: RoomPhase;
  hostId: string;
  settings: RoomSettings;
  competition: { id: string; name: string; shortName: string; accent: string; seasonLabel: string };
  rules: { squadSize: number; openingBid: number; minIncrement: number; bidIncrements: number[]; minPlayers: number };
  members: MemberView[];
  /** People watching read-only. */
  spectators: number;
  startsAt: number | null;
  auction: AuctionView | null;
  squadBuilding: SquadBuildingView | null;
  /** Revealed once every lineup is final. userId → lineup. */
  lineups: Record<string, LineupView> | null;
  /** Final ranking — present once the room reaches RESULTS. */
  results: {
    rankings: RankedScore[];
    evaluatedAt: number;
    /** Deterministic written analysis + awards. */
    report: MatchReport;
    /** Optional AI pundit paragraph (explains, never decides). */
    commentary: { status: 'disabled' | 'pending' | 'ready' | 'unavailable'; text: string | null };
    /** Ranked games only: rating before/after for each manager. */
    ratingChanges: EloChange[] | null;
    /** Achievement keys earned this game, per manager. */
    achievements: Record<string, string[]>;
  } | null;
  /** While in FINAL_EVALUATION: when results will be shown. */
  resultsAt: number | null;
  feed: FeedItem[];
  serverTime: number;
  version: number;
}

// ---------------------------------------------------------------------------
// Transient events (sounds / animations). State always comes from RoomView.
// ---------------------------------------------------------------------------

export type GameEvent =
  | { type: 'LOT_OPEN'; lotNumber: number }
  | { type: 'BID'; lotNumber: number; userId: string; amount: number; previousBidderId: string | null }
  | { type: 'EXTENDED'; lotNumber: number; endsAt: number }
  | { type: 'SOLD'; lotNumber: number; userId: string; amount: number }
  | { type: 'UNSOLD'; lotNumber: number }
  | { type: 'PICKED'; userId: string; playerId: string }
  | { type: 'AUCTION_COMPLETE' }
  | { type: 'LINEUP_LOCKED'; userId: string }
  | { type: 'LINEUPS_REVEALED' }
  | { type: 'RESULTS'; winnerId: string }
  | { type: 'GAME_STARTING'; startsAt: number };

export interface ChatMessage {
  id: number;
  ts: number;
  userId: string;
  username: string;
  text: string;
}

export interface SessionUser {
  id: string;
  username: string;
}

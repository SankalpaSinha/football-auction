import type { PositionGroup } from './positions';
import type { FormationSlot } from './formations';
import type { ObjectiveId } from './objectives';
import type { TacticId } from './playstyles';
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
  /** Real-world superstar (counts towards the star limit). Set by the server's catalog. */
  star?: boolean;
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
  /** The squads play a knockout cup; the winner lifts the trophy. */
  'TOURNAMENT',
  'RESULTS',
  'FINISHED',
] as const;
export type RoomPhase = (typeof ROOM_PHASES)[number];

export type GameMode = 'CASUAL' | 'RANKED';

/** How players are acquired. See GAME_FORMATS. */
export type GameFormat = 'CLASSIC' | 'BLITZ' | 'BUDGET' | 'DRAFT';

/** Optional auction twists (the host switches them on or off). */
export interface Twists {
  /** Now and then a player's name and rating stay hidden until someone wins them. */
  mystery: boolean;
  /** Now and then everyone gets one secret bid; the highest wins. */
  sealed: boolean;
  /** Market events: deadline day, bargain hour, quick-fire, sponsor money. */
  events: boolean;
  /** Freeze, Steal and Refund cards, once each per manager. */
  cards: boolean;
}

export interface RoomSettings {
  competitionId: string;
  seasonId: string;
  startingBudget: number;
  maxPlayers: number;
  lotDurationSec: number;
  mode: GameMode;
  isPublic: boolean;
  antiSnipe: boolean;
  format: GameFormat;
  twists: Twists;
  /** Games in the season (1 = a single game). Points carry over between games. */
  seasonLength: number;
}

/** AUCTION = won a lot · PICK = chosen in free pick · AUTO = auto-assigned. */
export type Acquisition = 'AUCTION' | 'PICK' | 'AUTO' | 'TRADE';

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
  /** Connected, but the app is in the background / screen locked. */
  away: boolean;
  /** Present once the auction has started. */
  budget: number | null;
  squad: SquadEntry[];
  /** Highest bid this member is currently allowed to make (budget reserve applied). */
  maxBid: number | null;
}

export type LotOutcome = 'SOLD' | 'UNSOLD' | 'AUTO_ASSIGNED' | 'PICKED';

/** NORMAL: open bidding · MYSTERY: player hidden until sold · SEALED: one secret bid each. */
export type LotKind = 'NORMAL' | 'MYSTERY' | 'SEALED';

export interface LotView {
  lotNumber: number;
  kind: LotKind;
  /** For a mystery lot this is a stand-in card: only the position and nation are real. */
  player: PlayerCard;
  openedAt: number;
  /** Server epoch ms. Clients render a countdown against their synced clock. */
  endsAt: number;
  /** Set while the auction is paused (everyone disconnected). */
  pausedRemainingMs: number | null;
  /** Full clock for this lot (quick-fire lots get half). */
  durationMs: number;
  currentBid: number | null;
  highestBidderId: string | null;
  minNextBid: number;
  skippedBy: string[];
  bidCount: number;
  extended: boolean;
  /** Was this player already offered once without a buyer? */
  reoffer: boolean;
  /** Managers frozen out of this lot by a Freeze card. */
  frozen: string[];
  /** The winning bid costs this much more (deadline day: 1.2 = +20%). */
  surcharge: number;
  /** Sealed lots: who has made their one secret choice (bid or pass), and the viewer's own. */
  sealed: { decided: string[]; mine: number | 'PASS' | null } | null;
}

export interface LotResultView {
  lotNumber: number;
  kind: LotKind;
  player: PlayerCard;
  outcome: LotOutcome;
  winnerId: string | null;
  price: number | null;
  estimatedValue: number;
  verdict: ValueVerdict | null;
  /** Server epoch ms when the next lot opens. */
  nextAt: number;
  /** Sealed lots: every secret bid, highest first (revealed after the lot). */
  sealedBids: { userId: string; amount: number }[] | null;
  /** Until then, managers holding a Steal card can match the price and take the player. */
  stealUntil: number | null;
  /** Set when someone used a Steal card on this player. */
  stolenFrom: string | null;
}

export type PowerCardId = 'FREEZE' | 'STEAL' | 'REFUND';

export type MarketEventId = 'DEADLINE_DAY' | 'BARGAIN_HOUR' | 'QUICK_FIRE' | 'SPONSOR';

export interface MarketView {
  id: MarketEventId;
  /** Lots the event still covers, including the current one. */
  lotsLeft: number;
}

/** Snake draft: whose pick it is, and who picks next. */
export interface DraftView {
  userId: string;
  endsAt: number;
  pausedRemainingMs: number | null;
  /** 1-based pick number and total picks in the draft. */
  pick: number;
  totalPicks: number;
  round: number;
  /** The next few pickers after the current one. */
  upcoming: string[];
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
  /** Host's choice of which positions come up next (null = any). */
  focus: PositionGroup | null;
  /** A pause every manager agreed to. Any manager can resume; it ends by itself at `until`. */
  hold: { by: string; until: number } | null;
  /** Someone asked to pause; it happens only if every connected manager agrees. */
  pauseVote: { requestedBy: string; endsAt: number; yes: string[]; waitingOn: string[] } | null;
  /** Lots in a row each manager has sat out (only managers with at least one). */
  idleLots: Record<string, number>;
  lot: LotView | null;
  lastResult: LotResultView | null;
  /** Power cards each manager still holds (public — everyone can see who still has a Steal). */
  cards: Record<string, PowerCardId[]>;
  /** A market event in force for the next few lots. */
  market: MarketView | null;
  /** Snake draft format only. */
  draft: DraftView | null;
}

export interface LineupView {
  formationId: string;
  /** The manager's own 11 positions when formationId is 'custom'. */
  custom?: FormationSlot[] | null;
  /** Team tactic (TacticId). */
  tactic: TacticId;
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
  rules: {
    squadSize: number;
    openingBid: number;
    minIncrement: number;
    bidIncrements: number[];
    minPlayers: number;
    inactiveLotsToRemove: number;
    starCap: { max: number };
    /** Most a single player can cost (Budget Cap format), or null. */
    maxPrice: number | null;
    /** Coins kept back for each other empty slot. */
    reservePerSlot: number;
  };
  /** Your own secret objectives (hidden from everyone else until the results). */
  myObjectives: ObjectiveId[] | null;
  members: MemberView[];
  /** People watching read-only. */
  spectators: number;
  startsAt: number | null;
  auction: AuctionView | null;
  squadBuilding: SquadBuildingView | null;
  /** Revealed once every lineup is final. userId → lineup. */
  lineups: Record<string, LineupView> | null;
  /** The cup the squads play after the lineups are in. */
  tournament: TournamentView | null;
  /** Season mode: standings across the room's games. */
  season: SeasonView | null;
  /** Final ranking — present once the room reaches RESULTS. */
  results: {
    /** Ordered by final position (the cup decides it; squad score breaks ties). */
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
  /** Trade offers you sent or received (only yours are shown). */
  trades: TradeOffer[];
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
  | { type: 'PAUSE_VOTE'; userId: string }
  | { type: 'PAUSED' }
  | { type: 'RESUMED' }
  | { type: 'REMOVED'; userId: string }
  | { type: 'TRADE_OFFER'; fromId: string; toId: string }
  | { type: 'TRADE_DECLINED'; fromId: string; toId: string }
  | { type: 'TRADED'; fromId: string; toId: string }
  | { type: 'RELEASED'; userId: string; playerId: string }
  | { type: 'AUCTION_COMPLETE' }
  | { type: 'LINEUP_LOCKED'; userId: string }
  | { type: 'LINEUPS_REVEALED' }
  | { type: 'RESULTS'; winnerId: string }
  | { type: 'GAME_STARTING'; startsAt: number }
  | { type: 'FROZEN'; byId: string; targetId: string }
  | { type: 'STOLEN'; byId: string; fromId: string; playerId: string }
  | { type: 'MARKET'; id: MarketEventId }
  | { type: 'KICKOFF'; round: number }
  | { type: 'GOAL'; matchId: string; userId: string }
  | { type: 'HALF_TIME'; round: number }
  | { type: 'FULL_TIME'; matchId: string; winnerId: string }
  | { type: 'CHAMPION'; userId: string };

/** A floating emoji or touchline taunt (not kept in state). */
export interface Reaction {
  id: number;
  userId: string;
  username: string;
  emoji?: string;
  taunt?: string;
}

// ---------------------------------------------------------------------------
// Cup (the squads play each other once the lineups are in)
// ---------------------------------------------------------------------------

/** Half-time instruction. */
export type TeamTalk = 'ATTACK' | 'CALM' | 'TIGHT';
/** Mid-match touchline shout (one of each per match). */
export type Shout = 'ALL_OUT' | 'PARK_IT';

export type MatchStatus = 'SCHEDULED' | 'FIRST_HALF' | 'HALF_TIME' | 'SECOND_HALF' | 'EXTRA_TIME' | 'PENALTIES' | 'FINISHED';

export type MatchEventKind = 'GOAL' | 'PEN_GOAL' | 'PEN_MISS' | 'CHANCE' | 'SAVE' | 'WOODWORK' | 'YELLOW' | 'RED' | 'SHOUT' | 'TALK' | 'INFO';

export interface MatchEvent {
  /** Match minute (extra time counts on from 90). */
  minute: number;
  /** 0 = home, 1 = away, null = neutral. */
  side: 0 | 1 | null;
  kind: MatchEventKind;
  playerId?: string;
  assistId?: string;
  text: string;
  /** Score after this event. */
  score: [number, number];
  /** Server time it is shown at (the engine plays a few seconds ahead). */
  at?: number;
  /** Shots: chance quality, and whether it was on target. */
  xg?: number;
  onTarget?: boolean;
}

export interface MatchSideView {
  userId: string;
  /** Squad-score seed (1 = best squad). */
  seed: number;
  formationId: string;
  tacticId: TacticId;
  goals: number;
  stats: { shots: number; onTarget: number; possession: number; xg: number; saves: number; yellow: number; red: number };
  /** Shouts this side has still got. */
  shoutsLeft: Shout[];
  /** Shown once the second half kicks off. */
  talk: TeamTalk | null;
  /** The viewer's own half-time choice while it's still secret. */
  talkChosen: boolean;
}

export interface MatchView {
  id: string;
  round: number;
  /** Position in the round (for the bracket). */
  slot: number;
  status: MatchStatus;
  home: MatchSideView;
  away: MatchSideView;
  /** Live clock: the minute shown is phaseMinute + (now - phaseStartedAt) / msPerMinute, capped at phaseEndMinute. */
  clock: { phaseStartedAt: number; phaseMinute: number; phaseEndMinute: number; msPerMinute: number } | null;
  halfTimeEndsAt: number | null;
  events: MatchEvent[];
  /** -1 (away on top) … 1 (home on top), one value per 5 minutes played. */
  momentum: number[];
  /** Penalty shootout score so far (null if it didn't go to penalties). */
  pens: [number, number] | null;
  /** Half-time score once the first half is over. */
  halfTime: [number, number] | null;
  shootout: { side: 0 | 1; playerId: string; scored: boolean; at: number }[] | null;
  winnerId: string | null;
  /** Man of the match (player id), once finished. */
  motm: string | null;
  /** Tactical battle notes, e.g. "Counter-Attack hits High Press on the break". */
  edges: string[];
}

export interface BracketSlotView {
  round: number;
  slot: number;
  homeId: string | null;
  awayId: string | null;
  /** A bye: one manager goes straight through. */
  bye: boolean;
  matchId: string | null;
  winnerId: string | null;
}

export interface TournamentView {
  /** Round names, first to last (e.g. ["Semi-finals", "Final"]). */
  rounds: string[];
  currentRound: number;
  /** Next round kicks off at (between rounds). */
  nextKickoffAt: number | null;
  bracket: BracketSlotView[];
  /** Matches of the current and earlier rounds. */
  matches: MatchView[];
  championId: string | null;
  /** userId → squad-score seed. */
  seeds: Record<string, number>;
}

export interface SeasonView {
  length: number;
  /** Games played so far (finished). */
  played: number;
  /** Sorted, best first. */
  table: { userId: string; username: string; points: number; wins: number; played: number }[];
  finished: boolean;
  championId: string | null;
}

/**
 * A proposed swap between two managers during the auction. `coins` > 0: the
 * proposer pays the recipient; < 0: the proposer asks the recipient for coins.
 */
export interface TradeOffer {
  id: string;
  fromId: string;
  toId: string;
  /** Players from the proposer's squad. */
  give: string[];
  /** Players from the recipient's squad. */
  take: string[];
  coins: number;
  createdAt: number;
  expiresAt: number;
}

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

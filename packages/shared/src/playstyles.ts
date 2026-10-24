import type { Position } from './positions';
import type { OutfieldStats, PlayerCard } from './types';

/**
 * Playstyles, team tactics and synergy combos.
 *
 * A playstyle describes *how* a player plays, derived deterministically from
 * their position and attributes. Tactics reward XIs built around certain
 * playstyles, and combos reward playstyles that work well together — so a
 * well-fitting 79 can be worth more than a mismatched 87.
 */

export const PLAYSTYLES = {
  SWEEPER_KEEPER: { label: 'Sweeper Keeper', short: 'SWK', blurb: 'Quick off his line and good with his feet' },
  SHOT_STOPPER: { label: 'Shot Stopper', short: 'STP', blurb: 'Stays on his line and makes the big saves' },
  BALL_PLAYING_DEFENDER: { label: 'Ball-Playing CB', short: 'BPD', blurb: 'Starts attacks with passes out from the back' },
  STOPPER: { label: 'Stopper', short: 'STO', blurb: 'Wins headers and tackles, no frills' },
  OVERLAPPING_FULLBACK: { label: 'Overlapping Full-back', short: 'OFB', blurb: 'Bombs forward down the flank' },
  DEFENSIVE_FULLBACK: { label: 'Defensive Full-back', short: 'DFB', blurb: 'Stays home and locks down the wing' },
  BALL_WINNER: { label: 'Ball Winner', short: 'BWM', blurb: 'Breaks up play in midfield' },
  DEEP_PLAYMAKER: { label: 'Deep-Lying Playmaker', short: 'DLP', blurb: 'Dictates the tempo from deep' },
  BOX_TO_BOX: { label: 'Box-to-Box', short: 'B2B', blurb: 'Covers every blade of grass' },
  ADVANCED_PLAYMAKER: { label: 'Advanced Playmaker', short: 'AP', blurb: 'Unlocks defences between the lines' },
  SHADOW_STRIKER: { label: 'Shadow Striker', short: 'SS', blurb: 'Arrives late in the box to score' },
  WIDE_CROSSER: { label: 'Wide Crosser', short: 'WC', blurb: 'Hugs the touchline and whips in crosses' },
  INSIDE_FORWARD: { label: 'Inside Forward', short: 'IF', blurb: 'Cuts inside onto the stronger foot to shoot' },
  TARGET_MAN: { label: 'Target Man', short: 'TM', blurb: 'Holds the ball up and wins everything in the air' },
  POACHER: { label: 'Poacher', short: 'PCH', blurb: 'Lives in the box, finishes chances' },
  PACE_FORWARD: { label: 'Pacey Forward', short: 'PF', blurb: 'Runs in behind the defence' },
  FALSE_NINE: { label: 'False Nine', short: 'F9', blurb: 'Drops deep to link play and create' },
} as const;

export type PlaystyleId = keyof typeof PLAYSTYLES;

const LEFT_SIDE: Position[] = ['LB', 'LWB', 'LM', 'LW'];
const RIGHT_SIDE: Position[] = ['RB', 'RWB', 'RM', 'RW'];

/** The player's playstyle (deterministic; depends only on the card's attributes). */
export function playstyleOf(p: PlayerCard): PlaystyleId {
  return classify(p);
}

function classify(p: PlayerCard): PlaystyleId {
  if (p.position === 'GK' || !p.outfield) {
    const g = p.goalkeeping;
    return g && g.kicking + g.speed >= 115 ? 'SWEEPER_KEEPER' : 'SHOT_STOPPER';
  }
  const s: OutfieldStats = p.outfield;
  switch (p.position) {
    case 'CB':
      return s.passing >= 61 ? 'BALL_PLAYING_DEFENDER' : 'STOPPER';
    case 'LB':
    case 'RB':
    case 'LWB':
    case 'RWB':
      return (s.pace + s.dribbling) / 2 - s.defending >= 3 ? 'OVERLAPPING_FULLBACK' : 'DEFENSIVE_FULLBACK';
    case 'CDM':
      return s.defending - s.passing >= 4 ? 'BALL_WINNER' : 'DEEP_PLAYMAKER';
    case 'CM':
      if (s.physical >= 72 && s.defending >= 63) return 'BOX_TO_BOX';
      return s.passing >= s.dribbling ? 'DEEP_PLAYMAKER' : 'ADVANCED_PLAYMAKER';
    case 'CAM':
      return s.shooting >= 76 && s.shooting >= s.passing - 4 ? 'SHADOW_STRIKER' : 'ADVANCED_PLAYMAKER';
    case 'LM':
    case 'RM':
    case 'LW':
    case 'RW': {
      const inverted =
        (LEFT_SIDE.includes(p.position) && p.preferredFoot === 'Right') ||
        (RIGHT_SIDE.includes(p.position) && p.preferredFoot === 'Left');
      if (inverted) return s.shooting >= s.passing - 2 ? 'INSIDE_FORWARD' : 'WIDE_CROSSER';
      return s.shooting > s.passing + 5 ? 'INSIDE_FORWARD' : 'WIDE_CROSSER';
    }
    case 'CF':
    case 'ST':
    default:
      if (s.physical >= 84 || p.heightCm >= 192) return 'TARGET_MAN';
      if (s.pace >= 88) return 'PACE_FORWARD';
      if (s.passing >= 74 && s.dribbling >= 78) return 'FALSE_NINE';
      if (s.physical >= 79 || p.heightCm >= 188) return 'TARGET_MAN';
      if (s.pace >= 80) return 'PACE_FORWARD';
      return 'POACHER';
  }
}

// --------------------------------------------------------------- tactics

type Attr = keyof OutfieldStats;

export interface TacticDemand {
  label: string;
  roles: Position[];
  attr: Attr;
  target: number;
}

export interface Tactic {
  label: string;
  blurb: string;
  /** Playstyles this tactic is built around. */
  likes: PlaystyleId[];
  demands: TacticDemand[];
}

const DEF: Position[] = ['CB', 'LB', 'RB', 'LWB', 'RWB'];
const FULLBACKS: Position[] = ['LB', 'RB', 'LWB', 'RWB'];
const MID: Position[] = ['CDM', 'CM', 'CAM', 'LM', 'RM'];
const CENTRAL_MID: Position[] = ['CDM', 'CM', 'CAM'];
const WIDE: Position[] = ['LB', 'RB', 'LWB', 'RWB', 'LM', 'RM', 'LW', 'RW'];
const WIDE_ATT: Position[] = ['LM', 'RM', 'LW', 'RW', 'LWB', 'RWB'];
const ATT: Position[] = ['ST', 'CF', 'LW', 'RW'];
const STRIKERS: Position[] = ['ST', 'CF'];

export const TACTICS = {
  BALANCED: {
    label: 'Balanced',
    blurb: 'No fixed style. Safe, but nothing gets a bonus.',
    likes: [],
    demands: [
      { label: 'Defensive solidity', roles: DEF, attr: 'defending', target: 84 },
      { label: 'Pace out wide', roles: WIDE, attr: 'pace', target: 86 },
      { label: 'Midfield control', roles: CENTRAL_MID, attr: 'passing', target: 85 },
      { label: 'Attacking threat', roles: ATT, attr: 'shooting', target: 85 },
      { label: 'Creativity', roles: ['CAM', 'CM', 'LW', 'RW', 'LM', 'RM'], attr: 'dribbling', target: 85 },
    ],
  },
  TIKI_TAKA: {
    label: 'Tiki-Taka',
    blurb: 'Keep the ball. Short passing and technical players.',
    likes: ['SWEEPER_KEEPER', 'BALL_PLAYING_DEFENDER', 'DEEP_PLAYMAKER', 'ADVANCED_PLAYMAKER', 'FALSE_NINE', 'INSIDE_FORWARD'],
    demands: [
      { label: 'Passing through midfield', roles: MID, attr: 'passing', target: 84 },
      { label: 'Close control up front', roles: [...ATT, 'CAM'], attr: 'dribbling', target: 85 },
      { label: 'Playing out from the back', roles: ['CB'], attr: 'passing', target: 70 },
    ],
  },
  COUNTER_ATTACK: {
    label: 'Counter-Attack',
    blurb: 'Sit deep, win it, then hit them on the break.',
    likes: ['STOPPER', 'DEFENSIVE_FULLBACK', 'BALL_WINNER', 'PACE_FORWARD', 'INSIDE_FORWARD', 'POACHER'],
    demands: [
      { label: 'Pace on the break', roles: [...ATT, 'LM', 'RM'], attr: 'pace', target: 87 },
      { label: 'Solid defending', roles: DEF, attr: 'defending', target: 82 },
      { label: 'Clinical finishing', roles: STRIKERS, attr: 'shooting', target: 84 },
    ],
  },
  HIGH_PRESS: {
    label: 'High Press',
    blurb: 'Hunt the ball high up the pitch. Needs legs everywhere.',
    likes: ['SWEEPER_KEEPER', 'OVERLAPPING_FULLBACK', 'BOX_TO_BOX', 'BALL_WINNER', 'PACE_FORWARD', 'INSIDE_FORWARD'],
    demands: [
      { label: 'Stamina in midfield', roles: MID, attr: 'physical', target: 80 },
      { label: 'Pressing from the front', roles: ATT, attr: 'pace', target: 85 },
      { label: 'Winning it back', roles: CENTRAL_MID, attr: 'defending', target: 72 },
      { label: 'Defending a high line', roles: ['CB'], attr: 'pace', target: 75 },
    ],
  },
  WING_PLAY: {
    label: 'Wing Play',
    blurb: 'Go round them. Width, crosses and a big man in the box.',
    likes: ['OVERLAPPING_FULLBACK', 'WIDE_CROSSER', 'TARGET_MAN', 'BOX_TO_BOX'],
    demands: [
      { label: 'Pace out wide', roles: WIDE, attr: 'pace', target: 86 },
      { label: 'Delivery from wide', roles: WIDE_ATT, attr: 'passing', target: 78 },
      { label: 'Presence in the box', roles: STRIKERS, attr: 'physical', target: 80 },
    ],
  },
  PARK_THE_BUS: {
    label: 'Park the Bus',
    blurb: 'Defend deep and stay compact. Nothing gets through.',
    likes: ['SHOT_STOPPER', 'STOPPER', 'DEFENSIVE_FULLBACK', 'BALL_WINNER', 'TARGET_MAN'],
    demands: [
      { label: 'Defensive wall', roles: DEF, attr: 'defending', target: 84 },
      { label: 'Midfield screen', roles: ['CDM', 'CM'], attr: 'defending', target: 75 },
      { label: 'Physicality', roles: [...DEF, ...CENTRAL_MID], attr: 'physical', target: 80 },
    ],
  },
} satisfies Record<string, Tactic>;

export type TacticId = keyof typeof TACTICS;
export const TACTIC_IDS = Object.keys(TACTICS) as TacticId[];
export const DEFAULT_TACTIC: TacticId = 'BALANCED';

export function isTacticId(v: unknown): v is TacticId {
  return typeof v === 'string' && v in TACTICS;
}

// ---------------------------------------------------------------- combos

export interface Combo {
  label: string;
  blurb: string;
  a: PlaystyleId[];
  b: PlaystyleId[];
  points: number;
  /** Both players must play on the same flank. */
  sameSide?: boolean;
}

export const COMBOS = {
  AERIAL: {
    label: 'Aerial threat',
    blurb: 'Crosses from wide for a big centre-forward',
    a: ['WIDE_CROSSER', 'OVERLAPPING_FULLBACK'],
    b: ['TARGET_MAN'],
    points: 3,
  },
  THROUGH_BALLS: {
    label: 'Through balls',
    blurb: 'A playmaker feeding a runner',
    a: ['DEEP_PLAYMAKER', 'ADVANCED_PLAYMAKER'],
    b: ['PACE_FORWARD', 'INSIDE_FORWARD'],
    points: 3,
  },
  ENGINE_ROOM: {
    label: 'Engine room',
    blurb: 'A ball winner doing the dirty work for a playmaker',
    a: ['BALL_WINNER'],
    b: ['DEEP_PLAYMAKER', 'ADVANCED_PLAYMAKER'],
    points: 3,
  },
  OVERLAP: {
    label: 'The overlap',
    blurb: 'A full-back running past an inside forward on the same flank',
    a: ['OVERLAPPING_FULLBACK'],
    b: ['INSIDE_FORWARD'],
    points: 3,
    sameSide: true,
  },
  BIG_LITTLE: {
    label: 'Big man, little man',
    blurb: 'A target man with a quick or clever partner',
    a: ['TARGET_MAN'],
    b: ['POACHER', 'PACE_FORWARD', 'SHADOW_STRIKER'],
    points: 3,
  },
  FALSE_NINE_RUNS: {
    label: 'False nine runs',
    blurb: 'A false nine dropping deep to open space for runners',
    a: ['FALSE_NINE'],
    b: ['INSIDE_FORWARD', 'SHADOW_STRIKER', 'PACE_FORWARD'],
    points: 3,
  },
  BUILD_FROM_BACK: {
    label: 'Build from the back',
    blurb: 'A sweeper keeper with a ball-playing centre-back',
    a: ['SWEEPER_KEEPER'],
    b: ['BALL_PLAYING_DEFENDER'],
    points: 2,
  },
  CB_PARTNERSHIP: {
    label: 'Centre-back partnership',
    blurb: 'A stopper alongside a ball-player',
    a: ['STOPPER'],
    b: ['BALL_PLAYING_DEFENDER'],
    points: 2,
  },
  MIDFIELD_LEGS: {
    label: 'Legs and brains',
    blurb: 'A box-to-box runner next to a playmaker',
    a: ['BOX_TO_BOX'],
    b: ['DEEP_PLAYMAKER', 'ADVANCED_PLAYMAKER'],
    points: 2,
  },
  DEFENSIVE_SHIELD: {
    label: 'Defensive shield',
    blurb: 'A ball winner screening a stopper',
    a: ['BALL_WINNER'],
    b: ['STOPPER'],
    points: 2,
  },
} satisfies Record<string, Combo>;

export type ComboId = keyof typeof COMBOS;

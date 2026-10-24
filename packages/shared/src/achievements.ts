import { positionFit } from './fit';
import { getFormation } from './formations';
import type { LineupInput } from './lineup';
import type { RankedScore } from './scoring';
import type { GameMode, SquadEntry } from './types';

export type AchievementTier = 'bronze' | 'silver' | 'gold';

export interface AchievementDef {
  key: string;
  emoji: string;
  title: string;
  description: string;
  tier: AchievementTier;
  /** Earned over many games (checked against profile totals) rather than in one game. */
  career?: boolean;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { key: 'first_whistle', emoji: '🎬', title: 'First Whistle', description: 'Finish your first game.', tier: 'bronze' },
  { key: 'champion', emoji: '🏆', title: 'Champion', description: 'Win a game.', tier: 'bronze' },
  { key: 'podium', emoji: '🥉', title: 'On the Podium', description: 'Finish top 3 in a room of 4 or more.', tier: 'bronze' },
  { key: 'full_house', emoji: '🏟️', title: 'Full House', description: 'Win a 6-manager room.', tier: 'gold' },
  { key: 'giant_killer', emoji: '🗡️', title: 'Giant Killer', description: 'Win a ranked game against someone rated 100+ ELO above you.', tier: 'gold' },
  { key: 'underdog', emoji: '🐺', title: 'Underdog', description: 'Win with the lowest-rated squad in the room.', tier: 'silver' },
  { key: 'shrewd', emoji: '🧮', title: 'Shrewd Operator', description: 'Win while spending half your budget or less.', tier: 'silver' },
  { key: 'bargain_hunter', emoji: '🛒', title: 'Bargain Hunter', description: 'Sign a player for a third of their value (or less).', tier: 'bronze' },
  { key: 'big_spender', emoji: '💸', title: 'Big Spender', description: 'Spend 40% of your budget on a single player.', tier: 'bronze' },
  { key: 'galacticos', emoji: '✨', title: 'Galácticos', description: 'Field a starting XI averaging 86+ overall.', tier: 'gold' },
  { key: 'perfect_fit', emoji: '🧩', title: 'Perfect Fit', description: 'Every starter in a natural or secondary position.', tier: 'silver' },
  { key: 'chemistry_lab', emoji: '🔗', title: 'Chemistry Lab', description: 'Reach 80+ chemistry.', tier: 'silver' },
  { key: 'tactician', emoji: '🧠', title: 'Master Tactician', description: 'Score 95+ for tactical fit.', tier: 'silver' },
  { key: 'system_builder', emoji: '⚙️', title: 'System Builder', description: 'Trigger 5+ synergy combos in one XI.', tier: 'silver' },
  { key: 'mastermind', emoji: '🕵️', title: 'Mastermind', description: 'Complete both secret objectives.', tier: 'gold' },
  { key: 'moneyball', emoji: '📉', title: 'Moneyball', description: 'Win without a single starter rated 85+.', tier: 'gold' },
  { key: 'hat_trick', emoji: '⚽', title: 'Hat-trick', description: 'Win 3 games.', tier: 'silver', career: true },
  { key: 'veteran', emoji: '🎖️', title: 'Veteran', description: 'Play 10 games.', tier: 'silver', career: true },
  { key: 'elite', emoji: '👑', title: 'Elite Manager', description: 'Reach 1400 ranked ELO.', tier: 'gold', career: true },
];

export const ACHIEVEMENT_BY_KEY = new Map(ACHIEVEMENTS.map((a) => [a.key, a]));

export interface GameAchievementInput {
  mode: GameMode;
  startingBudget: number;
  managers: {
    userId: string;
    score: RankedScore;
    squad: SquadEntry[];
    lineup: LineupInput;
    /** Ranked games: rating before this game. */
    eloBefore?: number;
  }[];
}

/** Achievements earned in a single finished game, per manager. Deterministic. */
export function gameAchievements(input: GameAchievementInput): Record<string, string[]> {
  const n = input.managers.length;
  const squadAvg = (s: SquadEntry[]) => s.reduce((a, e) => a + e.player.overall, 0) / Math.max(1, s.length);
  const lowestAvg = Math.min(...input.managers.map((m) => squadAvg(m.squad)));
  const out: Record<string, string[]> = {};

  for (const m of input.managers) {
    const keys: string[] = ['first_whistle'];
    const won = m.score.rank === 1;
    if (won) keys.push('champion');
    if (n >= 4 && m.score.rank <= 3) keys.push('podium');
    if (won && n >= 6) keys.push('full_house');
    if (won && input.mode === 'RANKED' && m.eloBefore !== undefined) {
      const strongest = Math.max(...input.managers.filter((o) => o !== m).map((o) => o.eloBefore ?? 0));
      if (strongest >= m.eloBefore + 100) keys.push('giant_killer');
    }
    if (won && n >= 2 && squadAvg(m.squad) === lowestAvg && input.managers.filter((o) => squadAvg(o.squad) === lowestAvg).length === 1) {
      keys.push('underdog');
    }
    if (won && m.score.spent <= input.startingBudget / 2) keys.push('shrewd');

    const bought = m.squad.filter((e) => e.via === 'AUCTION');
    const minGain = 100 * (input.startingBudget / 1000);
    if (bought.some((e) => e.estimatedValue >= 3 * e.price && e.estimatedValue - e.price >= minGain)) keys.push('bargain_hunter');
    if (bought.some((e) => e.price >= 0.4 * input.startingBudget)) keys.push('big_spender');

    const f = getFormation(m.lineup.formationId);
    const byId = new Map(m.squad.map((e) => [e.player.id, e.player]));
    const starters = m.lineup.slots.map((id) => (id ? byId.get(id) : undefined));
    if (starters.every(Boolean)) {
      const xiAvg = starters.reduce((a, p) => a + p!.overall, 0) / starters.length;
      if (xiAvg >= 86) keys.push('galacticos');
      if (won && starters.every((p) => p!.overall < 85)) keys.push('moneyball');
      if (f && starters.every((p, i) => ['NATURAL', 'SECONDARY'].includes(positionFit(p!, f.slots[i].role).level))) {
        keys.push('perfect_fit');
      }
    }
    if (m.score.breakdown.chemistry >= 80) keys.push('chemistry_lab');
    if (m.score.breakdown.tactics >= 95) keys.push('tactician');
    if ((m.score.synergies?.length ?? 0) >= 5) keys.push('system_builder');
    const objs = m.score.objectives ?? [];
    if (objs.length >= 2 && objs.every((o) => o.done)) keys.push('mastermind');
    out[m.userId] = keys;
  }
  return out;
}

/** Career achievements from profile totals. */
export function careerAchievements(totals: { games: number; wins: number; rankedElo: number }): string[] {
  const keys: string[] = [];
  if (totals.wins >= 3) keys.push('hat_trick');
  if (totals.games >= 10) keys.push('veteran');
  if (totals.rankedElo >= 1400) keys.push('elite');
  return keys;
}

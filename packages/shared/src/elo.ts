/**
 * Multiplayer ELO. Every pair of managers in a game is treated as a
 * head-to-head result decided by final rank. Beating stronger opponents earns
 * more; bigger rooms are worth more (and cost more).
 */
export const ELO_CONFIG = {
  initial: 1200,
  k: 32,
  /** Faster movement while a rating is still settling. */
  provisionalK: 48,
  provisionalGames: 10,
  /** Each manager beyond two adds this much to the swing (6 players → +60%). */
  roomSizeBonus: 0.15,
  floor: 100,
};

export interface EloInput {
  userId: string;
  rank: number;
  elo: number;
  games: number;
}

export interface EloChange {
  userId: string;
  before: number;
  after: number;
  delta: number;
}

export function expectedScore(rating: number, opponent: number) {
  return 1 / (1 + Math.pow(10, (opponent - rating) / 400));
}

export function computeEloChanges(players: EloInput[], cfg = ELO_CONFIG): EloChange[] {
  const n = players.length;
  if (n < 2) return players.map((p) => ({ userId: p.userId, before: p.elo, after: p.elo, delta: 0 }));
  const sizeFactor = 1 + cfg.roomSizeBonus * (n - 2);
  return players.map((p) => {
    let diff = 0;
    for (const o of players) {
      if (o === p) continue;
      const actual = p.rank < o.rank ? 1 : p.rank === o.rank ? 0.5 : 0;
      diff += actual - expectedScore(p.elo, o.elo);
    }
    const k = p.games < cfg.provisionalGames ? cfg.provisionalK : cfg.k;
    const delta = Math.round(((k * diff) / (n - 1)) * sizeFactor);
    const after = Math.max(cfg.floor, p.elo + delta);
    return { userId: p.userId, before: p.elo, after, delta: after - p.elo };
  });
}

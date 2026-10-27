import {
  type CupSummary,
  type RivalryRecord,
  type FormationSlot,
  isTacticId,
  type TacticId,
  buildMatchReport,
  ELO_CONFIG,
  type GameMode,
  type LeaderboardRow,
  type MatchDetailView,
  type MatchSummary,
  type ProfileView,
  type RankedScore,
  type SquadEntry,
  type StatsBlock,
  verdictFor,
} from '@fa/shared';
import type { PlayerCatalog } from '../data/catalog';
import type { Db } from '../lib/db';

/** Read side for profiles, leaderboards and match history (PostgreSQL). */
export class StatsService {
  constructor(
    private readonly db: Db,
    private readonly catalog: PlayerCatalog,
  ) {}

  private block(r?: { games: number; wins: number; podiums: number; totalScore: number; highestScore: number } | null): StatsBlock {
    const games = r?.games ?? 0;
    return {
      games,
      wins: r?.wins ?? 0,
      podiums: r?.podiums ?? 0,
      winRate: games ? Math.round(((r!.wins / games) * 1000)) / 10 : 0,
      avgScore: games ? Math.round((r!.totalScore / games) * 10) / 10 : 0,
      highestScore: Math.round((r?.highestScore ?? 0) * 10) / 10,
    };
  }

  async leaderboard(mode: GameMode, limit = 100): Promise<LeaderboardRow[]> {
    const rows = await this.db.playerRating.findMany({
      where: { mode, games: { gt: 0 } },
      include: { user: { select: { username: true } } },
      orderBy: mode === 'RANKED' ? [{ elo: 'desc' }, { wins: 'desc' }] : [{ wins: 'desc' }, { totalScore: 'desc' }],
      take: Math.min(limit, 200),
    });
    return rows.map((r, i) => ({
      rank: i + 1,
      userId: r.userId,
      username: r.user.username,
      elo: r.elo,
      ...this.block(r),
    }));
  }

  private competitionLabel(competitionId: string, seasonId: string) {
    return {
      id: competitionId,
      name: this.catalog.competitionName(competitionId)?.name ?? competitionId,
      seasonLabel: this.catalog.seasonLabel(seasonId),
    };
  }

  async profile(username: string): Promise<ProfileView | null> {
    const user = await this.db.user.findUnique({
      where: { usernameKey: username.toLowerCase() },
      include: { rating: true },
    });
    if (!user) return null;
    const ranked = user.rating.find((r) => r.mode === 'RANKED');
    const casual = user.rating.find((r) => r.mode === 'CASUAL');
    const globalRank =
      ranked && ranked.games > 0
        ? (await this.db.playerRating.count({ where: { mode: 'RANKED', games: { gt: 0 }, elo: { gt: ranked.elo } } })) + 1
        : null;

    const results = await this.db.matchResult.findMany({
      where: { userId: user.id },
      include: { game: { include: { room: true, _count: { select: { results: true } } } } },
      orderBy: { game: { endedAt: 'desc' } },
      take: 200,
    });
    const compCounts = new Map<string, number>();
    for (const r of results) compCounts.set(r.game.room.competitionId, (compCounts.get(r.game.room.competitionId) ?? 0) + 1);
    const favComp = [...compCounts].sort((a, b) => b[1] - a[1])[0]?.[0];

    const squads = await this.db.squad.findMany({
      where: { userId: user.id, game: { status: 'FINISHED' } },
      include: {
        players: { select: { playerStatsId: true, price: true, acquiredVia: true, lotNumber: true } },
        game: { select: { auction: { select: { lots: { select: { lotNumber: true, estimatedValue: true } } } } } },
      },
      orderBy: { game: { startedAt: 'desc' } },
      take: 100,
    });
    const formCounts = new Map<string, number>();
    for (const s of squads) if (s.formationId) formCounts.set(s.formationId, (formCounts.get(s.formationId) ?? 0) + 1);
    const formations = [...formCounts].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count);
    const favFormation = formations[0]?.id ?? null;

    // Spending habits across finished games.
    let bargains = 0;
    let overpays = 0;
    let signings = 0;
    let biggestBargain: ProfileView['spending']['biggestBargain'] = null;
    let recordSigning: ProfileView['spending']['recordSigning'] = null;
    const name = (id: string) => this.catalog.card(id)?.name ?? id;
    for (const s of squads) {
      const values = new Map((s.game.auction?.lots ?? []).map((l) => [l.lotNumber, l.estimatedValue]));
      for (const p of s.players) {
        if (p.acquiredVia !== 'AUCTION') continue;
        signings++;
        const value = values.get(p.lotNumber ?? -1) ?? 0;
        const v = verdictFor(p.price, value);
        if (v === 'BARGAIN') bargains++;
        if (v === 'OVERPAY') overpays++;
        if (!biggestBargain || value - p.price > biggestBargain.value - biggestBargain.price) {
          biggestBargain = { playerName: name(p.playerStatsId), price: p.price, value };
        }
        if (!recordSigning || p.price > recordSigning.price) recordSigning = { playerName: name(p.playerStatsId), price: p.price };
      }
    }
    const spent = squads.map((s) => s.budgetStart - s.budgetRemaining);
    const achievements = await this.db.userAchievement.findMany({ where: { userId: user.id }, orderBy: { unlockedAt: 'asc' } });

    const recent: MatchSummary[] = results.slice(0, 15).map((r) => ({
      gameId: r.gameId,
      mode: r.game.mode,
      competition: this.competitionLabel(r.game.room.competitionId, r.game.room.seasonId),
      players: r.game._count.results,
      rank: r.rank,
      score: Math.round(r.score * 10) / 10,
      eloDelta: r.eloBefore !== null && r.eloAfter !== null ? r.eloAfter - r.eloBefore : null,
      endedAt: (r.game.endedAt ?? r.game.startedAt).toISOString(),
    }));

    // Head-to-head: in every finished game you shared, who finished higher.
    const shared = await this.db.matchResult.findMany({
      where: { gameId: { in: results.map((r) => r.gameId) }, userId: { not: user.id } },
      select: { gameId: true, userId: true, rank: true, user: { select: { username: true } } },
    });
    const myRank = new Map(results.map((r) => [r.gameId, r.rank]));
    const rivalMap = new Map<string, { username: string; wins: number; losses: number }>();
    for (const o of shared) {
      const mine = myRank.get(o.gameId);
      if (mine === undefined || mine === o.rank) continue;
      const row = rivalMap.get(o.userId) ?? { username: o.user.username, wins: 0, losses: 0 };
      if (mine < o.rank) row.wins++;
      else row.losses++;
      rivalMap.set(o.userId, row);
    }
    const rivals = [...rivalMap.values()].sort((a, b) => b.wins + b.losses - (a.wins + a.losses) || a.username.localeCompare(b.username)).slice(0, 8);

    return {
      rivals,
      achievements: achievements.map((a) => ({ key: a.key, unlockedAt: a.unlockedAt.toISOString() })),
      trend: results
        .slice(0, 20)
        .reverse()
        .map((r) => ({
          score: Math.round(r.score * 10) / 10,
          rank: r.rank,
          players: r.game._count.results,
          mode: r.game.mode,
          endedAt: (r.game.endedAt ?? r.game.startedAt).toISOString(),
        })),
      spending: {
        avgSpent: spent.length ? Math.round(spent.reduce((a, b) => a + b, 0) / spent.length) : 0,
        bargains,
        overpays,
        signings,
        biggestBargain: biggestBargain && biggestBargain.value > biggestBargain.price ? biggestBargain : null,
        recordSigning,
      },
      formations,
      userId: user.id,
      username: user.username,
      memberSince: user.createdAt.toISOString(),
      ranked: { ...this.block(ranked), elo: ranked?.elo ?? ELO_CONFIG.initial, globalRank },
      casual: this.block(casual),
      favoriteCompetition: favComp ? { id: favComp, name: this.catalog.competitionName(favComp)?.name ?? favComp } : null,
      favoriteFormation: favFormation,
      recent,
    };
  }

  /** Head-to-head records between these managers (who finished higher in each game they shared). */
  async rivalries(userIds: string[]): Promise<RivalryRecord[]> {
    const ids = [...new Set(userIds)].slice(0, 8);
    if (ids.length < 2) return [];
    const rows = await this.db.matchResult.findMany({
      where: { userId: { in: ids }, game: { status: 'FINISHED' } },
      select: { gameId: true, userId: true, rank: true },
      orderBy: { gameId: 'desc' },
      take: 5000,
    });
    const byGame = new Map<string, { userId: string; rank: number }[]>();
    for (const r of rows) byGame.set(r.gameId, [...(byGame.get(r.gameId) ?? []), r]);
    const out = new Map<string, RivalryRecord>();
    for (const players of byGame.values()) {
      for (let i = 0; i < players.length; i++) {
        for (let j = i + 1; j < players.length; j++) {
          const [x, y] = [players[i], players[j]].sort((p, q) => p.userId.localeCompare(q.userId));
          if (x.rank === y.rank) continue;
          const key = `${x.userId}|${y.userId}`;
          const rec = out.get(key) ?? { a: x.userId, b: y.userId, aWins: 0, bWins: 0 };
          if (x.rank < y.rank) rec.aWins++;
          else rec.bWins++;
          out.set(key, rec);
        }
      }
    }
    return [...out.values()];
  }

  async match(gameId: string): Promise<MatchDetailView | null> {
    const game = await this.db.game.findUnique({
      where: { id: gameId },
      include: {
        room: true,
        results: { include: { user: { select: { username: true } } }, orderBy: { rank: 'asc' } },
        squads: { include: { players: true, user: { select: { username: true } } } },
        auction: { include: { lots: { include: { _count: { select: { bids: true } } }, orderBy: { lotNumber: 'asc' } } } },
      },
    });
    if (!game || game.status !== 'FINISHED') return null;
    const lots = game.auction?.lots ?? [];
    const valueByLot = new Map(lots.map((l) => [l.lotNumber, l.estimatedValue]));
    const usernames = new Map(game.squads.map((s) => [s.userId, s.user.username]));
    const settings = game.room.settings as { startingBudget?: number };

    const managers = game.squads.map((s) => {
      const squad: SquadEntry[] = s.players.flatMap((sp) => {
        const player = this.catalog.card(sp.playerStatsId);
        if (!player) return [];
        return [
          {
            player,
            price: sp.price,
            via: sp.acquiredVia,
            lotNumber: sp.lotNumber ?? 0,
            estimatedValue: valueByLot.get(sp.lotNumber ?? -1) ?? 0,
          },
        ];
      });
      const starters = s.players.filter((p) => p.role === 'STARTER' && p.slotIndex !== null);
      const slots: (string | null)[] = Array(11).fill(null);
      for (const p of starters) slots[p.slotIndex!] = p.playerStatsId;
      const result = game.results.find((r) => r.userId === s.userId);
      return {
        userId: s.userId,
        username: s.user.username,
        squad,
        budgetLeft: s.budgetRemaining,
        lineup: s.formationId
          ? {
              formationId: s.formationId,
              slots,
              tactic: tacticOf(result?.breakdown),
              custom: (s.customSlots as unknown as FormationSlot[] | null) ?? null,
            }
          : null,
        eloBefore: result?.eloBefore ?? null,
        eloAfter: result?.eloAfter ?? null,
      };
    });

    const rankings: RankedScore[] = game.results.map((r) => {
      const saved = r.breakdown as unknown as Omit<RankedScore, 'userId' | 'rank' | 'total'>;
      return {
        ...saved,
        // Games scored before tactics/synergy/objectives existed lack those fields.
        tacticId: tacticOf(saved),
        styleMatch: saved.styleMatch ?? { liked: 0, of: 11 },
        synergies: saved.synergies ?? [],
        objectives: saved.objectives ?? [],
        objectiveBonus: saved.objectiveBonus ?? 0,
        userId: r.userId,
        rank: r.rank,
        total: Math.round(r.score * 10) / 10,
      };
    });
    const comp = this.catalog.competitionName(game.room.competitionId);

    return {
      gameId: game.id,
      mode: game.mode,
      roomName: game.room.name,
      competition: {
        ...this.competitionLabel(game.room.competitionId, game.room.seasonId),
        accent: comp?.accent ?? '#c8ff2e',
      },
      startedAt: game.startedAt.toISOString(),
      endedAt: game.endedAt?.toISOString() ?? null,
      startingBudget: settings.startingBudget ?? 1000,
      rankings,
      report: buildMatchReport(
        rankings,
        managers.map((m) => ({ userId: m.userId, username: m.username, squad: m.squad })),
        { cup: (game.cup as unknown as CupSummary | null) ?? null, startingBudget: settings.startingBudget ?? 1000 },
      ),
      cup: (game.cup as unknown as CupSummary | null) ?? null,
      managers,
      lots: lots.map((l) => ({
        lotNumber: l.lotNumber,
        playerId: l.playerStatsId,
        playerName: this.catalog.card(l.playerStatsId)?.name ?? l.playerStatsId,
        outcome: l.outcome,
        winner: l.winnerUserId ? (usernames.get(l.winnerUserId) ?? null) : null,
        price: l.price,
        estimatedValue: l.estimatedValue,
        bids: l._count.bids,
      })),
    };
  }
}

/** The tactic a saved result was scored with (older games: Balanced). */
function tacticOf(breakdown: unknown): TacticId {
  const t = (breakdown as { tacticId?: unknown } | null)?.tacticId;
  return isTacticId(t) ? t : 'BALANCED';
}

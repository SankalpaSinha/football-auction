import type { CompetitionType } from '@fa/shared';
import type { Db } from '../lib/db';
import { toPlayerCard, type CatalogData, type PlayerStatus, type PoolRules } from './catalog';

/** Load the whole catalog from PostgreSQL into memory (read-mostly, a few thousand rows). */
export async function catalogFromDb(db: Db): Promise<CatalogData> {
  const [seasons, competitions, stats] = await Promise.all([
    db.season.findMany({ orderBy: { startYear: 'asc' } }),
    db.competition.findMany({ include: { seasons: true } }),
    db.playerStats.findMany({ include: { player: { include: { nation: true } }, club: true } }),
  ]);

  return {
    seasons: seasons.map((s) => ({ id: s.id, label: s.label, isCurrent: s.isCurrent })),
    competitions: competitions.map((c) => ({
      id: c.id,
      name: c.name,
      shortName: c.shortName,
      type: c.type as CompetitionType,
      accent: c.accent,
      selectable: c.selectable,
      sortOrder: c.sortOrder,
      seasons: Object.fromEntries(c.seasons.map((cs) => [cs.seasonId, cs.rules as PoolRules])),
    })),
    players: stats.map((s) => ({
      status: s.status as PlayerStatus,
      card: toPlayerCard({
        ...s,
        statsId: s.id,
        playerId: s.playerId,
        name: s.player.name,
        shortName: s.player.shortName,
        nation: { code: s.player.nation.code, name: s.player.nation.name, flag: s.player.nation.flag },
        club: {
          id: s.club.id,
          name: s.club.name,
          shortName: s.club.shortName,
          colors: s.club.colors,
          logoUrl: s.club.logoUrl,
        },
        league: s.leagueId,
        season: s.seasonId,
        preferredFoot: s.player.preferredFoot,
        heightCm: s.player.heightCm,
        imageUrl: s.player.imageUrl,
        imageCredit: s.player.imageCredit,
      }),
    })),
  };
}

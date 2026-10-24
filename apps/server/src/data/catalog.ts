import {
  isPosition,
  tierFor,
  type CompetitionSummary,
  type CompetitionType,
  type PlayerCard,
  type Position,
} from '@fa/shared';
import { GAME_RULES, isStarPlayer } from '@fa/shared';

/**
 * Source-agnostic player catalog. Loaders (seed files, PostgreSQL, a licensed
 * feed later) normalise into CatalogData; the game only talks to PlayerCatalog.
 */

export type PlayerStatus = 'ACTIVE' | 'INJURED' | 'INACTIVE';

/** Eligibility rules for one competition-season. Every present field must match. */
export interface PoolRules {
  leagues?: string[];
  clubs?: string[];
  nations?: string[];
  positions?: Position[];
  minOverall?: number;
  maxOverall?: number;
  /** Defaults to ['ACTIVE']. */
  statuses?: PlayerStatus[];
}

export interface CatalogCompetition {
  id: string;
  name: string;
  shortName: string;
  type: CompetitionType;
  accent: string;
  selectable: boolean;
  sortOrder: number;
  /** seasonId → rules */
  seasons: Record<string, PoolRules>;
}

export interface CatalogSeason {
  id: string;
  label: string;
  isCurrent: boolean;
}

export interface CatalogEntry {
  card: PlayerCard;
  status: PlayerStatus;
}

export interface CatalogData {
  seasons: CatalogSeason[];
  competitions: CatalogCompetition[];
  players: CatalogEntry[];
}

export interface CompetitionMeta {
  id: string;
  name: string;
  shortName: string;
  accent: string;
  seasonLabel: string;
}

export interface PlayerCatalog {
  competitions(): CompetitionSummary[];
  meta(competitionId: string, seasonId: string): CompetitionMeta | null;
  resolvePool(competitionId: string, seasonId: string): PlayerCard[] | null;
  /** Any player card by season-specific id, including inactive players (for history). */
  card(id: string): PlayerCard | undefined;
  competitionName(competitionId: string): { name: string; accent: string } | undefined;
  seasonLabel(seasonId: string): string;
}

export function matchesRules(entry: CatalogEntry, seasonId: string, rules: PoolRules): boolean {
  const c = entry.card;
  if (c.season !== seasonId) return false;
  if (!(rules.statuses ?? ['ACTIVE']).includes(entry.status)) return false;
  if (rules.leagues && !rules.leagues.includes(c.league)) return false;
  if (rules.clubs && !rules.clubs.includes(c.club.id)) return false;
  if (rules.nations && !rules.nations.includes(c.nation.code)) return false;
  if (rules.positions && !rules.positions.includes(c.position)) return false;
  if (rules.minOverall !== undefined && c.overall < rules.minOverall) return false;
  if (rules.maxOverall !== undefined && c.overall > rules.maxOverall) return false;
  return true;
}

export class InMemoryCatalog implements PlayerCatalog {
  private pools = new Map<string, PlayerCard[]>();
  private cards: Map<string, PlayerCard>;

  constructor(private readonly data: CatalogData) {
    this.cards = new Map(data.players.map((e) => [e.card.id, e.card]));
    for (const comp of data.competitions) {
      for (const [seasonId, rules] of Object.entries(comp.seasons)) {
        const pool = data.players.filter((e) => matchesRules(e, seasonId, rules)).map((e) => e.card);
        this.pools.set(`${comp.id}|${seasonId}`, pool);
      }
    }
  }

  competitions(): CompetitionSummary[] {
    return this.data.competitions
      .filter((c) => c.selectable)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((c) => ({
        id: c.id,
        name: c.name,
        shortName: c.shortName,
        type: c.type,
        accent: c.accent,
        seasons: Object.keys(c.seasons)
          .map((seasonId) => {
            const pool = this.pools.get(`${c.id}|${seasonId}`) ?? [];
            const goalkeepers = pool.filter((p) => p.position === 'GK').length;
            return {
              id: seasonId,
              label: this.data.seasons.find((s) => s.id === seasonId)?.label ?? seasonId,
              poolSize: pool.length,
              goalkeepers,
              maxPlayers: maxPlayersForPool(pool),
            };
          })
          .filter((s) => s.maxPlayers >= GAME_RULES.minPlayers),
      }))
      .filter((c) => c.seasons.length > 0);
  }

  meta(competitionId: string, seasonId: string): CompetitionMeta | null {
    const c = this.data.competitions.find((x) => x.id === competitionId);
    if (!c || !c.selectable || !c.seasons[seasonId]) return null;
    return {
      id: c.id,
      name: c.name,
      shortName: c.shortName,
      accent: c.accent,
      seasonLabel: this.data.seasons.find((s) => s.id === seasonId)?.label ?? seasonId,
    };
  }

  card(id: string) {
    return this.cards.get(id);
  }

  competitionName(competitionId: string) {
    const c = this.data.competitions.find((x) => x.id === competitionId);
    return c ? { name: c.name, accent: c.accent } : undefined;
  }

  seasonLabel(seasonId: string) {
    return this.data.seasons.find((s) => s.id === seasonId)?.label ?? seasonId;
  }

  resolvePool(competitionId: string, seasonId: string): PlayerCard[] | null {
    if (!this.meta(competitionId, seasonId)) return null;
    return this.pools.get(`${competitionId}|${seasonId}`) ?? null;
  }
}

/** How many managers a pool can support: everyone needs a full squad and a keeper. */
/** How many managers a pool supports: enough players, keepers, and non-stars (star cap) for everyone. */
export function maxPlayersForPool(pool: readonly PlayerCard[]): number {
  const r = GAME_RULES;
  const goalkeepers = pool.filter((p) => p.position === 'GK').length;
  const nonStars = pool.filter((p) => !isStarPlayer(p)).length;
  return Math.min(
    r.maxPlayers,
    Math.floor(pool.length / r.squadSize),
    Math.floor(goalkeepers / r.minGoalkeepers),
    Math.floor(nonStars / (r.squadSize - r.starCap.max)),
  );
}

// ---------------------------------------------------------------------------
// Card construction shared by every loader
// ---------------------------------------------------------------------------

export interface RawPlayerRow {
  statsId: string;
  playerId: string;
  name: string;
  shortName: string;
  nation: { code: string; name: string; flag: string };
  club: { id: string; name: string; shortName: string; colors: string[]; logoUrl: string | null };
  league: string;
  season: string;
  position: string;
  secondaryPositions: string[];
  overall: number;
  pace?: number | null;
  shooting?: number | null;
  passing?: number | null;
  dribbling?: number | null;
  defending?: number | null;
  physical?: number | null;
  diving?: number | null;
  handling?: number | null;
  kicking?: number | null;
  reflexes?: number | null;
  speed?: number | null;
  positioning?: number | null;
  age: number;
  preferredFoot: string;
  heightCm: number;
  imageUrl?: string | null;
  imageCredit?: string | null;
}

export function toPlayerCard(r: RawPlayerRow): PlayerCard {
  if (!isPosition(r.position)) throw new Error(`Unknown position "${r.position}" for ${r.name}`);
  const isGk = r.position === 'GK';
  const n = (v: number | null | undefined) => v ?? 0;
  return {
    id: r.statsId,
    playerId: r.playerId,
    name: r.name,
    shortName: r.shortName || r.name,
    nation: r.nation,
    club: {
      id: r.club.id,
      name: r.club.name,
      shortName: r.club.shortName,
      colors: [r.club.colors[0] ?? '#334155', r.club.colors[1] ?? '#e2e8f0'],
      logoUrl: r.club.logoUrl,
    },
    league: r.league,
    season: r.season,
    position: r.position,
    secondaryPositions: r.secondaryPositions.filter(isPosition),
    overall: r.overall,
    tier: tierFor(r.overall),
    outfield: isGk
      ? null
      : {
          pace: n(r.pace),
          shooting: n(r.shooting),
          passing: n(r.passing),
          dribbling: n(r.dribbling),
          defending: n(r.defending),
          physical: n(r.physical),
        },
    goalkeeping: isGk
      ? {
          diving: n(r.diving),
          handling: n(r.handling),
          kicking: n(r.kicking),
          reflexes: n(r.reflexes),
          speed: n(r.speed),
          positioning: n(r.positioning),
        }
      : null,
    age: r.age,
    preferredFoot: r.preferredFoot === 'Left' ? 'Left' : 'Right',
    heightCm: r.heightCm,
    imageUrl: r.imageUrl ?? null,
    imageCredit: r.imageCredit ?? null,
  };
}

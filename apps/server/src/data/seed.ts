import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPosition, type CompetitionType } from '@fa/shared';
import {
  toPlayerCard,
  type CatalogCompetition,
  type CatalogData,
  type CatalogSeason,
  type PlayerStatus,
  type PoolRules,
  type RawPlayerRow,
} from './catalog';

/**
 * Reads the on-disk dataset layout:
 *
 *   data/seasons.json
 *   data/competitions.json
 *   data/seed/<season>/nations.json
 *   data/seed/<season>/clubs.json
 *   data/seed/<season>/players.csv | players.json
 *
 * The same normaliser feeds both the DB importer and the no-database file mode,
 * so swapping in a licensed dataset only means dropping new files here.
 */

export interface NationRecord {
  code: string;
  name: string;
  flag: string;
}

export interface ClubRecord {
  id: string;
  name: string;
  shortName: string;
  league: string;
  country: string;
  colors: string[];
  logoUrl?: string | null;
  ucl?: boolean;
  tags?: string[];
}

export interface CompetitionConfig {
  id: string;
  name: string;
  shortName: string;
  type: CompetitionType;
  accent: string;
  selectable?: boolean;
  sortOrder?: number;
  /** Rules applied to every season, plus `clubTags` resolved against clubs.json. */
  rules: PoolRules & { clubTags?: string[] };
  seasonRules?: Record<string, PoolRules & { clubTags?: string[] }>;
}

export interface SeasonRecord {
  id: string;
  label: string;
  startYear: number;
  isCurrent?: boolean;
}

export interface NormalizedPlayer {
  playerId: string;
  statsId: string;
  name: string;
  shortName: string;
  nationCode: string;
  clubId: string;
  leagueId: string;
  seasonId: string;
  position: string;
  secondaryPositions: string[];
  overall: number;
  pace: number | null;
  shooting: number | null;
  passing: number | null;
  dribbling: number | null;
  defending: number | null;
  physical: number | null;
  diving: number | null;
  handling: number | null;
  kicking: number | null;
  reflexes: number | null;
  speed: number | null;
  positioning: number | null;
  attributes: Record<string, number> | null;
  age: number;
  preferredFoot: 'Left' | 'Right';
  heightCm: number;
  imageUrl: string | null;
  imageCredit: string | null;
  status: PlayerStatus;
}

export interface SeasonDataset {
  season: SeasonRecord;
  nations: NationRecord[];
  clubs: ClubRecord[];
  players: NormalizedPlayer[];
  errors: string[];
}

// ------------------------------------------------------------------ parsing

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const pick = (rec: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) {
    const v = rec[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
};

/**
 * Normalise one player record (CSV row or JSON object). Accepts ids or display
 * names for club / nation / competition so third-party datasets map cleanly.
 */
export function normalizePlayerRecord(
  rec: Record<string, unknown>,
  ctx: { seasonId: string; nations: NationRecord[]; clubs: ClubRecord[] },
): NormalizedPlayer {
  const name = String(pick(rec, 'name', 'fullName') ?? '').trim();
  if (!name) throw new Error('missing name');
  const playerId = String(pick(rec, 'externalId', 'id', 'playerId') ?? slug(name));

  const nationKey = String(pick(rec, 'nation', 'nationality', 'nationCode') ?? '');
  const nation = ctx.nations.find(
    (n) => n.code === nationKey.toUpperCase() || n.name.toLowerCase() === nationKey.toLowerCase(),
  );
  if (!nation) throw new Error(`unknown nation "${nationKey}"`);

  const clubKey = String(pick(rec, 'club', 'clubId', 'currentClub') ?? '');
  const club = ctx.clubs.find((c) => c.id === clubKey || c.name.toLowerCase() === clubKey.toLowerCase());
  if (!club) throw new Error(`unknown club "${clubKey}"`);

  const competition = pick(rec, 'competition', 'league');
  const leagueId = competition ? slug(String(competition)) : club.league;

  const position = String(pick(rec, 'position') ?? '').toUpperCase();
  if (!isPosition(position)) throw new Error(`unknown position "${position}"`);
  const secondaryRaw = pick(rec, 'secondaryPositions');
  const secondaryPositions = (
    Array.isArray(secondaryRaw) ? secondaryRaw.map(String) : String(secondaryRaw ?? '').split(/[|;/ ]+/)
  )
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s && isPosition(s) && s !== position);

  const overall = num(pick(rec, 'overall', 'ovr'));
  if (overall === null || overall < 1 || overall > 99) throw new Error('overall must be 1–99');

  const isGk = position === 'GK';
  const stat = (...keys: string[]) => {
    const v = num(pick(rec, ...keys));
    if (v !== null && (v < 1 || v > 99)) throw new Error(`${keys[0]} must be 1–99`);
    return v;
  };
  const out = {
    pace: stat('pace', 'pac'),
    shooting: stat('shooting', 'sho'),
    passing: stat('passing', 'pas'),
    dribbling: stat('dribbling', 'dri'),
    defending: stat('defending', 'def'),
    physical: stat('physical', 'phy'),
  };
  const gk = {
    diving: stat('diving', 'div'),
    handling: stat('handling', 'han'),
    kicking: stat('kicking', 'kic'),
    reflexes: stat('reflexes', 'ref'),
    speed: stat('speed', 'spd'),
    positioning: stat('positioning', 'pos'),
  };
  const required = isGk ? gk : out;
  for (const [k, v] of Object.entries(required)) if (v === null) throw new Error(`missing ${k}`);

  const status = String(pick(rec, 'status') ?? 'ACTIVE').toUpperCase();
  const attributes = pick(rec, 'attributes');

  return {
    playerId,
    statsId: `${playerId}@${ctx.seasonId}`,
    name,
    shortName: String(pick(rec, 'shortName') ?? name),
    nationCode: nation.code,
    clubId: club.id,
    leagueId,
    seasonId: String(pick(rec, 'season') ?? ctx.seasonId),
    position,
    secondaryPositions,
    overall,
    ...(isGk ? { pace: null, shooting: null, passing: null, dribbling: null, defending: null, physical: null } : out),
    ...(isGk
      ? gk
      : { diving: null, handling: null, kicking: null, reflexes: null, speed: null, positioning: null }),
    attributes: attributes && typeof attributes === 'object' ? (attributes as Record<string, number>) : null,
    age: num(pick(rec, 'age')) ?? 25,
    preferredFoot: String(pick(rec, 'preferredFoot', 'foot') ?? 'Right').toLowerCase().startsWith('l')
      ? 'Left'
      : 'Right',
    heightCm: num(pick(rec, 'heightCm', 'height')) ?? 180,
    imageUrl: (pick(rec, 'imageUrl', 'image') as string | undefined) ?? null,
    imageCredit: (pick(rec, 'imageCredit') as string | undefined) ?? null,
    status: (['ACTIVE', 'INJURED', 'INACTIVE'].includes(status) ? status : 'ACTIVE') as PlayerStatus,
  };
}

// ------------------------------------------------------------------ loading

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

export function loadSeasons(dataDir: string): SeasonRecord[] {
  return readJson<SeasonRecord[]>(join(dataDir, 'seasons.json'));
}

export function loadCompetitionConfig(dataDir: string): CompetitionConfig[] {
  return readJson<CompetitionConfig[]>(join(dataDir, 'competitions.json'));
}

export function loadSeasonDataset(dataDir: string, season: SeasonRecord, playersFile?: string): SeasonDataset {
  const dir = join(dataDir, 'seed', season.id);
  const nations = readJson<NationRecord[]>(join(dir, 'nations.json'));
  const clubs = readJson<ClubRecord[]>(join(dir, 'clubs.json'));
  const file =
    playersFile ?? (existsSync(join(dir, 'players.json')) ? join(dir, 'players.json') : join(dir, 'players.csv'));
  const records: Record<string, unknown>[] = file.endsWith('.json')
    ? readJson<Record<string, unknown>[]>(file)
    : parseCsv(readFileSync(file, 'utf8'));

  // Optional photo manifest produced by `npm run images:fetch`.
  const imagesFile = join(dir, 'images.json');
  const images: Record<string, { url?: string; credit?: string }> = existsSync(imagesFile) ? readJson(imagesFile) : {};

  const players: NormalizedPlayer[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  records.forEach((rec, i) => {
    try {
      const p = normalizePlayerRecord(rec, { seasonId: season.id, nations, clubs });
      const img = images[p.playerId];
      if (!p.imageUrl && img?.url) {
        p.imageUrl = img.url;
        p.imageCredit = img.credit ?? null;
      }
      if (seen.has(p.playerId)) throw new Error(`duplicate id "${p.playerId}"`);
      seen.add(p.playerId);
      players.push(p);
    } catch (e) {
      errors.push(`row ${i + 2}: ${(e as Error).message}`);
    }
  });
  return { season, nations, clubs, players, errors };
}

/** Resolve competition rules for a season, expanding `clubTags` into explicit club ids. */
export function resolveRules(cfg: CompetitionConfig, seasonId: string, clubs: ClubRecord[]): PoolRules {
  const { clubTags, ...rules } = { ...cfg.rules, ...(cfg.seasonRules?.[seasonId] ?? {}) };
  if (clubTags?.length) {
    const tagged = clubs
      .filter((c) => clubTags.some((t) => (t === 'ucl' && c.ucl) || c.tags?.includes(t)))
      .map((c) => c.id);
    rules.clubs = rules.clubs ? rules.clubs.filter((id) => tagged.includes(id)) : tagged;
  }
  return rules;
}

export function seasonIdsOnDisk(dataDir: string): string[] {
  const seedDir = join(dataDir, 'seed');
  if (!existsSync(seedDir)) return [];
  return readdirSync(seedDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/** Build a catalog straight from disk (no database). */
export function catalogFromSeedFiles(dataDir: string): { data: CatalogData; errors: string[] } {
  const seasons = loadSeasons(dataDir).filter((s) => seasonIdsOnDisk(dataDir).includes(s.id));
  const configs = loadCompetitionConfig(dataDir);
  const competitions: CatalogCompetition[] = configs.map((c) => ({
    id: c.id,
    name: c.name,
    shortName: c.shortName,
    type: c.type,
    accent: c.accent,
    selectable: c.selectable ?? true,
    sortOrder: c.sortOrder ?? 0,
    seasons: {},
  }));
  const data: CatalogData = {
    seasons: seasons.map<CatalogSeason>((s) => ({ id: s.id, label: s.label, isCurrent: !!s.isCurrent })),
    competitions,
    players: [],
  };
  const errors: string[] = [];

  for (const season of seasons) {
    const ds = loadSeasonDataset(dataDir, season);
    errors.push(...ds.errors.map((e) => `${season.id} ${e}`));
    configs.forEach((cfg, i) => {
      competitions[i].seasons[season.id] = resolveRules(cfg, season.id, ds.clubs);
    });
    const nationBy = new Map(ds.nations.map((n) => [n.code, n]));
    const clubBy = new Map(ds.clubs.map((c) => [c.id, c]));
    for (const p of ds.players) {
      const club = clubBy.get(p.clubId)!;
      data.players.push({ card: toPlayerCard(toRawRow(p, nationBy.get(p.nationCode)!, club)), status: p.status });
    }
  }
  return { data, errors };
}

export function toRawRow(p: NormalizedPlayer, nation: NationRecord, club: ClubRecord): RawPlayerRow {
  return {
    ...p,
    nation: { code: nation.code, name: nation.name, flag: nation.flag },
    club: { id: club.id, name: club.name, shortName: club.shortName, colors: club.colors, logoUrl: club.logoUrl ?? null },
    league: p.leagueId,
    season: p.seasonId,
  };
}

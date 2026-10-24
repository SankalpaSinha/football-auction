/**
 * Import player data into PostgreSQL.
 *
 *   npm run db:import                                  # every season under data/seed
 *   npm run db:import -- --season 2026-27              # one season
 *   npm run db:import -- --season 2026-27 --file my-players.json   # custom CSV/JSON file
 *   npm run db:import -- --if-empty                    # only when the database has no players (first deploy)
 *   npm run db:import -- --if-changed                  # only when the data files changed since the last import (deploys)
 *
 * Idempotent: re-running updates existing rows. Players that disappear from a
 * season's dataset are marked INACTIVE (kept for match history).
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createDb } from '../lib/db';
import {
  loadCompetitionConfig,
  loadSeasonDataset,
  loadSeasons,
  resolveRules,
  seasonIdsOnDisk,
} from '../data/seed';

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const dataDir = resolve(process.cwd(), process.env.DATA_DIR ?? '../../data');
const onlySeason = arg('season');
const file = arg('file') ? resolve(process.cwd(), arg('file')!) : undefined;

/** Fingerprint of every data file, so deploys re-import only when the data actually changed. */
function datasetHash(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else h.update(full.slice(dir.length)).update(readFileSync(full));
    }
  };
  walk(dir);
  return h.digest('hex');
}

const HASH_KEY = 'dataset-hash';

async function main() {
  const db = createDb();
  if (args.includes('--if-empty') && (await db.playerStats.count()) > 0) {
    console.log('Player data already present — skipping import.');
    await db.$disconnect();
    return;
  }
  const hash = datasetHash(dataDir);
  if (args.includes('--if-changed') && !file) {
    const stored = await db.appMeta.findUnique({ where: { key: HASH_KEY } });
    if (stored?.value === hash && (await db.playerStats.count()) > 0) {
      console.log('Player data unchanged since the last import — skipping.');
      await db.$disconnect();
      return;
    }
    console.log(stored ? 'Player data changed — re-importing.' : 'No import fingerprint yet — importing.');
  }
  const seasons = loadSeasons(dataDir).filter(
    (s) => seasonIdsOnDisk(dataDir).includes(s.id) && (!onlySeason || s.id === onlySeason),
  );
  if (!seasons.length) throw new Error(`No season data found in ${dataDir}/seed`);
  const configs = loadCompetitionConfig(dataDir);

  for (const cfg of configs) {
    await db.competition.upsert({
      where: { id: cfg.id },
      create: {
        id: cfg.id,
        name: cfg.name,
        shortName: cfg.shortName,
        type: cfg.type,
        accent: cfg.accent,
        selectable: cfg.selectable ?? true,
        sortOrder: cfg.sortOrder ?? 0,
      },
      update: {
        name: cfg.name,
        shortName: cfg.shortName,
        type: cfg.type,
        accent: cfg.accent,
        selectable: cfg.selectable ?? true,
        sortOrder: cfg.sortOrder ?? 0,
      },
    });
  }

  for (const season of seasons) {
    const ds = loadSeasonDataset(dataDir, season, file);
    const source = file ? basename(file) : `seed:${season.id}`;
    console.log(`\n▶ ${season.label}: ${ds.players.length} players, ${ds.clubs.length} clubs, ${ds.nations.length} nations`);
    if (ds.errors.length) {
      console.warn(`  ${ds.errors.length} rows skipped:`);
      for (const e of ds.errors.slice(0, 20)) console.warn(`   - ${e}`);
    }

    await db.season.upsert({
      where: { id: season.id },
      create: { id: season.id, label: season.label, startYear: season.startYear, isCurrent: !!season.isCurrent },
      update: { label: season.label, startYear: season.startYear, isCurrent: !!season.isCurrent },
    });

    for (const n of ds.nations) {
      await db.nation.upsert({ where: { code: n.code }, create: n, update: { name: n.name, flag: n.flag } });
    }

    // Leagues referenced by clubs/players that are not configured competitions get a hidden stub.
    const leagueIds = new Set([...ds.clubs.map((c) => c.league), ...ds.players.map((p) => p.leagueId)]);
    for (const id of leagueIds) {
      if (configs.some((c) => c.id === id)) continue;
      await db.competition.upsert({
        where: { id },
        create: { id, name: id, shortName: id.slice(0, 3).toUpperCase(), type: 'LEAGUE', accent: '#64748b', selectable: false },
        update: {},
      });
    }

    for (const c of ds.clubs) {
      const data = {
        name: c.name,
        shortName: c.shortName,
        country: c.country,
        colors: c.colors,
        logoUrl: c.logoUrl ?? null,
        leagueId: c.league,
      };
      await db.club.upsert({ where: { id: c.id }, create: { id: c.id, ...data }, update: data });
    }

    const ids: string[] = [];
    for (const p of ds.players) {
      await db.player.upsert({
        where: { id: p.playerId },
        create: {
          id: p.playerId,
          name: p.name,
          shortName: p.shortName,
          nationCode: p.nationCode,
          preferredFoot: p.preferredFoot,
          heightCm: p.heightCm,
          imageUrl: p.imageUrl,
          imageCredit: p.imageCredit,
        },
        update: {
          name: p.name,
          shortName: p.shortName,
          nationCode: p.nationCode,
          preferredFoot: p.preferredFoot,
          heightCm: p.heightCm,
          imageUrl: p.imageUrl,
          imageCredit: p.imageCredit,
        },
      });
      const stats = {
        clubId: p.clubId,
        leagueId: p.leagueId,
        position: p.position,
        secondaryPositions: p.secondaryPositions,
        overall: p.overall,
        pace: p.pace,
        shooting: p.shooting,
        passing: p.passing,
        dribbling: p.dribbling,
        defending: p.defending,
        physical: p.physical,
        diving: p.diving,
        handling: p.handling,
        kicking: p.kicking,
        reflexes: p.reflexes,
        speed: p.speed,
        positioning: p.positioning,
        attributes: p.attributes ?? undefined,
        age: p.age,
        status: p.status,
        source,
      };
      await db.playerStats.upsert({
        where: { id: p.statsId },
        create: { id: p.statsId, playerId: p.playerId, seasonId: season.id, ...stats },
        update: stats,
      });
      ids.push(p.statsId);
    }

    const retired = await db.playerStats.updateMany({
      where: { seasonId: season.id, source, id: { notIn: ids }, status: { not: 'INACTIVE' } },
      data: { status: 'INACTIVE' },
    });
    if (retired.count) console.log(`  ${retired.count} players no longer in dataset → INACTIVE`);

    for (const cfg of configs) {
      const rules = resolveRules(cfg, season.id, ds.clubs);
      await db.competitionSeason.upsert({
        where: { competitionId_seasonId: { competitionId: cfg.id, seasonId: season.id } },
        create: { competitionId: cfg.id, seasonId: season.id, rules: rules as object },
        update: { rules: rules as object },
      });
    }
    console.log(`  ✓ imported`);
  }
  // Remember what was imported (only for full imports of the files on disk).
  if (!file && !onlySeason) {
    await db.appMeta.upsert({ where: { key: HASH_KEY }, create: { key: HASH_KEY, value: hash }, update: { value: hash } });
  }
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

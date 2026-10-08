import 'dotenv/config';
import { resolve } from 'node:path';
import { makeRules } from '@fa/shared';
import { createApp } from './app';
import { InMemoryCatalog, type CatalogData } from './data/catalog';
import { catalogFromDb } from './data/dbCatalog';
import { catalogFromSeedFiles } from './data/seed';
import { systemClock } from './engine/clock';
import { NoopGameStore, type GameStore } from './engine/store';
import { createDb } from './lib/db';
import { PrismaGameStore } from './services/prismaStore';
import { MemoryUserStore, PrismaUserStore, type UserStore } from './services/users';

const env = process.env;
const port = Number(env.PORT ?? 4000);
const storage = env.STORAGE === 'file' ? 'file' : 'db';
const dataDir = resolve(process.cwd(), env.DATA_DIR ?? '../../data');

const devNumber = (name: string) => (env[name] ? Number(env[name]) : undefined);
const rules = makeRules({
  ...(devNumber('DEV_SOLD_REVEAL_MS') !== undefined && { soldRevealMs: devNumber('DEV_SOLD_REVEAL_MS')! }),
  ...(devNumber('DEV_UNSOLD_REVEAL_MS') !== undefined && { unsoldRevealMs: devNumber('DEV_UNSOLD_REVEAL_MS')! }),
  ...(devNumber('DEV_START_COUNTDOWN_MS') !== undefined && { startCountdownMs: devNumber('DEV_START_COUNTDOWN_MS')! }),
});

async function main() {
  let data: CatalogData;
  let users: UserStore;
  let store: GameStore;
  let disconnect = async () => {};

  if (storage === 'db') {
    const db = createDb();
    data = await catalogFromDb(db);
    if (!data.players.length) {
      console.warn('⚠ No players in the database. Run `npm run db:import` first.');
    }
    users = new PrismaUserStore(db);
    const prismaStore = new PrismaGameStore(db);
    await prismaStore.ensureFormations();
    store = prismaStore;
    disconnect = () => db.$disconnect();
  } else {
    const loaded = catalogFromSeedFiles(dataDir);
    if (loaded.errors.length) console.warn(`⚠ ${loaded.errors.length} seed rows skipped`);
    data = loaded.data;
    users = new MemoryUserStore();
    store = new NoopGameStore();
    console.warn('⚠ STORAGE=file — usernames and games are not persisted.');
  }

  const catalog = new InMemoryCatalog(data);
  const originEnv = env.CLIENT_ORIGIN ?? 'http://localhost:3000';
  const origins = originEnv === '*' ? true : originEnv.split(',').map((s) => s.trim());
  const server = createApp({ catalog, users, store, clock: systemClock, rules, corsOrigins: origins });
  const actualPort = await server.listen(port);

  const comps = catalog.competitions();
  console.log(`⚽ Football Auction server on http://localhost:${actualPort} (${storage})`);
  console.log(`   ${data.players.length} players · ${comps.length} playable competitions`);
  for (const c of comps) {
    for (const s of c.seasons) console.log(`   - ${c.name} ${s.label}: ${s.poolSize} players, up to ${s.maxPlayers} managers`);
  }

  const shutdown = async () => {
    console.log('\nShutting down…');
    await server.close();
    await disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Fetch free-licensed player photos from Wikimedia Commons (via Wikidata).
 *
 *   npm run images:fetch                     # current season, only players not yet looked up
 *   npm run images:fetch -- --refresh        # look everyone up again
 *   npm run images:fetch -- --season 2026-27
 *
 * Writes data/seed/<season>/images.json: playerId → { url, credit, license, source } | { none: true }.
 * Every photo keeps its author + licence so the UI can credit it (CC BY / CC BY-SA require attribution).
 * Matching uses the player's name, the "association football player" occupation and birth year.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadSeasonDataset, loadSeasons, seasonIdsOnDisk } from '../data/seed';

const args = process.argv.slice(2);
const arg = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const refresh = args.includes('--refresh');
const dataDir = resolve(process.cwd(), process.env.DATA_DIR ?? '../../data');
const UA = 'FootballAuctionDev/0.1 (local development; image lookup)';
const FOOTBALLER = 'Q937857';

export interface ImageEntry {
  url?: string;
  credit?: string;
  license?: string;
  source?: string;
  qid?: string;
  none?: true;
  checkedAt: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, attempt = 0): Promise<any> {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (res.status === 429 || res.status >= 500) {
    if (attempt > 7) throw new Error(`HTTP ${res.status} for ${url}`);
    const retryAfter = Number(res.headers.get('retry-after')) || 0;
    await sleep(Math.max(retryAfter * 1000, 2000 * 2 ** attempt));
    return getJson(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  await sleep(250); // stay well under Wikimedia's rate limits
  return res.json();
}

const wd = (params: Record<string, string>) =>
  `https://www.wikidata.org/w/api.php?${new URLSearchParams({ format: 'json', origin: '*', ...params })}`;
const commons = (params: Record<string, string>) =>
  `https://commons.wikimedia.org/w/api.php?${new URLSearchParams({ format: 'json', origin: '*', ...params })}`;

const stripHtml = (s: string) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}


async function lookup(todo: ReturnType<typeof loadSeasonDataset>['players'], cache: Record<string, ImageEntry>, startYear: number) {
  // 1. Search candidates by name.
  const candidates = new Map<string, string[]>();
  await pool(todo, 2, async (p) => {
    const r = await getJson(wd({ action: 'wbsearchentities', search: p.name, language: 'en', type: 'item', limit: '7' }));
    candidates.set(p.playerId, (r.search ?? []).map((x: { id: string }) => x.id));
  });

  // 2. Fetch claims for all candidate entities in batches of 50.
  const ids = [...new Set([...candidates.values()].flat())];
  const claims = new Map<string, any>();
  for (let i = 0; i < ids.length; i += 50) {
    const r = await getJson(wd({ action: 'wbgetentities', ids: ids.slice(i, i + 50).join('|'), props: 'claims' }));
    for (const [id, ent] of Object.entries<any>(r.entities ?? {})) claims.set(id, ent.claims ?? {});
  }

  const values = (c: any, prop: string) =>
    (c?.[prop] ?? []).map((s: any) => s.mainsnak?.datavalue?.value).filter(Boolean);

  // 3. Pick the matching footballer and their image.
  const files = new Map<string, { playerId: string; qid: string }>();
  for (const p of todo) {
    const bornAround = startYear - p.age;
    const match = (candidates.get(p.playerId) ?? []).find((qid) => {
      const c = claims.get(qid);
      if (!values(c, 'P106').some((v: any) => v.id === FOOTBALLER)) return false;
      const dob = values(c, 'P569')[0]?.time as string | undefined;
      if (!dob) return true;
      const year = Number(dob.slice(1, 5));
      return Math.abs(year - bornAround) <= 2;
    });
    const image = match ? (values(claims.get(match), 'P18')[0] as string | undefined) : undefined;
    if (match && image) files.set(`File:${image}`, { playerId: p.playerId, qid: match });
    else cache[p.playerId] = { none: true, qid: match, checkedAt: new Date().toISOString() };
  }

  // 4. Thumbnail URL + attribution from Commons.
  const titles = [...files.keys()];
  for (let i = 0; i < titles.length; i += 40) {
    const batch = titles.slice(i, i + 40);
    const r = await getJson(
      commons({ action: 'query', titles: batch.join('|'), prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '400' }),
    );
    const normalized = new Map<string, string>((r.query?.normalized ?? []).map((n: any) => [n.to, n.from]));
    for (const page of Object.values<any>(r.query?.pages ?? {})) {
      const original = normalized.get(page.title) ?? page.title;
      const target = files.get(original);
      const info = page.imageinfo?.[0];
      if (!target) continue;
      if (!info) {
        cache[target.playerId] = { none: true, qid: target.qid, checkedAt: new Date().toISOString() };
        continue;
      }
      const meta = info.extmetadata ?? {};
      const author = stripHtml(meta.Artist?.value ?? 'Unknown author');
      const license = stripHtml(meta.LicenseShortName?.value ?? 'see source');
      cache[target.playerId] = {
        url: info.thumburl ?? info.url,
        credit: `${author.slice(0, 80)} · ${license}`,
        license,
        source: info.descriptionurl,
        qid: target.qid,
        checkedAt: new Date().toISOString(),
      };
    }
  }

}

async function main() {
  const seasons = loadSeasons(dataDir).filter((s) => seasonIdsOnDisk(dataDir).includes(s.id));
  const season = seasons.find((s) => s.id === (arg('season') ?? '')) ?? seasons.find((s) => s.isCurrent) ?? seasons[0];
  const startYear = season.startYear;
  const ds = loadSeasonDataset(dataDir, season);
  const file = join(dataDir, 'seed', season.id, 'images.json');
  const cache: Record<string, ImageEntry> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const todo = ds.players.filter((p) => refresh || !cache[p.playerId]);
  console.log(`📷 ${season.label}: ${ds.players.length} players, ${todo.length} to look up`);

  const save = () => writeFileSync(file, JSON.stringify(cache, null, 1) + '\n');
  for (let c = 0; c < todo.length; c += 25) {
    await lookup(todo.slice(c, c + 25), cache, startYear);
    save();
    console.log(`   ${Math.min(c + 25, todo.length)}/${todo.length}`);
  }
  writeFileSync(file, JSON.stringify(cache, null, 1) + '\n');
  const found = ds.players.filter((p) => cache[p.playerId]?.url).length;
  console.log(`✓ ${found}/${ds.players.length} players have a photo → ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

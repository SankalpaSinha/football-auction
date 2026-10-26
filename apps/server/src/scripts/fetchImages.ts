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
import { loadSeasonDataset, loadSeasons, parseCsv, seasonIdsOnDisk } from '../data/seed';

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
  await sleep(600); // stay well under Wikimedia's rate limits
  return res.json();
}

const wd = (params: Record<string, string>) =>
  `https://www.wikidata.org/w/api.php?${new URLSearchParams({ format: 'json', origin: '*', ...params })}`;
const commons = (params: Record<string, string>) =>
  `https://commons.wikimedia.org/w/api.php?${new URLSearchParams({ format: 'json', origin: '*', ...params })}`;

const SPARQL = 'https://query.wikidata.org/sparql';

/** Resolve many players at once by exact English label → { playerId: { qid, file } }. */
async function sparqlBulk(players: { playerId: string; name: string; age: number }[], startYear: number) {
  const out = new Map<string, { qid: string; file: string }>();
  for (let i = 0; i < players.length; i += 80) {
    const chunk = players.slice(i, i + 80);
    const values = chunk.map((p) => `"${p.name.replace(/["\\]/g, '')}"@en`).join(' ');
    const query = `SELECT ?name ?p ?img ?dob WHERE {
      VALUES ?name { ${values} }
      ?p rdfs:label ?name; wdt:P106 wd:${FOOTBALLER}; wdt:P18 ?img.
      OPTIONAL { ?p wdt:P569 ?dob }
    }`;
    const res = await fetch(`${SPARQL}?${new URLSearchParams({ query, format: 'json' })}`, {
      headers: { 'user-agent': UA, accept: 'application/sparql-results+json' },
    });
    if (!res.ok) {
      console.warn(`   SPARQL chunk failed (${res.status}) — those players fall back to search`);
      await sleep(5000);
      continue;
    }
    const rows = ((await res.json()) as any).results.bindings as any[];
    for (const p of chunk) {
      const bornAround = startYear - p.age;
      const hit = rows.find((r) => {
        if (r.name.value !== p.name.replace(/["\\]/g, '')) return false;
        const y = r.dob ? Number(String(r.dob.value).slice(0, 4)) : bornAround;
        return Math.abs(y - bornAround) <= 2;
      });
      if (hit) {
        const file = decodeURIComponent(String(hit.img.value).split('/Special:FilePath/')[1] ?? '').replace(/_/g, ' ');
        if (file) out.set(p.playerId, { qid: String(hit.p.value).split('/').pop()!, file });
      }
    }
    await sleep(1500);
  }
  return out;
}

const stripHtml = (s: string) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}


/** Thumbnail URL + attribution from Commons for File: titles. */
async function attachCommons(files: Map<string, { playerId: string; qid: string }>, cache: Record<string, ImageEntry>) {
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

async function lookup(todo: ReturnType<typeof loadSeasonDataset>['players'], cache: Record<string, ImageEntry>, startYear: number) {
  // 1. Search candidates by name.
  const candidates = new Map<string, string[]>();
  await pool(todo, 1, async (p) => {
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

  await attachCommons(files, cache);
}

async function main() {
  const seasons = loadSeasons(dataDir).filter((s) => seasonIdsOnDisk(dataDir).includes(s.id));
  const season = seasons.find((s) => s.id === (arg('season') ?? '')) ?? seasons.find((s) => s.isCurrent) ?? seasons[0];
  const startYear = season.startYear;
  const ds = loadSeasonDataset(dataDir, season);
  const file = join(dataDir, 'seed', season.id, 'images.json');
  const cache: Record<string, ImageEntry> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  // Optional extra CSV columns (used by the all-time icons): the real birth year and Wikidata id.
  const extras = new Map<string, { birthYear?: number; qid?: string }>();
  const csvFile = join(dataDir, 'seed', season.id, 'players.csv');
  if (existsSync(csvFile)) {
    for (const r of parseCsv(readFileSync(csvFile, 'utf8'))) {
      const birthYear = Number(r.birthYear) || undefined;
      const qid = /^Q\d+$/.test(r.wikidataId ?? '') ? r.wikidataId : undefined;
      if (birthYear || qid) extras.set(r.externalId, { birthYear, qid });
    }
  }
  // Name matching uses "season year − age" as the birth year; legends have a real one instead.
  const todo = ds.players
    .filter((p) => refresh || !cache[p.playerId])
    .map((p) => {
      const by = extras.get(p.playerId)?.birthYear;
      return by ? { ...p, age: startYear - by } : p;
    });
  console.log(`📷 ${season.label}: ${ds.players.length} players, ${todo.length} to look up`);

  const save = () => writeFileSync(file, JSON.stringify(cache, null, 1) + '\n');

  // Known Wikidata ids: read the image straight from the entity.
  const known = todo.filter((p) => extras.get(p.playerId)?.qid);
  if (known.length) {
    const files = new Map<string, { playerId: string; qid: string }>();
    for (let i = 0; i < known.length; i += 50) {
      const batch = known.slice(i, i + 50);
      const ids = batch.map((p) => extras.get(p.playerId)!.qid!).join('|');
      const r = await getJson(`https://www.wikidata.org/w/api.php?${new URLSearchParams({ action: 'wbgetentities', ids, props: 'claims', format: 'json' })}`);
      for (const p of batch) {
        const qid = extras.get(p.playerId)!.qid!;
        const img = r?.entities?.[qid]?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
        if (img) files.set(`File:${img}`, { playerId: p.playerId, qid });
      }
    }
    await attachCommons(files, cache);
    save();
    console.log(`   Wikidata ids matched ${files.size}/${known.length}`);
  }

  // Fast path: bulk SPARQL by exact name.
  const bulk = await sparqlBulk(todo.filter((p) => !cache[p.playerId]), startYear);
  console.log(`   SPARQL matched ${bulk.size}/${todo.length}`);
  await attachCommons(
    new Map([...bulk].map(([playerId, v]) => [`File:${v.file}`, { playerId, qid: v.qid }])),
    cache,
  );
  save();
  const rest = todo.filter((p) => !cache[p.playerId]);
  if (!args.includes('--thorough')) {
    console.log(`   ${rest.length} unmatched — run with --thorough to search them one by one (slow, rate-limited)`);
  }
  const slow = args.includes('--thorough') ? rest : [];
  for (let c = 0; c < slow.length; c += 25) {
    await lookup(slow.slice(c, c + 25), cache, startYear);
    save();
    console.log(`   ${Math.min(c + 25, slow.length)}/${slow.length}`);
  }
  writeFileSync(file, JSON.stringify(cache, null, 1) + '\n');
  const found = ds.players.filter((p) => cache[p.playerId]?.url).length;
  console.log(`✓ ${found}/${ds.players.length} players have a photo → ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

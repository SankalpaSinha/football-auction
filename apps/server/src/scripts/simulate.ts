/**
 * Bots that play against a running server.
 *
 *   npm run sim                                  # 3 bots play a whole Premier League auction
 *   npm run sim -- --bots 4 --competition la-liga
 *   npm run sim -- --join FBA7K2 --bots 2        # bots join YOUR room; you host and press start
 *
 * Options: --server http://localhost:4000  --bots N  --competition id  --season 2026-27
 *          --aggression 0..1  --think-min ms  --think-max ms  --mode casual|ranked
 *          --format classic|blitz|budget|draft  --no-twists  --season-length 1|3|5
 *          --names A,B,C (reuse the same bot accounts)  --public
 */
import { randomBytes } from 'node:crypto';
import { Bot } from '../sim/bot';

const args = process.argv.slice(2);
const arg = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const base = arg('server', 'http://localhost:4000')!;
const join = arg('join')?.toUpperCase();
const count = Number(arg('bots', join ? '2' : '3'));
const competitionId = arg('competition', 'premier-league')!;
const seasonId = arg('season', '2026-27')!;
const aggression = Number(arg('aggression', '0.6'));
const fixedNames = arg('names')?.split(',').map((n) => n.trim()).filter(Boolean);
const isPublic = args.includes('--public');
const mode = (arg('mode', 'casual')!.toUpperCase() === 'RANKED' ? 'RANKED' : 'CASUAL') as 'RANKED' | 'CASUAL';
const format = (arg('format', 'classic')!.toUpperCase()) as 'CLASSIC' | 'BLITZ' | 'BUDGET' | 'DRAFT';
const twists = !args.includes('--no-twists');
const seasonLength = Number(arg('season-length', '1'));
/** Keep playing this many games in the room (the host starts each rematch). */
const games = Number(arg('games', '1'));
const think: [number, number] = [Number(arg('think-min', join ? '900' : '150')), Number(arg('think-max', join ? '4000' : '600'))];

const NAMES = ['BotKlopp', 'BotPep', 'BotAncelotti', 'BotSimeone', 'BotArteta', 'BotXabi', 'BotZidane', 'BotMourinho'];

async function main() {
  const tag = randomBytes(2).toString('hex');
  const bots = await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      // Unique even with more bots than names.
      const name = fixedNames?.[i] ?? `${NAMES[i % NAMES.length].slice(0, 11)}${i >= NAMES.length ? i : ''}_${tag}`.slice(0, 16);
      const bot = new Bot(base, name, { aggression, thinkMs: think, cardiness: 0.4, autoReady: true, reconnect: true });
      await bot.login();
      return bot.connect();
    }),
  );
  console.log(`🤖 ${bots.length} bots connected to ${base}`);

  let code = join;
  if (code) {
    for (const b of bots) {
      await b.must('room:join', { code });
      await b.must('room:ready', { ready: true });
    }
    console.log(`   joined ${code} and readied up — start the game from your browser.`);
  } else {
    const host = bots[0];
    ({ code } = await host.must<{ code: string }>('room:create', {
      name: 'Bot Cup',
      competitionId,
      seasonId,
      startingBudget: 1000,
      maxPlayers: Math.max(2, count),
      lotDurationSec: 15,
      mode,
      isPublic,
      format,
      twists: { mystery: twists, sealed: twists, events: twists, cards: twists },
      seasonLength,
    }));
    for (const b of bots.slice(1)) {
      await b.must('room:join', { code });
      await b.must('room:ready', { ready: true });
    }
    await host.waitFor((v) => v.members.length === count && v.members.every((m) => m.ready));
    await host.must('room:start');
    console.log(`   room ${code} started (${competitionId} ${seasonId})`);
  }

  const watcher = bots[0];
  let lastLot = 0;
  watcher.socket.on('room:state', (v) => {
    const r = v.auction?.lastResult;
    if (r && r.lotNumber !== lastLot) {
      lastLot = r.lotNumber;
      const who = v.members.find((m) => m.userId === r.winnerId)?.username ?? '—';
      const tag = r.outcome === 'SOLD' ? `→ ${who} for ${r.price} (${r.verdict?.toLowerCase()})` : 'unsold';
      console.log(`   #${String(r.lotNumber).padStart(3)} ${r.player.shortName.padEnd(18)} ${r.player.overall} ${r.player.position.padEnd(3)} ${tag}`);
    }
  });

  for (let game = 1; game <= games; game++) {
    if (game > 1) {
      await watcher.waitFor((v) => v.phase === 'LOBBY' || v.phase === 'WAITING_FOR_PLAYERS', 60 * 60_000);
      console.log(`\n🔁 Game ${game}: back in the lobby`);
      if (!join) {
        await watcher.waitFor((v) => v.members.every((m) => m.ready), 60_000);
        await watcher.must('room:start');
      }
    }
    await watcher.waitFor((v) => v.phase === 'SQUAD_BUILDING', 60 * 60_000);
    console.log('\n🏁 Auction complete — bots are picking lineups\n');
    await watcher.waitFor((v) => v.phase === 'TOURNAMENT', 15 * 60_000);
    console.log('⚽ The cup is on\n');
    const final = await watcher.waitFor((v) => v.phase === 'RESULTS', 15 * 60_000);
    const nameOf = (id: string) => final.members.find((m) => m.userId === id)?.username ?? id;
    for (const m of final.tournament?.matches ?? []) {
      const pens = m.pens ? ` (${m.pens[0]}–${m.pens[1]} pens)` : '';
      console.log(`  ${final.tournament!.rounds[m.round].padEnd(14)} ${nameOf(m.home.userId)} ${m.home.goals}–${m.away.goals} ${nameOf(m.away.userId)}${pens}`);
    }
    console.log('\n🏆 Results\n');
    for (const r of final.results!.rankings) {
      console.log(`  ${r.rank}. ${String(nameOf(r.userId)).padEnd(18)} ${(r.cupFinish ?? '').padEnd(14)} squad ${r.total.toFixed(1)} (#${r.squadRank})`);
    }
    console.log('');
    for (const m of final.members) {
      const spent = m.squad.reduce((s, e) => s + e.price, 0);
      const gk = m.squad.filter((e) => e.player.position === 'GK').length;
      const avg = (m.squad.reduce((s, e) => s + e.player.overall, 0) / m.squad.length).toFixed(1);
      const l = final.lineups?.[m.userId];
      console.log(`  ${m.username.padEnd(18)} ${m.squad.length} players · ${gk} GK · avg ${avg} OVR · spent ${spent} · left ${m.budget} · ${l?.formationId}${l?.auto ? ' (auto)' : ''}`);
    }
    if (game < games && !join) await watcher.must('room:rematch');
  }
  const errors = bots.flatMap((b) => b.errors);
  if (errors.length) console.log(`\n  unexpected rejections: ${errors.join(', ')}`);
  for (const b of bots) b.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

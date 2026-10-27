import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_TWISTS, makeRules, NO_TWISTS, validateLineup } from '@fa/shared';
import { createApp } from '../src/app';
import { InMemoryCatalog } from '../src/data/catalog';
import { systemClock } from '../src/engine/clock';
import { NoopGameStore } from '../src/engine/store';
import { MemoryUserStore } from '../src/services/users';
import { Bot } from '../src/sim/bot';
import { makePool } from './helpers';

/**
 * End-to-end: a real Socket.IO server and real socket clients playing a whole
 * auction, including a mid-auction refresh.
 */
let server: ReturnType<typeof createApp>;
let base = '';

beforeAll(async () => {
  const pool = makePool(150, 18);
  const catalog = new InMemoryCatalog({
    seasons: [{ id: '2026-27', label: '2026–27', isCurrent: true }],
    competitions: [
      {
        id: 'test',
        name: 'Test League',
        shortName: 'TL',
        type: 'LEAGUE',
        accent: '#fff',
        selectable: true,
        sortOrder: 1,
        seasons: { '2026-27': {} },
      },
    ],
    players: pool.map((card) => ({ card, status: 'ACTIVE' as const })),
  });
  server = createApp({
    catalog,
    users: new MemoryUserStore(),
    store: new NoopGameStore(),
    clock: systemClock,
    rules: makeRules({
      startCountdownMs: 50,
      soldRevealMs: 15,
      unsoldRevealMs: 10,
      evaluationMs: 50,
      // A quick cup.
      matchMinuteMs: 2,
      extraMinuteMs: 2,
      halfTimeMs: 400,
      penaltyKickMs: 10,
      roundIntroMs: 30,
      roundBreakMs: 30,
      ceremonyMs: 30,
      stealWindowMs: 40,
    }),
    corsOrigins: true,
    registrationsPerHour: 1000,
  });
  const port = await server.listen(0);
  base = `http://localhost:${port}`;
});

afterAll(async () => {
  await server?.close();
});

const roomInput = {
  name: 'E2E',
  competitionId: 'test',
  seasonId: '2026-27',
  startingBudget: 1000,
  maxPlayers: 4,
  lotDurationSec: 15,
  // Plain auctions here (twists move coins around); the twists get their own game below.
  twists: { ...NO_TWISTS },
};

describe('multiplayer over websockets', () => {
  it('rejects duplicate usernames (case-insensitive)', async () => {
    await new Bot(base, 'Dupe').login();
    const r = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'dUPE', password: 'another-pass' }),
    });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('USERNAME_TAKEN');
  });

  it('rejects malformed messages and unauthenticated sockets', async () => {
    const bot = await (await new Bot(base, 'Malformed').login()).connect();
    const r = await bot.emit('auction:bid', { lotNumber: 'x', amount: -5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('BAD_REQUEST');
    const r2 = await bot.emit('room:join', { code: 'nope' });
    expect(r2.ok).toBe(false);
    bot.disconnect();

    const anon = new Bot(base, 'anon');
    anon.token = 'not-a-real-token';
    await expect(anon.connect()).rejects.toThrow(/UNAUTHENTICATED/);
  });

  it('three managers play a full auction; one refreshes mid-way', async () => {
    const [a, b, c] = await Promise.all(
      ['Alice', 'Bruno', 'Chen'].map(async (n) => (await new Bot(base, n, { aggression: 0.7 }).login()).connect()),
    );
    const { code } = await a.must<{ code: string }>('room:create', roomInput);
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
    await b.must('room:join', { code });
    await c.must('room:join', { code });
    await a.waitFor((v) => v.members.length === 3);

    const notReady = await a.emit('room:start');
    expect(notReady.ok).toBe(false);

    await b.must('room:ready', { ready: true });
    await c.must('room:ready', { ready: true });
    await a.waitFor((v) => v.members.every((m) => m.ready));
    await a.must('room:start');
    await a.waitFor((v) => v.phase === 'AUCTION');

    // Chen "refreshes": drops, misses a few lots, comes back with a new socket.
    await c.waitFor((v) => (v.auction?.lotsOpened ?? 0) >= 6);
    const before = c.me!;
    c.disconnect();
    await a.waitFor((v) => v.members.find((m) => m.userId === c.userId)?.connected === false);
    await a.waitFor((v) => (v.auction?.lotsOpened ?? 0) >= 12);
    const c2 = new Bot(base, 'Chen', { aggression: 0.7 });
    c2.token = c.token;
    c2.userId = c.userId;
    await c2.connect();
    const back = await c2.waitFor((v) => v.members.find((m) => m.userId === c.userId)?.connected === true);
    const restored = back.members.find((m) => m.userId === c.userId)!;
    expect(restored.squad.length).toBeGreaterThanOrEqual(before.squad.length);
    expect(restored.budget).toBeLessThanOrEqual(before.budget!);

    const final = await a.waitFor((v) => v.phase === 'FINAL_EVALUATION', 60_000);
    // Every lineup was locked by its manager (not auto-completed) and is valid.
    for (const m of final.members) {
      const l = final.lineups![m.userId];
      expect(l.locked).toBe(true);
      expect(l.auto).toBe(false);
      expect(validateLineup(l, m.squad.map((e) => e.player), true)).toBeNull();
    }
    const results = await a.waitFor((v) => v.phase === 'RESULTS', 20_000);
    expect(results.results!.rankings).toHaveLength(3);
    expect(results.results!.rankings[0].rank).toBe(1);
    const ids = new Set<string>();
    for (const m of final.members) {
      expect(m.squad).toHaveLength(18);
      expect(m.squad.some((s) => s.player.position === 'GK')).toBe(true);
      expect(m.budget).toBeGreaterThanOrEqual(0);
      const spent = m.squad.reduce((sum, s) => sum + s.price, 0);
      expect(spent + m.budget!).toBe(1000);
      for (const s of m.squad) {
        expect(ids.has(s.player.id)).toBe(false);
        ids.add(s.player.id);
      }
    }
    // Bots only ever send legal-looking actions; the server must not have rejected
    // anything for reasons other than races.
    expect([...a.errors, ...b.errors, ...c2.errors].filter((e) => e !== 'RATE_LIMITED')).toEqual([]);
    for (const bot of [a, b, c2]) bot.disconnect();
  }, 90_000);

  it('a manager cannot join a second room while an auction is live', async () => {
    const [x, y, z] = await Promise.all(
      ['Xavi', 'Yaya', 'Zico'].map(async (n) => (await new Bot(base, n, { aggression: 0 }).login()).connect()),
    );
    const { code } = await x.must<{ code: string }>('room:create', roomInput);
    await y.must('room:join', { code });
    await y.must('room:ready', { ready: true });
    await x.must('room:start');
    await x.waitFor((v) => v.phase === 'AUCTION');
    const { code: other } = await z.must<{ code: string }>('room:create', roomInput);
    const r = await x.emit('room:join', { code: other });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ALREADY_IN_GAME');
    for (const bot of [x, y, z]) bot.disconnect();
  });

  it('lists public lobbies and quick match joins or creates one', async () => {
    const [host, guest, solo] = await Promise.all(
      ['PubHost', 'PubGuest', 'SoloQ'].map(async (n) => (await new Bot(base, n, { aggression: 0 }).login()).connect()),
    );
    const { code } = await host.must<{ code: string }>('room:create', { ...roomInput, isPublic: true });
    const list = (await (await fetch(`${base}/api/rooms/public`)).json()).rooms as { code: string; members: number }[];
    expect(list.some((r) => r.code === code)).toBe(true);

    const joined = await guest.must<{ code: string; created: boolean }>('match:quick', { mode: 'CASUAL', competitionId: 'test' });
    expect(joined).toEqual({ code, created: false });

    // No ranked lobby exists → quick match opens a new public ranked room.
    const fresh = await solo.must<{ code: string; created: boolean }>('match:quick', { mode: 'RANKED' });
    expect(fresh.created).toBe(true);
    const after = (await (await fetch(`${base}/api/rooms/public`)).json()).rooms as { code: string; mode: string }[];
    expect(after.find((r) => r.code === fresh.code)?.mode).toBe('RANKED');

    // Ranked needs the standard budget.
    const bad = await host.emit('room:create', { ...roomInput, mode: 'RANKED', startingBudget: 2000 });
    expect(bad.ok).toBe(false);
    for (const b of [host, guest, solo]) b.disconnect();
  });

  it('spectators watch live but can never act or see private lineups', async () => {
    const [p1, p2, fan] = await Promise.all(
      ['Player1', 'Player2', 'Watcher'].map(async (n) => (await new Bot(base, n, { aggression: 0.6 }).login()).connect()),
    );
    const { code } = await p1.must<{ code: string }>('room:create', { ...roomInput, isPublic: true });
    await p2.must('room:join', { code });
    await p2.must('room:ready', { ready: true });
    await p1.must('room:start');
    await p1.waitFor((v) => v.phase === 'AUCTION');

    const live = (await (await fetch(`${base}/api/rooms/live`)).json()).games as { code: string }[];
    expect(live.some((g) => g.code === code)).toBe(true);

    const r = await fan.must<{ code: string; role: string }>('room:spectate', { code });
    expect(r.role).toBe('spectator');
    const seen = await fan.waitFor((v) => v.code === code && (v.auction?.lot !== null || v.phase === 'PLAYER_SOLD'));
    expect(seen.members.map((m) => m.username).sort()).toEqual(['Player1', 'Player2']);
    await p1.waitFor((v) => v.spectators === 1);

    const lot = (await fan.waitFor((v) => !!v.auction?.lot)).auction!.lot!;
    const bid = await fan.emit('auction:bid', { lotNumber: lot.lotNumber, amount: 500 });
    expect(bid.ok).toBe(false);
    const join = await fan.emit('room:join', { code });
    expect(join.ok).toBe(false); // can't join a game in progress

    // Squad building: spectators see lock status but no lineups.
    const building = await fan.waitFor((v) => v.phase === 'SQUAD_BUILDING' || v.phase === 'RESULTS', 60_000);
    if (building.phase === 'SQUAD_BUILDING') {
      expect(building.squadBuilding!.mine).toBeNull();
      expect(building.lineups).toBeNull();
    }
    const results = await fan.waitFor((v) => v.phase === 'RESULTS', 30_000);
    expect(results.results!.rankings).toHaveLength(2);

    await fan.must('room:leave');
    await p1.waitFor((v) => v.spectators === 0);
    for (const b of [p1, p2, fan]) b.disconnect();
  }, 90_000);

  it('rejoining an old game detaches you from your other room (no ghost members)', async () => {
    const [a, b, c] = await Promise.all(
      ['GhostA', 'GhostB', 'GhostC'].map(async (n) => (await new Bot(base, n, { aggression: 0 }).login()).connect()),
    );
    const { code: x } = await a.must<{ code: string }>('room:create', roomInput);
    await b.must('room:join', { code: x });
    await b.must('room:ready', { ready: true });
    await a.must('room:start');
    await a.waitFor((v) => v.phase === 'AUCTION');

    await a.must('room:leave'); // walk out of the live game
    const { code: lobby } = await a.must<{ code: string }>('room:create', { ...roomInput, isPublic: true });
    await a.must('room:join', { code: x }); // and come back

    const lobbies = (await (await fetch(`${base}/api/rooms/public`)).json()).rooms as { code: string }[];
    expect(lobbies.some((r) => r.code === lobby)).toBe(false); // the lobby was left (and closed), not haunted

    // While playing a live game you can't wander off to watch another one.
    const { code: other } = await c.must<{ code: string }>('room:create', { ...roomInput, isPublic: true });
    const watch = await a.emit('room:spectate', { code: other });
    expect(watch.ok).toBe(false);
    if (!watch.ok) expect(watch.code).toBe('ALREADY_IN_GAME');
    for (const bot of [a, b, c]) bot.disconnect();
  });

  it('room chat: players talk, spectators read, input is cleaned and rate-limited', async () => {
    const [p1, p2, fan] = await Promise.all(
      ['ChatA', 'ChatB', 'ChatFan'].map(async (n) => (await new Bot(base, n, { aggression: 0 }).login()).connect()),
    );
    const { code } = await p1.must<{ code: string }>('room:create', { ...roomInput, isPublic: true });
    await p2.must('room:join', { code });
    await fan.must('room:spectate', { code });

    const heard = (bot: Bot) =>
      new Promise<{ text: string; username: string; code: string }>((res) => bot.socket.once('room:chat', res));
    const p2Hears = heard(p2);
    const fanHears = heard(fan);
    await p1.must('chat:send', { text: '  gl   hf\n everyone  ' });
    expect(await p2Hears).toMatchObject({ text: 'gl hf everyone', username: 'ChatA', code });
    expect((await fanHears).text).toBe('gl hf everyone');

    const spectatorPost = await fan.emit('chat:send', { text: 'hi' });
    expect(spectatorPost.ok).toBe(false);
    if (!spectatorPost.ok) expect(spectatorPost.code).toBe('CHAT_SPECTATOR');
    const empty = await p2.emit('chat:send', { text: '    ' });
    expect(empty.ok).toBe(false);

    const history = await p2.must<{ messages: { text: string }[] }>('chat:history');
    expect(history.messages.map((m) => m.text)).toEqual(['gl hf everyone']);

    // Spam gets cut off.
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => p2.emit('chat:send', { text: `spam ${i}` })));
    expect(results.some((r) => !r.ok && r.code === 'RATE_LIMITED')).toBe(true);
    for (const b of [p1, p2, fan]) b.disconnect();
  });

  it('a Blitz game with every twist on, then the cup, ends with a champion and sound squads', async () => {
    const bots = await Promise.all(
      ['TwistA', 'TwistB', 'TwistC', 'TwistD'].map(async (n) => (await new Bot(base, n, { aggression: 0.75, cardiness: 0.9 }).login()).connect()),
    );
    const [host, ...rest] = bots;
    const { code } = await host.must<{ code: string }>('room:create', { ...roomInput, format: 'BLITZ', twists: { ...ALL_TWISTS } });
    for (const b of rest) {
      await b.must('room:join', { code });
      await b.must('room:ready', { ready: true });
    }
    await host.waitFor((v) => v.members.length === 4 && v.members.every((m) => m.ready));
    await host.must('room:start');
    const kinds = new Set<string>();
    const markets = new Set<string>();
    host.onState((v) => {
      if (v.auction?.lot) kinds.add(v.auction.lot.kind);
      if (v.auction?.market) markets.add(v.auction.market.id);
    });
    // A client that misses a patch asks for a full snapshot and carries on.
    await host.waitFor((v) => v.phase === 'AUCTION');
    rest[0].state = { ...rest[0].state!, version: -1 };
    await rest[0].waitFor((v) => v.version > 0, 10_000);
    const cup = await host.waitFor((v) => v.phase === 'TOURNAMENT', 120_000);
    expect(cup.tournament!.rounds).toEqual(['Semi-finals', 'Final']);
    const done = await host.waitFor((v) => v.phase === 'RESULTS', 60_000);
    const t = done.tournament!;
    expect(t.championId).toBe(done.results!.rankings[0].userId);
    expect(t.matches.every((m) => m.status === 'FINISHED')).toBe(true);
    expect(t.matches).toHaveLength(3);
    expect(done.results!.rankings[0].cupFinish).toBe('Champion');
    const ids = new Set<string>();
    for (const m of done.members) {
      expect(m.squad).toHaveLength(11);
      expect(m.budget).toBeGreaterThanOrEqual(0);
      for (const e of m.squad) {
        expect(ids.has(e.player.id)).toBe(false);
        ids.add(e.player.id);
      }
    }
    expect(kinds.has('SEALED')).toBe(true);
    expect(kinds.has('MYSTERY')).toBe(true);
    expect(markets.size).toBeGreaterThan(0);
    expect(bots.flatMap((b) => b.played).some((p) => p.startsWith('talk:'))).toBe(true);
    expect(bots.flatMap((b) => b.errors).filter((e) => e !== 'RATE_LIMITED')).toEqual([]);
    // Everyone followed the whole game from patches: their copy matches a fresh full snapshot.
    await new Promise((r) => setTimeout(r, 500));
    for (const b of bots) {
      const before = b.state!;
      const patched = JSON.parse(JSON.stringify(before));
      await b.must('room:sync', { code });
      await b.waitFor((v) => v !== before);
      const { serverTime: _a, ...fresh } = JSON.parse(JSON.stringify(b.state));
      const { serverTime: _b, ...mine } = patched;
      expect(mine).toEqual(fresh);
    }
    for (const b of bots) b.disconnect();
  }, 200_000);

  it('a snake draft: picks go round in order, then back the other way', async () => {
    const bots = await Promise.all(
      ['DraftA', 'DraftB', 'DraftC'].map(async (n) => (await new Bot(base, n, { aggression: 0 }).login()).connect()),
    );
    const [host, ...rest] = bots;
    const { code } = await host.must<{ code: string }>('room:create', { ...roomInput, format: 'DRAFT' });
    for (const b of rest) {
      await b.must('room:join', { code });
      await b.must('room:ready', { ready: true });
    }
    await host.waitFor((v) => v.members.length === 3 && v.members.every((m) => m.ready));
    const pickers: string[] = [];
    host.onState((v) => {
      const d = v.auction?.draft;
      if (d && pickers.length < d.pick) pickers[d.pick - 1] = d.userId;
    });
    await host.must('room:start');
    const built = await host.waitFor((v) => v.phase === 'SQUAD_BUILDING', 60_000);
    // Round 1 one way, round 2 the other.
    expect(pickers.slice(3, 6)).toEqual(pickers.slice(0, 3).reverse());
    expect(new Set(pickers.slice(0, 3)).size).toBe(3);
    for (const m of built.members) {
      expect(m.squad).toHaveLength(18);
      expect(m.squad.every((e) => e.price === 0)).toBe(true);
      expect(m.budget).toBe(1000);
    }
    const done = await host.waitFor((v) => v.phase === 'RESULTS', 60_000);
    expect(done.results!.rankings).toHaveLength(3);
    expect(bots.flatMap((b) => b.errors)).toEqual([]);
    for (const b of bots) b.disconnect();
  }, 120_000);

  it('creating Blitz and Budget Cap rooms from the normal form: the server sets their timer and budget', async () => {
    const bot = await (await new Bot(base, 'FormatHost', { aggression: 0 }).login()).connect();
    await bot.must('room:create', { ...roomInput, format: 'BLITZ', lotDurationSec: 30 });
    let v = await bot.waitFor((x) => x.settings.format === 'BLITZ');
    expect(v.settings.lotDurationSec).toBe(10);
    expect(v.rules.squadSize).toBe(11);
    await bot.must('room:leave');
    await bot.must('room:create', { ...roomInput, format: 'BUDGET', startingBudget: 1500 });
    v = await bot.waitFor((x) => x.settings.format === 'BUDGET');
    expect(v.settings.startingBudget).toBe(50);
    expect(v.rules.maxPrice).toBe(5);
    await bot.must('room:leave');
    await bot.must('room:create', { ...roomInput, format: 'DRAFT', twists: { mystery: true, sealed: true, events: true, cards: true } });
    v = await bot.waitFor((x) => x.settings.format === 'DRAFT');
    expect(Object.values(v.settings.twists).some(Boolean)).toBe(false);
    const ranked = await bot.emit('room:create', { ...roomInput, mode: 'RANKED', format: 'BLITZ' });
    expect(ranked.ok).toBe(false);
    if (!ranked.ok) expect(ranked.code).toBe('RANKED_SETTINGS');
    bot.disconnect();
  });
});

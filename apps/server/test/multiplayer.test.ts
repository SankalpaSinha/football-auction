import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeRules, validateLineup } from '@fa/shared';
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
    rules: makeRules({ startCountdownMs: 50, soldRevealMs: 15, unsoldRevealMs: 10 }),
    corsOrigins: true,
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
};

describe('multiplayer over websockets', () => {
  it('rejects duplicate usernames (case-insensitive)', async () => {
    await new Bot(base, 'Dupe').login();
    await expect(new Bot(base, 'dUPE').login()).rejects.toThrow(/taken/);
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
    const ids = new Set<string>();
    for (const m of final.members) {
      expect(m.squad).toHaveLength(15);
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
});

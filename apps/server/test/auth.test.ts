import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeRules } from '@fa/shared';
import { createApp } from '../src/app';
import { InMemoryCatalog } from '../src/data/catalog';
import { systemClock } from '../src/engine/clock';
import { NoopGameStore } from '../src/engine/store';
import { hashPassword, MemoryUserStore, verifyPassword } from '../src/services/users';

let server: ReturnType<typeof createApp>;
let base = '';
const users = new MemoryUserStore();

beforeAll(async () => {
  server = createApp({
    catalog: new InMemoryCatalog({ seasons: [], competitions: [], players: [] }),
    users,
    store: new NoopGameStore(),
    clock: systemClock,
    rules: makeRules(),
    corsOrigins: true,
  });
  base = `http://localhost:${await server.listen(0)}`;
});
afterAll(() => server?.close());

const post = (path: string, body: unknown, token?: string) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const me = (token: string) => fetch(`${base}/api/session`, { headers: { authorization: `Bearer ${token}` } });

describe('accounts', () => {
  it('hashes passwords with scrypt and verifies them', async () => {
    const h = await hashPassword('secret123');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(h).not.toContain('secret123');
    expect(await verifyPassword('secret123', h)).toBe(true);
    expect(await verifyPassword('secret124', h)).toBe(false);
  });

  it('registers, rejects duplicate names case-insensitively, and validates input', async () => {
    const r = await post('/api/auth/register', { username: 'Messi10', password: 'goat1234' });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.user.username).toBe('Messi10');
    expect(typeof body.token).toBe('string');
    expect((await post('/api/auth/register', { username: 'messi10', password: 'other123' })).status).toBe(409);
    expect((await post('/api/auth/register', { username: 'ab', password: 'goat1234' })).status).toBe(400);
    expect((await post('/api/auth/register', { username: 'Shorty', password: '123' })).status).toBe(400);
  });

  it('signs in from several devices; each session is independent', async () => {
    await post('/api/auth/register', { username: 'JaiFC', password: 'pitch-perfect' });
    const bad = await post('/api/auth/login', { username: 'JaiFC', password: 'wrong-one' });
    expect(bad.status).toBe(401);
    const laptop = (await (await post('/api/auth/login', { username: 'jaifc', password: 'pitch-perfect' })).json()).token;
    const phone = (await (await post('/api/auth/login', { username: 'JaiFC', password: 'pitch-perfect' })).json()).token;
    expect(laptop).not.toBe(phone);
    expect((await me(laptop)).status).toBe(200);
    expect((await me(phone)).status).toBe(200);
    await post('/api/auth/logout', {}, phone);
    expect((await me(phone)).status).toBe(401);
    expect((await me(laptop)).status).toBe(200);
  });

  it('unknown usernames get the same error as wrong passwords', async () => {
    const r = await post('/api/auth/login', { username: 'NobodyHere', password: 'whatever1' });
    expect(r.status).toBe(401);
    expect((await r.json()).code).toBe('INVALID_CREDENTIALS');
  });

  it('a legacy account without a password is claimed by setting one', async () => {
    const legacy = await users.create('OldTimer', null as unknown as string);
    await users.setPassword(legacy.id, null as unknown as string);
    const claim = await post('/api/auth/login', { username: 'OldTimer', password: 'new-pass-1' });
    expect(claim.status).toBe(200);
    expect((await claim.json()).claimed).toBe(true);
    expect((await post('/api/auth/login', { username: 'OldTimer', password: 'different' })).status).toBe(401);
    expect((await post('/api/auth/login', { username: 'OldTimer', password: 'new-pass-1' })).status).toBe(200);
  });

  it('rate-limits repeated failed sign-ins', async () => {
    await post('/api/auth/register', { username: 'Target', password: 'correct-horse' });
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await post('/api/auth/login', { username: 'Target', password: `guess${i}xx` })).status;
    expect(last).toBe(429);
  });
});

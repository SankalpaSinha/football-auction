import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { SessionUser } from '@fa/shared';
import type { Db } from '../lib/db';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

// ------------------------------------------------------------- passwords

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------- errors

export class UsernameTakenError extends Error {
  constructor() {
    super('USERNAME_TAKEN');
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super('INVALID_CREDENTIALS');
  }
}

// ----------------------------------------------------------------- store

export interface StoredUser extends SessionUser {
  passwordHash: string | null;
}

/**
 * Accounts (unique username + password) and per-device sessions. The browser
 * keeps a random session token; only its hash is stored.
 */
export interface UserStore {
  findByUsername(username: string): Promise<StoredUser | null>;
  create(username: string, passwordHash: string): Promise<SessionUser>;
  setPassword(userId: string, passwordHash: string): Promise<void>;
  createSession(userId: string): Promise<string>;
  findByToken(token: string): Promise<SessionUser | null>;
  deleteSession(token: string): Promise<void>;
  touch(userId: string): Promise<void>;
}

export class MemoryUserStore implements UserStore {
  private users = new Map<string, StoredUser>();
  private byKey = new Map<string, string>();
  private sessions = new Map<string, string>();
  private seq = 0;

  async findByUsername(username: string) {
    const id = this.byKey.get(username.toLowerCase());
    return id ? { ...this.users.get(id)! } : null;
  }

  async create(username: string, passwordHash: string) {
    const key = username.toLowerCase();
    if (this.byKey.has(key)) throw new UsernameTakenError();
    const user = { id: `u${++this.seq}`, username, passwordHash };
    this.users.set(user.id, user);
    this.byKey.set(key, user.id);
    return { id: user.id, username };
  }

  async setPassword(userId: string, passwordHash: string) {
    const u = this.users.get(userId);
    if (u) u.passwordHash = passwordHash;
  }

  async createSession(userId: string) {
    const token = newToken();
    this.sessions.set(hashToken(token), userId);
    return token;
  }

  async findByToken(token: string) {
    const id = this.sessions.get(hashToken(token));
    const u = id ? this.users.get(id) : undefined;
    return u ? { id: u.id, username: u.username } : null;
  }

  async deleteSession(token: string) {
    this.sessions.delete(hashToken(token));
  }

  async touch() {}
}

export class PrismaUserStore implements UserStore {
  constructor(private readonly db: Db) {}

  async findByUsername(username: string) {
    return this.db.user.findUnique({
      where: { usernameKey: username.toLowerCase() },
      select: { id: true, username: true, passwordHash: true },
    });
  }

  async create(username: string, passwordHash: string) {
    try {
      return await this.db.user.create({
        data: { username, usernameKey: username.toLowerCase(), passwordHash },
        select: { id: true, username: true },
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new UsernameTakenError();
      throw e;
    }
  }

  async setPassword(userId: string, passwordHash: string) {
    await this.db.user.update({ where: { id: userId }, data: { passwordHash } });
  }

  async createSession(userId: string) {
    const token = newToken();
    await this.db.session.create({ data: { userId, tokenHash: hashToken(token) } });
    return token;
  }

  async findByToken(token: string) {
    const s = await this.db.session.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { user: { select: { id: true, username: true } } },
    });
    return s?.user ?? null;
  }

  async deleteSession(token: string) {
    await this.db.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }

  async touch(userId: string) {
    await this.db.user.update({ where: { id: userId }, data: { lastSeenAt: new Date() } });
  }
}

// --------------------------------------------------------------- service

/**
 * Register / sign in. Accounts created before passwords existed (no hash) are
 * claimed by the first person who signs in with that name and sets a password.
 */
export async function register(users: UserStore, username: string, password: string) {
  const user = await users.create(username, await hashPassword(password));
  return { user, token: await users.createSession(user.id) };
}

export async function login(users: UserStore, username: string, password: string) {
  const stored = await users.findByUsername(username);
  if (!stored) {
    // Spend comparable time so response timing doesn't reveal which names exist.
    await hashPassword(password);
    throw new InvalidCredentialsError();
  }
  let claimed = false;
  if (stored.passwordHash === null) {
    await users.setPassword(stored.id, await hashPassword(password));
    claimed = true;
  } else if (!(await verifyPassword(password, stored.passwordHash))) {
    throw new InvalidCredentialsError();
  }
  const user = { id: stored.id, username: stored.username };
  return { user, token: await users.createSession(user.id), claimed };
}

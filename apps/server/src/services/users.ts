import { createHash, randomBytes } from 'node:crypto';
import type { SessionUser } from '@fa/shared';
import type { Db } from '../lib/db';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

export class UsernameTakenError extends Error {
  constructor() {
    super('USERNAME_TAKEN');
  }
}

/**
 * MVP identity: a unique username bound to a random session token kept in the
 * browser. Swappable for real accounts later without touching game code.
 */
export interface UserStore {
  findByToken(token: string): Promise<SessionUser | null>;
  create(username: string, token: string): Promise<SessionUser>;
  touch(userId: string): Promise<void>;
}

export class MemoryUserStore implements UserStore {
  private byHash = new Map<string, SessionUser>();
  private keys = new Set<string>();
  private seq = 0;

  async findByToken(token: string) {
    return this.byHash.get(hashToken(token)) ?? null;
  }

  async create(username: string, token: string) {
    const key = username.toLowerCase();
    if (this.keys.has(key)) throw new UsernameTakenError();
    const user = { id: `u${++this.seq}`, username };
    this.keys.add(key);
    this.byHash.set(hashToken(token), user);
    return user;
  }

  async touch() {}
}

export class PrismaUserStore implements UserStore {
  constructor(private readonly db: Db) {}

  async findByToken(token: string) {
    const u = await this.db.user.findUnique({
      where: { sessionTokenHash: hashToken(token) },
      select: { id: true, username: true },
    });
    return u;
  }

  async create(username: string, token: string) {
    try {
      return await this.db.user.create({
        data: { username, usernameKey: username.toLowerCase(), sessionTokenHash: hashToken(token) },
        select: { id: true, username: true },
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new UsernameTakenError();
      throw e;
    }
  }

  async touch(userId: string) {
    await this.db.user.update({ where: { id: userId }, data: { lastSeenAt: new Date() } });
  }
}

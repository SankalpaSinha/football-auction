import type { CompetitionSummary, GameRules, SessionUser } from '@fa/shared';
import { serverUrl } from './config';

const TOKEN_KEY = 'fa.session';

export interface StoredSession {
  user: SessionUser;
  token: string;
}

export function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: StoredSession | null) {
  try {
    if (s) localStorage.setItem(TOKEN_KEY, JSON.stringify(s));
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable — session lasts for this tab only */
  }
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${serverUrl()}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError('OFFLINE', 'Cannot reach the game server.', 0);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.code ?? 'ERROR', body.error ?? 'Request failed', res.status);
  return body as T;
}

export const api = {
  register: (username: string, password: string) =>
    request<StoredSession>('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) }),
  login: (username: string, password: string) =>
    request<StoredSession & { claimed?: boolean }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: (token: string) => request<{ ok: true }>('/api/auth/logout', { method: 'POST', body: '{}', token }),
  me: (token: string) => request<{ user: SessionUser; activeRoom: string | null }>('/api/session', { token }),
  competitions: () => request<{ competitions: CompetitionSummary[]; rules: GameRules }>('/api/competitions'),
  room: (code: string) =>
    request<{ code: string; name: string; phase: string; members: number; maxPlayers: number; competition: { name: string } }>(
      `/api/rooms/${encodeURIComponent(code)}`,
    ),
};

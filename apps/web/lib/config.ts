/**
 * Where the game server lives.
 * - NEXT_PUBLIC_SERVER_URL wins if set (separate deployments).
 * - Production builds default to the same origin (the game server serves the site).
 * - Development defaults to <current host>:4000 so LAN devices work.
 */
export function serverUrl(): string {
  if (process.env.NEXT_PUBLIC_SERVER_URL) return process.env.NEXT_PUBLIC_SERVER_URL;
  if (typeof window === 'undefined') return 'http://localhost:4000';
  if (process.env.NODE_ENV === 'production') return window.location.origin;
  return `${window.location.protocol}//${window.location.hostname}:4000`;
}

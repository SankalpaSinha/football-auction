'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { api, saveSession } from '@/lib/api';
import { disconnectSocket } from '@/lib/socket';
import { useGame } from '@/lib/store';
import { Avatar, Logo, SoundToggle } from './ui';

/** Top navigation for the non-game pages. */
export function SiteHeader() {
  const session = useGame((s) => s.session);
  const setSession = useGame((s) => s.setSession);
  const path = usePathname();
  const links = [
    { href: '/', label: 'Play' },
    { href: '/leaderboard', label: 'Leaderboard' },
    ...(session ? [{ href: `/u/${session.user.username}`, label: 'Profile' }] : []),
  ];
  return (
    <header className="flex h-16 items-center gap-4">
      <Logo />
      <nav className="ml-2 hidden items-center gap-1 sm:flex">
        {links.map((l) => {
          const active = l.href === '/' ? path === '/' : path?.startsWith(l.href);
          return (
            <Link
              key={l.href}
              href={l.href}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${active ? 'bg-white/10 text-ink' : 'text-muted hover:text-ink'}`}
            >
              {l.label}
            </Link>
          );
        })}
      </nav>
      <div className="ml-auto flex items-center gap-2">
        {session && (
          <div className="flex items-center gap-2">
            <Link href={`/u/${session.user.username}`} className="flex items-center gap-2 rounded-xl px-1 py-1 hover:bg-white/5">
              <Avatar name={session.user.username} size={28} />
              <span className="hidden text-sm font-semibold md:inline">{session.user.username}</span>
            </Link>
            <button
              className="text-xs text-dim hover:text-ink"
              onClick={() => {
                void api.logout(session.token).catch(() => {});
                disconnectSocket();
                saveSession(null);
                setSession(null);
              }}
            >
              Sign out
            </button>
          </div>
        )}
        <SoundToggle />
      </div>
    </header>
  );
}

/** Compact nav for phones (shown under the header). */
export function MobileNav() {
  const session = useGame((s) => s.session);
  const path = usePathname();
  const links = [
    { href: '/', label: 'Play' },
    { href: '/leaderboard', label: 'Leaderboard' },
    ...(session ? [{ href: `/u/${session.user.username}`, label: 'Profile' }] : []),
  ];
  return (
    <nav className="mb-4 flex gap-1 sm:hidden">
      {links.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className={`flex-1 rounded-lg py-2 text-center text-xs font-bold uppercase tracking-wider ${
            (l.href === '/' ? path === '/' : path?.startsWith(l.href)) ? 'bg-white/10 text-ink' : 'bg-white/[.03] text-muted'
          }`}
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}

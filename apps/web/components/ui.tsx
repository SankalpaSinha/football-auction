'use client';
import Link from 'next/link';
import { forwardRef } from 'react';
import { useGame, type ConnectionState } from '@/lib/store';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export const Button = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md' | 'lg' }
>(function Button({ variant = 'primary', size = 'md', className = '', ...props }, ref) {
  const base =
    'relative inline-flex select-none items-center justify-center gap-2 font-semibold uppercase tracking-wider transition active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100';
  const sizes = { sm: 'h-9 px-3 text-xs rounded-lg', md: 'h-11 px-5 text-sm rounded-xl', lg: 'h-14 px-7 text-base rounded-2xl' };
  const variants: Record<ButtonVariant, string> = {
    primary:
      'bg-volt text-night shadow-[0_0_0_1px_rgba(200,255,46,.4),0_10px_30px_-10px_rgba(200,255,46,.6)] hover:brightness-110',
    secondary: 'glass text-ink hover:bg-white/10',
    ghost: 'text-muted hover:text-ink hover:bg-white/5',
    danger: 'bg-danger/15 text-rose-200 border border-danger/40 hover:bg-danger/25',
  };
  return <button ref={ref} className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} {...props} />;
});

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="group inline-flex items-center gap-2.5">
      <svg viewBox="0 0 40 40" className="h-8 w-8 drop-shadow-[0_0_12px_rgba(200,255,46,.35)]" aria-hidden>
        <defs>
          <linearGradient id="lg" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="#c8ff2e" />
            <stop offset="1" stopColor="#2ee6ff" />
          </linearGradient>
        </defs>
        <path d="M4 8 L28 8 L36 16 L36 32 L12 32 L4 24 Z" fill="none" stroke="url(#lg)" strokeWidth="2.5" />
        <circle cx="20" cy="20" r="6.5" fill="url(#lg)" />
        <path d="M20 13.5 L20 26.5 M13.5 20 L26.5 20" stroke="#05070d" strokeWidth="1.6" />
      </svg>
      {!compact && (
        <span className="display text-xl font-extrabold leading-none tracking-wide">
          Football<span className="text-volt"> Auction</span>
        </span>
      )}
    </Link>
  );
}

export function Avatar({ name, size = 36, ring }: { name: string; size?: number; ring?: string }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    <div
      className="grid shrink-0 place-items-center rounded-xl font-bold text-night"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: `linear-gradient(135deg, hsl(${h} 90% 70%), hsl(${(h + 50) % 360} 85% 55%))`,
        boxShadow: ring ? `0 0 0 2px ${ring}` : undefined,
      }}
    >
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}

export function ConnectionDot({ connected }: { connected: boolean }) {
  return (
    <span className="relative inline-flex h-2.5 w-2.5">
      {connected && <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/50" />}
      <span className={`relative h-2.5 w-2.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-zinc-500'}`} />
    </span>
  );
}

const CONNECTION_TEXT: Record<ConnectionState, string | null> = {
  idle: null,
  connected: null,
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  replaced: 'Opened in another tab',
  error: 'Session expired',
};

export function ConnectionBanner() {
  const c = useGame((s) => s.connection);
  const text = CONNECTION_TEXT[c];
  if (!text) return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full border border-amber/40 bg-amber/15 px-4 py-1.5 text-xs font-semibold text-amber-100 backdrop-blur-xl">
      <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-amber" />
      {text}
    </div>
  );
}

export function SoundToggle() {
  const on = useGame((s) => s.soundOn);
  const set = useGame((s) => s.setSound);
  return (
    <button
      onClick={() => set(!on)}
      className="grid h-9 w-9 place-items-center rounded-lg text-muted transition hover:bg-white/5 hover:text-ink"
      title={on ? 'Sound on' : 'Sound off'}
      aria-label={on ? 'Mute sound' : 'Unmute sound'}
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M11 5 6 9H3v6h3l5 4V5z" fill="currentColor" stroke="none" />
        {on ? (
          <>
            <path d="M15.5 8.5a5 5 0 0 1 0 7" />
            <path d="M18.5 5.5a9 9 0 0 1 0 13" />
          </>
        ) : (
          <path d="m16 9 6 6m0-6-6 6" />
        )}
      </svg>
    </button>
  );
}

export function Pill({ children, color, className = '' }: { children: React.ReactNode; color?: string; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider ${className}`}
      style={color ? { borderColor: `${color}66`, background: `${color}1f`, color } : undefined}
    >
      {children}
    </span>
  );
}

export function Coin({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden>
      <circle cx="10" cy="10" r="9" fill="#f5c542" />
      <circle cx="10" cy="10" r="6.5" fill="none" stroke="#a16207" strokeWidth="1.4" />
      <path d="M8 6.5h3.2a1.9 1.9 0 0 1 0 3.8H8m0 0h3.6a1.9 1.9 0 0 1 0 3.8H8V6.5" fill="none" stroke="#a16207" strokeWidth="1.4" />
    </svg>
  );
}

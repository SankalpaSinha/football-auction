'use client';
import { useState } from 'react';
import { USERNAME_RE } from '@fa/shared';
import { api, ApiError, saveSession } from '@/lib/api';
import { useGame } from '@/lib/store';
import { Button } from './ui';

type Mode = 'login' | 'register';

/** Sign in or create an account (unique username + password). */
export function UsernameGate({ onDone, autoFocus = true }: { onDone?: () => void; autoFocus?: boolean }) {
  const setSession = useGame((s) => s.setSession);
  const toast = useGame((s) => s.toast);
  const [mode, setMode] = useState<Mode>('login');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameOk = USERNAME_RE.test(name.trim());
  const pwOk = password.length >= 6 && password.length <= 72;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!nameOk || !pwOk || busy) return;
    setBusy(true);
    setError(null);
    try {
      const s = mode === 'login' ? await api.login(name.trim(), password) : await api.register(name.trim(), password);
      saveSession({ user: s.user, token: s.token });
      setSession({ user: s.user, token: s.token });
      if ('claimed' in s && s.claimed) toast('success', `Password set — ${s.user.username} is now yours on any device.`);
      onDone?.();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'USERNAME_TAKEN') {
        setError('That username is taken. If it’s yours, sign in instead.');
      } else {
        setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      }
    } finally {
      setBusy(false);
    }
  }

  const input =
    'glass h-14 w-full rounded-2xl px-5 text-lg font-semibold outline-none ring-volt/60 placeholder:text-dim placeholder:font-normal focus:ring-2';

  return (
    <form onSubmit={submit} className="w-full max-w-md">
      <div className="mb-4 inline-flex rounded-xl bg-white/[.05] p-1">
        {(['login', 'register'] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m);
              setError(null);
            }}
            className={`h-9 rounded-lg px-4 text-sm font-bold uppercase tracking-wider transition ${
              mode === m ? 'bg-volt text-night' : 'text-muted hover:text-ink'
            }`}
          >
            {m === 'login' ? 'Sign in' : 'Create account'}
          </button>
        ))}
      </div>

      <div className="space-y-2.5">
        <input
          aria-label="Username"
          id="username"
          autoFocus={autoFocus}
          autoComplete="username"
          spellCheck={false}
          maxLength={16}
          value={name}
          onChange={(e) => {
            setName(e.target.value.replace(/\s/g, ''));
            setError(null);
          }}
          placeholder="Username"
          className={input}
        />
        <input
          aria-label="Password"
          id="password"
          type="password"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          maxLength={72}
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setError(null);
          }}
          placeholder={mode === 'login' ? 'Password' : 'Choose a password (6+ characters)'}
          className={input}
        />
      </div>

      <Button type="submit" size="lg" className="mt-3 w-full" disabled={!nameOk || !pwOk || busy}>
        {busy ? '…' : mode === 'login' ? 'Sign in & play' : 'Create account & play'}
      </Button>

      <p className={`mt-2 text-sm ${error ? 'text-rose-300' : 'text-dim'}`}>
        {error ??
          (mode === 'login'
            ? 'New here? Tap “Create account” — it takes ten seconds.'
            : '3–16 characters · letters, numbers, underscore · unique')}
      </p>
    </form>
  );
}

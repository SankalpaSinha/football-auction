'use client';
import { useState } from 'react';
import { USERNAME_RE } from '@fa/shared';
import { api, ApiError, saveSession } from '@/lib/api';
import { useGame } from '@/lib/store';
import { Button } from './ui';

export function UsernameGate({ onDone, autoFocus = true }: { onDone?: () => void; autoFocus?: boolean }) {
  const setSession = useGame((s) => s.setSession);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = USERNAME_RE.test(name.trim());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const s = await api.claimUsername(name.trim());
      saveSession(s);
      setSession(s);
      onDone?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full max-w-md">
      <label className="label mb-2 block" htmlFor="username">
        Choose your manager name
      </label>
      <div className="flex gap-2">
        <input
          id="username"
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
          maxLength={16}
          value={name}
          onChange={(e) => {
            setName(e.target.value.replace(/\s/g, ''));
            setError(null);
          }}
          placeholder="e.g. FootballKing"
          className="glass h-14 min-w-0 flex-1 rounded-2xl px-5 text-lg font-semibold outline-none ring-volt/60 placeholder:text-dim focus:ring-2"
        />
        <Button type="submit" size="lg" disabled={!valid || busy}>
          {busy ? '…' : 'Play'}
        </Button>
      </div>
      <p className={`mt-2 text-sm ${error ? 'text-rose-300' : 'text-dim'}`}>
        {error ?? '3–16 characters · letters, numbers, underscore · must be unique'}
      </p>
    </form>
  );
}

'use client';
import Link from 'next/link';
import { useEffect } from 'react';

/** Any page that crashes while rendering lands here instead of a blank screen. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="text-5xl">🟥</div>
      <h1 className="display text-4xl font-extrabold">Something went wrong</h1>
      <p className="text-muted">That screen hit an unexpected error. Your game is still running on the server — try again.</p>
      <div className="flex gap-2">
        <button onClick={reset} className="h-11 rounded-xl bg-volt px-5 text-sm font-semibold uppercase tracking-wider text-night">
          Try again
        </button>
        <Link href="/" className="grid h-11 place-items-center rounded-xl border border-white/10 px-5 text-sm font-semibold uppercase tracking-wider">
          Home
        </Link>
      </div>
    </main>
  );
}

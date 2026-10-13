import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="display text-7xl font-extrabold text-volt">404</div>
      <h1 className="display text-3xl font-extrabold">Offside</h1>
      <p className="text-muted">That page doesn’t exist.</p>
      <Link href="/" className="grid h-11 place-items-center rounded-xl bg-volt px-5 text-sm font-semibold uppercase tracking-wider text-night">
        Back to the game
      </Link>
    </main>
  );
}

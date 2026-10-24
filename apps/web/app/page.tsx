'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion } from 'motion/react';
import { ROOM_CODE_RE } from '@fa/shared';
import { CreateRoom } from '@/components/CreateRoom';
import { LiveGames, PlayNow, PublicRooms } from '@/components/Matchmaking';
import { MobileNav, SiteHeader } from '@/components/SiteHeader';
import { UsernameGate } from '@/components/UsernameGate';
import { Button } from '@/components/ui';
import { api, saveSession } from '@/lib/api';
import { useGame } from '@/lib/store';

export default function Home() {
  const session = useGame((s) => s.session);
  const loaded = useGame((s) => s.sessionLoaded);
  const setSession = useGame((s) => s.setSession);
  const [activeRoom, setActiveRoom] = useState<string | null>(null);

  // Validate the stored session; a wiped database means claiming a name again.
  useEffect(() => {
    if (!session) return;
    api
      .me(session.token)
      .then((r) => setActiveRoom(r.activeRoom))
      .catch((e) => {
        if (e.status === 401) {
          saveSession(null);
          setSession(null);
        }
      });
  }, [session, setSession]);

  return (
    <main className="mx-auto min-h-dvh max-w-6xl px-4 pb-16 sm:px-6">
      <SiteHeader />
      {session && <MobileNav />}

      {!loaded ? null : !session ? (
        <Hero />
      ) : (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="mt-6">
          <div className="mb-8">
            <p className="label">Matchday</p>
            <h1 className="display text-4xl font-extrabold sm:text-5xl">
              Welcome, <span className="text-volt">{session.user.username}</span>
            </h1>
          </div>

          {activeRoom && (
            <Link
              href={`/room/${activeRoom}`}
              className="mb-6 flex items-center justify-between rounded-2xl border border-volt/40 bg-volt/10 px-5 py-4 transition hover:bg-volt/15"
            >
              <span className="font-semibold">
                You have a room in progress — <span className="font-mono text-volt">{activeRoom}</span>
              </span>
              <span className="display font-bold text-volt">Rejoin →</span>
            </Link>
          )}

          <PlayNow />
          <PublicRooms />
          <LiveGames />

          <div className="mt-8 grid gap-6 lg:grid-cols-[1.6fr_1fr]">
            <CreateRoom />
            <div className="flex flex-col gap-6">
              <JoinRoom />
              <HowItWorks />
            </div>
          </div>
        </motion.div>
      )}
    </main>
  );
}

function Hero() {
  return (
    <section className="grid min-h-[78dvh] items-center gap-10 lg:grid-cols-[1.15fr_1fr]">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
        <p className="label mb-3 text-volt">Live multiplayer · 2–6 managers</p>
        <h1 className="display text-6xl font-extrabold leading-[0.9] sm:text-7xl lg:text-8xl">
          Bid.
          <br />
          Build.
          <br />
          <span className="bg-gradient-to-r from-volt to-cyan bg-clip-text text-transparent">Outsmart.</span>
        </h1>
        <p className="mt-6 max-w-lg text-lg text-muted">
          Every manager gets the same budget. Every star goes under the hammer once. Build an 18-man squad that wins on football
          knowledge — not just on who spent the most.
        </p>
        <div className="mt-8">
          <UsernameGate />
        </div>
      </motion.div>
      <HeroCards />
    </section>
  );
}

function HeroCards() {
  return (
    <div className="relative hidden h-[520px] lg:block" aria-hidden>
      {[
        { r: -12, x: -10, y: 40, c: 'from-sky-400 to-blue-900', o: 84, p: 'CB' },
        { r: 9, x: 170, y: 70, c: 'from-violet-400 to-purple-950', o: 87, p: 'CM' },
        { r: -2, x: 70, y: 0, c: 'from-amber-300 to-amber-900', o: 91, p: 'ST' },
      ].map((card, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, y: 40, rotate: card.r }}
          animate={{ opacity: 1, y: card.y, rotate: card.r }}
          transition={{ delay: 0.2 + i * 0.15, type: 'spring', stiffness: 80 }}
          className="absolute"
          style={{ left: card.x }}
        >
          <div className={`cut-corners animate-float h-[400px] w-[280px] bg-gradient-to-br ${card.c} p-6 shadow-2xl`} style={{ animationDelay: `${i * 0.8}s` }}>
            <div className="display text-6xl font-extrabold text-white/90">{card.o}</div>
            <div className="display text-2xl font-bold text-white/70">{card.p}</div>
            <div className="absolute inset-x-6 bottom-6 space-y-2">
              <div className="h-5 w-2/3 rounded bg-white/25" />
              <div className="h-3 w-1/2 rounded bg-white/15" />
            </div>
          </div>
        </motion.div>
      ))}
      <motion.div
        initial={{ scale: 0, rotate: -20 }}
        animate={{ scale: 1, rotate: -12 }}
        transition={{ delay: 0.9, type: 'spring', stiffness: 200, damping: 12 }}
        className="display absolute right-4 top-6 rounded-lg border-4 border-danger px-5 py-1 text-5xl font-extrabold text-danger"
      >
        Sold!
      </motion.div>
    </div>
  );
}

function JoinRoom() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = ROOM_CODE_RE.test(code);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    try {
      await api.room(code);
      router.push(`/room/${code}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={go} className="glass cut-corners p-6">
      <p className="label text-cyan">Invited?</p>
      <h2 className="display text-3xl font-extrabold">Join a room</h2>
      <input
        value={code}
        onChange={(e) => {
          setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6));
          setError(null);
        }}
        placeholder="FBA7K2"
        autoComplete="off"
        spellCheck={false}
        className="mt-4 h-16 w-full rounded-2xl border border-white/10 bg-white/5 text-center font-mono text-3xl font-bold tracking-[0.4em] outline-none placeholder:text-white/15 focus:border-cyan/60"
      />
      {error && <p className="mt-2 text-sm text-rose-300">{error}</p>}
      <Button type="submit" variant="secondary" className="mt-4 w-full" disabled={!valid || busy}>
        {busy ? 'Checking…' : 'Join'}
      </Button>
    </form>
  );
}

function HowItWorks() {
  const steps = [
    ['Auction', 'One player at a time, 30 seconds, highest bid wins. Skip what you don’t want.'],
    ['Budget', 'Same coins for everyone. Finish with exactly 18, and no more than 3 stars rated 85+.'],
    ['Squad', 'Pick a formation, a tactic and your XI. Playstyles that click beat a pile of big names.'],
    ['Secrets', 'Everyone gets 2 hidden objectives worth bonus points, revealed at the end.'],
  ];
  return (
    <div className="px-1">
      <p className="label mb-3">How it works</p>
      <ol className="space-y-3">
        {steps.map(([t, d], i) => (
          <li key={t} className="flex gap-3">
            <span className="display grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white/5 font-bold text-volt">{i + 1}</span>
            <span className="text-sm text-muted">
              <span className="font-semibold text-ink">{t}.</span> {d}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

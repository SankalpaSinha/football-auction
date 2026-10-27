'use client';
import { useEffect, useState } from 'react';
import { ChatButton } from './ChatPanel';
import { ReactionButton } from './Reactions';
import { AnimatePresence, motion } from 'motion/react';
import { GAME_FORMATS, type RoomView } from '@fa/shared';
import { Rivalries } from './Results';
import { emit } from '@/lib/socket';
import { serverNow, useGame } from '@/lib/store';
import { Avatar, Button, Coin, Logo, Pill, SoundToggle } from './ui';

export function Lobby({ room, me, onLeave, onJoin }: { room: RoomView; me: string; onLeave: () => void; onJoin?: () => void }) {
  const toast = useGame((s) => s.toast);
  const self = room.members.find((m) => m.userId === me);
  const isHost = room.hostId === me;
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const [busy, setBusy] = useState(false);
  const accent = room.competition.accent;

  const blocker =
    room.members.length < room.rules.minPlayers
      ? `Need at least ${room.rules.minPlayers} managers`
      : room.members.some((m) => !m.connected)
        ? 'Waiting for everyone to reconnect'
        : room.members.some((m) => !m.ready)
          ? 'Waiting for everyone to ready up'
          : null;

  async function act(event: 'room:ready' | 'room:start', payload?: unknown) {
    setBusy(true);
    const r = await emit(event, payload);
    setBusy(false);
    if (!r.ok) toast('error', r.error);
  }

  // Phones get the native share sheet (WhatsApp, Messages…).
  const [canShare, setCanShare] = useState(false);
  useEffect(() => setCanShare(typeof navigator !== 'undefined' && !!navigator.share && matchMedia('(pointer: coarse)').matches), []);
  function share() {
    navigator
      .share({
        title: 'Football Auction',
        text: `Join my ${room.competition.name} auction — room code ${room.code}`,
        url: `${window.location.origin}/room/${room.code}`,
      })
      .catch(() => {});
  }

  function copy(kind: 'code' | 'link') {
    const text = kind === 'code' ? room.code : `${window.location.origin}/room/${room.code}`;
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(kind);
        setTimeout(() => setCopied(null), 1500);
      },
      () => toast('warn', 'Copy failed — select the code manually.'),
    );
  }

  const slots = Array.from({ length: room.settings.maxPlayers }, (_, i) => room.members[i] ?? null);

  return (
    <main className="mx-auto min-h-dvh max-w-6xl px-4 pb-16 sm:px-6">
      <header className="flex h-16 items-center justify-between">
        <Logo />
        <div className="flex items-center gap-1">
          <ReactionButton canTaunt={room.members.some((m) => m.userId === me)} />
          <ChatButton />
            <SoundToggle />
          <Button variant="ghost" size="sm" onClick={onLeave}>
            Leave
          </Button>
        </div>
      </header>

      <section className="relative mt-4 overflow-hidden rounded-3xl border border-white/10 p-6 sm:p-10" style={{ background: `linear-gradient(120deg, ${accent}30, transparent 55%), rgba(255,255,255,.02)` }}>
        <div className="pointer-events-none absolute -right-20 -top-20 h-80 w-80 rounded-full blur-3xl" style={{ background: `${accent}33` }} />
        <div className="relative flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="label">Football Auction · {room.name}</p>
            <h1 className="display mt-1 text-5xl font-extrabold leading-none sm:text-7xl">{room.competition.name}</h1>
            <div className="mt-4 flex flex-wrap gap-2">
              {room.competition.seasonLabel !== room.competition.name && <Pill color={accent}>{room.competition.seasonLabel}</Pill>}
              <Pill color="#c8ff2e">
                {GAME_FORMATS[room.settings.format].emoji} {GAME_FORMATS[room.settings.format].label}
              </Pill>
              {room.settings.format !== 'DRAFT' && (
                <Pill color="#f5c542">
                  <Coin className="h-3 w-3" /> {room.settings.startingBudget.toLocaleString()} budget
                  {room.rules.maxPrice ? ` · max ${room.rules.maxPrice} a player` : ''}
                </Pill>
              )}
              <Pill color="#2ee6ff">
                {room.settings.lotDurationSec}s per {room.settings.format === 'DRAFT' ? 'pick' : 'player'}
              </Pill>
              {room.settings.seasonLength > 1 && (
                <Pill color="#f5c542">
                  👑 Season · game {Math.min((room.season?.played ?? 0) + 1, room.settings.seasonLength)} of {room.settings.seasonLength}
                </Pill>
              )}
              {room.settings.format !== 'DRAFT' &&
                (
                  [
                    ['mystery', '🎁 Mystery'],
                    ['sealed', '🔒 Sealed bids'],
                    ['events', '📰 Market events'],
                    ['cards', '🃏 Cards'],
                  ] as const
                )
                  .filter(([k]) => room.settings.twists[k])
                  .map(([k, label]) => (
                    <Pill key={k} color="#a78bfa">
                      {label}
                    </Pill>
                  ))}
              <Pill color="#c8ff2e">{room.settings.mode === 'CASUAL' ? 'Casual' : 'Ranked ⚡ ELO on the line'}</Pill>
              <Pill color="#8b94a8">{room.settings.isPublic ? 'Public' : 'Private'}</Pill>
              <Pill color="#8b94a8">{room.rules.squadSize}-man squads</Pill>
              {room.settings.antiSnipe && <Pill color="#8b94a8">Anti-snipe</Pill>}
            </div>
          </div>
          <div className="text-left lg:text-right">
            <p className="label">Room code</p>
            <button onClick={() => copy('code')} className="group mt-1 font-mono text-5xl font-bold tracking-[0.25em] text-ink transition hover:text-volt sm:text-6xl">
              {room.code}
            </button>
            <div className="mt-2 flex gap-2 lg:justify-end">
              <Button variant="secondary" size="sm" onClick={() => copy('code')}>
                {copied === 'code' ? 'Copied ✓' : 'Copy code'}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => (canShare ? share() : copy('link'))}>
                {copied === 'link' ? 'Copied ✓' : canShare ? 'Share invite' : 'Copy invite link'}
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section className="mt-8">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="display text-2xl font-extrabold">
            Managers <span className="text-muted">{room.members.length}/{room.settings.maxPlayers}</span>
          </h2>
          <p className="text-sm text-muted">{room.phase === 'WAITING_FOR_PLAYERS' ? 'Waiting for players…' : 'Lobby open'}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <AnimatePresence mode="popLayout">
            {slots.map((m, i) =>
              m ? (
                <motion.div
                  key={m.userId}
                  layout
                  initial={{ opacity: 0, scale: 0.9, y: 10 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className={`glass flex items-center gap-4 rounded-2xl p-4 ${m.userId === me ? 'ring-1 ring-volt/50' : ''}`}
                >
                  <Avatar name={m.username} size={48} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <a href={`/u/${m.username}`} target="_blank" rel="noreferrer" className="truncate text-lg font-bold hover:text-volt">
                        {m.username}
                      </a>
                      {m.isHost && <span title="Host">👑</span>}
                      {m.userId === me && <span className="text-xs text-muted">(you)</span>}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-sm">
                      <StatusDot state={!m.connected ? 'offline' : m.ready ? 'ready' : 'waiting'} />
                      <span className="text-muted">{!m.connected ? 'Reconnecting…' : m.isHost ? 'Host' : m.ready ? 'Ready' : 'Not ready'}</span>
                    </div>
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key={`empty-${i}`}
                  layout
                  className="flex items-center gap-4 rounded-2xl border border-dashed border-white/10 p-4 text-dim"
                >
                  <div className="grid h-12 w-12 place-items-center rounded-xl border border-dashed border-white/10 text-xl">+</div>
                  <span className="text-sm">Open seat</span>
                </motion.div>
              ),
            )}
          </AnimatePresence>
        </div>
      </section>

      {room.season && room.season.played > 0 && (
        <section className="mt-8">
          <h2 className="display mb-3 text-2xl font-extrabold">
            Season table <span className="text-muted">· {room.season.played}/{room.season.length}</span>
          </h2>
          <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {room.season.table.map((r, i) => (
              <li key={r.userId} className={`glass flex items-center gap-3 rounded-xl px-4 py-2.5 ${r.userId === me ? 'ring-1 ring-volt/50' : ''}`}>
                <span className="display w-5 text-lg font-extrabold text-muted">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate font-bold">{r.username}</span>
                <span className="display text-xl font-extrabold num">{r.points}</span>
                <span className="text-[10px] uppercase tracking-wider text-muted">pts</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <Rivalries room={room} />

      <section className="sticky bottom-0 mt-10 -mx-4 flex flex-col items-center gap-3 bg-gradient-to-t from-night via-night/95 to-transparent px-4 pb-4 pt-6 sm:mx-0 sm:flex-row sm:justify-end sm:bg-none sm:px-0">
        {onJoin ? (
          <>
            <span className="text-sm text-muted">You’re watching this lobby.</span>
            <Button size="lg" onClick={onJoin} disabled={room.members.length >= room.settings.maxPlayers} className="w-full sm:w-auto">
              Join this room
            </Button>
          </>
        ) : isHost ? (
          <>
            {blocker && <span className="text-sm text-muted">{blocker}</span>}
            <Button size="lg" disabled={!!blocker || busy || room.phase !== 'LOBBY'} onClick={() => act('room:start')} className="w-full sm:w-auto">
              Start auction
            </Button>
          </>
        ) : (
          <>
            <span className="text-sm text-muted">{self?.ready ? 'Waiting for the host to start…' : 'Ready up when you are set'}</span>
            <Button
              size="lg"
              variant={self?.ready ? 'secondary' : 'primary'}
              disabled={busy}
              onClick={() => act('room:ready', { ready: !self?.ready })}
              className="w-full sm:w-auto"
            >
              {self?.ready ? 'Not ready' : 'Ready'}
            </Button>
          </>
        )}
      </section>

      <AnimatePresence>
        {room.phase === 'STARTING' && room.startsAt && <Countdown until={room.startsAt} what={room.settings.format === 'DRAFT' ? 'draft' : 'auction'} />}
      </AnimatePresence>
    </main>
  );
}

function StatusDot({ state }: { state: 'ready' | 'waiting' | 'offline' }) {
  const c = { ready: 'bg-emerald-400', waiting: 'bg-amber', offline: 'bg-zinc-500' }[state];
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${c} ${state === 'ready' ? 'shadow-[0_0_10px_#34d399]' : ''}`} />;
}

function Countdown({ until, what }: { until: number; what: string }) {
  const [n, setN] = useState(() => Math.max(1, Math.ceil((until - serverNow()) / 1000)));
  useEffect(() => {
    const t = setInterval(() => setN(Math.max(1, Math.ceil((until - serverNow()) / 1000))), 100);
    return () => clearInterval(t);
  }, [until]);
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 grid place-items-center bg-night/85 backdrop-blur-md"
    >
      <div className="text-center">
        <p className="label mb-4 text-volt">The {what} starts in</p>
        <AnimatePresence mode="popLayout">
          <motion.div
            key={n}
            initial={{ scale: 2.2, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.4, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 18 }}
            className="display text-[10rem] font-extrabold leading-none text-volt"
          >
            {n}
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

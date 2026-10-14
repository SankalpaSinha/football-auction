'use client';
import { useEffect, useRef, useState } from 'react';
import { ChatButton } from '../ChatPanel';
import { AnimatePresence, motion } from 'motion/react';
import type { RoomView } from '@fa/shared';
import { useGame } from '@/lib/store';
import { PlayerCard } from '../PlayerCard';
import { TiltCard } from '../TiltCard';
import { Logo, Pill, SoundToggle } from '../ui';
import { BidPanel } from './BidPanel';
import { Feed } from './Feed';
import { ManagersPanel, SquadPanel } from './Panels';
import { SoldOverlay } from './SoldOverlay';
import { Timer } from './Timer';
import { useCountdown } from './useCountdown';
import { FreePickPanel } from './FreePick';
import { SquadSheet } from '../SquadViews';
import { PauseBanners, PauseButton } from './PauseControls';

type Tab = 'squad' | 'managers' | 'feed';

export function AuctionScreen({ room, me }: { room: RoomView; me: string }) {
  const auction = room.auction!;
  const lot = auction.lot;
  const self = room.members.find((m) => m.userId === me);
  const remaining = useCountdown(lot);
  const totalMs = lot?.extended ? 5_000 : room.settings.lotDurationSec * 1000;
  const [tab, setTab] = useState<Tab>('managers');
  const [viewing, setViewing] = useState<string | null>(null);
  const viewed = room.members.find((m) => m.userId === viewing);
  const { flash: outbid, seq: outbidKey } = useOutbidFlash(me, room);

  return (
    <div className="flex min-h-dvh flex-col">
      {/* top bar */}
      <header className="sticky top-0 z-30 border-b border-white/5 bg-night/70 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-[1500px] items-center gap-3 px-3 sm:px-5">
          <Logo compact />
          <Pill color={room.competition.accent}>{room.competition.shortName}</Pill>
          <span className="hidden text-sm font-semibold sm:inline">{room.competition.name}</span>
          <span className="hidden text-xs text-muted md:inline">{room.competition.seasonLabel}</span>
          <div className="ml-auto flex items-center gap-3 text-xs text-muted sm:gap-5">
            <span>
              Lot <span className="display text-base font-bold text-ink num">{lot?.lotNumber ?? auction.lastResult?.lotNumber ?? '–'}</span>
            </span>
            <span className="hidden sm:inline">
              <span className="display text-base font-bold text-ink num">{auction.remainingInQueue}</span> in pool
            </span>
            {auction.unsoldWaiting > 0 && <span className="hidden md:inline">{auction.unsoldWaiting} unsold waiting</span>}
            {auction.reofferRound && <Pill color="#ffb020">Re-offer round</Pill>}
            {room.spectators > 0 && <span title="Spectators">👀 {room.spectators}</span>}
            <span className="hidden font-mono text-ink/70 lg:inline">{room.code}</span>
            <PauseButton room={room} me={me} />
            <ChatButton />
            <SoundToggle />
          </div>
        </div>
      </header>

      <AnimatePresence>
        {outbid && (
          <motion.div
            initial={{ opacity: 0.6 }}
            animate={{ opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.9 }}
            className="pointer-events-none fixed inset-0 z-20 shadow-[inset_0_0_160px_rgba(255,77,94,.65)]"
          />
        )}
      </AnimatePresence>

      <main className="mx-auto grid w-full max-w-[1500px] flex-1 gap-4 p-3 sm:p-5 lg:grid-cols-[260px_1fr_280px] xl:grid-cols-[300px_1fr_320px]">
        {/* left — your squad */}
        <aside className="hidden max-h-[calc(100dvh-7rem)] lg:block">
          <SquadPanel room={room} me={self} />
        </aside>

        {/* centre — the lot */}
        {/* @container: the lot layout adapts to this column's width, not the window's */}
        <section className="@container flex min-w-0 flex-col gap-4">
          <PauseBanners room={room} me={me} />
          {auction.freePick ? (
            <FreePickPanel room={room} me={me} />
          ) : (
          <div className="glass relative flex flex-col gap-4 overflow-hidden rounded-3xl p-3 sm:p-6 @3xl:flex-row @3xl:items-start @3xl:justify-center @3xl:gap-6">
            <div
              className="pointer-events-none absolute -left-24 top-0 h-96 w-96 rounded-full opacity-40 blur-3xl"
              style={{ background: lot ? lot.player.club.colors[0] : 'transparent' }}
            />
            {/* card (+ timer beside it on phones so bid controls stay above the fold) */}
            <div className="relative flex items-center gap-4 @3xl:block">
              <div className="relative shrink-0" style={{ perspective: 1200 }}>
                <AnimatePresence mode="wait">
                  {lot ? (
                    <motion.div
                      key={lot.lotNumber}
                      initial={{ rotateY: -95, y: 40, opacity: 0, scale: 0.85 }}
                      animate={{ rotateY: 0, y: 0, opacity: 1, scale: 1 }}
                      exit={{ y: -30, opacity: 0, scale: 0.9, transition: { duration: 0.2 } }}
                      transition={{ type: 'spring', stiffness: 90, damping: 14 }}
                    >
                      <div className="hidden @3xl:block">
                        <TiltCard>
                          <PlayerCard player={lot.player} size="lg" />
                        </TiltCard>
                      </div>
                      <PlayerCard player={lot.player} size="md" className="hidden @lg:block @3xl:hidden" />
                      <PlayerCard player={lot.player} size="sm" className="@lg:hidden" />
                    </motion.div>
                  ) : (
                    <div className="grid h-[255px] w-[178px] place-items-center text-sm text-dim @3xl:h-[450px] @3xl:w-[300px]">Next player…</div>
                  )}
                </AnimatePresence>
                {lot?.reoffer && (
                  <div className="absolute -top-2 left-1/2 -translate-x-1/2">
                    <Pill color="#ffb020">Second chance</Pill>
                  </div>
                )}
                {lot?.player.imageCredit && (
                  <div className="mt-2 max-w-[178px] truncate text-center text-[10px] text-dim @3xl:max-w-[300px]" title={lot.player.imageCredit}>
                    📷 {lot.player.imageCredit}
                  </div>
                )}
              </div>
              {lot && (
                <div className="min-w-0 flex-1 @3xl:hidden">
                  <LotInfo room={room} remaining={remaining} totalMs={totalMs} compact />
                </div>
              )}
            </div>

            <div className="relative flex w-full flex-col gap-4 @3xl:max-w-sm">
              {lot && (
                <>
                  <div className="hidden @3xl:block">
                    <LotInfo room={room} remaining={remaining} totalMs={totalMs} />
                  </div>
                  <motion.div
                    key={outbidKey}
                    animate={outbidKey ? { x: [0, -10, 9, -6, 4, 0] } : { x: 0 }}
                    transition={{ duration: 0.45 }}
                  >
                    <BidPanel room={room} lot={lot} me={self} remainingMs={remaining} />
                  </motion.div>
                </>
              )}
            </div>
          </div>
          )}

          {/* mobile tabs */}
          <div className="lg:hidden">
            <div className="mb-3 grid grid-cols-3 gap-1 rounded-xl bg-white/[.04] p-1">
              {(['squad', 'managers', 'feed'] as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`h-9 rounded-lg text-xs font-bold uppercase tracking-wider ${tab === t ? 'bg-white/10 text-ink' : 'text-muted'}`}
                >
                  {t === 'squad' ? `Squad ${self?.squad.length ?? 0}/${room.rules.squadSize}` : t}
                </button>
              ))}
            </div>
            {tab === 'squad' && <SquadPanel room={room} me={self} />}
            {tab === 'managers' && <ManagersPanel room={room} lot={lot} me={me} onSelect={setViewing} />}
            {tab === 'feed' && (
              <div className="glass rounded-2xl p-3">
                <Feed items={room.feed} me={me} className="max-h-80" />
              </div>
            )}
          </div>

          {/* desktop feed */}
          <div className="glass hidden rounded-2xl p-4 lg:block">
            <div className="label mb-2">Live auction feed</div>
            <Feed items={room.feed} me={me} className="max-h-48" />
          </div>
        </section>

        {/* right — managers */}
        <aside className="hidden lg:block">
          <ManagersPanel room={room} lot={lot} me={me} onSelect={setViewing} />
        </aside>
      </main>

      <AnimatePresence>
        {viewed && <SquadSheet member={viewed} squadSize={room.rules.squadSize} onClose={() => setViewing(null)} />}
      </AnimatePresence>

      <AnimatePresence>
        {room.phase === 'PLAYER_SOLD' && auction.lastResult && (
          <SoldOverlay key={auction.lastResult.lotNumber} room={room} result={auction.lastResult} me={me} />
        )}
      </AnimatePresence>
    </div>
  );
}

function LotInfo({ room, remaining, totalMs, compact = false }: { room: RoomView; remaining: number; totalMs: number; compact?: boolean }) {
  const lot = room.auction!.lot!;
  const p = lot.player;
  return (
    <div className={compact ? 'flex flex-col gap-2' : 'flex items-center gap-4'}>
      <Timer remainingMs={remaining} totalMs={totalMs} paused={lot.pausedRemainingMs !== null} size={compact ? 84 : 112} />
      <div className="min-w-0">
        <div className="label">Now bidding</div>
        <div className={`display font-extrabold leading-tight ${compact ? 'text-2xl' : 'truncate text-3xl'}`}>{p.name}</div>
        <div className="mt-0.5 text-sm text-muted">
          {p.nation.flag} {p.nation.name} · {p.age} yrs{compact ? '' : ` · ${p.preferredFoot} foot`}
        </div>
        {p.secondaryPositions.length > 0 && <div className="mt-1 text-xs text-dim">Also plays {p.secondaryPositions.join(', ')}</div>}
        {lot.extended && <div className="mt-1 text-xs font-bold text-danger">⏱ Extended — late bid!</div>}
      </div>
    </div>
  );
}

/** Red edge flash + toast when someone takes the top bid from you. */
function useOutbidFlash(me: string, room: RoomView) {
  const lastEvent = useGame((s) => s.lastEvent);
  const toast = useGame((s) => s.toast);
  const [flash, setFlash] = useState(0);
  const [seq, setSeq] = useState(0);
  const seen = useRef<number>(0);
  const members = useRef(room.members);
  members.current = room.members;
  useEffect(() => {
    if (!lastEvent || lastEvent.at === seen.current) return;
    seen.current = lastEvent.at;
    if (lastEvent.type === 'BID' && lastEvent.previousBidderId === me && lastEvent.userId !== me) {
      const who = members.current.find((m) => m.userId === lastEvent.userId)?.username ?? 'Someone';
      toast('warn', `Outbid! ${who} bid ${lastEvent.amount}`);
      setFlash(lastEvent.at);
      setSeq((n) => n + 1);
      const t = setTimeout(() => setFlash(0), 900);
      return () => clearTimeout(t);
    }
  }, [lastEvent, me, toast]);
  return { flash: flash !== 0, seq };
}

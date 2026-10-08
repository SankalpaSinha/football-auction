'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  autoPick,
  FORMATIONS,
  getFormation,
  GROUP_ORDER,
  POSITION_GROUP,
  positionFit,
  remapLineup,
  summarizeLineup,
  validateLineup,
  ERROR_MESSAGES,
  type PlayerCard,
  type RoomView,
} from '@fa/shared';
import { GROUP_LABEL } from '@/lib/format';
import { emit } from '@/lib/socket';
import { serverNow, useGame } from '@/lib/store';
import { PlayerAvatar } from '../PlayerAvatar';
import { Avatar, Button, Logo, Pill, SoundToggle } from '../ui';
import { FIT_STYLE, PitchSurface, SlotChip } from './Pitch';

type Selection = { kind: 'bench'; id: string } | { kind: 'slot'; index: number } | null;

export function SquadBuilder({ room, me }: { room: RoomView; me: string }) {
  const toast = useGame((s) => s.toast);
  const sb = room.squadBuilding!;
  const mine = sb.mine;
  const self = room.members.find((m) => m.userId === me);
  const squad = useMemo(() => (self?.squad ?? []).map((e) => e.player), [self?.squad]);
  const byId = useMemo(() => new Map(squad.map((p) => [p.id, p])), [squad]);

  const [formationId, setFormationId] = useState(mine?.formationId ?? '4-3-3');
  const [slots, setSlots] = useState<(string | null)[]>(mine?.slots ?? Array(11).fill(null));
  const [selected, setSelected] = useState<Selection>(null);
  const [busy, setBusy] = useState(false);
  const locked = !!mine?.locked;
  const formation = getFormation(formationId)!;

  // Adopt the server's copy on first load and whenever lock state changes (e.g. after refresh).
  const lockedRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!mine) return;
    if (lockedRef.current === null || lockedRef.current !== mine.locked) {
      setFormationId(mine.formationId);
      setSlots(mine.slots);
    }
    lockedRef.current = mine.locked;
  }, [mine]);

  // Debounced draft autosave so the deadline auto-complete keeps your choices.
  const firstSave = useRef(true);
  useEffect(() => {
    if (firstSave.current) {
      firstSave.current = false;
      return;
    }
    if (locked) return;
    const t = setTimeout(() => void emit('squad:draft', { formationId, slots }), 400);
    return () => clearTimeout(t);
  }, [formationId, slots, locked]);

  const summary = summarizeLineup({ formationId, slots }, squad);
  const starters = new Set(slots.filter(Boolean) as string[]);
  const bench = squad.filter((p) => !starters.has(p.id));
  const complete = validateLineup({ formationId, slots }, squad, true);
  const partial = summary.filled > 0 && summary.filled < 11;

  // ------------------------------------------------------------ editing

  function update(next: (string | null)[]) {
    if (locked) return;
    setSlots(next);
    setSelected(null);
  }

  function placeBench(id: string, index: number) {
    const next = [...slots];
    next[index] = id; // previous occupant drops to the bench
    update(next);
  }

  function swapSlots(a: number, b: number) {
    const next = [...slots];
    [next[a], next[b]] = [next[b], next[a]];
    update(next);
  }

  function removeFromSlot(index: number) {
    const next = [...slots];
    next[index] = null;
    update(next);
  }

  function clickSlot(index: number) {
    if (locked) return;
    if (selected?.kind === 'bench') return placeBench(selected.id, index);
    if (selected?.kind === 'slot') {
      if (selected.index === index) return setSelected(null);
      return swapSlots(selected.index, index);
    }
    setSelected({ kind: 'slot', index });
  }

  function clickBench(id: string) {
    if (locked) return;
    if (selected?.kind === 'slot') {
      const next = [...slots];
      next[selected.index] = id;
      return update(next);
    }
    setSelected(selected?.kind === 'bench' && selected.id === id ? null : { kind: 'bench', id });
  }

  function onDrop(e: React.DragEvent, index: number | 'bench') {
    e.preventDefault();
    const data = e.dataTransfer.getData('text/plain');
    if (!data) return;
    const [kind, value] = data.split(':');
    if (index === 'bench') {
      if (kind === 'slot') removeFromSlot(Number(value));
      return;
    }
    if (kind === 'bench') placeBench(value, index);
    else if (kind === 'slot') swapSlots(Number(value), index);
  }

  function changeFormation(id: string) {
    if (locked || id === formationId) return;
    setFormationId(id);
    setSlots(remapLineup(slots, id, squad));
    setSelected(null);
  }

  async function lock() {
    if (complete) return toast('error', ERROR_MESSAGES[complete]);
    setBusy(true);
    const r = await emit('squad:lock', { formationId, slots });
    setBusy(false);
    if (!r.ok) toast('error', r.error);
  }

  async function unlock() {
    setBusy(true);
    const r = await emit('squad:unlock');
    setBusy(false);
    if (!r.ok) toast('error', r.error);
  }

  const lockedCount = Object.values(sb.locked).filter(Boolean).length;

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-white/5 bg-night/70 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-3 px-3 sm:px-5">
          <Logo compact />
          <span className="display text-lg font-extrabold">Squad builder</span>
          <Pill color={room.competition.accent} className="hidden sm:inline-flex">
            {room.competition.shortName}
          </Pill>
          <div className="ml-auto flex items-center gap-3">
            <Deadline endsAt={sb.endsAt} />
            <SoundToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-[1400px] flex-1 gap-5 p-3 sm:p-5 lg:grid-cols-[minmax(0,1fr)_400px]">
        {/* pitch */}
        <section className="flex min-w-0 flex-col items-center gap-4">
          <div className="scrollbar-thin flex w-full max-w-[640px] gap-1.5 overflow-x-auto pb-1">
            {FORMATIONS.map((f) => (
              <button
                key={f.id}
                disabled={locked}
                onClick={() => changeFormation(f.id)}
                className={`display h-9 shrink-0 rounded-lg border px-3 text-[15px] font-bold transition disabled:opacity-50 ${
                  f.id === formationId ? 'border-volt bg-volt/15 text-volt' : 'border-white/10 bg-white/[.03] hover:bg-white/[.07]'
                }`}
              >
                {f.name}
              </button>
            ))}
          </div>

          <PitchSurface className="w-full" style={{ maxWidth: 'min(640px, calc((100dvh - 15rem) * 0.68))', minWidth: 'min(100%, 300px)' }}>
            {formation.slots.map((s, i) => {
              const id = slots[i];
              const player = id ? (byId.get(id) ?? null) : null;
              const isSel = selected?.kind === 'slot' && selected.index === i;
              const target = !!selected && !isSel && !locked;
              return (
                <motion.div
                  key={i}
                  initial={false}
                  animate={{ left: `${s.x}%`, top: `${s.y}%` }}
                  transition={{ type: 'spring', stiffness: 220, damping: 26 }}
                  className="absolute z-10 -translate-x-1/2 -translate-y-1/2"
                  style={{ left: `${s.x}%`, top: `${s.y}%` }}
                >
                  <button
                    draggable={!!player && !locked}
                    onDragStart={(e) => e.dataTransfer.setData('text/plain', `slot:${i}`)}
                    onDragOver={(e) => !locked && e.preventDefault()}
                    onDrop={(e) => onDrop(e, i)}
                    onClick={() => clickSlot(i)}
                    className={`block ${locked ? 'cursor-default' : 'cursor-pointer'}`}
                    aria-label={player ? `${player.name} at ${s.role}` : `Empty ${s.role} slot`}
                  >
                    <SlotChip player={player} role={s.role} selected={isSel} highlight={target && !player} />
                  </button>
                </motion.div>
              );
            })}
            <AnimatePresence>
              {locked && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="absolute inset-x-3 top-3 z-20 rounded-xl border border-volt/40 bg-night/85 px-4 py-2 text-center text-sm backdrop-blur"
                >
                  <span className="font-bold text-volt">Locked in ✓</span>
                  <span className="text-muted"> — waiting for {room.members.length - lockedCount} more</span>
                </motion.div>
              )}
            </AnimatePresence>
          </PitchSurface>

          <div className="grid w-full max-w-[640px] grid-cols-3 gap-2 text-center">
            <Stat label="Avg OVR" value={summary.averageOverall ? summary.averageOverall.toFixed(1) : '–'} />
            <Stat label="Effective OVR" value={summary.effectiveOverall ? summary.effectiveOverall.toFixed(1) : '–'} hint="After position fit" />
            <Stat label="In position" value={`${summary.fit.NATURAL + summary.fit.SECONDARY}/${summary.filled || 11}`} />
          </div>
          <div className="flex w-full max-w-[640px] flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted">
            {(Object.keys(FIT_STYLE) as (keyof typeof FIT_STYLE)[]).map((k) => (
              <span key={k} className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: FIT_STYLE[k].color }} />
                {FIT_STYLE[k].label}
                {summary.fit[k] > 0 && <span className="font-bold text-ink">{summary.fit[k]}</span>}
              </span>
            ))}
          </div>
        </section>

        {/* sidebar */}
        <aside className="flex flex-col gap-4">
          <div className="glass rounded-2xl p-4">
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="flex-1"
                disabled={locked}
                onClick={() => update(autoPick(squad, formationId, partial ? slots : undefined))}
              >
                {partial ? 'Auto-complete XI' : 'Auto-pick best XI'}
              </Button>
              <Button variant="ghost" size="sm" disabled={locked || !slots.some(Boolean)} onClick={() => update(Array(11).fill(null))}>
                Clear
              </Button>
            </div>
            {locked ? (
              <Button variant="secondary" size="lg" className="mt-3 w-full" disabled={busy} onClick={unlock}>
                Unlock to edit
              </Button>
            ) : (
              <Button size="lg" className="mt-3 w-full" disabled={busy || !!complete} onClick={lock}>
                {complete ? `${summary.filled}/11 picked` : 'Lock in lineup'}
              </Button>
            )}
            <p className="mt-2 text-center text-xs text-dim">
              {locked
                ? 'You can unlock until everyone has locked in.'
                : complete === 'GOALKEEPER_REQUIRED'
                  ? 'Put a goalkeeper in goal to lock in.'
                  : 'Tap a player then a position — or drag. Unfinished lineups are auto-completed at the deadline.'}
            </p>
          </div>

          <div className="glass rounded-2xl p-4">
            <div className="label mb-2">Managers</div>
            <ul className="space-y-1.5">
              {room.members.map((m) => (
                <li key={m.userId} className="flex items-center gap-2 text-sm">
                  <Avatar name={m.username} size={24} />
                  <span className="flex-1 truncate font-semibold">
                    {m.username} {m.userId === me && <span className="text-xs text-muted">(you)</span>}
                  </span>
                  {sb.locked[m.userId] ? (
                    <span className="text-xs font-bold text-volt">Locked ✓</span>
                  ) : (
                    <span className="text-xs text-muted">{m.connected ? 'Picking…' : 'Offline'}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <div
            className="glass flex-1 rounded-2xl p-4"
            onDragOver={(e) => !locked && e.preventDefault()}
            onDrop={(e) => onDrop(e, 'bench')}
          >
            <div className="mb-2 flex items-baseline justify-between">
              <span className="label">Bench & squad</span>
              <span className="text-xs text-muted">
                {bench.length} not in XI {bench.length === 4 && '· your 4 subs'}
              </span>
            </div>
            <div className="space-y-3">
              {GROUP_ORDER.map((g) => {
                const list = squad.filter((p) => POSITION_GROUP[p.position] === g).sort((a, b) => b.overall - a.overall);
                if (!list.length) return null;
                return (
                  <div key={g}>
                    <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-dim">{GROUP_LABEL[g]}</div>
                    <ul className="space-y-1">
                      {list.map((p) => (
                        <SquadRow
                          key={p.id}
                          player={p}
                          slotIndex={slots.indexOf(p.id)}
                          formationRole={slots.indexOf(p.id) >= 0 ? formation.slots[slots.indexOf(p.id)].role : null}
                          selected={selected?.kind === 'bench' && selected.id === p.id}
                          locked={locked}
                          onClick={() => {
                            const idx = slots.indexOf(p.id);
                            if (idx >= 0) clickSlot(idx);
                            else clickBench(p.id);
                          }}
                        />
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          </div>
        </aside>
      </main>

      {/* phones: keep the primary action in reach */}
      <div className="sticky bottom-0 z-30 border-t border-white/10 bg-night/90 px-3 py-2.5 backdrop-blur-xl lg:hidden">
        {locked ? (
          <Button variant="secondary" className="w-full" disabled={busy} onClick={unlock}>
            Locked ✓ · Unlock to edit
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => update(autoPick(squad, formationId, partial ? slots : undefined))}>
              Auto-pick
            </Button>
            <Button className="flex-[2]" disabled={busy || !!complete} onClick={lock}>
              {complete ? `${summary.filled}/11 picked` : 'Lock in lineup'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function SquadRow({
  player,
  slotIndex,
  formationRole,
  selected,
  locked,
  onClick,
}: {
  player: PlayerCard;
  slotIndex: number;
  formationRole: PlayerCard['position'] | null;
  selected: boolean;
  locked: boolean;
  onClick: () => void;
}) {
  const fit = formationRole ? positionFit(player, formationRole) : null;
  return (
    <li>
      <button
        draggable={!locked}
        onDragStart={(e) => e.dataTransfer.setData('text/plain', slotIndex >= 0 ? `slot:${slotIndex}` : `bench:${player.id}`)}
        onClick={onClick}
        disabled={locked}
        className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition disabled:cursor-default ${
          selected ? 'bg-volt/15 ring-1 ring-volt' : 'bg-white/[.03] hover:bg-white/[.07]'
        }`}
      >
        <PlayerAvatar player={player} size={30} />
        <span className="w-9 text-[11px] font-bold text-muted">{player.position}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{player.shortName}</span>
        <span className="display w-6 text-right font-bold">{player.overall}</span>
        <span className="w-[74px] text-right">
          {fit ? (
            <span className="rounded px-1.5 py-0.5 text-[10px] font-bold text-night" style={{ background: FIT_STYLE[fit.level].color }}>
              XI · {formationRole}
            </span>
          ) : (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-dim">Bench</span>
          )}
        </span>
      </button>
    </li>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="glass rounded-xl px-2 py-2" title={hint}>
      <div className="display text-2xl font-extrabold num">{value}</div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</div>
    </div>
  );
}

function Deadline({ endsAt }: { endsAt: number }) {
  const [left, setLeft] = useState(() => Math.max(0, endsAt - serverNow()));
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, endsAt - serverNow())), 250);
    return () => clearInterval(t);
  }, [endsAt]);
  const s = Math.ceil(left / 1000);
  const urgent = s <= 30;
  return (
    <span className={`display rounded-lg px-2.5 py-1 text-lg font-extrabold num ${urgent ? 'animate-urgent bg-danger/15 text-danger' : 'bg-white/5 text-ink'}`}>
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}
    </span>
  );
}

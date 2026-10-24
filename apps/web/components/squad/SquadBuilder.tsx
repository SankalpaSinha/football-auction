'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChatButton } from '../ChatPanel';
import { AnimatePresence, motion } from 'motion/react';
import {
  autoPick,
  FORMATIONS,
  getFormation,
  GROUP_ORDER,
  POSITION_GROUP,
  positionFit,
  remapLineup,
  roleRating,
  scoreSquad,
  summarizeLineup,
  validateLineup,
  ERROR_MESSAGES,
  DEFAULT_TACTIC,
  OBJECTIVES,
  PLAYSTYLES,
  playstyleOf,
  TACTIC_IDS,
  TACTICS,
  type PlayerCard,
  type RoomView,
  type ScoreContext,
  type TacticId,
} from '@fa/shared';
import { GROUP_LABEL } from '@/lib/format';
import { emit } from '@/lib/socket';
import { serverNow, useGame } from '@/lib/store';
import { PlayerAvatar } from '../PlayerAvatar';
import { Avatar, Button, Logo, Pill, SoundToggle } from '../ui';
import { FIT_STYLE, LINK_COLOR, linksFor, PitchSurface, SlotChip } from './Pitch';
import { SquadSheet } from '../SquadViews';

type Selection = { kind: 'bench'; id: string } | { kind: 'slot'; index: number } | null;

export function SquadBuilder({ room, me }: { room: RoomView; me: string }) {
  const toast = useGame((s) => s.toast);
  const sb = room.squadBuilding!;
  const mine = sb.mine;
  const self = room.members.find((m) => m.userId === me);
  const squad = useMemo(() => (self?.squad ?? []).map((e) => e.player), [self?.squad]);
  const byId = useMemo(() => new Map(squad.map((p) => [p.id, p])), [squad]);

  const [formationId, setFormationId] = useState(mine?.formationId ?? '4-3-3');
  const [tactic, setTactic] = useState<TacticId>(mine?.tactic ?? DEFAULT_TACTIC);
  const [slots, setSlots] = useState<(string | null)[]>(mine?.slots ?? Array(11).fill(null));
  const [selected, setSelected] = useState<Selection>(null);
  const [picker, setPicker] = useState<number | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const viewed = room.members.find((m) => m.userId === viewing);
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
      setTactic(mine.tactic ?? DEFAULT_TACTIC);
    }
    lockedRef.current = mine.locked;
  }, [mine]);

  // Debounced draft autosave so the deadline auto-complete keeps your choices.
  // Unsaved changes are retried after a reconnect and flushed if you navigate away.
  const connection = useGame((s) => s.connection);
  const [unsaved, setUnsaved] = useState(false);
  const pending = useRef<{ formationId: string; slots: (string | null)[]; tactic: TacticId } | null>(null);
  const save = useRef(async () => {
    const draft = pending.current;
    if (!draft) return;
    const r = await emit('squad:draft', draft);
    if (r.ok && pending.current === draft) {
      pending.current = null;
      setUnsaved(false);
    } else if (!r.ok && r.code !== 'LINEUP_LOCKED' && r.code !== 'WRONG_PHASE') {
      setUnsaved(true);
    }
  });
  const firstSave = useRef(true);
  useEffect(() => {
    if (firstSave.current) {
      firstSave.current = false;
      return;
    }
    if (locked) return;
    pending.current = { formationId, slots, tactic };
    const t = setTimeout(() => void save.current(), 400);
    return () => clearTimeout(t);
  }, [formationId, slots, tactic, locked]);
  useEffect(() => {
    if (connection === 'connected' && pending.current) void save.current();
  }, [connection]);
  useEffect(() => () => void save.current(), []);

  const summary = summarizeLineup({ formationId, slots }, squad);
  const starters = new Set(slots.filter(Boolean) as string[]);
  const bench = squad.filter((p) => !starters.has(p.id));
  const complete = validateLineup({ formationId, slots }, squad, true);
  const partial = summary.filled > 0 && summary.filled < 11;
  // Live preview with the same engine the server uses (the server's score is the one that counts).
  const ctx: ScoreContext = useMemo(
    () => ({ objectives: room.myObjectives ?? [], startingBudget: room.settings.startingBudget, budgetLeft: self?.budget ?? undefined }),
    [room.myObjectives, room.settings.startingBudget, self?.budget],
  );
  const projected = useMemo(
    () => (!complete && self ? scoreSquad(self.squad, { formationId, slots, tactic }, ctx) : null),
    [complete, self, formationId, slots, tactic, ctx],
  );
  /** What each tactic would score with this XI (complete lineups only). */
  const byTactic = useMemo(() => {
    if (complete || !self) return null;
    return Object.fromEntries(TACTIC_IDS.map((t) => [t, scoreSquad(self.squad, { formationId, slots, tactic: t }, ctx).total])) as Record<TacticId, number>;
  }, [complete, self, formationId, slots, ctx]);
  // Partial lineups still get live objective/synergy feedback.
  const preview = useMemo(() => (self ? scoreSquad(self.squad, { formationId, slots, tactic }, ctx) : null), [self, formationId, slots, tactic, ctx]);
  const pitchLinks = useMemo(() => linksFor(formationId, slots, byId), [formationId, slots, byId]);

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
    // Nothing selected: open the picker for this position (one tap on phones).
    setPicker(index);
  }

  /** From the picker: put this player in the slot (swapping if they're already in the XI). */
  function pickFor(index: number, id: string) {
    const current = slots.indexOf(id);
    if (current === index) return setPicker(null);
    if (current >= 0) swapSlots(current, index);
    else placeBench(id, index);
    setPicker(null);
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
    const r = await emit('squad:lock', { formationId, slots, tactic });
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
            <ChatButton />
            <SoundToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-[1400px] flex-1 gap-5 p-3 sm:p-5 lg:grid-cols-[minmax(0,1fr)_400px]">
        {/* pitch */}
        <section className="flex min-w-0 flex-col items-center gap-4">
          <div className="scrollbar-thin flex w-full max-w-[640px] gap-1.5 overflow-x-auto pb-1 sm:flex-wrap sm:justify-center sm:overflow-visible">
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

          <TacticPicker tactic={tactic} onChange={setTactic} locked={locked} totals={byTactic} />

          <PitchSurface className="w-full" links={pitchLinks} style={{ maxWidth: 'min(640px, calc((100dvh - 15rem) * 0.68))', minWidth: 'min(100%, 300px)' }}>
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

          <div className="grid w-full max-w-[640px] grid-cols-3 gap-2 text-center sm:grid-cols-5">
            <Stat label="Projected score" value={projected ? projected.total.toFixed(1) : '–'} hint="Preview — final scores are calculated by the server" accent />
            <Stat label="Tactic fit" value={projected ? projected.breakdown.tactics.toFixed(0) : '–'} />
            <Stat label="Synergy" value={projected ? projected.breakdown.synergy.toFixed(0) : '–'} />
            <Stat label="Chemistry" value={projected ? projected.breakdown.chemistry.toFixed(0) : '–'} />
            <Stat label="Avg OVR" value={summary.averageOverall ? summary.averageOverall.toFixed(1) : '–'} />
          </div>
          <div className="flex w-full max-w-[640px] flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted">
            {(['STRONG', 'MEDIUM', 'WEAK'] as const).map((k) => (
              <span key={k} className="inline-flex items-center gap-1.5">
                <span className="h-0.5 w-4 rounded" style={{ background: LINK_COLOR[k] }} />
                {k === 'STRONG' ? 'Strong link (club)' : k === 'MEDIUM' ? 'Link (nation / league)' : 'No link'}
              </span>
            ))}
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
            {unsaved && !locked && (
              <p className="mt-2 text-center text-xs font-semibold text-amber-200">Changes not saved yet — reconnecting…</p>
            )}
            <p className="mt-2 text-center text-xs text-dim">
              {locked
                ? 'You can unlock until everyone has locked in.'
                : complete === 'GOALKEEPER_REQUIRED'
                  ? 'Put a goalkeeper in goal to lock in.'
                  : 'Tap a player then a position — or drag. Unfinished lineups are auto-completed at the deadline.'}
            </p>
          </div>

          {preview && <PlanPanel score={preview} byId={byId} />}

          <div className="glass rounded-2xl p-4">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="label">Managers</span>
              <span className="text-[10px] text-dim">tap to see squads</span>
            </div>
            <ul className="space-y-1.5">
              {room.members.map((m) => (
                <li key={m.userId}>
                  <button
                    onClick={() => setViewing(m.userId)}
                    className="flex w-full items-center gap-2 rounded-lg px-1 py-0.5 text-left text-sm hover:bg-white/[.05]"
                    aria-label={`See ${m.username}'s squad`}
                  >
                  <Avatar name={m.username} size={24} />
                  <span className="flex-1 truncate font-semibold">
                    {m.username} {m.userId === me && <span className="text-xs text-muted">(you)</span>}
                  </span>
                  {sb.locked[m.userId] ? (
                    <span className="text-xs font-bold text-volt">Locked ✓</span>
                  ) : (
                    <span className="text-xs text-muted">{m.connected ? 'Picking…' : 'Offline'}</span>
                  )}
                  </button>
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
                {bench.length} not in XI {bench.length === room.rules.squadSize - 11 && `· your ${bench.length} subs`}
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
                          liked={(TACTICS[tactic].likes as readonly string[]).includes(playstyleOf(p))}
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

      <AnimatePresence>
        {viewed && <SquadSheet member={viewed} squadSize={room.rules.squadSize} onClose={() => setViewing(null)} />}
      </AnimatePresence>

      <AnimatePresence>
        {picker !== null && (
          <SlotPicker
            role={formation.slots[picker].role}
            current={slots[picker]}
            squad={squad}
            slots={slots}
            formationRoles={formation.slots.map((x) => x.role)}
            onPick={(id) => pickFor(picker, id)}
            onRemove={() => {
              removeFromSlot(picker);
              setPicker(null);
            }}
            onClose={() => setPicker(null)}
          />
        )}
      </AnimatePresence>

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
  liked,
  locked,
  onClick,
}: {
  player: PlayerCard;
  slotIndex: number;
  formationRole: PlayerCard['position'] | null;
  selected: boolean;
  /** Their playstyle suits the chosen tactic. */
  liked: boolean;
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
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{player.shortName}</span>
          <span className={`block truncate text-[10px] ${liked ? 'font-bold text-volt' : 'text-dim'}`} title={PLAYSTYLES[playstyleOf(player)].blurb}>
            {liked && '★ '}
            {PLAYSTYLES[playstyleOf(player)].label}
          </span>
        </span>
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

function Stat({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: boolean }) {
  return (
    <div className={`glass rounded-xl px-2 py-2 ${accent ? 'ring-1 ring-volt/40' : ''}`} title={hint}>
      <div className={`display text-2xl font-extrabold num ${accent ? 'text-volt' : ''}`}>{value}</div>
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

const FIT_RANK = { NATURAL: 0, SECONDARY: 1, COMPATIBLE: 2, OUT_OF_POSITION: 3, EXTREME: 4 } as const;

/** Bottom sheet (phones) / dialog (desktop) to choose who plays in one position. */
function SlotPicker({
  role,
  current,
  squad,
  slots,
  formationRoles,
  onPick,
  onRemove,
  onClose,
}: {
  role: PlayerCard['position'];
  current: string | null;
  squad: PlayerCard[];
  slots: (string | null)[];
  formationRoles: PlayerCard['position'][];
  onPick: (id: string) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const options = squad
    .map((p) => ({ p, fit: positionFit(p, role), rating: roleRating(p, role) }))
    .sort((a, b) => FIT_RANK[a.fit.level] - FIT_RANK[b.fit.level] || b.rating - a.rating);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-end justify-center bg-night/70 backdrop-blur-sm sm:items-center"
      onClick={onClose}
    >
      <motion.div
        role="dialog"
        aria-label={`Choose a player for ${role}`}
        initial={{ y: 60 }}
        animate={{ y: 0 }}
        exit={{ y: 60 }}
        transition={{ type: 'spring', stiffness: 320, damping: 30 }}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80dvh] w-full max-w-md flex-col rounded-t-3xl border border-white/10 bg-deep p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:rounded-3xl"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/20 sm:hidden" />
        <div className="mb-3 flex items-center justify-between">
          <h3 className="display text-2xl font-extrabold">
            Who plays <span className="text-volt">{role}</span>?
          </h3>
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-white/5" aria-label="Close">
            ✕
          </button>
        </div>
        <ul className="scrollbar-thin -mx-1 flex-1 space-y-1 overflow-y-auto px-1">
          {options.map(({ p, fit, rating }) => {
            const at = slots.indexOf(p.id);
            const isCurrent = p.id === current;
            return (
              <li key={p.id}>
                <button
                  onClick={() => onPick(p.id)}
                  className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition active:scale-[0.99] ${
                    isCurrent ? 'bg-volt/15 ring-1 ring-volt' : 'bg-white/[.03] hover:bg-white/[.07]'
                  }`}
                >
                  <PlayerAvatar player={p} size={36} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{p.shortName}</span>
                    <span className="text-xs text-muted">
                      {p.position}
                      {p.secondaryPositions.length ? ` · ${p.secondaryPositions.join('/')}` : ''} · {PLAYSTYLES[playstyleOf(p)].label} ·{' '}
                      {at >= 0 ? (isCurrent ? 'here now' : `in XI at ${formationRoles[at]}`) : 'bench'}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="display block text-xl font-extrabold leading-none num">{Math.round(rating)}</span>
                    <span className="text-[10px] font-bold uppercase" style={{ color: FIT_STYLE[fit.level].color }}>
                      {FIT_STYLE[fit.level].label}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {current && (
          <button onClick={onRemove} className="mt-3 h-11 rounded-xl border border-white/10 text-sm font-semibold text-muted hover:bg-white/5">
            Move to bench
          </button>
        )}
      </motion.div>
    </motion.div>
  );
}

/** Team tactic: changes which playstyles and attributes the XI is judged on. */
function TacticPicker({
  tactic,
  onChange,
  locked,
  totals,
}: {
  tactic: TacticId;
  onChange: (t: TacticId) => void;
  locked: boolean;
  totals: Record<TacticId, number> | null;
}) {
  const t = TACTICS[tactic];
  const best = totals ? (Object.entries(totals).sort((a, b) => b[1] - a[1])[0][0] as TacticId) : null;
  return (
    <div className="glass w-full max-w-[640px] rounded-2xl p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="label">Team tactic</span>
        {totals && best && best !== tactic && !locked && (
          <button onClick={() => onChange(best)} className="text-[11px] font-semibold text-cyan hover:underline">
            Best for this XI: {TACTICS[best].label} ({totals[best].toFixed(1)})
          </button>
        )}
      </div>
      <div className="scrollbar-thin flex gap-1.5 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible">
        {TACTIC_IDS.map((id) => (
          <button
            key={id}
            disabled={locked}
            onClick={() => onChange(id)}
            aria-pressed={id === tactic}
            className={`shrink-0 rounded-lg border px-2.5 py-1.5 text-left text-xs font-bold transition disabled:opacity-50 ${
              id === tactic ? 'border-volt bg-volt/15 text-volt' : 'border-white/10 bg-white/[.03] hover:bg-white/[.07]'
            }`}
          >
            {TACTICS[id].label}
            {totals && <span className="ml-1.5 font-normal text-muted num">{totals[id].toFixed(1)}</span>}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted">
        {t.blurb}
        {t.likes.length > 0 && (
          <>
            {' '}
            Built around: <span className="text-ink">{t.likes.map((l) => PLAYSTYLES[l].label).join(', ')}</span>.
          </>
        )}
      </p>
    </div>
  );
}

/** Live synergy combos and secret-objective progress for the current XI. */
function PlanPanel({ score, byId }: { score: ReturnType<typeof scoreSquad>; byId: Map<string, PlayerCard> }) {
  const name = (id: string) => byId.get(id)?.shortName ?? '?';
  return (
    <div className="glass rounded-2xl p-4">
      {score.objectives.length > 0 && (
        <>
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="label">🕵️ Secret objectives</span>
            <span className="text-[10px] text-dim">+3 each · only you can see these</span>
          </div>
          <ul className="mb-3 space-y-1 text-xs">
            {score.objectives.map((o) => (
              <li key={o.id} className={o.done ? 'text-emerald-200' : 'text-muted'}>
                {o.done ? '✓' : '○'} <b className={o.done ? '' : 'text-ink'}>{OBJECTIVES[o.id].label}</b> · {OBJECTIVES[o.id].text}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="label">⚙️ Synergy combos</span>
        <span className="text-[10px] text-dim">playstyles that click</span>
      </div>
      {score.synergies.length === 0 ? (
        <p className="text-xs text-dim">
          None yet. Pair playstyles that work together, like a Wide Crosser with a Target Man, or a Ball Winner next to a playmaker.
        </p>
      ) : (
        <ul className="space-y-1 text-xs">
          {score.synergies.map((h) => (
            <li key={h.key} className="flex items-baseline justify-between gap-2">
              <span>
                <b>{h.label}</b> <span className="text-muted">{name(h.players[0])} + {name(h.players[1])}</span>
              </span>
              <span className="text-volt num">+{h.points}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

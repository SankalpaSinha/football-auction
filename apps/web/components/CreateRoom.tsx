'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'motion/react';
import {
  ALL_TWISTS,
  BLITZ_LOT_SEC,
  BUDGET_CAP_BUDGET,
  FORMAT_IDS,
  GAME_FORMATS,
  GAME_RULES,
  MARKET_EVENTS,
  POWER_CARDS,
  SEASON_LENGTHS,
  type CompetitionSummary,
  type GameFormat,
  type Twists,
} from '@fa/shared';
import { api } from '@/lib/api';
import { emit, ensureConnected } from '@/lib/socket';
import { useGame } from '@/lib/store';
import { Button, Coin } from './ui';

const COMP_ICON: Record<string, string> = {
  LEAGUE: '🏟️',
  CLUB_CUP: '⭐',
  INTERNATIONAL: '🌍',
  GLOBAL: '🌐',
};

export function CreateRoom() {
  const router = useRouter();
  const session = useGame((s) => s.session)!;
  const toast = useGame((s) => s.toast);
  const [comps, setComps] = useState<CompetitionSummary[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [name, setName] = useState(`${session.user.username}'s Auction`.slice(0, 32));
  const [competitionId, setCompetitionId] = useState('premier-league');
  const [seasonId, setSeasonId] = useState('');
  const [budget, setBudget] = useState(GAME_RULES.defaultBudget);
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [timer, setTimer] = useState(GAME_RULES.defaultLotDurationSec);
  const [antiSnipe, setAntiSnipe] = useState(true);
  const [mode, setMode] = useState<'CASUAL' | 'RANKED'>('CASUAL');
  const [isPublic, setIsPublic] = useState(false);
  const [format, setFormat] = useState<GameFormat>('CLASSIC');
  const [twists, setTwists] = useState<Twists>({ ...ALL_TWISTS });
  const [seasonLength, setSeasonLength] = useState(1);
  const ranked = mode === 'RANKED';
  const draft = format === 'DRAFT';
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .competitions()
      .then((r) => setComps(r.competitions))
      .catch(() => setLoadError(true));
  }, []);

  const comp = comps?.find((c) => c.id === competitionId) ?? comps?.[0];
  const season = comp?.seasons.find((s) => s.id === seasonId) ?? comp?.seasons[0];
  const sizeOptions = useMemo(
    () => Array.from({ length: (season?.maxPlayers ?? 6) - 1 }, (_, i) => i + 2),
    [season?.maxPlayers],
  );

  useEffect(() => {
    if (season && maxPlayers > season.maxPlayers) setMaxPlayers(season.maxPlayers);
  }, [season, maxPlayers]);

  async function create() {
    if (!comp || !season || busy) return;
    setBusy(true);
    try {
      if (!(await ensureConnected(session.token))) throw new Error('Cannot reach the game server.');
      const r = await emit<{ code: string }>('room:create', {
        name: name.trim() || 'Football Auction',
        competitionId: comp.id,
        seasonId: season.id,
        // Budget Cap always uses its own small budget; the server sets that itself.
        startingBudget: ranked ? GAME_RULES.defaultBudget : budget,
        maxPlayers,
        // Blitz always runs 10-second lots; the server sets that itself.
        lotDurationSec: timer,
        mode,
        isPublic,
        antiSnipe,
        format,
        twists,
        seasonLength,
      });
      if (!r.ok) throw new Error(r.error);
      router.push(`/room/${r.data!.code}`);
    } catch (e) {
      toast('error', (e as Error).message);
      setBusy(false);
    }
  }

  return (
    <section className="glass cut-corners p-6 sm:p-8">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <p className="label text-volt">Host</p>
          <h2 className="display text-3xl font-extrabold">Create a room</h2>
        </div>
      </div>

      <Field label="Room name">
        <input
          value={name}
          maxLength={32}
          onChange={(e) => setName(e.target.value)}
          className="h-11 w-full rounded-xl border border-white/10 bg-white/5 px-4 font-medium outline-none focus:border-volt/60"
        />
      </Field>

      <Field label="Competition — the player pool">
        {loadError ? (
          <p className="text-sm text-rose-300">Could not load competitions — is the server running?</p>
        ) : !comps ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="h-20 animate-pulse rounded-xl bg-white/5" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {comps.map((c) => {
              const active = c.id === comp?.id;
              return (
                <button
                  key={c.id}
                  onClick={() => {
                    setCompetitionId(c.id);
                    setSeasonId('');
                  }}
                  className={`relative overflow-hidden rounded-xl border p-3 text-left transition ${
                    active ? 'border-transparent' : 'border-white/10 bg-white/[.03] hover:bg-white/[.06]'
                  }`}
                  style={active ? { background: `linear-gradient(135deg, ${c.accent}40, ${c.accent}10)`, boxShadow: `inset 0 0 0 1.5px ${c.accent}` } : undefined}
                >
                  <div className="text-lg">{COMP_ICON[c.type] ?? '⚽'}</div>
                  <div className="display mt-1 text-[15px] font-bold leading-tight">{c.name}</div>
                  <div className="mt-0.5 text-[11px] text-muted">{c.seasons[0]?.poolSize} players</div>
                </button>
              );
            })}
          </div>
        )}
      </Field>

      <Field label="Format">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {FORMAT_IDS.map((f) => {
            const info = GAME_FORMATS[f];
            const active = f === format;
            const blocked = ranked && f !== 'CLASSIC';
            return (
              <button
                key={f}
                disabled={blocked}
                onClick={() => setFormat(f)}
                title={blocked ? 'Ranked games use the Classic format' : info.blurb}
                className={`rounded-xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  active ? 'border-volt bg-volt/10 shadow-[inset_0_0_0_1px_rgba(200,255,46,.6)]' : 'border-white/10 bg-white/[.03] hover:bg-white/[.06]'
                }`}
              >
                <div className="text-lg">{info.emoji}</div>
                <div className={`display mt-1 text-[15px] font-bold leading-tight ${active ? 'text-volt' : ''}`}>{info.label}</div>
                <div className="mt-0.5 text-[11px] leading-snug text-muted">{info.blurb}</div>
              </button>
            );
          })}
        </div>
      </Field>

      <div className="grid gap-x-6 sm:grid-cols-2">
        <Field label="Season">
          <Chips
            options={(comp?.seasons ?? []).map((s) => ({ value: s.id, label: s.label }))}
            value={season?.id ?? ''}
            onChange={setSeasonId}
          />
        </Field>
        <Field label="Room size">
          <Chips options={sizeOptions.map((n) => ({ value: n, label: `${n}` }))} value={maxPlayers} onChange={setMaxPlayers} />
        </Field>
        {draft ? (
          <Field label="Budget">
            <p className="text-sm text-muted">No bidding in a draft — every pick is free.</p>
          </Field>
        ) : format === 'BUDGET' ? (
          <Field label="Budget">
            <p className="flex items-center gap-1.5 text-sm text-muted">
              <Coin className="h-3.5 w-3.5" /> {BUDGET_CAP_BUDGET} coins each · players cost 1–5
            </p>
          </Field>
        ) : (
          <Field label="Starting budget">
            <Chips
              options={GAME_RULES.budgetOptions.map((b) => ({
                value: b,
                label: b.toLocaleString(),
                disabled: ranked && b !== GAME_RULES.defaultBudget,
              }))}
              value={ranked ? GAME_RULES.defaultBudget : budget}
              onChange={setBudget}
              icon={<Coin className="h-3.5 w-3.5" />}
            />
          </Field>
        )}
        <Field label={draft ? 'Pick timer' : 'Bid timer'}>
          {format === 'BLITZ' ? (
            <p className="text-sm text-muted">{BLITZ_LOT_SEC}s per player in Blitz</p>
          ) : (
            <Chips options={GAME_RULES.lotDurationOptions.map((t) => ({ value: t, label: `${t}s` }))} value={timer} onChange={setTimer} />
          )}
        </Field>
        <Field label="Mode">
          <Chips
            options={[
              { value: 'CASUAL', label: 'Casual' },
              { value: 'RANKED', label: 'Ranked ⚡' },
            ]}
            value={mode}
            onChange={(v) => {
              setMode(v);
              if (v === 'RANKED') {
                setBudget(GAME_RULES.defaultBudget);
                setFormat('CLASSIC');
              }
            }}
          />
        </Field>
        <Field label="Season mode">
          <Chips
            options={SEASON_LENGTHS.map((n) => ({ value: n, label: n === 1 ? 'Single game' : `${n}-game season` }))}
            value={seasonLength}
            onChange={setSeasonLength}
          />
        </Field>
        <Field label="Visibility">
          <Chips
            options={[
              { value: 'PRIVATE', label: 'Private · code' },
              { value: 'PUBLIC', label: 'Public' },
            ]}
            value={isPublic ? 'PUBLIC' : 'PRIVATE'}
            onChange={(v) => setIsPublic(v === 'PUBLIC')}
          />
        </Field>
      </div>

      {ranked && (
        <p className="-mt-2 mb-4 text-xs text-muted">
          Ranked games change everyone’s ELO and use the Classic format with the standard {GAME_RULES.defaultBudget.toLocaleString()}-coin budget so
          scores are comparable.
        </p>
      )}
      {!draft && (
        <Field label="Auction twists">
          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                ['mystery', '🎁 Mystery lots', 'Some players stay hidden until someone wins them.'],
                ['sealed', '🔒 Sealed bids', 'One secret bid each — highest wins.'],
                ['events', '📰 Market events', Object.values(MARKET_EVENTS).map((e) => e.label).join(', ') + '.'],
                ['cards', '🃏 Power cards', Object.values(POWER_CARDS).map((c) => `${c.emoji} ${c.label}`).join(' · ') + ' — once each.'],
              ] as [keyof Twists, string, string][]
            ).map(([key, label, blurb]) => (
              <label
                key={key}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 text-sm transition ${twists[key] ? 'border-volt/50 bg-volt/[.06]' : 'border-white/10 bg-white/[.02]'}`}
              >
                <input
                  type="checkbox"
                  checked={twists[key]}
                  onChange={(e) => setTwists({ ...twists, [key]: e.target.checked })}
                  className="mt-0.5 h-4 w-4 accent-[#c8ff2e]"
                />
                <span>
                  <span className="font-semibold text-ink">{label}</span>
                  <span className="block text-xs text-muted">{blurb}</span>
                </span>
              </label>
            ))}
          </div>
        </Field>
      )}
      <label className={`mb-6 flex cursor-pointer items-center gap-3 text-sm text-muted ${draft ? 'hidden' : ''}`}>
        <input type="checkbox" checked={antiSnipe} onChange={(e) => setAntiSnipe(e.target.checked)} className="h-4 w-4 accent-[#c8ff2e]" />
        <span>
          <span className="font-semibold text-ink">Anti-snipe</span> — a bid in the last {GAME_RULES.antiSnipe.thresholdMs / 1000}s resets
          the clock to {GAME_RULES.antiSnipe.extendToMs / 1000}s
        </span>
      </label>

      <motion.div whileHover={{ scale: 1.01 }}>
        <Button size="lg" className="w-full" onClick={create} disabled={!comp || busy}>
          {busy ? 'Creating…' : 'Create room'}
        </Button>
      </motion.div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <div className="label mb-2">{label}</div>
      {children}
    </div>
  );
}

function Chips<T extends string | number>({
  options,
  value,
  onChange,
  icon,
}: {
  options: { value: T; label: string; disabled?: boolean; hint?: string }[];
  value: T;
  onChange: (v: T) => void;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            title={o.disabled ? 'Not available yet' : undefined}
            className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
              active ? 'border-volt bg-volt/15 text-volt' : 'border-white/10 bg-white/[.03] text-ink hover:bg-white/[.07]'
            }`}
          >
            {icon}
            {o.label}
            {o.hint && <span className="rounded bg-white/10 px-1 text-[9px] uppercase tracking-wider text-muted">{o.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

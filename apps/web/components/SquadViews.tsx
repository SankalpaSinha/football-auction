'use client';
import { useEffect, useMemo } from 'react';
import { motion } from 'motion/react';
import { GROUP_ORDER, PLAYSTYLES, playstyleOf, POSITION_GROUP, verdictFor, type FormationSlot, type MemberView, type PlayerCard, type SquadEntry } from '@fa/shared';
import { coins, GROUP_LABEL } from '@/lib/format';
import { PlayerAvatar } from './PlayerAvatar';
import { MiniPitch } from './squad/Pitch';
import { Avatar, Coin } from './ui';

const VERDICT_STYLE = { BARGAIN: 'text-emerald-300', FAIR: 'text-muted', OVERPAY: 'text-rose-300' } as const;

function sortSquad(squad: SquadEntry[]) {
  return [...squad].sort(
    (a, b) =>
      GROUP_ORDER.indexOf(POSITION_GROUP[a.player.position]) - GROUP_ORDER.indexOf(POSITION_GROUP[b.player.position]) ||
      b.player.overall - a.player.overall,
  );
}

/** Compact table of a squad: photo, position, name, OVR, price, verdict. */
export function SquadTable({ squad, starters }: { squad: SquadEntry[]; starters?: Set<string> }) {
  if (!squad.length) return <p className="py-4 text-center text-sm text-dim">No players yet.</p>;
  return (
    <table className="w-full table-fixed text-xs">
      <colgroup>
        <col className="w-7" />
        <col className="w-9" />
        <col />
        <col className="w-8" />
        <col className="w-9" />
        <col className="w-16" />
      </colgroup>
      <tbody>
        {sortSquad(squad).map((e) => {
          const v = e.via === 'AUCTION' ? verdictFor(e.price, e.estimatedValue) : null;
          return (
            <tr key={e.player.id} className="border-b border-white/5 last:border-0">
              <td className="py-1 pr-2">
                <PlayerAvatar player={e.player} size={22} />
              </td>
              <td className="py-1 font-bold text-muted">{e.player.position}</td>
              <td className="truncate py-1 pr-2" title={`${e.player.name} · ${PLAYSTYLES[playstyleOf(e.player)].label}`}>
                {e.player.shortName}
                <span className="ml-1 text-[10px] text-dim">{PLAYSTYLES[playstyleOf(e.player)].short}</span>
                {starters && !starters.has(e.player.id) && <span className="ml-1 text-dim">(bench)</span>}
              </td>
              <td className="py-1 pr-2 text-right font-bold num">{e.player.overall}</td>
              <td className="py-1 pr-2 text-right num">{e.price}</td>
              <td className={`py-1 text-right text-[10px] font-bold uppercase ${v ? VERDICT_STYLE[v] : 'text-cyan'}`}>
                {v ?? (e.via === 'PICK' ? 'picked' : e.via === 'TRADE' ? 'traded' : 'auto')}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Sheet showing one manager's squad — available any time during the game. */
export function SquadSheet({
  member,
  squadSize,
  onClose,
  action,
}: {
  member: MemberView;
  squadSize: number;
  onClose: () => void;
  /** Optional button under the header (e.g. propose a trade). */
  action?: React.ReactNode;
}) {
  const spent = member.squad.reduce((s, e) => s + e.price, 0);
  const groups = useMemo(() => {
    const out: Record<string, number> = { GK: 0, DEF: 0, MID: 0, ATT: 0 };
    for (const e of member.squad) out[POSITION_GROUP[e.player.position]]++;
    return out;
  }, [member.squad]);
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
        aria-label={`${member.username}'s squad`}
        initial={{ y: 60 }}
        animate={{ y: 0 }}
        exit={{ y: 60 }}
        transition={{ type: 'spring', stiffness: 320, damping: 30 }}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85dvh] w-full max-w-md flex-col rounded-t-3xl border border-white/10 bg-deep p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:rounded-3xl"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/20 sm:hidden" />
        <div className="mb-3 flex items-center gap-3">
          <Avatar name={member.username} size={40} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-lg font-bold">{member.username}</div>
            <div className="flex items-center gap-1 text-xs text-muted num">
              {member.squad.length}/{squadSize} players · spent {coins(spent)} · <Coin className="h-3 w-3" /> {coins(member.budget)} left
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-white/5" aria-label="Close">
            ✕
          </button>
        </div>
        {action && <div className="mb-3">{action}</div>}
        <div className="mb-3 grid grid-cols-4 gap-1.5 text-center">
          {GROUP_ORDER.map((g) => (
            <div key={g} className="rounded-lg bg-white/[.04] py-1.5">
              <div className="display text-lg font-extrabold num">{groups[g]}</div>
              <div className="text-[9px] font-semibold uppercase tracking-wider text-muted">{GROUP_LABEL[g]}</div>
            </div>
          ))}
        </div>
        <div className="scrollbar-thin -mx-1 flex-1 overflow-y-auto px-1">
          <SquadTable squad={member.squad} />
        </div>
      </motion.div>
    </motion.div>
  );
}

export interface SquadCardData {
  userId: string;
  username: string;
  squad: SquadEntry[];
  lineup?: { formationId: string; slots: (string | null)[]; custom?: FormationSlot[] | null } | null;
  budgetLeft: number | null;
  rank?: number;
  total?: number;
}

const MEDAL = ['🥇', '🥈', '🥉'];

/** Every manager's full squad side by side (results + match history). */
export function AllSquads({ managers, me }: { managers: SquadCardData[]; me?: string }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {managers.map((m) => {
        const players = new Map<string, PlayerCard>(m.squad.map((e) => [e.player.id, e.player]));
        const starters = m.lineup ? new Set(m.lineup.slots.filter((x): x is string => !!x)) : undefined;
        const spent = m.squad.reduce((s, e) => s + e.price, 0);
        return (
          <div key={m.userId} className={`glass rounded-2xl p-4 ${m.userId === me ? 'ring-1 ring-volt/50' : ''}`}>
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <span className="truncate font-bold">
                {m.rank ? `${MEDAL[m.rank - 1] ?? `#${m.rank}`} ` : ''}
                {m.username}
                {m.userId === me && <span className="text-xs text-muted"> (you)</span>}
              </span>
              <span className="shrink-0 text-xs text-muted num">
                {m.total !== undefined && <span className="display mr-2 text-lg font-extrabold text-ink">{m.total.toFixed(1)}</span>}
                spent {spent}
                {m.budgetLeft !== null ? ` · ${m.budgetLeft} left` : ''}
              </span>
            </div>
            {m.lineup && (
              <div className="mx-auto mb-3 max-w-[260px]">
                <div className="label mb-1 !text-[10px]">{m.lineup.formationId}</div>
                <MiniPitch formationId={m.lineup.formationId} custom={m.lineup.custom} slots={m.lineup.slots} players={players} />
              </div>
            )}
            <SquadTable squad={m.squad} starters={starters} />
          </div>
        );
      })}
    </div>
  );
}

'use client';
import { useState } from 'react';
import type { PositionGroup, RoomView } from '@fa/shared';
import { emit } from '@/lib/socket';
import { useGame } from '@/lib/store';

const OPTIONS: { value: PositionGroup | null; label: string }[] = [
  { value: null, label: 'Any' },
  { value: 'GK', label: 'GK' },
  { value: 'DEF', label: 'DEF' },
  { value: 'MID', label: 'MID' },
  { value: 'ATT', label: 'ATT' },
];
const NAMES: Record<PositionGroup, string> = { GK: 'Goalkeepers', DEF: 'Defenders', MID: 'Midfielders', ATT: 'Attackers' };

/** Host: choose which positions come up next. Everyone else: see the current choice. */
export function FocusControl({ room, me }: { room: RoomView; me: string }) {
  const a = room.auction!;
  const toast = useGame((s) => s.toast);
  const [busy, setBusy] = useState(false);
  if (a.freePick) return null;
  const isHost = room.hostId === me;

  if (!isHost) {
    if (!a.focus) return null;
    return (
      <div className="rounded-xl border border-cyan/30 bg-cyan/[.07] px-3 py-2 text-xs">
        <b className="text-cyan">Host filter:</b> {NAMES[a.focus]} only for now
      </div>
    );
  }

  async function pick(group: PositionGroup | null) {
    if (group === a.focus) return;
    setBusy(true);
    const r = await emit('auction:focus', { group });
    setBusy(false);
    if (!r.ok) toast('error', r.error);
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-white/[.03] px-3 py-2 text-xs">
      <span className="font-bold" title="Only you (the host) can change this">
        👑 Next up:
      </span>
      <div className="flex gap-1">
        {OPTIONS.map((o) => (
          <button
            key={o.label}
            disabled={busy}
            onClick={() => pick(o.value)}
            aria-pressed={a.focus === o.value}
            className={`h-7 rounded-md px-2.5 font-bold transition disabled:opacity-50 ${
              a.focus === o.value ? 'bg-volt text-night' : 'bg-white/[.06] text-muted hover:bg-white/10'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      {a.focus && <span className="text-dim">from the next player</span>}
    </div>
  );
}

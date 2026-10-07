'use client';
import { useEffect, useRef, useState } from 'react';
import type { LotView } from '@fa/shared';
import { sound } from '@/lib/sound';
import { serverNow } from '@/lib/store';

/** Remaining ms for the open lot, rendered against the synced server clock. */
export function useCountdown(lot: LotView | null): number {
  const [remaining, setRemaining] = useState(0);
  const lastTick = useRef<string>('');

  useEffect(() => {
    if (!lot) return;
    if (lot.pausedRemainingMs !== null) {
      setRemaining(lot.pausedRemainingMs);
      return;
    }
    let raf = 0;
    const loop = () => {
      const r = Math.max(0, lot.endsAt - serverNow());
      setRemaining(r);
      const sec = Math.ceil(r / 1000);
      const key = `${lot.lotNumber}:${sec}`;
      if (sec > 0 && sec <= 5 && key !== lastTick.current) {
        lastTick.current = key;
        sound.tick(sec <= 3);
      }
      if (r > 0) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [lot]);

  return remaining;
}

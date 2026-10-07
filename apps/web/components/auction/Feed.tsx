'use client';
import { AnimatePresence, motion } from 'motion/react';
import type { FeedItem, FeedKind } from '@fa/shared';

const KIND: Partial<Record<FeedKind, { dot: string; text: string }>> = {
  BID: { dot: 'bg-volt', text: 'text-ink' },
  SKIP: { dot: 'bg-zinc-500', text: 'text-muted' },
  SOLD: { dot: 'bg-gold', text: 'text-gold font-semibold' },
  UNSOLD: { dot: 'bg-zinc-600', text: 'text-dim' },
  AUTO: { dot: 'bg-cyan', text: 'text-cyan' },
  EXTENDED: { dot: 'bg-danger', text: 'text-rose-300 font-semibold' },
  DISCONNECT: { dot: 'bg-amber', text: 'text-amber-200' },
  RECONNECT: { dot: 'bg-emerald-400', text: 'text-emerald-200' },
  HOST: { dot: 'bg-gold', text: 'text-amber-100' },
};

export function Feed({ items, me, className = '' }: { items: FeedItem[]; me: string; className?: string }) {
  const list = [...items].reverse().slice(0, 30);
  return (
    <div className={`scrollbar-thin overflow-y-auto ${className}`}>
      <ul className="space-y-1">
        <AnimatePresence initial={false}>
          {list.map((f) => {
            const k = KIND[f.kind] ?? { dot: 'bg-white/30', text: 'text-muted' };
            return (
              <motion.li
                key={f.id}
                layout
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                className={`flex items-center gap-2.5 rounded-lg px-2 py-1 text-sm ${f.userId === me && f.kind === 'BID' ? 'bg-volt/[.06]' : ''}`}
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${k.dot}`} />
                <span className={`truncate ${k.text}`}>{f.text}</span>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </div>
  );
}

'use client';
import { motion } from 'motion/react';
import { ACHIEVEMENT_BY_KEY, ACHIEVEMENTS, type AchievementTier } from '@fa/shared';

const TIER: Record<AchievementTier, { ring: string; label: string; text: string }> = {
  bronze: { ring: 'border-[#c98a4b]/50 bg-[#c98a4b]/10', label: 'Bronze', text: 'text-[#e4b384]' },
  silver: { ring: 'border-slate-300/40 bg-slate-300/[.08]', label: 'Silver', text: 'text-slate-200' },
  gold: { ring: 'border-gold/50 bg-gold/10', label: 'Gold', text: 'text-gold' },
};

/** Badges earned in one game (results screen). */
export function EarnedBadges({ keys, title = 'Achievements this game' }: { keys: string[]; title?: string }) {
  const defs = keys.map((k) => ACHIEVEMENT_BY_KEY.get(k)).filter((d): d is NonNullable<typeof d> => !!d);
  if (!defs.length) return null;
  return (
    <div>
      <div className="label mb-2">{title}</div>
      <ul className="flex flex-wrap gap-2">
        {defs.map((d, i) => (
          <motion.li
            key={d.key}
            initial={{ opacity: 0, scale: 0.6, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ delay: 0.15 + i * 0.08, type: 'spring', stiffness: 260, damping: 18 }}
            className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${TIER[d.tier].ring}`}
            title={d.description}
          >
            <span>{d.emoji}</span>
            <span className={`font-semibold ${TIER[d.tier].text}`}>{d.title}</span>
          </motion.li>
        ))}
      </ul>
    </div>
  );
}

/** Full collection on the profile: unlocked first, locked greyed out. */
export function AchievementGrid({ unlocked }: { unlocked: { key: string; unlockedAt: string }[] }) {
  const got = new Map(unlocked.map((u) => [u.key, u.unlockedAt]));
  const sorted = [...ACHIEVEMENTS].sort((a, b) => Number(got.has(b.key)) - Number(got.has(a.key)));
  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="display text-2xl font-extrabold">Achievements</h2>
        <span className="text-sm text-muted">
          {got.size}/{ACHIEVEMENTS.length} unlocked
        </span>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {sorted.map((d) => {
          const at = got.get(d.key);
          return (
            <li
              key={d.key}
              className={`flex items-start gap-3 rounded-xl border p-3 ${at ? TIER[d.tier].ring : 'border-white/5 bg-white/[.02] opacity-50 grayscale'}`}
            >
              <span className="text-2xl leading-none">{d.emoji}</span>
              <span className="min-w-0">
                <span className={`block font-bold ${at ? TIER[d.tier].text : ''}`}>{d.title}</span>
                <span className="block text-xs text-muted">{d.description}</span>
                <span className="mt-0.5 block text-[10px] uppercase tracking-wider text-dim">
                  {TIER[d.tier].label}
                  {at ? ` · ${new Date(at).toLocaleDateString()}` : ' · locked'}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

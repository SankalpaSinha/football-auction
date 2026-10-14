'use client';
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CHAT_MAX_LENGTH } from '@fa/shared';
import { emit } from '@/lib/socket';
import { useGame } from '@/lib/store';
import { Avatar } from './ui';

/** Floating room chat: players talk, spectators read. */
export function ChatPanel({ me, canPost }: { me: string; canPost: boolean }) {
  const messages = useGame((s) => s.chat);
  const open = useGame((s) => s.chatOpen);
  const setOpen = useGame((s) => s.setChatOpen);
  const toast = useGame((s) => s.toast);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the newest message in view.
  useEffect(() => {
    if (open) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    const r = await emit('chat:send', { text: t });
    setSending(false);
    if (!r.ok) return toast('error', r.error);
    setText('');
    inputRef.current?.focus();
  }

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.section
            role="dialog"
            aria-label="Room chat"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
            className="fixed inset-x-0 bottom-0 z-50 flex h-[62dvh] flex-col rounded-t-3xl border border-white/10 bg-deep/97 shadow-2xl backdrop-blur-xl sm:inset-x-auto sm:bottom-auto sm:right-5 sm:top-16 sm:h-[460px] sm:w-[360px] sm:rounded-2xl"
          >
            <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <span className="display text-lg font-extrabold">Room chat</span>
              <button onClick={() => setOpen(false)} className="rounded-lg px-2 py-1 text-muted hover:bg-white/5" aria-label="Close chat">
                ✕
              </button>
            </header>

            <div ref={listRef} className="scrollbar-thin flex-1 space-y-2 overflow-y-auto px-3 py-3" aria-live="polite">
              {messages.length === 0 && <p className="py-8 text-center text-sm text-dim">No messages yet. Say hi 👋</p>}
              {messages.map((m) => {
                const mine = m.userId === me;
                return (
                  <div key={m.id} className={`flex gap-2 ${mine ? 'flex-row-reverse' : ''}`}>
                    {!mine && <Avatar name={m.username} size={26} />}
                    <div className={`max-w-[78%] rounded-2xl px-3 py-1.5 text-sm ${mine ? 'rounded-br-md bg-volt/20 text-ink' : 'rounded-bl-md bg-white/[.06]'}`}>
                      {!mine && <div className="text-[11px] font-bold text-muted">{m.username}</div>}
                      <div className="whitespace-pre-wrap break-words">{m.text}</div>
                    </div>
                  </div>
                );
              })}
            </div>

            <form onSubmit={send} className="flex gap-2 border-t border-white/10 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <input
                ref={inputRef}
                value={text}
                disabled={!canPost}
                maxLength={CHAT_MAX_LENGTH}
                onChange={(e) => setText(e.target.value)}
                placeholder={canPost ? 'Message the room…' : 'Spectators can read but not post'}
                aria-label="Chat message"
                className="h-11 min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-3 text-base outline-none placeholder:text-sm placeholder:text-dim focus:border-volt/60 disabled:opacity-50 sm:text-sm"
              />
              <button
                type="submit"
                disabled={!canPost || !text.trim() || sending}
                className="h-11 rounded-xl bg-volt px-4 text-sm font-bold uppercase tracking-wider text-night disabled:opacity-40"
              >
                Send
              </button>
            </form>
          </motion.section>
        )}
      </AnimatePresence>
    </>
  );
}

/** Header button that opens the room chat (shows unread count). Lives next to the sound toggle. */
export function ChatButton() {
  const open = useGame((s) => s.chatOpen);
  const unread = useGame((s) => s.chatUnread);
  const setOpen = useGame((s) => s.setChatOpen);
  const active = useGame((s) => !!s.activeCode);
  if (!active) return null;
  return (
    <button
      onClick={() => setOpen(!open)}
      aria-label={open ? 'Close chat' : `Open chat${unread ? ` (${unread} new)` : ''}`}
      className={`relative grid h-9 w-9 place-items-center rounded-lg transition hover:bg-white/5 ${open ? 'bg-white/10' : ''}`}
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5 text-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden>
        <path d="M4 5h16v11H9l-5 4V5z" />
      </svg>
      {unread > 0 && !open && (
        <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-bold text-white num">
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </button>
  );
}


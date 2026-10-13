'use client';
import { create } from 'zustand';
import type { GameEvent, RoomView } from '@fa/shared';
import type { StoredSession } from './api';

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'replaced' | 'error';

export interface Toast {
  id: number;
  kind: 'error' | 'info' | 'success' | 'warn';
  text: string;
}

interface GameStore {
  session: StoredSession | null;
  sessionLoaded: boolean;
  connection: ConnectionState;
  room: RoomView | null;
  /** Room code of the room page currently on screen; updates for other rooms are ignored. */
  activeCode: string | null;
  roomClosed: string | null;
  /** True once the clock offset has been measured (or seeded from a snapshot). */
  clockSynced: boolean;
  /** serverTime - Date.now() */
  clockOffset: number;
  lastEvent: (GameEvent & { at: number }) | null;
  toasts: Toast[];
  soundOn: boolean;

  setSession(s: StoredSession | null): void;
  setConnection(c: ConnectionState): void;
  setRoom(r: RoomView | null): void;
  setActiveCode(code: string | null): void;
  setRoomClosed(reason: string | null): void;
  setClockOffset(o: number): void;
  pushEvent(e: GameEvent): void;
  toast(kind: Toast['kind'], text: string): void;
  dismiss(id: number): void;
  setSound(on: boolean): void;
}

let toastSeq = 0;

export const useGame = create<GameStore>((set, get) => ({
  session: null,
  sessionLoaded: false,
  connection: 'idle',
  room: null,
  activeCode: null,
  roomClosed: null,
  clockSynced: false,
  clockOffset: 0,
  lastEvent: null,
  toasts: [],
  soundOn: true,

  setSession: (session) => set({ session, sessionLoaded: true }),
  setConnection: (connection) => set({ connection }),
  setActiveCode: (activeCode) => set({ activeCode }),
  setRoom: (room) => {
    const cur = get().room;
    if (room && get().activeCode && room.code !== get().activeCode) return;
    // Until the NTP-style sync finishes, seed the offset from the snapshot's server time.
    if (room && !get().clockSynced) set({ clockOffset: room.serverTime - Date.now() });
    // Ignore out-of-order snapshots for the same room.
    if (room && cur && cur.id === room.id && room.version < cur.version) return;
    set({ room });
  },
  setRoomClosed: (roomClosed) => set({ roomClosed }),
  setClockOffset: (clockOffset) => set({ clockOffset, clockSynced: true }),
  pushEvent: (e) => set({ lastEvent: { ...e, at: Date.now() } }),
  toast: (kind, text) => {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts.slice(-3), { id, kind, text }] });
    setTimeout(() => get().dismiss(id), kind === 'error' ? 3200 : 2600);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setSound: (soundOn) => {
    try {
      localStorage.setItem('fa.sound', soundOn ? '1' : '0');
    } catch {}
    set({ soundOn });
  },
}));

export const serverNow = () => Date.now() + useGame.getState().clockOffset;

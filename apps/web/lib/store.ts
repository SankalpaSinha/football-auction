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
  roomClosed: string | null;
  /** serverTime - Date.now() */
  clockOffset: number;
  lastEvent: (GameEvent & { at: number }) | null;
  toasts: Toast[];
  soundOn: boolean;

  setSession(s: StoredSession | null): void;
  setConnection(c: ConnectionState): void;
  setRoom(r: RoomView | null): void;
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
  roomClosed: null,
  clockOffset: 0,
  lastEvent: null,
  toasts: [],
  soundOn: true,

  setSession: (session) => set({ session, sessionLoaded: true }),
  setConnection: (connection) => set({ connection }),
  setRoom: (room) => {
    const cur = get().room;
    // Ignore out-of-order snapshots for the same room.
    if (room && cur && cur.id === room.id && room.version < cur.version) return;
    set({ room });
  },
  setRoomClosed: (roomClosed) => set({ roomClosed }),
  setClockOffset: (clockOffset) => set({ clockOffset }),
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

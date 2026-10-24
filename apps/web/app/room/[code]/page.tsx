'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { AuctionComplete } from '@/components/AuctionComplete';
import { AuctionScreen } from '@/components/auction/AuctionScreen';
import { Lobby } from '@/components/Lobby';
import { Results } from '@/components/Results';
import { SquadBuilder } from '@/components/squad/SquadBuilder';
import { UsernameGate } from '@/components/UsernameGate';
import { Button, ConnectionBanner, Logo } from '@/components/ui';
import { api, saveSession } from '@/lib/api';
import { emit, ensureConnected, reclaimSession } from '@/lib/socket';
import { useGame } from '@/lib/store';
import type { ChatMessage, RoomView } from '@fa/shared';
import { ChatPanel } from '@/components/ChatPanel';

export default function RoomPage() {
  const params = useParams<{ code: string }>();
  const code = String(params.code ?? '').toUpperCase();
  const router = useRouter();
  const session = useGame((s) => s.session);
  const loaded = useGame((s) => s.sessionLoaded);
  const connection = useGame((s) => s.connection);
  const room = useGame((s) => s.room);
  const roomClosed = useGame((s) => s.roomClosed);
  const removedReason = useGame((s) => s.removedReason);
  const [joinError, setJoinError] = useState<{ code: string; error: string } | null>(null);
  const [watching, setWatching] = useState(false);
  // Don't join until we know whether this visit is to play or to watch (`?watch=1`).
  const [modeResolved, setModeResolved] = useState(false);
  const joinedFor = useRef<string | null>(null);
  const toast = useGame((s) => s.toast);

  useEffect(() => {
    setWatching(new URLSearchParams(window.location.search).get('watch') === '1');
    setModeResolved(true);
  }, [code]);

  // This page owns the screen: forget any previous room and ignore updates for others.
  useEffect(() => {
    const g = useGame.getState();
    g.setActiveCode(code);
    g.setRoom(null);
    g.setRoomClosed(null);
    g.setRemoved(null);
    g.setChat([]);
    g.setChatOpen(false);
    return () => {
      useGame.getState().setActiveCode(null);
      useGame.getState().setRoom(null);
    };
  }, [code]);

  useEffect(() => {
    if (!session) return;
    void ensureConnected(session.token);
  }, [session]);

  // (Re)join — or re-attach as a spectator — whenever the socket (re)connects.
  useEffect(() => {
    if (!session || connection !== 'connected' || !modeResolved) return;
    const key = `${code}:${watching}:${Date.now()}`;
    joinedFor.current = key;
    const loadChat = () =>
      emit<{ code: string; messages: ChatMessage[] }>('chat:history').then((h) => {
        if (h.ok && h.data?.code === code) useGame.getState().setChat(h.data.messages);
      });
    const onFail = (r: { code: string; error: string }) => {
      // Drop any stale view so the error is visible instead of a frozen screen.
      useGame.getState().setRoom(null);
      setJoinError({ code: r.code, error: r.error });
    };
    if (watching) {
      emit<{ role: 'member' | 'spectator' }>('room:spectate', { code }).then((r) => {
        if (joinedFor.current !== key) return;
        if (!r.ok) return onFail(r);
        setJoinError(null);
        void loadChat();
        if (r.data?.role === 'member') setWatching(false);
      });
    } else {
      emit('room:join', { code }).then((r) => {
        if (joinedFor.current !== key) return;
        if (!r.ok) return onFail(r);
        setJoinError(null);
        void loadChat();
      });
    }
  }, [session, connection, code, watching, modeResolved]);

  // Only sign out when the server confirms the session is really gone (not on a hiccup).
  useEffect(() => {
    if (connection !== 'error' || !session) return;
    api.me(session.token).then(
      () => useGame.getState().setConnection('reconnecting'),
      (e) => {
        if (e?.status === 401) {
          saveSession(null);
          useGame.getState().setSession(null);
        }
      },
    );
  }, [connection, session]);

  // A spectator taking an open seat: try it, and stay a spectator if it fails.
  const joinFromWatching = async () => {
    const r = await emit('room:join', { code });
    if (!r.ok) return toast('error', r.error);
    setWatching(false);
  };

  if (!loaded) return null;

  if (!session) return <JoinAsGuest code={code} />;

  if (connection === 'replaced') {
    return (
      <Centered title="Opened in another tab" body="This game is active in another tab or device. You can only play from one place at a time.">
        <Button onClick={() => reclaimSession()}>Play here instead</Button>
      </Centered>
    );
  }

  if (removedReason) {
    return (
      <Centered
        title="You were removed from the game"
        body={`The other managers carried on without you because ${removedReason}. Your players went back into the auction.`}
      >
        <div className="flex flex-wrap justify-center gap-2">
          {/* Full reload so the page starts fresh in watch mode. */}
          <a href={`/room/${code}?watch=1`}>
            <Button>👀 Watch the rest</Button>
          </a>
          <Link href="/">
            <Button variant="secondary">Back to home</Button>
          </Link>
        </div>
      </Centered>
    );
  }

  if (roomClosed) {
    return (
      <Centered title="Room closed" body={`This room has closed (${roomClosed}).`}>
        <Link href="/">
          <Button>Back to home</Button>
        </Link>
      </Centered>
    );
  }

  if (joinError && (!room || room.code !== code)) {
    return (
      <Centered title="Can’t join this room" body={joinError.error}>
        <div className="flex gap-2">
          {joinError.code === 'GAME_IN_PROGRESS' && (
            <Button onClick={() => setWatching(true)}>👀 Watch instead</Button>
          )}
          <Link href="/">
            <Button variant="secondary">Back to home</Button>
          </Link>
        </div>
      </Centered>
    );
  }

  if (!room || room.code !== code) {
    return (
      <Centered title="Entering room…" body={`Room ${code}`}>
        <div className="h-1 w-40 overflow-hidden rounded bg-white/10">
          <div className="h-full w-1/2 animate-[shine_1.2s_linear_infinite] bg-volt" />
        </div>
        <ConnectionBanner />
      </Centered>
    );
  }

  const isMember = room.members.some((m) => m.userId === session.user.id);
  const leave = async () => {
    await emit('room:leave');
    useGame.getState().setRoom(null);
    router.push('/');
  };

  let screen: React.ReactNode;
  switch (room.phase) {
    case 'WAITING_FOR_PLAYERS':
    case 'LOBBY':
    case 'STARTING':
      screen = (
        <Lobby
          room={room}
          me={session.user.id}
          onLeave={leave}
          onJoin={!isMember ? joinFromWatching : undefined}
        />
      );
      break;
    case 'AUCTION':
    case 'PLAYER_SOLD':
      screen = <AuctionScreen room={room} me={session.user.id} />;
      break;
    case 'SQUAD_BUILDING':
      screen = room.squadBuilding?.mine ? (
        <SquadBuilder room={room} me={session.user.id} />
      ) : (
        <SpectatorSquadWait room={room} onLeave={leave} />
      );
      break;
    case 'RESULTS':
    case 'FINISHED':
      screen = room.results ? (
        <Results room={room} me={session.user.id} onLeave={leave} />
      ) : (
        <AuctionComplete room={room} me={session.user.id} onLeave={leave} />
      );
      break;
    default:
      screen = <AuctionComplete room={room} me={session.user.id} onLeave={leave} />;
  }

  return (
    <>
      {screen}
      {!isMember && room.phase !== 'SQUAD_BUILDING' && <SpectatorBadge count={room.spectators} onLeave={leave} />}
      <ChatPanel me={session.user.id} canPost={isMember} />
      <ConnectionBanner />
    </>
  );
}

function SpectatorBadge({ count, onLeave }: { count: number; onLeave: () => void }) {
  return (
    <div className="fixed bottom-4 left-4 z-50 flex items-center gap-3 rounded-full border border-cyan/40 bg-night/90 py-1.5 pl-4 pr-1.5 text-sm backdrop-blur-xl">
      <span className="font-semibold text-cyan">👀 Spectating</span>
      <span className="text-xs text-muted">{count} watching</span>
      <button onClick={onLeave} className="rounded-full bg-white/10 px-3 py-1 text-xs font-bold hover:bg-white/20">
        Stop
      </button>
    </div>
  );
}

function SpectatorSquadWait({ room, onLeave }: { room: RoomView; onLeave: () => void }) {
  const sb = room.squadBuilding;
  return (
    <Centered title="Squad builder" body="The managers are picking formations and starting XIs. Lineups are revealed together once everyone locks in.">
      <ul className="w-full max-w-sm space-y-2 text-left">
        {room.members.map((m) => (
          <li key={m.userId} className="glass flex items-center justify-between rounded-xl px-4 py-2.5">
            <span className="font-semibold">{m.username}</span>
            {sb?.locked[m.userId] ? <span className="text-xs font-bold text-volt">Locked ✓</span> : <span className="text-xs text-muted">Picking…</span>}
          </li>
        ))}
      </ul>
      <p className="text-xs text-dim">👀 {room.spectators} watching</p>
      <Button variant="secondary" size="sm" onClick={onLeave}>
        Stop watching
      </Button>
    </Centered>
  );
}

function JoinAsGuest({ code }: { code: string }) {
  const [info, setInfo] = useState<{ name: string; competition: { name: string }; members: number; maxPlayers: number } | null>(null);
  const [missing, setMissing] = useState(false);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    api
      .room(code)
      .then(setInfo)
      .catch((e) => (e?.status === 404 ? setMissing(true) : setOffline(true)));
  }, [code]);
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6">
      <div className="mb-10">
        <Logo />
      </div>
      <p className="label text-cyan">You’re invited</p>
      <h1 className="display text-5xl font-extrabold">{missing ? 'Room not found' : (info?.name ?? 'Football Auction')}</h1>
      {offline && <p className="mt-2 text-amber-200">Can’t reach the game server right now — you can still sign in below.</p>}
      {info && (
        <p className="mt-2 text-muted">
          {info.competition.name} · {info.members}/{info.maxPlayers} managers · code <span className="font-mono text-ink">{code}</span>
        </p>
      )}
      <div className="mt-8">{missing ? <Link href="/"><Button>Home</Button></Link> : <UsernameGate />}</div>
    </main>
  );
}

function Centered({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-5 px-6 text-center">
      <Logo />
      <h1 className="display text-4xl font-extrabold">{title}</h1>
      <p className="text-muted">{body}</p>
      {children}
    </main>
  );
}

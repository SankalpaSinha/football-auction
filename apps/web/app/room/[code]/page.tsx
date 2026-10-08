'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { AuctionComplete } from '@/components/AuctionComplete';
import { AuctionScreen } from '@/components/auction/AuctionScreen';
import { Lobby } from '@/components/Lobby';
import { SquadBuilder } from '@/components/squad/SquadBuilder';
import { UsernameGate } from '@/components/UsernameGate';
import { Button, ConnectionBanner, Logo } from '@/components/ui';
import { api, saveSession } from '@/lib/api';
import { emit, ensureConnected, reclaimSession } from '@/lib/socket';
import { useGame } from '@/lib/store';

export default function RoomPage() {
  const params = useParams<{ code: string }>();
  const code = String(params.code ?? '').toUpperCase();
  const router = useRouter();
  const session = useGame((s) => s.session);
  const loaded = useGame((s) => s.sessionLoaded);
  const connection = useGame((s) => s.connection);
  const room = useGame((s) => s.room);
  const roomClosed = useGame((s) => s.roomClosed);
  const [joinError, setJoinError] = useState<string | null>(null);
  const joinedFor = useRef<string | null>(null);

  // Fresh page: forget any previous room view.
  useEffect(() => {
    useGame.getState().setRoom(null);
    useGame.getState().setRoomClosed(null);
  }, [code]);

  useEffect(() => {
    if (!session) return;
    void ensureConnected(session.token);
  }, [session]);

  // (Re)join whenever the socket (re)connects. Joining is idempotent for members.
  useEffect(() => {
    if (!session || connection !== 'connected') return;
    const key = `${code}:${Date.now()}`;
    joinedFor.current = key;
    emit('room:join', { code }).then((r) => {
      if (joinedFor.current !== key) return;
      setJoinError(r.ok ? null : r.error);
    });
  }, [session, connection, code]);

  useEffect(() => {
    if (connection === 'error') {
      saveSession(null);
      useGame.getState().setSession(null);
    }
  }, [connection]);

  if (!loaded) return null;

  if (!session) return <JoinAsGuest code={code} />;

  if (connection === 'replaced') {
    return (
      <Centered title="Opened in another tab" body="This game is active in another tab or device. You can only play from one place at a time.">
        <Button onClick={() => reclaimSession()}>Play here instead</Button>
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
      <Centered title="Can’t join this room" body={joinError}>
        <Link href="/">
          <Button>Back to home</Button>
        </Link>
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
      screen = <Lobby room={room} me={session.user.id} onLeave={leave} />;
      break;
    case 'AUCTION':
    case 'PLAYER_SOLD':
      screen = <AuctionScreen room={room} me={session.user.id} />;
      break;
    case 'SQUAD_BUILDING':
      screen = room.squadBuilding?.mine ? (
        <SquadBuilder room={room} me={session.user.id} />
      ) : (
        <Centered title="Squad builder" body="Managers are picking their lineups…" />
      );
      break;
    default:
      screen = <AuctionComplete room={room} me={session.user.id} onLeave={leave} />;
  }

  return (
    <>
      {screen}
      <ConnectionBanner />
    </>
  );
}

function JoinAsGuest({ code }: { code: string }) {
  const [info, setInfo] = useState<{ name: string; competition: { name: string }; members: number; maxPlayers: number } | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    api
      .room(code)
      .then(setInfo)
      .catch(() => setMissing(true));
  }, [code]);
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6">
      <div className="mb-10">
        <Logo />
      </div>
      <p className="label text-cyan">You’re invited</p>
      <h1 className="display text-5xl font-extrabold">{missing ? 'Room not found' : (info?.name ?? 'Football Auction')}</h1>
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

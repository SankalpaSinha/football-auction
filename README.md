# Football Auction

A real-time multiplayer football auction game. 2–6 managers share one budget size, bid on players one at a time, and must each finish with exactly 15 players.

**Status:** Phases 1–6 are done: multiplayer with accounts, the live auction, the squad builder, deterministic scoring, the results experience, and the competitive layer (ranked ELO, leaderboard, profiles, match history, public rooms and matchmaking). Next is Phase 7 (polish: spectator mode, achievements …).

---

## Quick start

Requirements: Node 20+, Docker.

```bash
npm install
npm run db:up                    # PostgreSQL 17 in Docker (port 5433)
cp apps/server/.env.example apps/server/.env
npm run db:migrate               # create tables
npm run db:import                # load data/seed/2026-27 (542 players)
npm run dev                      # server :4000 + web :3000
```

Open http://localhost:3000.

### Playing alone (bots)

1. Create a room in the browser and copy its code.
2. Run `npm run sim -- --join ABC123 --bots 2`. Bots join and ready up.
3. Press **Start auction**.

Run `npm run sim` on its own to watch bots play a whole auction in the terminal.

### Playing with friends on your network

The web app connects to `<same host>:4000`, so a friend on your Wi-Fi can open `http://<your-LAN-IP>:3000`. Next.js prints the address when it starts.

### Accounts

- Players create an account with a unique username (case-insensitive) and a password, then sign in from any browser or device.
- Each device gets its own session token. The browser keeps the token; the database stores only its SHA-256 hash. Signing out ends just that device's session.
- Passwords are hashed with scrypt. Failed sign-ins are rate-limited per IP and username, and an unknown username gets the same error as a wrong password.
- Accounts created before passwords existed are claimed by the first person who signs in with that name and sets a password.

### Tests

```bash
npm test            # 83 tests: auction, lineups, scoring, ELO, accounts, matchmaking, full games over real sockets
npm run typecheck
```

---

## Architecture

```
Browser (Next.js / React)  ──WebSocket (Socket.IO)──▶  Game server (Node)
   renders RoomView                                      RoomManager
   sends intents only                                     └─ Room (state machine)
                                                              └─ Auction (lots, timer, bids)
                                                         PlayerCatalog ◀── PostgreSQL / seed files
                                                         GameStore     ──▶ PostgreSQL (Prisma)
```

- **The server is authoritative.** Clients send *intents* such as `auction:bid {lotNumber, amount}`. The server validates every one: phase, membership, lot number, server clock, budget, reserve, squad rules. It then broadcasts a full `RoomView` snapshot. Clients never compute budgets, ownership or timers.
- **The timer is server-side.** Each lot has an `endsAt` timestamp on the server clock. The server closes the lot. Clients estimate their offset from the server clock (NTP-style) and only *display* a countdown.
- **Live state lives in memory, history lives in Postgres.** A running auction is held in memory, so it's fast with no database round-trip per bid. Every result that matters is written through a per-room ordered queue: rooms, members, games, every lot, every bid, squads.
- **Data comes through one catalog.** The game only sees `PlayerCard` objects from `PlayerCatalog`. Loaders exist for PostgreSQL and the raw seed files. A licensed feed can be added later as another loader.

### Game state machine

```
WAITING_FOR_PLAYERS ⇄ LOBBY → STARTING → AUCTION ⇄ PLAYER_SOLD → SQUAD_BUILDING → FINAL_EVALUATION → (RESULTS → FINISHED)
```

Every action checks the current phase. Formation choice happens inside `SQUAD_BUILDING`, so `FORMATION_SELECTION` isn't used as a separate state. The phases in brackets come with Phase 4–5.

### Competitive layer (Phase 6)

- **ELO** (`packages/shared/src/elo.ts`): every pair of managers in a ranked game is treated as a head-to-head result decided by final rank. Expected scores use the standard 400-point logistic curve. K is 32, or 48 for a player's first 10 games. Each manager beyond two adds 15% to the swing, so a 6-player win is worth more than a 2-player win. Ranked games must use the standard 1,000 budget.
- **Ranked vs casual:** both count towards profile stats (games, wins, podiums, average and best score). Only ranked games change ELO.
- **Public rooms and "Play now":** `match:quick` joins the best open public lobby. It prefers the chosen competition, fuller rooms and, for ranked, the closest average ELO. If nothing matches, it opens a new public room. `GET /api/rooms/public` lists open lobbies.
- **Stats API:** `GET /api/leaderboard?mode=RANKED|CASUAL`, `GET /api/users/:username` (profile, global rank, favourites, recent matches) and `GET /api/matches/:gameId` (ranking, squads, XIs, auction log, report rebuilt from stored scores). These need the database.
- **Pages:** `/leaderboard`, `/u/<username>`, `/match/<gameId>`.

### Results & commentary (Phase 5)

- **Written analysis** (`packages/shared/src/analysis.ts`) is built from the scoring output with fixed rules: a headline, the decisive factor between 1st and 2nd, room awards (biggest bargain, biggest overpay, record signing, best player, best chemistry, tactical mastermind, deepest bench, most frugal) and a verdict for each manager. It needs no AI.
- **AI pundit (optional)**, in `apps/server/src/services/commentary.ts`, runs only when `ANTHROPIC_API_KEY` is set. It receives the already-decided results as JSON and writes one paragraph, using Claude Opus 5.5 at low effort with server-side refusal fallback. The results never wait for it. If it is slow, refuses or fails, the screen simply shows the written analysis. It explains the result and never changes it.

### Scoring (Phase 4)

`packages/shared/src/scoring.ts` holds every weight and threshold in `SCORING_CONFIG`. The server computes the scores; the client only shows a preview.

| Component | Weight | What it measures |
|---|---|---|
| Player quality | 35% | Each starter's role rating, using position-specific attribute weights (ST: shooting/pace, CB: defending/physical, GK: diving/reflexes/handling …) |
| Position fit | 20% | Average fit factor of the XI |
| Tactics | 15% | Formation demands: defensive solidity, pace out wide, midfield control, protection in front of the defence, attacking threat, creativity |
| Chemistry | 10% | Links between neighbouring slots (same club +2, nation +1, league +1, max 3), plus players being in position |
| Squad balance | 10% | Shape of the 15 (GK 1–2, DEF 4–6, MID 4–6, ATT 3–5) and the gap between the defensive, midfield and attacking lines |
| Depth | 5% | Bench quality and positional cover |
| Budget efficiency | 5% | Estimated value received per coin spent |

Ties are broken by quality, then position fit, then fewer coins spent. The tests check that the same squad always scores the same, that chemistry can't lift a weak squad over an elite one, and that a balanced XI beats superstar attackers with a weak spine.

### Squad builder (Phase 3)

- 7 formations in `packages/shared/src/formations.ts`. Each has 11 slots, and slot 0 is the goalkeeper.
- Position fit table in `packages/shared/src/fit.ts`: natural ×1.0, secondary ×0.9, compatible ×0.7, out of position ×0.3, wrong side of the GK line ×0.05. You can change these values freely.
- You have 3 minutes to pick (`squadBuildingMs`). Drafts autosave to the server and stay hidden from opponents. Locking in is validated on the server: 11 of your own players, no duplicates, and a goalkeeper in goal. You can unlock until everyone has locked.
- At the deadline, unfinished lineups are completed by a deterministic best-fit picker that keeps whatever the manager had already placed. All lineups are then revealed together.

### Auction rules (server-enforced)

| Rule | Behaviour |
|---|---|
| Timer | 15/20/30/45 s per lot (default 30), run by the server. |
| Bidding | Opening bid 10, minimum raise 10. Quick buttons +10/+25/+50/+100, or a custom amount. |
| Budget reserve | Max bid = budget − 10 × (empty slots − 1), so a manager can always complete 15. |
| Skip | A manager who skips can't bid on that player. When nobody else can or will bid, the lot closes immediately. |
| Anti-snipe | A bid in the last 3 s resets the clock to 5 s (optional per room). |
| Goalkeepers | A manager's last open slot must be a keeper. A manager who already has a keeper can't buy another if that would leave someone else without one. Keepers are moved forward when someone needs one urgently. |
| Unsold players | Re-offered once after the main pool runs out. If squads are still short, the server auto-assigns the lowest-rated leftovers at the opening price. |
| Disconnects | Squad and budget stay. A disconnected manager counts as passing. The top bidder still wins if they drop at the hammer. If everyone is offline the auction pauses and resumes with at least 5 s on the clock. |
| Host | Moves to the next manager immediately if the host leaves the lobby, or after 10 s if the host disconnects. |
| Abuse | Zod validation on every message, per-socket token buckets (bids 6/s), room-creation limits, one live socket per user, 16 KB message cap. |

Estimated player value (`packages/shared/src/valuation.ts`) only labels a sale as **bargain**, **fair** or **overpay**. It never decides a winner.

### Folder structure

```
apps/server/
  prisma/schema.prisma       relational model (User, Room, Game, Auction, AuctionLot, Bid, Squad, …)
  src/engine/                pure game logic: room.ts, auction.ts, clock.ts, rng.ts, ordering.ts
  src/realtime/              RoomManager — rooms, membership, broadcasting
  src/app.ts                 HTTP + Socket.IO wiring, validation, rate limits
  src/data/                  catalog abstraction, seed loader, DB loader
  src/services/              Prisma user store + game store
  src/scripts/               import.ts (CSV/JSON importer), simulate.ts (bots)
  test/                      engine + websocket tests
apps/web/
  app/                       routes: / (home) and /room/[code]
  components/                Lobby, auction/*, PlayerCard, AuctionComplete
  lib/                       socket client, clock sync, zustand store, sound
packages/shared/             types, protocol schemas, rules, valuation (used by server + client)
data/
  competitions.json          competition definitions + pool rules
  seasons.json
  seed/2026-27/              nations.json, clubs.json, players.csv
```

### Player data

- `data/competitions.json` defines each competition's pool rules: `leagues`, `clubs`, `clubTags` (for example `ucl`), `nations`, `positions`, `minOverall`, and per-season overrides. You can add a competition without changing any code.
- `npm run db:import -- --season 2026-27 --file my-players.json` imports CSV or JSON. Fields can be ids or display names (club, nationality, competition). Players removed from a dataset are marked `INACTIVE`.
- **Player photos** come from Wikimedia Commons through Wikidata (`npm run images:fetch -w @fa/server`). Each photo's author and licence travel with it and are shown in the UI, which the CC licences require. Players without a usable photo get a generated portrait. A licensed photo feed can replace this through `imageUrl` and `imageCredit`.
- **The included dataset is a placeholder.** Ratings are original estimates, not EA FC data, and rosters are a best guess for summer 2026. Player images and club logos are generated (silhouettes in club colours, generic badges). Replace them with a licensed dataset through the importer; `imageUrl`/`logoUrl` are supported. The World Cup nation list and Champions League club flags are also estimates and should be checked.

---

## Roadmap

- [x] **Phase 1:** usernames, private rooms, codes, lobby, ready-up, host transfer, reconnects
- [x] **Phase 2:** player database, seeded pool, server timer, bids, skip, budget reserve, SOLD flow, real-time sync
- [x] **Phase 3:** squad builder: pitch, formations, drag-and-drop XI, bench
- [x] **Phase 4:** deterministic scoring: position fit, chemistry, tactics, balance, depth, efficiency, plus a results screen
- [x] **Phase 5:** results reveal, written match analysis, room awards, best buy and overpay, optional AI commentary
- [x] **Phase 6:** profiles, match history, ELO, leaderboard, ranked mode, public rooms, "Play now" matchmaking
- [ ] **Phase 7:** polish, spectator mode, achievements

Not implemented yet: spectator mode, achievements, tournaments, friends, chat (Phase 7 and later).

Known limitations: live games aren't recovered after a server restart, and the server runs as a single process. A shared store such as Redis would be needed to scale across several processes.

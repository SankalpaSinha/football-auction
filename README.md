# Football Auction

A real-time multiplayer football auction game. 2–8 managers share one budget size, bid on players one at a time, and must each finish with exactly 18 players.

**Status:** All seven phases from the spec are built: multiplayer with accounts, the live auction, the squad builder, deterministic scoring, the results experience, the competitive layer (ranked ELO, leaderboard, profiles, match history, public rooms, matchmaking) and polish (spectator mode, achievements, advanced stats, card effects).

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

Simulator flags: `--bots N`, `--join CODE`, `--mode ranked`, `--public` (so you can watch it under "Live now"), `--names A,B,C` (reuse the same bot accounts so their profiles build up), `--competition id`.


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
npm test            # 95 tests: auction, lineups, scoring, ELO, accounts, matchmaking, spectators, achievements, full games over real sockets
npm run typecheck
```

---

## Deployment

The production image (`Dockerfile`) is a **single service**: the game server also serves the built website, so pages, the API and WebSockets share one domain (no CORS). On every start it runs `prisma migrate deploy` and seeds the player data on the first boot (`import --if-empty`).

**Rehearse locally:** run `docker compose -p fa-prod -f docker-compose.prod.yml up --build`, then open http://localhost:8090.

**Environment variables:**

| Variable | Value |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (required) |
| `TRUST_PROXY` | Number of reverse proxies in front (Railway/Render/Fly: `1`). Leave `0` when exposed directly. Rate limits use the client IP this resolves. |
| `PORT` | Set by the platform (defaults to 8080 in the image) |
| `ANTHROPIC_API_KEY` | Optional: turns on the AI pundit |
| `CLIENT_ORIGIN` | Only if the website is hosted separately |

**Must run as exactly one instance.** Live games are held in memory. A redeploy or restart ends games in progress (players see a clear message, and accounts, stats and finished games are kept). Scaling out needs a shared store such as Redis, which isn't built yet.

**Free hosting: Render + Neon** (`render.yaml` is included):

1. **Neon** (free Postgres, no expiry): create a project, then copy the **direct** connection string (connection pooling off, `?sslmode=require`).
2. **GitHub:** push this repository.
3. **Render:** go to New → Blueprint, pick the repo, and paste the Neon string as `DATABASE_URL`. The first deploy builds the image, runs migrations and seeds the players.
4. Free Render services sleep after 15 minutes without traffic, and the first visit after that takes about a minute to wake. To keep it awake, add a free uptime monitor (for example UptimeRobot) that hits `https://<your-app>.onrender.com/api/health` every 5 minutes. One always-on service fits within Render's 750 free hours a month.

**Railway** (`railway.json` is included): create a project, add PostgreSQL, deploy this folder, then set `DATABASE_URL=${{Postgres.DATABASE_URL}}` and `TRUST_PROXY=1`, and generate a domain.

**Admin:** run `npm run user:set-password -w @fa/server -- <username> <password>` to set or reset a password (for example for accounts created before passwords existed). It also signs that user out everywhere.

Don't point `npm run sim` at production: the bot accounts use predictable passwords.

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

### Room features

- **Live chat:** everyone in a room can chat in every phase (lobby → results), and spectators can read. Messages are plain text, at most 200 characters, rate-limited, and the last 100 are kept in memory.
- **See any manager's squad at any time:** tap a manager in the auction or the squad builder. Lineups stay hidden until the reveal; the players they bought are public.
- **All squads at the end:** the results screen and the match page show every manager's XI, bench and purchases.
- **Player data updates:** on every start the server re-imports `data/` only if the files changed (a SHA-256 fingerprint is kept in the `AppMeta` table). Editing `players.csv`, `clubs.json` or `images.json` and deploying is enough.
- **Free pick:** when only one manager still needs players, nobody can bid against them. The auction switches to free pick: they choose from everyone left at the opening price, with 60 seconds per pick (the best fitting player is picked automatically if time runs out). If they're offline for 60 seconds, their squad is auto-completed.

### Polish (Phase 7)

- **Spectator mode:** `room:spectate` lets a signed-in user watch any room (public games are listed under "Live now", or open `/room/<code>?watch=1`). Spectators get the shared public snapshot, so they never see lineups before the reveal, and they can't act because every action checks membership. The limit is 50 per room.
- **Achievements** (`packages/shared/src/achievements.ts`): 16 badges in bronze, silver and gold. Game achievements are worked out deterministically when a game ends and shown on the results. Career achievements (Hat-trick, Veteran, Elite Manager) are checked against profile totals. Each unlocks once (`UserAchievement`).
- **Profile statistics:** a score trend chart, transfer habits (average spend, bargains and overpays, best bargain, record signing), formation usage, and the achievement collection.

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
| Player quality | 30% | Each starter's role rating, using position-specific attribute weights (ST: shooting/pace, CB: defending/physical, GK: diving/reflexes/handling …). Ratings above 83 count half per point, so stacking superstars has diminishing returns. |
| Position fit | 15% | Average fit factor of the XI |
| Tactical fit | 15% | How well the XI suits the chosen team tactic: 60% from the tactic's attribute demands, 40% from how many starters play a playstyle the tactic is built around. A tactic whose key positions are missing from the formation (say, Wing Play with no wide players) is penalised. |
| Synergy | 12% | Playstyle combos in the XI, for example Wide Crosser + Target Man, playmaker + runner, or Ball Winner + playmaker. Each combo is weighted by the pair's quality, and players out of position don't bring their playstyle. |
| Chemistry | 10% | Links between neighbouring slots (same club +2, nation +1, league +1, max 3), plus players being in position |
| Squad balance | 8% | Shape of the 18 (GK 1–3, DEF 5–7, MID 5–7, ATT 3–6) and the gap between the defensive, midfield and attacking lines |
| Depth | 5% | Bench quality and positional cover |
| Budget efficiency | 5% | Estimated value received per coin spent |
| Secret objectives | +3 each | Each manager gets 2 hidden objectives (drawn from the game seed) and sees only their own until the results |

**Playstyles** (`packages/shared/src/playstyles.ts`) come from a player's position and attributes: Sweeper Keeper, Shot Stopper, Ball-Playing CB, Stopper, Overlapping/Defensive Full-back, Ball Winner, Deep-Lying Playmaker, Box-to-Box, Advanced Playmaker, Shadow Striker, Wide Crosser, Inside Forward, Target Man, Poacher, Pacey Forward and False Nine. They show on the player card during the auction.

**Tactics:** Balanced, Tiki-Taka, Counter-Attack, High Press, Wing Play and Park the Bus. The squad builder shows what each tactic would score with your XI.

**Secret objectives** (`packages/shared/src/objectives.ts`), for example: 3+ starters from one club, XI average age 25 or under, 25% of the budget unspent, no starter rated 86+, 3+ synergy combos, or 8+ different playstyles.

Ties are broken by quality, then position fit, then fewer coins spent. The tests check that the same squad always scores the same, that the tactic changes the score, that combos are detected, and that objectives add their bonus.

### Squad builder (Phase 3)

- 16 formations in `packages/shared/src/formations.ts` (4-3-3, 4-4-2, 4-2-3-1, 3-5-2, 3-4-3, 4-1-2-1-2, 5-3-2, 4-5-1, 4-1-4-1, 4-3-2-1, 4-4-1-1, 4-2-2-2, 3-4-2-1, 3-4-1-2, 5-4-1, 5-2-3). Each has 11 slots, and slot 0 is the goalkeeper.
- Position fit table in `packages/shared/src/fit.ts`: natural ×1.0, secondary ×0.9, compatible ×0.7, out of position ×0.3, wrong side of the GK line ×0.05. You can change these values freely.
- You have 10 minutes to pick a formation, a tactic and your XI (`squadBuildingMs`). Drafts autosave to the server and stay hidden from opponents. Locking in is validated on the server: 11 of your own players, no duplicates, and a goalkeeper in goal. You can unlock until everyone has locked.
- At the deadline, unfinished lineups are completed by a deterministic best-fit picker that keeps whatever the manager had already placed. All lineups are then revealed together.

### Auction rules (server-enforced)

| Rule | Behaviour |
|---|---|
| Timer | 15/20/30/45 s per lot (default 30), run by the server. |
| Bidding | Opening bid 10, minimum raise 10. Quick buttons +10/+25/+50/+100, or a custom amount. |
| Budget reserve | Max bid = budget − 10 × (empty slots − 1), so a manager can always complete 18. |
| Skip | A manager who skips can't bid on that player. When nobody else can or will bid, the lot closes immediately. |
| Anti-snipe | A bid in the last 3 s resets the clock to 5 s (optional per room). |
| Goalkeepers | A manager's last open slot must be a keeper. A manager who already has a keeper can't buy another if that would leave someone else without one. Keepers are moved forward when someone needs one urgently. |
| Unsold players | Re-offered once after the main pool runs out. If squads are still short, the server auto-assigns the lowest-rated leftovers at the opening price. |
| Disconnects | Squad and budget stay, and a manager can rejoin any time: the page reconnects on its own after a network drop, reopening the room link works, and the home page shows a "Rejoin" banner. A disconnected manager counts as passing. The top bidder still wins if they drop at the hammer. If everyone is offline the auction pauses and resumes with at least 5 s on the clock. Rooms live in server memory, so a deploy or restart ends games in progress. |
| Star cap | At most 5 **star players** per squad. Stars are a hand-picked list of real-world household names (Ronaldo, Messi, Neymar, Mbappé, Yamal, Haaland, Kane, Bellingham …, see `packages/shared/src/stars.ts`), not simply high ratings. The cap is enforced on bids, free picks and trades. A purchase is also refused if it would leave any squad unable to finish within the cap or without a keeper. |
| Release | Tap ✕ next to one of your players while lots are being auctioned. The slot opens up again, but you **don't get the coins back**, and the player goes back into the auction. It's refused if you couldn't afford to fill the slot again, or if you hold the top bid and couldn't still pay it. |
| Trades | Tap a manager and choose **Propose a trade**: up to 3 players each way, plus coins in either direction. The other manager has 90 s to accept. Coins only change hands in a trade. Each traded player's new price is what the receiving manager gave up for it, split by estimated value. A trade is refused if a squad would go over 18, someone couldn't afford to finish their squad, a keeper would become impossible to get, or the top bidder couldn't still pay. Offers are private to the two managers, and offers whose players have moved are dropped. Trades and releases stop when free pick starts. |
| Pause | Any manager can ask to pause (⏸ in the top bar). It only happens if every connected manager agrees within 20 s. One "No" cancels it, and the same manager has to wait 30 s to ask again. While paused the lot clock is frozen. Any manager can resume, and it resumes by itself after 5 minutes. If agreed during a sold/unsold reveal, the next lot opens paused. |
| Inactivity | A manager who lets 3 lots in a row run out without bidding or skipping is removed. This only counts lots the manager could afford and that someone else acted on. They're warned after 2 (banner plus 💤 2/3 next to their name), and any bid or skip resets the count. Their players go back into the pool, their coins are gone, and hosting passes on. If only one manager is left, they finish with a free pick. Offline managers are never counted as idle; the disconnect rules cover them. Neither are managers whose screen is locked or app is in the background: the client reports this, and they show as "Away". After 20 s away they're treated like a disconnected manager: lots and pause votes stop waiting for them until they come back. A removed manager can't rejoin that game as a player, but can watch the rest. In ranked games they take a joint-last-place rating loss. |
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
- [x] **Phase 7:** spectator mode, achievements, profile statistics (score trend, transfer habits, formations), 3D card tilt, outbid shake
- [x] **Mobile:** one-tap position picker, native share for invites, Add to Home Screen, no iOS input zoom, responsive results and leaderboard

Future ideas (designed for, not built): tournaments and brackets, friends, chat and voice, replays, daily and weekly challenges, legends, women's football, draft mode, trading.

Known limitations: live games aren't recovered after a server restart, and the server runs as a single process. A shared store such as Redis would be needed to scale across several processes.

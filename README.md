# Solarion — Phase 6 (Character Creation)

A multiplayer browser-based social game by **Re-Launch Studios** — an
original-IP take on the classic Coke Music / Coke Studios loop:
customizable avatars, social rooms, a music mixer, stage performances
with audience voting, a virtual currency, and private decorated rooms.

**Phase 5 is the security + launch-readiness pass** — see the Phase 5
section below for the findings table, the load-test harness, and the
Render deploy shape (`render.yaml`).

**Phase 1** built the foundation: accounts, avatars, the Gateway hub,
one city lobby (Solstice Bay), gateway travel, real-time presence, chat,
and z coins with the daily login bonus.

**Phase 2 is the core loop — music.** Players arrange original,
procedurally-synthesized loops in a 5-slot mixer, save mixes
server-side, queue up at the Solstice Bay stage, perform for the room
with synchronized playback, and earn z coins from audience thumbs-up
votes.

**Phase 3 adds the Casino Lounge** in Solstice Bay: server-authoritative
Texas Hold'em poker (2 tables × 4 chairs, side pots) and slot machines,
ported from the validated Kingdom of Goleon tavern engine and
re-denominated in z coins.

**Phase 4 opens the world up:** all four remaining cities (Neon
District, Cinder Mesa, Frosthaven, Verdant Hollow — each with its own
palette, layout and a working stage), private decorated **studios**
with a furniture catalog, and **avatar editing** after creation.

**Phase 6 is character creation.** Registering now creates only the
account; after login, a dedicated creation screen ("Become someone")
designs the character before the world opens. Male and female
characters with genuinely distinct sprite work, and deep
customization: 10 face shapes, 10 eye styles (+8 eye colors), 10
noses and 10 lip styles **per gender**, 8 skin tones, 10 hair styles
per gender × free color, 6 tops, 5 bottoms per gender (skirt on F),
shoe colors and an accessory layer. One options module
(`src/appearance.js`) drives server validation, the creation screen
and the in-game editor, so the three can never disagree. Existing
v1 accounts migrate in place (schema v2) and skip creation. See the
Phase 6 section below.

## Run it locally

```bash
npm install
npm start            # http://localhost:3000
```

Env vars: `SOLARION_PORT` (default 3000), `SOLARION_DB_PATH`
(default `data/solarion.db`), `SOLARION_TEST=1` (enables a test-only
`debug-teleport` websocket message; never set in production).

Tests (spawns real server processes, full protocol coverage):

```bash
TEST_RUN=1 npm test
```

## Architecture

Stack matches the proven Kingdom of Goleon stack: **Node + Express + ws +
bcryptjs, SQLite via built-in `node:sqlite`, zero native dependencies.**

```
src/db.js       SQLite schema v1: users, avatars, sessions (DB-backed,
                30-day TTL — restarts/crashes never log anyone out)
src/auth.js     register/login, bcrypt hashes, session resolution,
                login rate limiting
src/maps.js     data-driven maps (see below)
src/game.js     world sim: 20 Hz server-authoritative movement
                (clients send input intents only), collision with wall
                sliding, gateway detection, per-map chat (6 msg / 10 s
                limit), daily-bonus claim
src/music.js    Phase 2: the loop manifest (48 original loops) + mix
                validation/persistence (mixes table) + performance-pay
                ledger (perf_earnings table)
src/stage.js    Phase 2: stage queue + performance engine + voting +
                payouts, on its own 250 ms timer
src/casino.js   Phase 3: server-authoritative Texas Hold'em (card
                evaluator, betting rounds, server-computed side pots)
                + slot machine, ported from the validated Goleon
                engine and re-denominated in z coins, on its own
                500 ms timer; atomic z-coin debit/credit guards
src/studio.js   Phase 4: private studios — the furniture catalog +
                studio_items table, the studio template scene, and
                the buy/place/pickup/kick/enter/leave handlers
src/server.js   Express static + /api/register, /api/login, /api/me,
                /api/avatar, /api/music/loops, /health, WebSocket wiring
public/         client: index.html, style.css, sprites.js, client.js,
                mixer.js (Phase 2: Web Audio synth engine, mixer UI,
                stage/queue/vote UI), casino.js (Phase 3: lounge
                panel, poker UI, slots UI with reel animation)
test/test.js    node:test suite (auth, presence, movement, travel,
                bonus, chat, health, restart-survival)
test/music.test.js  Phase 2 suite (catalog, mix CRUD + validation,
                stage flow, voting pay, anti-farm rules, daily cap,
                performer sing-chat)
test/casino.test.js Phase 3 suite (poker hands, side-pot exactness,
                invalid-action rejections, slots math/cooldown/
                proximity, disconnect/map-change cleanup,
                restart persistence + stranded-chip refund)
test/studios.test.js Phase 4 suite (4-city travel + isolation, stage
                in a new city, studio buy/place/persist + restart
                persistence, visitor limits + kick/block, avatar
                editing live + persisted + validation)
test/security.test.js Phase 5 suite (frame caps + fuzz, malformed HTTP,
                reserved names, login lockout, register throttle,
                vote/bonus/slots/poker concurrency races, studio
                ownership, avatar whitelist, untradeable currency,
                debug hooks dead without SOLARION_TEST)
test/creation.test.js Phase 6 suite (creation gate + WS 4403, per-axis
                validation/fuzz, M/F snapshot appearance, editor
                parity + gender-switch normalization, restart
                persistence, v1->v2 migration on a hand-built v1 DB)
test/sprites.test.js Phase 6 suite (pixel-row widths, every axis
                value renders in 3 directions, every face/eye/nose/
                lip/hair/top/bottom option renders distinctly, M != F)
scripts/load-test.js Phase 5 load sanity (~50 concurrent bots)
```

## Phase 2 — music, mixer, stage

### The loop library (no audio files, ever)

Every loop is a **pattern**, not a recording: drum step strings, note
events, chord lists and fx events, all original and all in A minor over
the Am–F–C–G family so any combination stays listenable. The client
synthesizes them live with Web Audio (oscillators + filtered noise).
**48 loops**: 6 genres (Pop / Dance / Hip-Hop / Rock / Latin / Chill) ×
8 (2 drums, 2 bass, 2 melody, 1 pad, 1 fx). The catalog is public:
`GET /api/music/loops`. The server owns the manifest of valid loopIds
(`src/music.js`) and validates every saved mix against it.

### Mix format and rules (server-enforced)

```json
{ "name": "Sunset Jam", "bpm": 112, "bars": 8,
  "tracks": [ { "loopId": "pop-drums-1", "startBar": 0 } ] }
```

Each track's loop tiles (repeats) from its `startBar` to the end of the
mix. Limits: ≤5 tracks, 1–16 bars, bpm 70–160, name ≤40 chars, payload
≤8 KB — so the longest possible mix is 16 bars at 70 bpm ≈ 55 s, under
the 60 s performance cap. Mixes persist in the `mixes` table, **5 slots
per account**, via WebSocket CRUD:

| client → server | server → client |
|---|---|
| `{type:'mix-list'}` | `{type:'mixes', mixes}` (also sent on connect) |
| `{type:'mix-save', slot, data}` | `{type:'mix-saved', mix}` or `{type:'mix-error', error}` |
| `{type:'mix-delete', slot}` | refreshed `{type:'mixes', mixes}` |

The mixer UI (🎵 Mixer button, `public/mixer.js`) is a toy, not a DAW:
pick a slot → EDIT → click a loop to hear it, click a grid row to place
it, ▶ to audition the whole mix, 💾 to save. No piano roll.

### The stage (Solstice Bay)

Solstice Bay's map def carries a `stage` zone — a raised platform at
the north-center of the promenade with two speakers that animate while
someone performs; the audience floor faces it. Protocol:

| client → server | meaning |
|---|---|
| `{type:'stage-join', mixId}` | join this map's stage queue with a saved mix |
| `{type:'stage-leave'}` | leave the queue |
| `{type:'vote', value: 1\|-1}` | vote on the live performance |

| server → client | meaning |
|---|---|
| `{type:'stage-queue', queue, current}` | queue order + who's on, broadcast on every change (and sent on map entry) |
| `{type:'performance-start', performerId, performerName, mix, startAt, durationMs}` | `startAt` = server timestamp + ~1.2 s; every client schedules the same mix locally from it |
| `{type:'performance-end', up, down, earned}` | results, broadcast the moment voting closes |
| `{type:'zcoins', zcoins}` | balance update (sent to the performer when paid) |

Rules, all enforced server-side (`src/stage.js`):

- One queue entry per player; leaving the map or disconnecting
  dequeues you (and ends a live set early). When your turn comes, the
  server walks you to centre stage and flags you `performing` —
  clients draw you holding a mic 🎤.
- **Voting window**: during the performance plus a 10 s grace period
  after the music stops. One vote per listener per performance, no
  self-votes, voters must be in the same map.
- **Pay**: +5 z per thumbs-up, hard-capped at **350 z per day** from
  performance earnings (`perf_earnings` ledger, server-local day).
- **Cooldown**: 60 s before a performer can rejoin a queue.
- **Performer chat**: while performing, your chat is flagged `sing`
  and rendered as a room-wide shout — the performer is the room's
  voice (the Phase 1 per-map chat rate limit stays as the abuse guard).

## Phase 3 — the Casino Lounge (poker + slots)

Solstice Bay's south-west corner is now an enclosed indoor **Casino
Lounge** (dark club-purple floor and wall frame, gold-trim door in the
east wall labelled 🎰 Casino Lounge), built by `makeCasinoLounge()` in
`src/maps.js` — a data builder, not bespoke code, so Phase 4 can drop
an identical lounge into any other city by adding one map field.
Inside: **2 poker tables × 4 chairs** and **4 slot machines** along the
south wall. Their positions ship in `clientMap().casino`.

### Poker (server-authoritative; engine ported from Goleon)

| client → server | meaning |
|---|---|
| `{type:'poker', action:'state'}` | request all table states |
| `{type:'poker', action:'sit', table, chair}` | buy in (50–200z) and sit — you must be in the lounge, near the table |
| `{type:'poker', action:'act', act:'fold\|check\|call\|raise\|allin', amount}` | act on your turn |
| `{type:'poker', action:'stand'}` | fold + cash out |
| `{type:'poker', action:'rebuy'}` | top back up to 200z between hands |

| server → client | meaning |
|---|---|
| `{type:'poker-state', …}` | public table state (chairs, pot, community cards), broadcast on every change |
| `{type:'poker-cards', cards}` | YOUR hole cards only — never broadcast |

Blinds 2z/5z, 25 s turn timer (auto check/fold), 6 s start countdown.
Betting rounds, hand evaluation and **side pots are computed
server-side**; movement is locked while seated. Disconnecting or
leaving the map folds your hand and cashes out your uncommitted chips
immediately — no stuck chips, no phantom seats.

**Currency safety.** Buy-ins, rebuys and slot bets debit with an atomic
`UPDATE … WHERE zcoins >= amount` guard, so a balance can never go
negative, even across racing requests. Live table equity is mirrored
to `avatars.casino_chips` on every mutation; if the server dies
mid-hand, the stranded chips are refunded exactly once at next login.

**Port audit — one real bug found and fixed.** The Goleon `buildPots`
lacked a `Math.max(0, …)` clamp: for a seat committed *below* a pot
level, its contribution went negative once a middle stack level
existed, silently shrinking the top pot (reproduced at 100/50/20
stacks: 140 of 170z paid out). With ≤2 distinct stack levels it never
bites, which is how it survived Goleon's validation. The clamp is in
`src/casino.js`, with a deterministic regression test (exact side-pot
distribution: main 60 / side 60 / side 50) in `test/casino.test.js`.

### Slots

`{type:'slots', action:'spin', bet}` with bets of **5 / 10 / 25z**;
server rolls 3 reels and pays instantly. Any pair pays 2×; three of a
kind pays 3–50× by symbol. 1.2 s spin cooldown stops spam-betting, and
you must be standing at a machine. The paytable (weights + multipliers)
is byte-identical to the Goleon machine — only names/emoji changed —
so the theoretical RTP is unchanged at **0.969**. Fresh simulation
against the ported code (Phase 3): 300,000 spins at each of 5z/10z/25z
measured **0.9710 / 0.9699 / 0.9696**; 900,000 combined spins at 10z
measured **0.9679** and a separate 1,000,000-spin run measured
**0.9661** — all within sampling noise of the Goleon machine's ~0.967.

### Maps are data

`src/maps.js` defines each scene as plain data: a tile grid string
(`#` / `%` / `|` solid, `.` walkable), colors, a spawn point, and
gateway rectangles. Adding a city = adding one definition plus one
gateway entry on the Gateway plaza. The Gateway renders all five
cities as arches — since Phase 4, all five are open.

## Phase 4 — cities, private studios, avatar editing

### Four new cities

| city | one strong read (soul doc §9.21) | stage | return arch |
|---|---|---|---|
| Neon District | night-market glow — dark violet floor, hot-pink neon walls | north | south |
| Cinder Mesa | ember/desert forge — baked orange sand, forge-rock walls | east | south-west |
| Frosthaven | aurora ice — pale blue ice, glacier walls, frozen pond | south | north |
| Verdant Hollow | firefly grove — deep greens, tree clusters, pond | centre | south-east |

Each city def carries the same `stage` data shape Solstice Bay
introduced in Phase 2, and the StageManager registers a stage for
*every* map that defines one — no city is special-cased, so queues,
performances, voting and payouts work identically in all five cities.

### Private studios

Every account owns **one studio**: an instanced scene keyed
`studio:<ownerUserId>`, built from a single cozy template (20×14
tiles, warm wood, door on the south wall). Studios are not in the
static MAPS registry — `Game.sceneFor()` resolves a studio id to the
template on demand, and presence/snapshots/chat key off the scene id,
so a studio behaves exactly like a map for its occupants and is
invisible to everyone else. Studio positions are never persisted as a
respawn point.

| client → server | meaning |
|---|---|
| `{type:'enter-studio', owner}` | enter a studio (owner = username or userId; anyone's studio — public in v1) |
| `{type:'leave-studio'}` | back to the map/position you came from (Gateway if unavailable) |
| `{type:'studio-buy', itemId}` | buy catalog furniture — **own studio only**, atomic debit |
| `{type:'studio-place', instanceItemId, x, y, rot}` | place/move an owned item (tile coords) |
| `{type:'studio-pickup', instanceItemId}` | return a placed item to your inventory |
| `{type:'studio-kick', userId}` | owner only: visitor → Gateway + 10-min re-entry block |

The catalog (`src/studio.js`) holds 14 original items — seating,
tables, a rug, a plant, a lamp, a (decorative in v1) jukebox, a stage
speaker, wall decor including the **gold record** trophy, a neon sign
and a drink dispenser — priced 25–300z. Purchases debit atomically
(`UPDATE … WHERE zcoins >= price`) in the same transaction as the
inventory insert. Placement rules, all server-side: inside the room,
never on the door tile, rotations 0–3, **max 100 placed items**.
Furniture persists in the `studio_items` table across relogs and
server restarts, ships in the entry payload, and placement changes
broadcast live (`studio-furniture`) to everyone in the studio.
Non-owners can never buy, place, pick up or kick — enforced
server-side on every message.

### Avatar editing

`POST /api/avatar` (token-authed) or the in-game
`{type:'avatar-update', …}` changes `hair_style`, `hair_color`,
`body_color` (shirt) and `accent_color` (pants) after creation.
Validation reuses the exact registration sets in `src/auth.js`
(exported as `auth.HAIR_STYLES` / `auth.SKIN_TONES` / `auth.COLOR_RE`)
— one source of truth. The change persists to the avatars row and is
mirrored onto the live player, so the room sees the new look in the
next snapshot with no relog. The client gets a 🎨 Look panel with
style cycling and color swatches, plus a 🏠 Studio panel (catalog,
inventory, tile-click placement, right-click pickup, visit-by-name,
kick list).

### Currency: z coins

Balance lives on the avatar row. **Daily login bonus: +100z**, claimed
atomically in the DB (`UPDATE ... WHERE last_bonus_day <> today`) at
WebSocket connect, so relogging, reconnecting or restarting the server
can never double-pay it. New accounts start at 0 and receive the bonus
on first connect.

## Art direction

Characters and rooms follow the **Coke Music / Coke Studios V-ego
style as a reference**: big expressive heads, compact bodies, isometric
rooms. All artwork is **original, drawn in code** (`public/sprites.js`) —
no Coke or Habbo assets are used, copied or traced.

- **Layered pixel sprites** (20×25 px), composed per avatar:
  skin tone layer → shirt → pants → hair overlay (styles: short, spiky,
  long). Shirt/pants/hair are independent colors; skin comes from 4
  preset tones. Directions: front, back, and profile (mirrored).
- **Isometric rendering**: the client projects the world with a 2:1
  isometric transform — diamond floor tiles, extruded wall blocks,
  depth-sorted sprites with walk-bob, name labels and speech bubbles.

**Deliberate tradeoff**: the *server* movement/collision model stays a
plain top-down grid (the proven Goleon model); only the client renders
isometrically. Movement maths, collision and gateway detection are
projection-independent, so the foundation stays simple and testable
while the presentation reads as a true isometric room. If a later phase
wants true iso pathing/occlusion, it's a client concern only.

## Phase 5 — security + launch readiness

### Findings and fixes (all reproduced before patching)

| # | vulnerability | how it was exploited in testing | fix |
|---|---|---|---|
| 1 | **Any signed-in client could crash the server with one frame.** WS handlers passed wire values (objects/arrays) straight into `node:sqlite`, whose binder throws — e.g. `{type:'stage-join', mixId:{}}` in Solstice Bay killed the whole process. | Fuzz probe: server exit code 1, `/health` dead, all players dropped. | Type-guards at every DB boundary (mixId/instanceItemId must be integers, studio `owner`/`itemId` length-capped, casino actions/amounts validated), strict vote values, + the whole WS dispatch wrapped in try/catch so one bad frame can never kill the server again. |
| 2 | **No WS frame size cap.** `ws` defaults to 100 MB — a huge frame could OOM the process. | 5 MB chat frame was accepted and processed. | `maxPayload: 64 KB` on the WebSocket server + an explicit byte-length check that closes the offending socket (1009); rest of the world unaffected. |
| 3 | **Malformed HTTP bodies → 500 + stack trace.** A numeric login password threw inside `bcrypt.compareSync`, returning Express's HTML error page. | `POST /api/login` with `{"password":12345}` → HTTP 500, bcrypt stack in the body. | Type-guard every inbound value in `auth.login`/`register` before bcrypt/SQLite; malformed bodies → plain JSON 401/400. Also: user-not-found now always runs a dummy compare (constant-time-ish, thwarts enumeration timing). |
| 4 | **No registration throttle.** Unlimited accounts from one IP; each `register` burns a bcrypt hash (CPU DoS) and DB rows. | (By design, not reproduced — mirrors the Goleon precedent.) | Per-IP cap: 20 new accounts/hour (env `SOLARION_REGISTER_LIMIT` / `SOLARION_REGISTER_WINDOW_MS`); over-cap → 429. Bulk-test harnesses opt out via `SOLARION_TEST_NO_ABUSE_LIMITS=1`; the security suite deliberately does NOT set it and exercises the real limit. |
| 5 | **Login lockout was IP-only** (rotating IPs could brute-force one account forever) — and malformed login shapes leaked a 500 (see #3). | Wrong-password hammering trips it; the release path is covered by the suite. | Per-IP **and** per-account lockout: 10 failures in 10 min → timed lockout (default 5 min, env `SOLARION_LOGIN_LOCKOUT_MS`); a successful login clears the streak. |
| 6 | **No reserved usernames** — anyone could register `admin` / `system` / `solarion` and impersonate staff. | Registered `Admin`, `System`, `SOLARION` pre-fix: all accepted. | Case-insensitive reserved-name blocklist (`admin`, `system`, `moderator`, `support`, `root`, …). |
| 7 | **Stale-socket race could evict a live session.** `addPlayer` closes the old socket on reconnect; the old socket's late `close` event then removed the NEW player — and its poker seat (mid-hand cash-out) and stage queue entry. | Reconnect test against the patched code (pre-fix ordering verified by code inspection of the close handler). | Close/error handlers now only `removePlayer` when the closing socket is the player's current one. |
| 8 | **z-coin transfer surface audit (soul doc §9.24: untradeable).** | Sent `transfer`/`give`/`trade`/`pay`/`/give` frames between two accounts. | Confirmed: no message type moves z coins between accounts — unknown types are dropped, balances unchanged. Casino chips can only be cashed out to the same account (`stand`/disconnect), never transferred. |
| 9 | **Poker double-sit / chip leak.** | Rapid duplicate `sit` requests across both tables. | Exactly one seat survives (server-side `findSeatByUser` + atomic debit); cash-out returns only the leaver's own chips; z+chips conserved across accounts in test. |
| 10 | **Vote / bonus / slots payout races.** | 30× hammered duplicate votes, 6 concurrent same-token connects, 25 rapid spins. | One vote per voter per performance (existing `votes` map, now strict-valued); daily bonus is an atomic `UPDATE … WHERE last_bonus_day <> today` — exactly one grant; slot cooldown makes the burst execute exactly once. |

**Regression coverage:** `test/security.test.js` (13 tests, wired into `npm test`): fuzz frames, frame-size cap, no-test-mode debug-hook deadness, stale-socket race, lockout trigger+release, register throttle, vote/bonus/slots concurrency, poker conservation, studio ownership, avatar-update whitelist (unknown fields like `zcoins`/`name` are ignored), untradeable-currency attempts, reserved names, malformed HTTP.

**Debug hooks audit:** the only `SOLARION_TEST`-gated hooks are the three test-only WS messages in `src/server.js` (`debug-teleport`, `debug-seed-perf`, `debug-casino`) plus the abuse-limit test escape hatch in `src/auth.js` (`SOLARION_TEST_NO_ABUSE_LIMITS`, requires both vars) — all verified unreachable with `SOLARION_TEST` unset, and `render.yaml` explicitly leaves it unset. The login-lockout duration and register limits are plain env config with production defaults, not debug hooks.

**Load sanity:** `scripts/load-test.js` — 50 concurrent bots, all moving, chatting, one stage cycle, slot spins, studio visits. Server tick health is now exposed on `/health` (`tick` counters; drift concentrates in the 50-account registration burst, where synchronous bcrypt blocks the loop — same tradeoff as the proven Goleon stack).

### Deploy

`render.yaml` mirrors the Kingdom of Goleon precedent: free plan, `npm install` build, `npm start`, `SOLARION_DB_PATH=./data/solarion.db`, `SOLARION_TEST` unset, `/health` health check. The server already reads Render's injected `PORT`. NOTE (same as Goleon): the free plan has no persistent disk, so the SQLite DB at `./data/` is ephemeral across redeploys/idle-spins unless a disk is added — see the deploy handoff notes.

## Phase 6 — character creation

### The flow

Register → login → **creation screen** → The Gateway. Registration
inserts a placeholder avatar (`created = 0`); `POST
/api/create-character` validates the display name and every axis,
writes the look, and flips `created = 1` — one-shot (a second call
gets 409; later changes go through the look editor). The WebSocket
refuses uncreated accounts with close code **4403**, and the client
routes them back to the creation screen. v1 accounts never see it:
the migration backfills `created = 1`.

### One options module

`src/appearance.js` is the single source of truth for legal looks.
The server validates against it (`auth.createCharacter` /
`auth.updateAvatar` via `appearance.mergeLook`); `GET
/api/appearance` serves it; `public/looks.js` builds BOTH the
creation screen and the in-game 🎨 Look panel from it. Creation and
editing share every list — there is nothing to drift.

| Axis | Options |
| --- | --- |
| gender | M / F (distinct sprite sets, not a palette swap) |
| face | 10 per gender (span-profile head/jaw/cheek geometry) |
| eyes | 10 per gender (incl. lash/winged/wink variants) |
| eye color | 8 |
| nose | 10 per gender |
| lips | 10 per gender (shape + tint) |
| skin tone | 8 (the 4 v1 tones included) |
| hair style | 10 per gender (16 distinct maps) |
| hair / top / bottom color | 12-swatch palettes + custom #rrggbb |
| top style | 6 (tee, hoodie, jacket, tank, sweater, button-up) |
| bottom style | 5 per gender (F includes skirt) |
| shoe color | 8 |
| accessory | none + cap, beanie, glasses, sunglasses, headband |

Switching gender in the editor normalizes per-gender axes that don't
exist for the new gender to its defaults (skirt → pants, ponytail →
short), on both the WS and HTTP paths.

### Sprites

`public/sprites.js` renders parametrically: per-gender face span
profiles, eye/nose/lip pixel patterns, torso templates with per-style
detail (hoodie pocket, jacket opening, button-up collar/buttons,
sweater bands, sleeve lengths), per-gender leg maps, and the
accessory layer last. `test/sprites.test.js` proves every option
renders distinctly — a menu entry that looks like another entry is
a failed test, not a shrug.

### Migration (schema v2)

Column-presence-driven `ALTER TABLE` on `avatars` (the casino_chips
pattern): the ten new columns arrive with defaults; when upgrading a
pre-v2 database, existing rows are marked `created = 1` — a v1
avatar was a finished character. Idempotent; verified against a
hand-built v1-shaped DB in `test/creation.test.js`.

## Stubbed / deferred to later phases

- More Casino Lounges: `makeCasinoLounge()` can build one for any
  city, but the Phase 3 CasinoSystem tracks a single lounge map —
  generalizing it to several lounges is its own task, so Phase 4
  ships without a second lounge rather than destabilizing poker.
- Studio upgrades: multiple rooms per player, room naming/themes,
  sitting on furniture, and the jukebox actually playing visitors'
  mixes (it's decorative in v1)
- Deployment (Fly.io, cheap always-on — per Zan, later)

<!-- deploy-refresh 2026-10-20: force fresh Render instance to clear suspected wedged edge/instance state (POST-body hang investigation). No code change. -->

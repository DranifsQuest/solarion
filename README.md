# Solarion — Phase 10 (The Warm Home Pass: Real Doors + Cozy)

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

**Phase 7 is the world expansion.** Every public scene is ~5× its old
area (the Gateway and the five cities are 72×45 tiles), re-laid-out
with plazas, streets, stages and decor at the new scale. Interiors are
now real scenes behind **doors**: the Casino Lounge off Solstice Bay,
a café off the Gateway, a second grand casino in Neon District, and a
hookah lounge in Cinder Mesa. **Every** scene transfer (gateway
arches and doors alike) runs through a fixed **3-second load screen**:
input is locked server-side, and the client lifts the screen only
once the new scene's first snapshot is in. **Sitting** works on
benches, chairs, sofas, café tables and studio furniture (E key /
Sit button) with a seated sprite variant for both genders. Poker
lives in exactly the two casinos — 6 tables × 4 chairs and 10 slot
machines each, slots in their own section played **sitting on the
machine's stool**. Each casino has a **bar**: the bartender sells
**5z drinks**; the server tracks your count (bubbles, sway and screen
haze scale with it; −1 per minute) and at **10 drinks you pass out
for 20 seconds**, waking at 2. The **hookah lounge** sells **5z
puffs** with a psychedelic screen effect; at **10 puffs you turn
hippy for 20 seconds** (a broadcast appearance override), then your
real look returns. See the Phase 7 notes in `docs/playtest-checklist.md`.

**Phase 8 turns studios into player homes.** The furniture catalog
grows from 14 to **44 items**: 4 beds, 9 sittable chairs & sofas
(the Phase 7 sitting system just works on them), 5 shelves, 6 rugs
(flat, walkable, drawn under everything), more lamps/plants/tables/
wall art, **3 TVs and 3 radios**. Placed TVs and radios are
*devices* with server-side state in a new `studio_devices` table:
TVs have power + 6 fake channels (procedurally drawn shows — news,
soap, cooking, weather, a cartoon, static), and radios play either
the 48-loop library or **the room owner's own saved mixes**, with
server-timestamped starts so the whole room hears the same track
together. Anyone present in the room may work the TV/radio (the
furniture itself stays owner-only). And **room invites**: an owner
can invite any online player from anywhere; accepting rides the
standard 3-second transfer into the room — and a fresh invite is
the one way back in for a kicked visitor. See the Phase 8 section
below.

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

## Phase 8 — player homes (studios, upgraded)

Phase 4's private studio becomes a real home. Everything below is
enforced server-side; the client only sends intents.

### The catalog: 44 items

`src/studio.js` owns the catalog. The original 14 items keep their
ids and prices; Phase 8 adds 30 more. All footprints stay 1 tile —
the furniture system has always been 1-tile, beds included.

| category (`cat`) | count | what's in it |
|---|---|---|
| beds | 4 | Single, Double, Bunk, Canopy (90–220z) |
| chairs | 9 | the Cozy Chair + Cloud Couch, plus Dining Chair, Armchair, Beanbag, Rocking Chair, Bar Stool, Floor Cushion, Loveseat — all type `seating`, so the Phase 7 sitting system works on every one, in homes exactly as in the world |
| shelves | 5 | Bookshelf, Wall Shelf, Display Shelf, Cube Storage, Tall Bookcase |
| rugs | 6 | Sun, Wave, Star, Checker, Rainbow, Moon — type `rug`: flat, walkable, no collision, rendered under furniture and avatars |
| tvs | 3 | Tube TV (150z), Flat TV (260z), Cinema TV (400z) |
| radios | 3 | Boombox (80z), Retro Radio (120z), Hi-Fi System (200z) |
| decor | 14 | tables, plants, lamps (incl. the new Floor Lamp + Cactus + Side Table + Wave Poster), wall art, the jukebox, speaker, dispenser |

Purchases are the same atomic debit + insert as Phase 4; placement
rules are unchanged (inside the walls, never the door tile, rot 0–3,
max 100 placed).

### TVs with fake shows

A placed TV is a **device**: `{ on, channel }` stored per placed
instance in the `studio_devices` table, so it survives relogs and
server restarts and is identical for everyone in the room. Six
channels, all original and drawn procedurally on the TV screen by
the client (no footage, no assets):

| ch | id | show |
|---|---|---|
| 1 | news | **Solarion News 24/7** — anchor, story panel, scrolling ticker, blinking LIVE dot |
| 2 | soap | **Days of Our Tides** — two faces mid-argument, rotating dialogue captions |
| 3 | cooking | **Sizzle & Sun** — a pan, bobbing dinner, rising steam |
| 4 | weather | **Solarion Weather** — spinning sun, drifting cloud, 24° |
| 5 | cartoon | **Captain Comet** — a comet streaking a starfield |
| 6 | static | **Off-Air Static** — honest noise |

Controls (`{type:'home-device', instanceId, action}`): `power`,
`channel-next` / `channel-prev`, `channel-set` (changing channel
wakes the TV). **Documented choice: anyone present in the room** —
owner or visitor — may work the TV. State changes broadcast the
resolved device (`{type:'home-device', ownerId, device}`) to the
whole room and ride along in the studio entry payload.

### Radios: the loop library, or the owner's own mixes

A placed radio is a device too: `{ source, index, playing,
startedAt }`. **Source A** is the game's 48-loop library; **source
B is the room owner's saved mixes** (Phase 2) — the state payload
carries the owner's mix list by name, and for the playing mix the
full mix data, exactly like `performance-start`. Controls: `play`,
`stop`, `next`, `prev`, `source` — same anyone-in-the-room rule as
the TV. Playing an empty mix source is refused (the owner hasn't
saved any mixes yet).

Playback renders client-side over the existing Web Audio engine
(the same `AE` the stage uses). The server stamps each play/track
change with `startedAt = now + 1.2s` (the stage's sync-delay idea):
occupants schedule the track from that instant together, and a
late joiner aligns to the next loop/mix pass on the `startedAt`
grid — approximate to within one pass, exact thereafter. If two
radios in one room play at once, each client sounds only the most
recently started one.

### Room invites

`{type:'studio-invite', username}` invites any **online** player,
from anywhere in the world — the owner needn't be standing in the
room. The invitee gets a prompt (`{type:'studio-invite'}` with the
inviter's name) and answers `{type:'studio-invite-response',
ownerId, accept}` within 60 seconds. Accepting consumes the invite
and runs the ordinary enter flow — the standard **3-second
load-screen transfer** into the owner's instance. An invite is one
transport, not standing access: leaving works as always, the
owner's kick stays absolute, and a kicked visitor's 10-minute block
is lifted **only** by a fresh invite's accept (the kick handler is
otherwise untouched). Declines are reported back to the owner.

## Phase 9 — the adjustments build

Sixteen items, in the order they were built. Two rulings from Zan
govern the phase: **hosting stays on Render** (no Fly.io move), and
**when a mix plays — stage or home radio — everyone in the room
hears it, the creator/performer included.** That second one is now a
tested protocol contract (`test/audibility.test.js`): the server's
`performance-start` / `home-device` broadcasts have never excluded
anyone, and the tests pin identical timing data for performer +
audience. The real-world silence was client-side: an AudioContext
born inside a WebSocket handler starts *suspended* under browser
autoplay rules, and the radio bailed silently if the loop catalog
hadn't loaded yet. Fixes: any pointer/key gesture unlocks the shared
engine, the radio re-syncs when the catalog lands and again after
the scene applies.

### Movement (items 2, 3, 14)

- **Click/tap-to-move**: one `{type:'move-to', x, y}` intent; the
  server routes it (BFS over the tile grid using the same collision
  test as walking, greedy line-of-sight smoothing) and walks the
  route. Solid targets snap to the nearest walkable tile; garbage
  payloads are ignored. Keyboard input cancels the route.
- **Run toggle**: 🚶/🏃 button, ×1.55 speed, both input modes.
- **Touch**: the existing joystick stays; on-screen Sit / Chat /
  World / Friends buttons plus tap-to-move make phones playable.
- **Camera** eases toward the player with a small facing lookahead.
- **Named areas** per map raise a place nameplate on entry
  ("Fountain Plaza", "The Slots", "Casino Corner", …).

### Social (items 4, 6, 7)

- **Friends**: request / accept / decline / remove; the payload
  always carries live presence + current scene.
- **Navigator** (🧭): every public place (hub, cities, interiors,
  both casinos) with live occupant counts and the original's 6-dot
  fullness scale, which friends are where, and the open homes of
  online owners. Travel is the standard 3s transfer. **Join-friend**
  lands you beside your friend through the same transfer.
- **Profiles**: click a player — look preview, their mix titles,
  and wired actions (Add Friend / Join / Visit Home / Invite).
- **Emotes**: 👋 wave, 🕺 dance (anywhere), 😂 laugh, 👍 thumbs-up —
  server-tracked in snapshots; chat bubbles now fade out.

### The performance ritual (items 5, 8, 9)

The Coke loop, restored end to end (soul doc §2/§3):

- **Burn-to-CD**: blank CDs come in **packs of 10 for 20z**
  (`buy-blanks`); `burn-cd` spends one blank on one of your mixes;
  **the stage refuses a performer without a CD of the mix**, and the
  CD is consumed when the set starts. Deleting a mix deletes its CDs.
- The performer still holds the 🎤 mic, their chat still goes
  room-wide as a shout, and the stage speakers still pulse.
- **Trophies**: lifetime up-votes **on one mix** — **25 = Gold
  Record, 100 = Platinum Record** — awarded once each as wall
  furniture in your home inventory. Trophies are *earned*: the shop
  refuses to sell them.
- **Top-40 chart**: mixes ranked by up-votes over the **trailing
  7 days** (ties: fewer down-votes, then more performances) —
  viewable in the Stage panel and via the **Top-40 Chart Poster**
  furniture (60z).
- **Mixer depth**: the loop library grows **48 → 72 loops** (+4 per
  genre across Pop / Dance / Hip-Hop / Rock / Latin / Chill), still
  organized in genre folders; mix **titles** surface on the stage,
  radios, the chart, and profiles. The 5-mix cap, +5z per vote, and
  350z/day performance cap are unchanged.
- **Voting juice**: every vote floats a 👍/👎 over the stage for
  the whole room (`vote-fx` broadcasts); the performer's results
  card already existed — now a strong set (≥3 up, >2:1 ratio) also
  earns synthesized **applause**, a flop earns a groan.

### Homes v2 (item 10)

- **Wall paint** (5 styles) and **floor styles** (4), server-saved
  in `studio_meta`, applied to the room for everyone in it.
- **Expandable size**: Studio 20×14 (free) → **Loft 24×17 (1500z)**
  → **Penthouse 28×20 (4000z)**. Expansion keeps the top-left
  origin, so placed furniture never moves.
- **Home name** (shown on the door/map) and a **lock**: a locked
  home admits only its owner and guests who accepted an invite.

### The bartender's daily (item 11)

The **first drink of the day at either bartender** (Salty Sam or
Vex) is **free, and the house tips you 10z** — server-enforced once
per account per day (`avatars.last_bar_day`), completely
independent of the 100z login bonus. Drinks after that are the
usual 5z; the vice system is untouched.

### Casino social (item 12)

- **Spectators**: poker tables already broadcast their public state
  map-wide; the panel now calls it out — you can follow any hand
  without a seat.
- **Table chat** (`{type:'table-chat'}`): heard only by players
  seated at, or standing within sitting range of, your table.
- **Progressive jackpot, shared by BOTH casinos**: **2% of every
  slot bet** feeds one pool (stored in hundredths of a z so the math
  is exact at every bet size). **Three Suns pay the whole pool**
  instead of the fixed 50× line, then the house reseeds it at
  **250z**. Honest RTP: the fixed paytable alone measures ~0.967;
  diverting 2% of handle into the pool and paying it back (plus the
  250z reseed) on a ~1-in-4096 event makes the long-run effective
  RTP ≈ **0.96**, drifting slightly with the pool's average size.

### Ambient life + sound (items 13, 15)

- **14 named NPCs** wander waypoint loops across the cities and
  interiors (Maple the Guide, DJ Nova, Barista Bea, …) with
  occasional flavor chat. One 500ms world timer; they ride the
  snapshot pipeline and can't be friended/profiled.
- **Day/night**: a server-anchored **12-minute cycle**; nights get a
  world tint with lamp glow at arches, doors, and the stage rig.
  Water and fountain tiles shimmer. Per Zan's standing aesthetic —
  **cozy, warm, golden** — the night tint is warm plum rather than
  cold navy, golden hour washes the world amber at sunrise/sunset,
  and the indoor ambience beds are filtered low and warm. A fuller
  cozy pass (fireplaces, seating nooks, warm UI accents) is scoped
  as the next phase's headline, not snuck in here.
- **Sound**: synthesized UI clicks, a door chime on arrival,
  per-zone ambient beds (surf at the Bay, casino hush, café warmth),
  applause — all on the shared engine, with **volume + mute
  persisted on the device**.

### Cold start (item 16)

The free-tier server sleeps; the first thing a visitor sees is now
a **waking screen** — progress bar, live status, and rotating
gameplay tips — that hands off to the world when the first snapshot
lands, and returns with "Reconnecting…" if the socket drops.
Never a dead page.

## Phase 10 — the Warm Home pass (real doors + cozy)

Zan's ruling, verbatim in spirit: doors must be REAL doors that
open — "not lil SPACES that warp" — and the whole place should feel
like a warm, fun home. Phase 9 tuned the tints; this phase builds
the substance.

### Real doors, everywhere

- **Every door renders as a door**: a framed wooden door (posts,
  lintel, paneled leaf, brass knob) with a welcome mat and its name
  hung over the lintel like a welcome sign. The old flat pad +
  🚪-emoji rendering is gone — no glowing warp tiles remain.
- **They open**: the swing is proximity-driven and visible to
  everyone — as any player approaches, the leaf swings open (a soft
  synthesized creak plays for those nearby) and closes behind them.
  The scene transfer still fires server-side on the door tile and
  the 3s lock is unchanged — the sequence masks the swap: door
  opens → you step into the darkened threshold → the **warm load
  screen** (dark wood, a flickering lantern, the destination's name
  as the welcome sign, "come on in — the fire's lit…") → you arrive
  inside, where the destination's door starts open and swings shut
  behind you.
- **Your front door stands in the world**: the Gateway's west block
  now carries a dressed door labelled **My Home** (lanterns flank
  the walkway at Homes Corner). Stepping through takes you into
  your own studio; inside, your home's own door — nameplate with
  your home's name, mat, lamp beside it, night glow — is a real
  door too: **walk onto its tile to leave**, landing back outside
  your front door (never on its pad, so it can't bounce you in).
  The old Leave button still works.
- **Conversion list** (all verified both directions by the suite /
  live harness): Gateway ⇄ Café, Solstice Bay ⇄ Casino Lounge,
  Neon District ⇄ Neon Casino, Cinder Mesa ⇄ Hookah Lounge, and
  Gateway ⇄ your home. Gateway arches remain arches — portals by
  design — and keep their chime; doors get the door sound.

### Cozy substance

- **Fireplaces**: a **Fireplace** furniture item (**300z**) with an
  animated three-tongue flame, a warm glow radius at night, and the
  crackle (below). Fixed hearths with hearth-side seats anchor the
  **Gateway Café** and the **Hookah Lounge** — both gain a named
  area, **The Hearth Corner**.
- **Seating nooks**: rug + lamp + sofa/chair clusters dressed into
  the Gateway (fountain + café corner), Solstice Bay boardwalk,
  Neon market square, Cinder forge plaza, Frosthaven pond shore,
  and the Verdant grove — every cluster includes real sittable
  seats.
- **String lights + lanterns**: **String Lights (65z)** and **Porch
  Lantern (50z)** for homes; lanterns and string lights also dress
  the public maps. All of them — plus placed lamps and fireplaces —
  punch warm holes in the night through the lamp-glow pass, as does
  a home's own door.
- **Hearth-crackle ambience**: a synthesized fire bed (brown-noise
  body + randomized soft pops) that follows the fire — always on in
  the café and hookah lounge, and in any home with a placed
  fireplace. It rides the shared volume/mute like everything else.
- **Warm UI**: the HUD/panel palette moved from slate blue to
  amber/wood (warm browns, gold accents kept, body text unchanged
  for contrast); the auth card, creation screen, and wake screen
  got the same treatment; the wake bar burns amber now.
- **Warm home defaults**: new homes already default to **Warm Wood
  walls + Classic Wood floors** — now asserted by test so it can't
  quietly regress.

### Honest scope notes

- There is no per-player house *facade row*: homes are instanced
  interiors reached through your Gateway front door, visits, invites,
  and the Navigator. What the world shows is your named, dressed,
  glowing front door — the strongest version the studio-entry
  architecture supports without faking a neighborhood.
- Door swings are client-rendered from the same snapshot positions
  the server already broadcasts; the transfer/lock protocol is
  untouched, so every Phase B door guarantee still holds verbatim.

## Stubbed / deferred to later phases

- More Casino Lounges: `makeCasinoLounge()` can build one for any
  city, but the Phase 3 CasinoSystem tracks a single lounge map —
  generalizing it to several lounges is its own task, so Phase 4
  ships without a second lounge rather than destabilizing poker.
- Studio upgrades: multiple rooms per player, and the jukebox
  actually playing visitors' mixes (Phase 8 radios play the room
  *owner's* mixes; guest mixes are the natural next step). Naming,
  themes, sizes and locks shipped in Phase 9 (Homes v2, above).
- Late-joiner stage sync: walking into a performance mid-set hears
  it from the next pass on radios (grid-aligned), but stage sets are
  heard from the top only if you were present at the start.
- Deployment (Fly.io, cheap always-on — per Zan, later)

<!-- deploy-refresh 2026-10-20: force fresh Render instance to clear suspected wedged edge/instance state (POST-body hang investigation). No code change. -->

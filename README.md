# Solarion — Phase 2 (Music: mixer + stage performances)

A multiplayer browser-based social game by **Re-Launch Studios** — an
original-IP take on the classic Coke Music / Coke Studios loop:
customizable avatars, social rooms, a music mixer, stage performances
with audience voting, a virtual currency, and private decorated rooms.

**Phase 1** built the foundation: accounts, avatars, the Gateway hub,
one city lobby (Solstice Bay), gateway travel, real-time presence, chat,
and z coins with the daily login bonus.

**Phase 2 is the core loop — music.** Players arrange original,
procedurally-synthesized loops in a 5-slot mixer, save mixes
server-side, queue up at the Solstice Bay stage, perform for the room
with synchronized playback, and earn z coins from audience thumbs-up
votes. Poker, slots, private rooms and the remaining cities land in
later phases.

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
src/server.js   Express static + /api/register, /api/login, /api/me,
                /api/music/loops, /health, WebSocket wiring
public/         client: index.html, style.css, sprites.js, client.js,
                mixer.js (Phase 2: Web Audio synth engine, mixer UI,
                stage/queue/vote UI)
test/test.js    node:test suite (auth, presence, movement, travel,
                bonus, chat, health, restart-survival)
test/music.test.js  Phase 2 suite (catalog, mix CRUD + validation,
                stage flow, voting pay, anti-farm rules, daily cap,
                performer sing-chat)
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

### Maps are data

`src/maps.js` defines each scene as plain data: a tile grid string
(`#` / `%` / `|` solid, `.` walkable), colors, a spawn point, and
gateway rectangles. Adding a city = adding one definition plus one
gateway entry on the Gateway plaza. The Gateway already renders all
five planned cities as arches — Neon District, Cinder Mesa, Frosthaven
and Verdant Hollow are sealed until their maps exist.

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

## Stubbed / deferred to later phases

- Private decorated rooms + furniture catalog
- Poker tables + slot machines (port the triple-validated Goleon tavern
  systems; re-denominate in z coins)
- Remaining cities: Neon District, Cinder Mesa, Frosthaven, Verdant Hollow
- Avatar editing after creation (appearance is set at registration)
- Deployment (Fly.io, cheap always-on — per Zan, later)

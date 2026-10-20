# Solarion — Phase 1 (Foundation)

A multiplayer browser-based social game by **Re-Launch Studios** — an
original-IP take on the classic Coke Music / Coke Studios loop:
customizable avatars, social rooms, a music mixer, stage performances
with audience voting, a virtual currency, and private decorated rooms.

**Phase 1 is the foundation only**: accounts, avatars, the Gateway hub,
one city lobby (Solstice Bay), gateway travel, real-time presence, chat,
and z coins with the daily login bonus. No mixer, stage, poker or slots
yet — those land in later phases.

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
src/server.js   Express static + /api/register, /api/login, /api/me,
                /health, WebSocket wiring
public/         client: index.html, style.css, sprites.js, client.js
test/test.js    node:test suite (auth, presence, movement, travel,
                bonus, chat, health, restart-survival)
```

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

- Music mixer + stage performances + audience voting (currency sink #1)
- Private decorated rooms + furniture catalog
- Poker tables + slot machines (port the triple-validated Goleon tavern
  systems; re-denominate in z coins)
- Remaining cities: Neon District, Cinder Mesa, Frosthaven, Verdant Hollow
- Avatar editing after creation (appearance is set at registration)
- Deployment (Fly.io, cheap always-on — per Zan, later)

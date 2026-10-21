# The Bake Shop — Solarion build tooling

Tooling that makes art/map-heavy phases faster: **see** your work
instead of drawing blind, **catch** layout bugs in seconds instead
of in a 6-minute suite, and **compose** buildings/props from parts
instead of hand-drawing every facade.

Everything here is dev-only. The preview routes exist solely under
`SOLARION_TEST=1`; the factory is a plain client library the next
bake imports when it wants it. Node stdlib only, like the rest of
the codebase.

## 1. Preview renderer — `npm run preview`

```bash
npm run preview                    # every map, day + night
npm run preview -- solstice-bay    # one map
npm run preview -- --phase night   # one phase only
npm run preview -- --factory       # + the factory demo scene
```

Output lands in `previews/<map>-day.png` / `<map>-night.png`
(gitignored). The viewport is 2800×1500, which frames a whole
72×45 isometric map at the client's ZOOM 0.72.

**How it works** (this is the real client, not a re-drawing):

1. `scripts/preview.mjs` boots `src/server.js` with
   `SOLARION_TEST=1` on a scratch port + throwaway DB, and a
   daemonized headless Chromium driven over CDP (via the repo's
   existing `ws` dependency — no new deps).
2. In test mode only, the server registers preview routes:
   - `GET /preview-data/:mapId?phase=…` — a synthetic `hello`
     payload built from the SAME code the live hello uses:
     `clientMap()` for the map, the `publicPlayer` field shape for
     three dressed sample characters standing on standable tiles
     near the map centre (found with the game's own `collides()`),
     and a `dayCycle` anchor pre-shifted so the world clock reads
     full day (phase 0.25) or deep night (phase 0.70, lamp-glow
     pass lit). It sends `Access-Control-Allow-Origin: *` (see 3).
   - `GET /preview/:mapId?phase=…` — the same thing as an HTML
     page, for a human dev on a normal machine.
3. The driver generates the preview page to a temp file — the real
   `public/index.html` plus an injected config — and loads it from
   **file://**. Why: this VM's Chromium blocks navigations to
   http://localhost under Local Network Access checks
   (`ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS` — the initiator
   is classified "public", and the one-shot `chrome --screenshot`
   CLI hangs here anyway). A file:// page is a LOCAL initiator, so
   only the JSON hello crosses http, as a local→local fetch.
   `public/preview.js` feeds that payload through the client's OWN
   message handler (`handle(hello)` + `handle(snapshot)`), so
   `public/client.js`'s `draw()` renders the frame — tiles, doors,
   props, casino, stage, day/night tint, everything. It hides HUD
   chrome via CSS for a clean shot; the world pixels are
   untouched.
4. Each shot waits for the page's exact title
   (`preview:<map>:<phase>`) before capturing, so a slow navigation
   can't photograph the previous map. A screenshot under 20 KB is
   treated as a failure (blank/broken frame) and the run exits 1.

Studios (player homes) are dynamic instances, not `MAPS` entries,
so they aren't previewed; the 10 static maps are.

**First catch (why this tool exists):** the very first preview run
showed the Gateway Café and Hookah Lounge fractured into smeared
double images while every other map was clean. Bisecting with the
tool pinned it to the 'hearth' prop: `drawHearthAt` in client.js
called `ctx.ellipse()` with 6 arguments instead of 7 (missing
rotation), which throws every frame — aborting `draw()` before its
`ctx.restore()`, so the camera transform accumulated and the
canvas smeared. Any interior with a hearth (and any player home
with a placed fireplace — the same function) was broken at
runtime. **Fixed on this branch: `public/client.js` line 208**
(one argument). The café preview now shows the flame for the
first time.

## 2. Dressing validator — `npm run validate:maps`

Reads `src/maps.js` directly and exits 1 with an itemized report
on:

- ragged tile rows, unknown tile characters;
- a spawn point inside a solid tile (the game's `collides()`);
- any door/gateway rect entirely on solid tiles, unreachable from
  the map's spawn (tile BFS over the game's walkable set), or whose
  centre a player cannot stand on;
- door/gateway targets that don't exist, or one-way portals (no
  door/gateway in the target map points back);
- a door's `targetSpawn` landing inside a solid tile, or inside a
  door/gateway rect in the target map (the bounce-back bug class);
- props or seats overlapping door/gateway tiles; seats embedded
  in solid tiles; casino slot/bar interact spots in solid tiles.

Warnings (Zan's standing rules, as far as the data supports):
an interior map with ≠ 1 inbound door (exactly one facade
entrance), and an exterior door with no adjacent solid tile (no
building face — a floating door). The dynamic home door
(`studio:self`) is noted and skipped for pairing, since studios
are instanced at runtime.

Tile BFS is a tile-level approximation of the game's circle
collision; spawn/landing/centre checks use `collides()` itself.
Current status: **PASS — 10 maps, 0 errors, 0 warnings.**

## 3. Asset factory — `public/factory.js`

Parametric parts in the Phase 10 style language (framed wood
`#4a3423`, door leaf `#8a5a2b`, brass `#ffd23f`, warm lit glass
`#ffca7a`), dual browser/Node export exactly like `sprites.js`
(`window.SolarionFactory` / `module.exports`). Every function
takes the 2D context first and draws in projected screen space at
a ground anchor — the same convention as client.js's own draw
pass, so a bake can call them straight from a draw function:

| Part | Call | Notes |
| --- | --- | --- |
| Building | `makeBuilding(ctx, cx, cy, { w, floors, wall, roof, sign, lit, windows })` | Two-tone wall (iso corner at centre seam), pitched gable roof, lit window grid, Phase 10 door with lintel sign. Returns `{ w, h, door }`. |
| Cabinet | `makeCabinet(ctx, cx, cy, { body, marquee, screen, reels, label })` | Chunky arcade body, bulb marquee, angled glass screen with reels + shine, coin panel. Returns `{ w, h }`. |
| Tree | `makeTree(ctx, cx, cy, { size, canopy, trunk, fruit })` | Tapered trunk, three-shade layered canopy. |
| Lamp | `makeLamp(ctx, cx, cy, { lantern })` | Post + warm head. **Returns the glow anchor** `{ x, y, r }` — feed it to the night pass ('lighter' radial gradient) like client.js does for map lamps. |
| Planter | `makePlanter(ctx, cx, cy, { box, hw, flowers })` | Iso box, soil top, foliage + flower dots. |
| Sign | `makeSign(ctx, cx, cy, { text, board, w })` | Two posts, framed board, brass nails, warm text. |

Helpers exported too: `proj`, `diamond`, `shade`, `PALETTE`,
`ZOOM` (mirrors client.js's projection constants).

Proof scene: `scripts/factory-demo.html` composes a café building,
two cabinets, trees, a planter, a sign and a glowing lantern on an
iso ground patch with two real avatar sprites for scale.
Screenshot it with `npm run preview -- --factory`
(→ `previews/factory-demo.png`). It is generated to a temp file
and loaded from file:// by the driver, like the map previews —
there is no server route for it. Note for future parts:
`factory.js` must not declare a top-level `const API` —
`sprites.js` already does, and classic scripts share one lexical
scope (the demo caught exactly that collision).

## Test-mode-only guarantee

The preview routes are registered inside
`if (TEST_MODE)` in `src/server.js`, where
`TEST_MODE = process.env.SOLARION_TEST === '1'`. Without that env
var the routes never exist — they 404 like any unknown path, and
`public/preview.js` is inert (nothing in the normal client loads
it; it no-ops without the injected `window.__PREVIEW_CFG__`).
Verified by booting the server WITHOUT `SOLARION_TEST` and
confirming `/preview/the-gateway` and `/preview-data/the-gateway`
return 404 while `/health` stays 200.

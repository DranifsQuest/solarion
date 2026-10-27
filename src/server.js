'use strict';

/**
 * Solarion — HTTP + WebSocket server (Phase 1).
 *
 *   POST /api/register  { username, password, body_color, accent_color }
 *   POST /api/login     { username, password }          -> { token, avatar }
 *   POST /api/me        { token }                       -> { avatar }
 *   GET  /health                                        -> status + counts
 *   WS   /ws?token=...                                  -> game protocol
 *
 * Game messages (client -> server):
 *   { type: 'input', keys: { up, down, left, right } }
 *   { type: 'chat', text }
 *   { type: 'debug-teleport', x, y }   (SOLARION_TEST=1 only)
 * Phase 2 (music/stage) messages:
 *   { type: 'mix-list' } -> server sends { type: 'mixes', mixes: [...] }
 *   { type: 'mix-save', slot, name, data } -> { type: 'mix-saved', mix } |
 *       { type: 'mix-error', error } (followed by a refreshed mix list)
 *   { type: 'mix-delete', slot }
 *   { type: 'stage-join', mixId }   (player must be in the stage's map)
 *   { type: 'stage-leave' }
 *   { type: 'vote', value: 1 | -1 } (during a performance or the 10s grace)
 * Phase 3 (casino) messages:
 *   { type: 'poker', action: 'state'|'sit'|'stand'|'rebuy'|'act', table, chair, act, amount }
 *   { type: 'slots', action: 'info'|'spin', bet }
 * Phase 4 (cities / studios / avatar editing):
 *   POST /api/avatar  { token, hair_style, hair_color, body_color, accent_color }
 *   { type: 'avatar-update', hair_style, hair_color, body_color, accent_color }
 *   { type: 'enter-studio', owner }  { type: 'leave-studio' }
 *   { type: 'studio-buy', itemId }  { type: 'studio-place', instanceItemId, x, y, rot }
 *   { type: 'studio-pickup', instanceItemId }  { type: 'studio-kick', userId }
 *   { type: 'studio-state' }
 * Phase 8 (player homes) messages:
 *   { type: 'home-device', instanceId, action, channel?, source? }
 *       -> room broadcast { type: 'home-device', ownerId, device }
 *   { type: 'studio-invite', username } -> invitee gets { type: 'studio-invite' }
 *   { type: 'studio-invite-response', ownerId, accept }
 *
 * Game messages (server -> client):
 *   hello / map / snapshot / chat / notice / bonus / zcoins
 *   mixes / mix-saved / mix-error
 *   stage-queue / performance-start / performance-end / vote-ack
 *   poker-state / poker-cards / slot-result / slot-info
 */

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const auth = require('./auth');
const appearance = require('./appearance');
const { Game, localDay, DAY_CYCLE } = require('./game');
const { MAPS, clientMap } = require('./maps');
const { seasonAt, SEASONS } = require('./seasons');
const { q } = require('./db');
const music = require('./music');
const { StageManager } = require('./stage');
const { ClubSystem } = require('./club');
const casinoModule = require('./casino');
const { CasinoSystem } = casinoModule;
const { BlackjackSystem } = require('./blackjack');
const studioModule = require('./studio');
const { StudioSystem } = studioModule;
const socialModule = require('./social');
const { SocialSystem } = socialModule;
const recordsModule = require('./records');

music.init();
casinoModule.initLedger();
studioModule.init();
socialModule.init();
recordsModule.init();

const PORT = parseInt(process.env.SOLARION_PORT || process.env.PORT || '3000', 10);
const TEST_MODE = process.env.SOLARION_TEST === '1';

const app = express();
// Friend-launch fix: the production host (Render) fronts this process
// with ONE proxy hop that sets X-Forwarded-For. Without trusting that
// hop, req.ip is the proxy's own address for EVERY visitor, so
// auth.js's per-IP registration throttle and per-IP login lockout
// would lump all players into a single shared bucket — 20
// registrations/hr TOTAL across all friends, and one person's typos
// locking everyone out for 5 minutes. Trust exactly one hop (the
// platform proxy); direct local/test traffic sends no XFF and is
// unaffected.
app.set('trust proxy', 1);
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
// Phase 5: malformed / oversized JSON bodies get a clean JSON 4xx,
// never Express's default HTML error page (which leaks a stack trace).
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large' || err.status === 400 || err.status === 413)) {
    return res.status(err.status === 413 || err.type === 'entity.too.large' ? 413 : 400).json({ ok: false, error: 'Bad request body.' });
  }
  return next(err);
});

const game = new Game();
const startedAt = Date.now();

// Stage per map that has one; performance engine runs on its own timer.
const stages = new StageManager(game);
for (const [mapId, map] of Object.entries(MAPS)) {
  if (map.stage) stages.registerMap(mapId, map.stage);
}
// Phase 3: casino (poker + slots) — tables/slots come from map casino
// defs, so future cities with a lounge get tables for free.
const casino = new CasinoSystem(game);
casino.initFromMaps(MAPS);
// v1.5: blackjack — one converted table per casino (src/blackjack.js).
// The two systems share the chips ledger, so each refuses the
// other's seated players (one stack per player, one mirror row).
const blackjack = new BlackjackSystem(game);
blackjack.initFromMaps(MAPS);
blackjack.pokerSeated = (userId) => casino.isSeated(userId);
casino.blackjackSeated = (userId) => blackjack.isSeated(userId);
// v1.4: Club Mirage — dancer tips (the drinks ride game.js's
// shared bar/vice path; the club def comes from the map data).
const club = new ClubSystem(game);
club.initFromMaps(MAPS);
// v1.9: the Visitors — Orenius at the Gateway, Agent Sims in
// Elsewhere, and the Threshold's portal scene (src/visitors.js).
const { VisitorSystem } = require('./visitors');
const visitors = new VisitorSystem(game);
const { SkySystem } = require('./sky');
const sky = new SkySystem(game);
// Phase 4: private studios — instanced scenes (see studio.js). No
// per-studio registration anywhere: game.js resolves `studio:<id>`
// scene ids on demand, and this system only handles studio messages.
const studios = new StudioSystem(game);
game.studioSystem = studios; // Phase 10: portal routing (home door / studio door exit)
game.stageSystem = stages;   // v1.2 (Item A): the sim asks it who owns the stage
// Phase 9: friends / navigator / profiles (needs studios for home travel).
const social = new SocialSystem(game, studios);
// Phase 9: trophy fanfare — the record lands in the performer's home
// inventory; tell them (and refresh the inventory if they're home).
stages.onTrophy = (userId, kind, mixName) => {
  const label = kind === 'platinum-record' ? '💿 PLATINUM RECORD' : '🏆 GOLD RECORD';
  const target = game.getPlayer(userId);
  if (target) {
    game.send(target, { type: 'notice', text: `${label}! "${mixName}" earned it — find the trophy in your home's items and hang it on the wall!` });
    game.broadcastToMap(target.mapId, { type: 'chat', userId: 0, name: '📣', text: `${target.name}'s "${mixName}" just went ${kind === 'platinum-record' ? 'PLATINUM' : 'GOLD'}! ${label}`, system: true });
    if (target.mapId.startsWith('studio:')) studios.sendState(target);
  }
};
game.onPlayerGone = (userId) => { stages.handlePlayerGone(userId); casino.handlePlayerGone(userId); blackjack.handlePlayerGone(userId); club.handlePlayerGone(userId); };
game.onStandUp = (p, seat, viaMovement) => {
  // v1.5: seat kinds route to their owning system.
  if (seat && (seat.kind === 'blackjack' || seat.kind === 'blackjack-pending')) {
    return blackjack.releaseSeatStand(p, seat, viaMovement);
  }
  return casino.releaseSeatStand(p, seat, viaMovement);
};
game.onMapEntered = (p) => { stages.syncPlayer(p); casino.syncPlayer(p); blackjack.syncPlayer(p); club.syncPlayer(p); visitors.syncPlayer(p); sky.syncPlayer(p); };

function sendAvatar(res, result) {
  res.json({
    ok: true,
    token: result.token,
    avatar: result.avatar,
    zcoins: result.avatar.zcoins,
  });
}

app.post('/api/register', (req, res) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  const { username, password, shirt, pants, skin_tone, hair_style, hair_color } = body;
  const r = auth.register(username, password, { shirt, pants, skin_tone, hair_style, hair_color }, req.ip);
  if (!r.ok) return res.status(r.code || 400).json({ ok: false, error: r.error });
  return sendAvatar(res, r);
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const r = auth.login(username, password, req.ip);
  if (!r.ok) return res.status(r.code || 401).json({ ok: false, error: r.error });
  return sendAvatar(res, r);
});

// Friend-launch fix: auth.logout() existed but no route ever called
// it, so a session token could never be invalidated before its
// 30-day expiry (a "log out" that only clears localStorage leaves the
// token live for anyone who copied it). Idempotent and always 200 —
// no oracle about whether the token ever existed.
app.post('/api/logout', (req, res) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  if (typeof body.token === 'string' && body.token) auth.logout(body.token);
  return res.json({ ok: true });
});

app.post('/api/me', (req, res) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  const s = auth.resolveSession(body.token);
  if (!s) return res.status(401).json({ ok: false, error: 'Invalid or expired session.' });
  return res.json({ ok: true, avatar: auth.publicAvatar(s.avatar) });
});

// Phase 6: the shared appearance options — the creation screen and
// the look editor both build their pickers from this payload, which
// is generated from src/appearance.js, the same module the server
// validates against. One list, three consumers, zero drift.
app.get('/api/appearance', (req, res) => {
  res.json({ ok: true, ...appearance.clientOptions() });
});

// Phase 6: character creation (after login). One-shot per account —
// only a placeholder avatar (created = 0) can be created; afterwards
// the look editor (POST /api/avatar) owns changes.
app.post('/api/create-character', (req, res) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  const s = auth.resolveSession(body.token);
  if (!s) return res.status(401).json({ ok: false, error: 'Invalid or expired session.' });
  const r = auth.createCharacter(s.user.id, body);
  if (!r.ok) return res.status(r.code || 400).json({ ok: false, error: r.error });
  return res.json({ ok: true, avatar: r.avatar });
});

// Phase 4: edit your look after creation. Validation lives in
// auth.updateAvatar — the same sets registration uses. If the player
// is online, their live publicPlayer updates in place too.
app.post('/api/avatar', (req, res) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  const s = auth.resolveSession(body.token);
  if (!s) return res.status(401).json({ ok: false, error: 'Invalid or expired session.' });
  const r = applyAvatarUpdate(s.user.id, body);
  if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
  return res.json({ ok: true, avatar: r.avatar });
});

/** Persist a look change and mirror it onto the live player, if any. */
function applyAvatarUpdate(userId, fields) {
  const r = auth.updateAvatar(userId, fields);
  if (!r.ok) return r;
  const p = game.getPlayer(userId);
  if (p) {
    for (const axis of appearance.AXIS_NAMES) p[axis] = r.avatar[axis];
    // Push fresh snapshots now so the room sees the new look without
    // anyone relogging (the regular 10 Hz broadcast would catch up
    // within ~100 ms anyway; this makes it instant and testable).
    game.broadcastSnapshots();
    game.send(p, { type: 'avatar-updated', avatar: r.avatar, you: game.publicPlayer(p) });
  }
  return r;
}

// Public loop catalog for the mixer UI (pattern data the client
// synthesizes with Web Audio — no audio files exist anywhere).
app.get('/api/music/loops', (req, res) => {
  // Test-only (Bake Shop mixer scene): the preview page loads from
  // file://, so its catalog fetch needs the same CORS allowance the
  // /preview-data route carries. Production responses are unchanged.
  if (TEST_MODE) res.set('Access-Control-Allow-Origin', '*');
  res.json({
    ok: true,
    loops: music.LOOPS,
    bpmMin: music.BPM_MIN,
    bpmMax: music.BPM_MAX,
    maxTracks: music.MAX_TRACKS,
    maxBars: music.MAX_BARS,
    maxSlots: music.MAX_SLOTS,
  });
});

app.get('/health', (req, res) => {
  const counts = game.mapCounts();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  res.json({
    ok: true,
    game: 'solarion',
    phase: 10,
    version: require('../package.json').version,
    uptime_s: Math.floor((Date.now() - startedAt) / 1000),
    players_online: total,
    maps: counts,
    tick: game.tickStats,
    sky: sky.publicSummary(),
  });
});

const server = http.createServer(app);

// ------------------------------------------------------------------
// Bake Shop — TEST-ONLY preview routes (registered ONLY when
// SOLARION_TEST=1; in production these paths 404 like any other
// unknown route — see docs/bakeshop.md). They let tooling render any
// map through the REAL client (public/client.js draws it) with a
// synthetic hello payload built from the same serializers the live
// hello uses (clientMap + the publicPlayer field shape), so a build
// agent can SEE its own map/sprite work. No auth, no DB writes.
// ------------------------------------------------------------------
if (TEST_MODE) {
  const fs = require('fs');
  const { TILE: MTILE, collides: mapCollides } = require('./maps');

  // Standable pixel point nearest the given tile, using the game's
  // own circle-collision test — preview characters stand exactly
  // where a real player could.
  function previewSpot(map, tx, ty) {
    for (let r = 0; r < 24; r++) {
      for (let yy = ty - r; yy <= ty + r; yy++) {
        for (let xx = tx - r; xx <= tx + r; xx++) {
          if (Math.max(Math.abs(xx - tx), Math.abs(yy - ty)) !== r) continue;
          const x = xx * MTILE + MTILE / 2, y = yy * MTILE + MTILE / 2;
          if (xx >= 0 && yy >= 0 && xx < map.tiles.w && yy < map.tiles.h && !mapCollides(map, x, y, 10)) {
            return { x, y };
          }
        }
      }
    }
    return { x: map.spawn.x, y: map.spawn.y };
  }

  function fakePub(id, name, look, x, y, dir, seat) {
    return {
      id, name, x, y, dir,
      seated: Boolean(seat), seatId: seat ? seat.id : null,
      drinks: 0, puffs: 0, fallen: false,
      performing: false, emote: null, ...look,
    };
  }

  // Playtest Gate (tooling only): the shot list for ?scene=playtest.
  // Deterministic poses derived from the map's own data: sitters
  // spread over every seat KIND present (table chairs first — the
  // legs-under-tables pixel check needs them; hearth-arc seats;
  // audience front rows; casino poker chairs as pseudo-seats), a
  // doorway stander, a gateway stander, a pit-front stander. The
  // checker (scripts/playtest-check.mjs) consumes the SAME shot ids
  // plus the manifest the capture driver records.
  function playtestShots(map) {
    const TS = MTILE;
    const tileOf = (v) => Math.floor(v / TS);
    const seats = (map.seats || []).slice();
    const props = map.props || [];
    const tableNear = (s) => props.find(pr => pr.kind === 'table'
      && Math.abs(pr.x - s.x) <= TS * 1.05 && Math.abs(pr.y - s.y) <= TS * 1.05
      && (pr.x !== s.x || pr.y !== s.y));
    const hearths = props.filter(p => p.kind === 'hearth');
    const nearHearth = (s) => hearths.some(h =>
      Math.max(Math.abs(tileOf(s.x) - tileOf(h.x)), Math.abs(tileOf(s.y) - tileOf(h.y))) <= 6);
    const aud = seats.filter(s => {
      const m = /-seat-(\d+)$/.exec(s.id);
      return m && Number(m[1]) >= 101;
    });
    const used = new Set();
    const groups = [];
    const take = (list, n) => {
      const picked = [];
      for (const d of ['down', 'left', 'right', 'up']) {
        const s = list.find(s2 => s2.dir === d && !used.has(s2.id) && !picked.includes(s2));
        if (s && picked.length < n) picked.push(s);
      }
      for (const s of list) {
        if (picked.length >= n) break;
        if (!used.has(s.id) && !picked.includes(s)) picked.push(s);
      }
      picked.forEach(s => used.add(s.id));
      return picked;
    };
    const pushGroup = (id, list, n) => {
      const p = take(list, n);
      if (p.length) groups.push({ id, seats: p });
    };
    pushGroup('table', seats.filter(s => s.kind === 'chair' && tableNear(s)), 4);
    pushGroup('hearth', seats.filter(s => (s.kind === 'chair' || s.kind === 'sofa') && nearHearth(s)), 3);
    // v1.6: bar stools are GONE game-wide (X's order) — there is
    // no 'bar' sitter group anymore. The casinos' bar is posed as
    // STANDING patrons at the counter instead (see the 'bar' shot
    // below, beside the door/gateway standers).
    for (const kind of ['chair', 'stool', 'sofa', 'bench', 'cafe', 'hookah']) {
      pushGroup(kind, seats.filter(s => s.kind === kind), 4);
    }
    if (aud.length && map.stage) {
      const pcx = map.stage.pit.x + map.stage.pit.w / 2, pcy = map.stage.pit.y + map.stage.pit.h / 2;
      const sorted = aud.slice().sort((a, b) =>
        (Math.abs(a.x - pcx) + Math.abs(a.y - pcy)) - (Math.abs(b.x - pcx) + Math.abs(b.y - pcy)));
      pushGroup('audience', sorted, 4);
    }
    if (map.casino) {
      // Every poker chair is posed (not one per table): the
      // Playtest Gate verifies each chair's back on its
      // unoccupied observations, so all of them need a posed
      // appearance in the manifest.
      const picks = [];
      for (const t of map.casino.tables) {
        for (const c of t.chairs || []) {
          const dx = c.x - t.x, dy = c.y - t.y;
          const face = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'left' : 'right') : (dy > 0 ? 'up' : 'down');
          picks.push({ id: `poker:${t.id}:${c.dir}`, x: c.x, y: c.y, dir: face, kind: 'poker' });
        }
      }
      if (picks.length) groups.push({ id: 'poker', seats: picks });
      // v1.5: mid-hand captures for the parent sign-off — a poker
      // table with the board ON the felt (Feature 1) and the
      // blackjack table with hands down (Feature 3). The payload
      // builder attaches synthetic table states for exactly these
      // shot ids (see tableFx below), so the frames show a live
      // hand frozen mid-street.
      const chairPick = (t, dirs) => dirs
        .map(d => (t.chairs || []).find(c => c.dir === d)).filter(Boolean)
        .map(c => {
          const dx = c.x - t.x, dy = c.y - t.y;
          const face = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'left' : 'right') : (dy > 0 ? 'up' : 'down');
          return { id: `poker:${t.id}:${c.dir}`, x: c.x, y: c.y, dir: face, kind: 'poker' };
        });
      const t1 = map.casino.tables.find(t => t.game !== 'blackjack');
      const bjt = map.casino.tables.find(t => t.game === 'blackjack');
      if (t1) { const p = chairPick(t1, ['S', 'N']); if (p.length) groups.push({ id: 'board', seats: p }); }
      if (bjt) { const p = chairPick(bjt, ['S', 'E']); if (p.length) groups.push({ id: 'bjhand', seats: p }); }
    }
    // Chunk each group into shots of <=5 sitters, clustered within
    // 16 tiles so a play-zoom frame holds the whole group.
    const shots = [];
    for (const g of groups) {
      const chunks = [];
      let rest = g.seats.slice();
      while (rest.length) {
        const first = rest[0];
        let cluster = rest.filter(s => Math.max(Math.abs(s.x - first.x), Math.abs(s.y - first.y)) <= TS * 16).slice(0, 5);
        if (!cluster.length) cluster = [rest[0]];
        const ids = new Set(cluster.map(s => s.id));
        rest = rest.filter(s => !ids.has(s.id));
        chunks.push(cluster);
      }
      chunks.forEach((cluster, i) => {
        shots.push({
          id: `sit-${g.id}${chunks.length > 1 ? '-' + (i + 1) : ''}`,
          units: cluster.map(s => ({ seat: s })),
        });
      });
    }
    const faceToward = (fx, fy, tx2, ty2) => {
      const dx = tx2 - fx, dy = ty2 - fy;
      return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    };
    const door = (map.doors || [])[0];
    if (door) {
      const cx = door.x + door.w / 2, cy = door.y + door.h / 2;
      const mx = map.tiles.w * TS / 2, my = map.tiles.h * TS / 2;
      const ix = cx + Math.sign(mx - cx) * TS, iy = cy + Math.sign(my - cy) * TS;
      const spot = previewSpot(map, tileOf(ix), tileOf(iy));
      shots.push({
        id: 'door',
        units: [{ stand: { x: spot.x, y: spot.y, dir: faceToward(spot.x, spot.y, cx, cy), at: 'door', label: door.label } }],
      });
    }
    const gw = (map.gateways || [])[0];
    if (gw) {
      const spot = previewSpot(map, tileOf(gw.x + gw.w / 2), tileOf(gw.y + gw.h / 2));
      shots.push({
        id: 'gateway',
        units: [{ stand: { x: spot.x, y: spot.y, dir: faceToward(spot.x, spot.y, map.tiles.w * TS / 2, map.tiles.h * TS / 2), at: 'gateway', label: gw.label } }],
      });
    }
    if (map.casino && map.casino.bar) {
      // v1.6: STANDING patrons at the counter (the bar stools are
      // gone) — two regulars side by side, facing the bartender
      // over the flat 'B' counter. This is the frame that proves
      // standing service: the Drink flow never needed a seat.
      const b = map.casino.bar;
      const s1 = previewSpot(map, tileOf(b.x), tileOf(b.y));
      const s2 = previewSpot(map, tileOf(b.x) + 3, tileOf(b.y));
      shots.push({
        id: 'bar',
        units: [
          { stand: { x: s1.x, y: s1.y, dir: 'down', at: 'bar', label: 'The Bar' } },
          { stand: { x: s2.x, y: s2.y, dir: 'down', at: 'bar', label: 'The Bar' } },
        ],
      });
    }
    if (map.club) {
      // v1.4 (Club Mirage): a ringside shot — two standers at the
      // stage fronts facing the dancers, one at the bar facing the
      // bartender. The payload builder flags this shot so the
      // capture catches a dancer-flourish mid-animation (the tip
      // interaction pose). v1.6: at the dancers' new player-equal
      // size this frame is also the SIZE PARITY proof (standers
      // shoulder-to-shoulder with 1.5x dancers), and the bar unit
      // is the after shot for the stool removal (Mira serving a
      // standing patron, counter clear).
      const units = [];
      for (const stg of map.club.stages.slice(0, 2)) {
        const spot = previewSpot(map, tileOf(stg.x + stg.w / 2), tileOf(stg.y + stg.h) + 2);
        units.push({ stand: { x: spot.x, y: spot.y, dir: 'up', at: 'clubstage', label: stg.dancer.name } });
      }
      const b = map.club.bar;
      if (b) {
        const spot = previewSpot(map, tileOf(b.x), tileOf(b.y));
        units.push({ stand: { x: spot.x, y: spot.y, dir: 'down', at: 'clubbar', label: 'The Bar' } });
      }
      if (units.length) shots.push({ id: 'club-stage', units });
      // v1.6: the follow, posed — two regulars mid-dance-floor and
      // the payload builder seeds a live dancer-state trailing the
      // first of them, so the capture shows her OFF her stage, at
      // player size, on his heels (the follow's money shot).
      const f1 = previewSpot(map, 19, 16);
      const f2 = previewSpot(map, 22, 18);
      shots.push({
        id: 'club-follow',
        units: [
          { stand: { x: f1.x, y: f1.y, dir: 'right', at: 'clubfollow', label: 'Dance Floor' } },
          { stand: { x: f2.x, y: f2.y, dir: 'up', at: 'clubfollow', label: 'Dance Floor' } },
        ],
      });
    }
    if (map.stage && !aud.length) {
      // v1.6: a PIT-ONLY venue (Club Mirage's player stage): a
      // performer mid-set ON the platform (the payload builder
      // flags the unit + replays a synthetic performance-start so
      // the lights and speakers run) and two fans standing in the
      // pit facing the stage. City venues use the 'stage' shot
      // below (pit-front stander + their audience grid).
      const st = map.stage;
      const west = st.pit.x < st.x;
      const pcx = st.x + st.w / 2, pcy = st.y + st.h / 2;
      const perf = previewSpot(map, tileOf(pcx), tileOf(pcy));
      const units = [{
        stand: { x: perf.x, y: perf.y, dir: west ? 'left' : 'up', at: 'clubperform', label: 'On Stage' },
        perform: true,
      }];
      const pitCx = st.pit.x + st.pit.w / 2, pitCy = st.pit.y + st.pit.h / 2;
      for (const off of [-0.22, 0.22]) {
        const px2 = west ? pitCx : pitCx + st.pit.w * off;
        const py2 = west ? pitCy + st.pit.h * off : pitCy;
        const spot = previewSpot(map, tileOf(px2), tileOf(py2));
        units.push({ stand: { x: spot.x, y: spot.y, dir: west ? 'right' : 'up', at: 'clubpit', label: 'The Pit' } });
      }
      shots.push({ id: 'club-perform', units });
    }
    if (map.stage && aud.length) {
      const st = map.stage;
      const pcx = st.pit.x + st.pit.w / 2, pcy = st.pit.y + st.pit.h / 2;
      const acx = aud.reduce((a, s) => a + s.x, 0) / aud.length;
      const acy = aud.reduce((a, s) => a + s.y, 0) / aud.length;
      let px = pcx, py = pcy;
      if (Math.abs(acx - pcx) > Math.abs(acy - pcy)) px = pcx + Math.sign(acx - pcx) * (st.pit.w / 2 + TS);
      else py = pcy + Math.sign(acy - pcy) * (st.pit.h / 2 + TS);
      const spot = previewSpot(map, tileOf(px), tileOf(py));
      shots.push({
        id: 'stage',
        units: [{ stand: { x: spot.x, y: spot.y, dir: faceToward(spot.x, spot.y, st.x + st.w / 2, st.y + st.h / 2), at: 'pitfront' } }],
      });
    }
    return shots;
  }

  app.get('/preview-data/:mapId', (req, res) => {
    const map = MAPS[req.params.mapId];
    if (!map) return res.status(404).json({ ok: false, error: 'unknown map' });
    // The Bake Shop preview page is loaded from file:// (Chrome's
    // Local Network Access rules block http://localhost pages in
    // this environment); its origin is "null", so let it read this
    // synthetic, test-only payload cross-origin.
    res.set('Access-Control-Allow-Origin', '*');
    // Force the world clock: 0.25 = full day, 0.70 = deep night.
    const phase = req.query.phase === 'night' ? 0.70 : 0.25;
    const dayCycle = { periodMs: DAY_CYCLE.periodMs, anchor: Date.now() - phase * DAY_CYCLE.periodMs };
    // Bake Shop season override (tooling only): ?season=halloween|
    // christmas forces that layer; ?season=none forces it off.
    // Absent = the calendar's real season, exactly like live play.
    const sq = req.query.season;
    const season = sq === 'none' ? null
      : SEASONS.includes(sq) ? sq : seasonAt(new Date());
    // Playtest Gate: ?scene=playtest&shot=__list__ enumerates the
    // shots for this map (the capture driver hardcodes nothing).
    if (req.query.scene === 'playtest' && req.query.shot === '__list__') {
      return res.json({
        ok: true, map: map.id, interior: !(map.gateways || []).length,
        shots: playtestShots(map).map(s => ({ id: s.id, actors: s.units.length })),
      });
    }
    const ctx = Math.floor(map.tiles.w / 2), cty = Math.floor(map.tiles.h / 2);
    const v = previewSpot(map, ctx, cty);
    const s1 = previewSpot(map, ctx + 2, cty + 2);
    const s2 = previewSpot(map, ctx - 2, cty + 2);
    const lookM = { ...appearance.defaultsFor('M'), hair_color: '#111111', body_color: '#22242c', top_style: 'button-up' };
    const lookF = { ...appearance.defaultsFor('F'), hair_style: 'ponytail', hair_color: '#ff2e88', body_color: '#17102b', accessory: 'sunglasses' };
    const lookM2 = { ...appearance.defaultsFor('M'), hair_color: '#ffd23f', body_color: '#3aa7e0', accessory: 'cap' };
    let you = fakePub(900001, 'Preview', lookM, v.x, v.y, 'down');
    let players = [
      you,
      fakePub(900002, 'Pip', lookF, s1.x, s1.y, 'left'),
      fakePub(900003, 'Juno', lookM2, s2.x, s2.y, 'right'),
    ];
    // Bake Shop scene override (tooling only): ?scene=sit parks the
    // sample players IN seats — occupied-seat rendering (the v1.2.2
    // deferred chair backs, the seated pose) can only be judged
    // with sitters in frame. "You" take the first seat so the
    // camera centres on an occupied seat. Casino maps use their
    // slot stools (a north-row 'up' seat + an east-row 'right'
    // seat); other maps use their first three baked seats.
    if (req.query.scene === 'sit' && (map.seats || []).length) {
      const seats = map.seats;
      const picks = map.casino
        ? [seats[0], seats[5], seats[1]].filter(Boolean)
        : seats.slice(0, 3);
      const folks = [
        [900001, 'Preview', lookM], [900002, 'Pip', lookF], [900003, 'Juno', lookM2],
      ];
      players = picks.map((s, i) => fakePub(folks[i][0], folks[i][1], folks[i][2], s.x, s.y, s.dir, s));
      you = players[0];
      // v1.3.1 (chair-spacing pass): pose MORE sitters so every
      // seating family can be eyeballed in one Bake Shop frame —
      // the first four stage-audience seats, a beach towel (the
      // lying pose), and two poker chairs in the casinos.
      let extra = 900010;
      const audience = seats.filter(s => /-seat-1\d\d$/.test(s.id));
      for (const s of audience.slice(0, 4)) {
        players.push(fakePub(extra, `Aud${extra - 900009}`, lookF, s.x, s.y, s.dir, s));
        extra++;
      }
      const towel = seats.find(s => s.kind === 'towel');
      if (towel) players.push(fakePub(extra++, 'Sunny', lookM2, towel.x, towel.y, towel.dir, towel));
      if (map.casino && map.casino.tables && map.casino.tables[0]) {
        const t = map.casino.tables[0];
        const FACE = { N: 'down', S: 'up', E: 'left', W: 'right' };
        for (const ch of t.chairs.slice(0, 2)) {
          players.push(fakePub(extra++, 'Poker', lookM, ch.x, ch.y, FACE[ch.dir], { id: `poker:${t.id}:${ch.dir}` }));
        }
      }
    }
    // Playtest Gate scene: pose the shot's actors. Every posed
    // actor wears neon-green pants (accent_color) — the checker's
    // legs-under-tables pixel test keys on that marker. Actor 0 is
    // the unit nearest the shot centroid: they are "you", so the
    // client camera centres on them, exactly like a player's.
    let playtest = null;
    let tableFx = null;
    let fx = null;
    if (req.query.scene === 'playtest') {
      const shots = playtestShots(map);
      const shot = shots.find(s => s.id === req.query.shot) || shots[0];
      const TS = MTILE;
      const tableNear = (s) => (map.props || []).find(pr => pr.kind === 'table'
        && Math.abs(pr.x - s.x) <= TS * 1.05 && Math.abs(pr.y - s.y) <= TS * 1.05
        && (pr.x !== s.x || pr.y !== s.y));
      const units = shot.units.map(u => u.seat
        ? { x: u.seat.x, y: u.seat.y, dir: u.seat.dir, seat: u.seat, perform: Boolean(u.perform) }
        : { x: u.stand.x, y: u.stand.y, dir: u.stand.dir, stand: u.stand, perform: Boolean(u.perform) });
      const ccx = units.reduce((a, u) => a + u.x, 0) / units.length;
      const ccy = units.reduce((a, u) => a + u.y, 0) / units.length;
      units.sort((a, b) => (Math.abs(a.x - ccx) + Math.abs(a.y - ccy)) - (Math.abs(b.x - ccx) + Math.abs(b.y - ccy)));
      const LOOKS = [
        { ...appearance.defaultsFor('M'), hair_color: '#111111', body_color: '#22242c', top_style: 'button-up' },
        { ...appearance.defaultsFor('F'), hair_style: 'ponytail', hair_color: '#ff2e88', body_color: '#17102b', accessory: 'sunglasses' },
        { ...appearance.defaultsFor('M'), hair_color: '#ffd23f', body_color: '#3aa7e0', accessory: 'cap' },
        { ...appearance.defaultsFor('F'), hair_color: '#7a4a21', body_color: '#7a3b4f' },
        { ...appearance.defaultsFor('M'), hair_color: '#e8e8e8', body_color: '#5d7d43' },
        { ...appearance.defaultsFor('F'), hair_color: '#3aa7e0', body_color: '#c4505f' },
      ];
      const NAMES = ['Preview', 'Pip', 'Juno', 'Ash', 'Rue', 'Sol'];
      const actors = [];
      players = units.map((u, i) => {
        const look = { ...LOOKS[i % LOOKS.length], accent_color: '#2bff5e', bottom_style: 'pants', shoe_color: '#101010' };
        const p = fakePub(900001 + i, NAMES[i % NAMES.length], look, u.x, u.y, u.dir, u.seat || null);
        if (u.perform) p.performing = true; // v1.6: the club-perform shot's headliner
        let pull = null;
        if (u.seat && u.seat.kind === 'chair') {
          const t = tableNear(u.seat);
          if (t) pull = [Math.sign(t.x - u.seat.x) * 5, Math.sign(t.y - u.seat.y) * 5];
        }
        actors.push({
          pid: p.id, name: p.name, x: u.x, y: u.y, dir: u.dir,
          seated: Boolean(u.seat), seatId: u.seat ? u.seat.id : null,
          seatKind: u.seat ? u.seat.kind : null, stand: u.stand ? u.stand.at : null,
          pull,
        });
        return p;
      });
      you = players[0];
      playtest = { shot: shot.id, map: map.id, camera: { x: units[0].x, y: units[0].y }, actors };
      // v1.4: the club's ringside shot poses a tip — the client
      // starts the first dancer's flourish on hello (this field
      // exists only in test-mode preview payloads, never live).
      if (shot.id === 'club-stage' && map.club && map.club.stages[0]) {
        playtest.clubFlourish = { dancer: map.club.stages[0].dancer.id };
      }
      // v1.6: the follow shot — the client seeds a live dancer
      // state trailing the first posed regular (Roxy, off her
      // stage at player size, on his heels mid-dance-floor).
      if (shot.id === 'club-follow' && map.club && map.club.stages[0]) {
        const lead = actors[0];
        playtest.dancerFollow = {
          dancer: map.club.stages[0].dancer.id,
          x: lead.x - 54, y: lead.y + 8, dir: 'right', withName: lead.name,
        };
      }
      // v1.6: the club-perform shot runs a synthetic set — a
      // performance-start replayed through the client's real
      // handlers (preview.js hello.fx), so the stage lights,
      // speaker pulse and now-playing UI are the live ones.
      if (shot.id === 'club-perform') {
        const head = actors.find(a => a.stand === 'clubperform') || actors[0];
        fx = [{
          type: 'performance-start',
          performerId: head ? head.pid : 900001,
          performerName: head ? head.name : 'Preview',
          mixName: 'Playtest Set',
          mix: { bpm: 124, bars: 8, grid: {} },
          startAt: Date.now() + 200,
          durationMs: 15484,
        }];
      }
      // v1.5: the mid-hand shots carry synthetic table states,
      // fed through the client's real message handlers by
      // preview.js (hello.tableFx). Chair names come from the
      // posed actors themselves, so the felt state lines up with
      // the sitters in frame. Test-mode preview only — the live
      // server never invents table state.
      if (map.casino && (shot.id.startsWith('sit-board') || shot.id.startsWith('sit-bjhand'))) {
        const bySeat = new Map(playtest.actors.filter(a => a.seatId).map(a => [a.seatId, a.name]));
        const chairStates = (t, fill) => t.chairs.map((c) => {
          const name = bySeat.get(`poker:${t.id}:${c.dir}`) || null;
          return fill(c, name);
        });
        if (shot.id.startsWith('sit-board')) {
          const t = map.casino.tables.find(t2 => t2.game !== 'blackjack');
          if (t) {
            let first = true;
            tableFx = [{
              type: 'poker-state', id: t.id, game: 'poker', state: 'flop',
              pot: 75, toCall: 25, dealerChair: 0, actionChair: -1,
              // v1.6: the posed board shows a heads-up hand — the
              // house seat rides along (its cards stay face-down).
              house: { name: 'House', chips: 140, bet: 25, folded: false, allIn: false, acting: false, cards: 2, x: Math.round(t.x), y: Math.round(t.y - 44) },
              buyin: 100, streetDeadline: 0,
              community: ['A♠', 'K♥', '7♦'], winners: [],
              chairs: chairStates(t, (c, name) => {
                const seated = Boolean(name);
                const acting = seated && first; if (seated) first = false;
                return {
                  name, chips: seated ? 180 : null, bet: seated ? 25 : 0,
                  folded: false, allIn: false, acting, sittingOut: false,
                };
              }),
              reveal: [],
            }, { type: 'poker-cards', table: t.id, cards: ['Q♠', 'Q♦'] }];
          }
        } else {
          const t = map.casino.tables.find(t2 => t2.game === 'blackjack');
          if (t) {
            const hands = {
              S: { hand: ['10♦', '8♣'], handTotal: 18, bet: 25, acting: false },
              E: { hand: ['A♥', '6♠'], handTotal: 17, bet: 10, acting: true },
            };
            tableFx = [{
              type: 'blackjack-state', id: t.id, game: 'blackjack', state: 'playing',
              buyin: 100, buyinMin: 50, buyinMax: 500, minBet: 5, maxBet: 100,
              countdown: 0, results: null,
              dealer: { cards: ['K♠', null], total: 10 },
              chairs: chairStates(t, (c, name) => {
                const h = name ? hands[c.dir] : null;
                return {
                  dir: c.dir, x: Math.round(c.x), y: Math.round(c.y),
                  name, chips: name ? 175 : 0, bet: h ? h.bet : 0,
                  hand: h ? h.hand : [], handTotal: h ? h.handTotal : null,
                  doubled: false, acting: h ? h.acting : false,
                  result: null, sittingOut: false,
                };
              }),
            }];
          }
        }
      }
    }
    // Sky override (tooling only): ?sky=day|night|snow|rain|storm
    // forces that sky so Bake Shop / Playtest captures can show
    // each condition on demand (forced events sit at 50% progress).
    // Absent = the real sky, except the legacy ?phase=night knob
    // still forces night (it used to drive the world clock).
    const nowMs = Date.now();
    const skyQ = req.query.sky === 'storm' ? 'thunderstorm' : req.query.sky;
    let skyPayload = sky.publicState(map.id);
    if (skyQ === 'day') skyPayload = { isNight: false, active: null, last: null, marks: [] };
    else if (skyQ === 'night') skyPayload = { isNight: true, active: null, last: null, marks: [] };
    else if (['snow', 'rain', 'thunderstorm'].includes(skyQ)) {
      skyPayload = {
        isNight: false,
        active: { type: skyQ, startedAt: nowMs - 10 * 60 * 1000, endsAt: nowMs + 10 * 60 * 1000, cycleKey: 'preview' },
        last: null, marks: [],
      };
    } else if (req.query.phase === 'night') {
      skyPayload = { ...skyPayload, isNight: true };
    }
    res.json({
      type: 'hello', you, map: clientMap(map, season), players, season,
      chat: [], zcoins: 0, bonusGranted: false, bonusAmount: 0, dayCycle,
      playtest, tableFx, fx, sky: skyPayload,
    });
  });
  app.get('/preview/:mapId', (req, res) => {
    if (!MAPS[req.params.mapId]) return res.status(404).send('unknown map');
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const phase = req.query.phase === 'night' ? 'night' : 'day';
    const skyQ = ['day', 'night', 'snow', 'rain', 'storm'].includes(req.query.sky) ? req.query.sky : null;
    const inject = `<script>window.__PREVIEW_CFG__ = ${JSON.stringify({ mapId: req.params.mapId, phase, sky: skyQ })};</script>\n<script src="/preview.js"></script>\n</body>`;
    res.type('html').send(html.replace('</body>', inject));
  });
}
// Phase 5: cap inbound WS frames at 64 KB. The `ws` library default is
// 100 MB — one huge frame from any signed-in client could OOM the
// process. Mix payloads are already capped at ~8 KB by Phase 2, so
// 64 KB is generous headroom for every legitimate message.
const MAX_WS_FRAME_BYTES = 64 * 1024;
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_WS_FRAME_BYTES });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  const session = auth.resolveSession(token);
  if (!session) {
    ws.close(4401, 'unauthorized');
    return;
  }
  // Phase 6: the world requires a created character. Accounts that
  // registered but never finished the creation screen get a distinct
  // close code (4403) so the client can route them back to it.
  if (!session.avatar.created) {
    ws.close(4403, 'character required');
    return;
  }

  const p = game.addPlayer(ws, session);

  // Casino crash recovery: refund any table chips stranded by a crash
  // (mirrored in avatars.casino_chips) exactly once, before the bonus.
  if (casino.recoverStrandedChips(session.user.id)) {
    const fresh = q.avatarByUser.get(session.user.id);
    if (fresh) session.avatar.zcoins = fresh.zcoins;
  }

  // Daily login bonus: atomic one-claim-per-day in the DB (5,000z
  // welcome bonus on a brand-new account's first-ever claim).
  const bonusAmount = game.claimDailyBonus(session.user.id);
  const bonusGranted = bonusAmount > 0;
  if (bonusGranted) {
    const fresh = q.avatarByUser.get(session.user.id);
    if (fresh) session.avatar.zcoins = fresh.zcoins;
  }

  // Owner top-up: X's accounts floor at 1,000,000z on every connect
  // (his ruling, 2026-10-21). The owner set lives in src/owners.js —
  // one source of truth, shared with fast-travel enforcement.
  const { ownerFloorFor, isOwnerName } = require('./owners');
  const topUp = ownerFloorFor(session.user.username);
  if (topUp) {
    const r = q.ownerTopUp.run(topUp, session.user.id, topUp);
    if (r.changes) {
      const fresh = q.avatarByUser.get(session.user.id);
      if (fresh) session.avatar.zcoins = fresh.zcoins;
    }
  }

  const map = MAPS[p.mapId];
  const youPub = game.publicPlayer(p);
  // v1.2 (Item J): the client needs to know whether THIS account
  // gets the owner-only fast-travel controls. (Enforcement is
  // server-side regardless; this only shapes the UI.)
  youPub.isOwner = isOwnerName(session.user.username);
  // v1.9: the visitor summon buttons belong to Zantheon's account
  // alone (narrower than the owners set — X's direct order). The
  // server enforces the same check in visitors.summon; this only
  // shapes the UI.
  youPub.canSummon = session.user.username.toLowerCase() === 'zantheon';
  game.send(p, {
    type: 'hello',
    you: youPub,
    map: clientMap(map),
    season: seasonAt(new Date()),
    players: game.playersInMap(p.mapId),
    chat: game.historyFor(p.mapId),
    zcoins: q.avatarByUser.get(session.user.id).zcoins,
    bonusGranted,
    bonusAmount,
    dayCycle: DAY_CYCLE,
    sky: sky.publicState(p.mapId),
  });
  stages.syncPlayer(p);
  casino.syncPlayer(p);
  blackjack.syncPlayer(p);
  game.send(p, { type: 'mixes', mixes: music.listMixes(session.user.id) });
  social.sendFriends(p);

  ws.on('message', (raw) => {
    // Phase 5 — inbound frame guards. NOTHING reaches a handler until
    // the frame has passed all of these:
    //   1. size cap (belt-and-braces with maxPayload above),
    //   2. JSON.parse inside try/catch,
    //   3. shape validation: a plain (non-array) object whose `type`
    //      is a short string,
    //   4. the dispatch itself runs inside try/catch, so a single
    //      malformed frame can never take the process down (pre-Phase-5
    //      a {type:'stage-join', mixId:{}} frame crashed the server via
    //      an unbindable SQLite parameter).
    const byteLen = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(String(raw), 'utf8');
    if (byteLen > MAX_WS_FRAME_BYTES) {
      try { ws.close(1009, 'frame too large'); } catch (e) { /* already gone */ }
      return;
    }
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch (e) { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    if (typeof msg.type !== 'string' || msg.type.length === 0 || msg.type.length > 64) return;
    try {
    switch (msg.type) {
      case 'input':
        // Seated at a poker or blackjack table? Movement is locked until you stand.
        if (!casino.isSeated(p.userId) && !blackjack.isSeated(p.userId)) game.handleInput(p, msg.keys);
        else p.keys = {};
        break;
      case 'move-to':
        // Phase 9: click/tap-to-move (server-routed). Table seats lock it too.
        // v1.9: so does the Threshold's chair.
        if (!p.captive && !casino.isSeated(p.userId) && !blackjack.isSeated(p.userId)) game.handleMoveTo(p, msg.x, msg.y);
        break;
      case 'enter-door':
        // UX overhaul: click/tap a nearby door to walk through it.
        // The server re-validates proximity; table seats lock it too.
        if (!casino.isSeated(p.userId) && !blackjack.isSeated(p.userId)) game.handleEnterDoor(p);
        break;
      case 'run':
        game.handleRun(p, msg.on);
        break;
      case 'emote':
        game.handleEmote(p, msg.emote);
        break;
      case 'friend-request':
      case 'friend-respond':
      case 'friend-remove':
      case 'friend-list':
      case 'navigator':
      case 'navigate':
      case 'navigate-home':
      case 'join-friend':
      case 'profile':
        social.handle(p, msg);
        break;
      case 'poker':
        casino.handlePoker(p, msg);
        break;
      case 'blackjack':
        blackjack.handleBlackjack(p, msg);
        break;
      case 'slots':
        casino.handleSlots(p, msg);
        break;
      case 'table-chat':
        casino.handleTableChat(p, msg.text);
        break;
      case 'chat':
        game.handleChat(p, msg.text);
        break;
      case 'interact': {
        // v1.9.1: E near a present visitor (Orenius / Agent Sims)
        // opens their dialogue instead of sitting/fishing.
        if (visitors.interact(p)) break;
        // Sitting. Poker/blackjack GAME seats are managed by their
        // systems (the tray's Stand / Cash out) — but v1.1.1: E at
        // a table first sits you down as a spectator and pops the
        // buy-in offer.
        if (casino.isSeated(p.userId) || blackjack.isSeated(p.userId)) {
          game.send(p, { type: 'notice', text: 'You hold chips at a table — use Stand / Cash out in the tray to leave.' });
        } else if (p.seated && (p.seated.kind === 'poker-pending' || p.seated.kind === 'blackjack-pending')) {
          // v1.3.1: handleInteract -> standUp() -> the onStandUp
          // hook releases the spectator reservation (was: manual
          // clearPending here, which the movement-stand path
          // bypassed — the seat-leak bug).
          game.handleInteract(p);
        } else if (!p.seated
          && !game.seatsInScene(p).some((s2) => Math.hypot(s2.x - p.x, s2.y - p.y) <= 52)) {
          // v1.5: two table games share the floor — the table whose
          // CENTRE is nearest owns the E press (a player standing
          // at the blackjack table is ~60px from its centre but can
          // be ~130px from the neighbouring poker table's centre,
          // inside its wide sit radius; nearest-centre keeps each
          // table's chairs unambiguous).
          const pk = casino.tableFor(p);
          const bj = blackjack.nearestTable(p);
          const pkD = pk ? Math.hypot(pk.x - p.x, pk.y - p.y) : Infinity;
          const bjD = bj ? bj.dist : Infinity;
          const sat = bjD < pkD ? blackjack.offerSeat(p) : casino.offerSeat(p);
          if (!sat) game.handleInteract(p);
          // sat down at a table — the buy-in offer is on its way.
          // (A real seat under your feet — a slot stool, a bar stool —
          // wins over the table offer: the tables' reach is wide.)
        } else {
          game.handleInteract(p);
        }
        break;
      }
      case 'buy-drink':
        // Phase B amendment: bartender drink purchase (5z, casino bars).
        game.handleBuyDrink(p);
        break;
      case 'debug-vice':
        // TEST MODE ONLY: fast-forward vice windows so the suite can
        // assert recovery/revert without real 20s waits (same pattern
        // as debug-casino; dead in production).
        if (TEST_MODE) {
          const now = Date.now();
          if (msg.op === 'wake') p.passedOutUntil = 1; // tick performs the wake + count reset
          else if (msg.op === 'unhippy') p.hippyUntil = 1; // tick clears + resyncs
          else if (msg.op === 'set-drinks' && Number.isFinite(msg.count)) p.vice.drinks = { count: Math.max(0, Math.min(99, Math.round(msg.count))), at: now };
          else if (msg.op === 'set-puffs' && Number.isFinite(msg.count)) p.vice.puffs = { count: Math.max(0, Math.min(99, Math.round(msg.count))), at: now };
          // v1.1: simulate time passing for ALL vice clocks at once
          // (the 30s window, pass-out, hippy) so the suite can assert
          // the window model without real 30s waits.
          else if (msg.op === 'age' && Number.isFinite(msg.ms)) {
            const ms = Math.max(0, Math.round(msg.ms));
            for (const k of ['drinks', 'puffs']) {
              if (p.vice[k] && p.vice[k].at) p.vice[k] = { count: p.vice[k].count, at: p.vice[k].at - ms };
            }
            if (p.passedOutUntil) p.passedOutUntil -= ms;
            if (p.hippyUntil) p.hippyUntil -= ms;
          }
        }
        break;
      case 'enter-studio':
      case 'leave-studio':
      case 'studio-buy':
      case 'studio-place':
      case 'studio-pickup':
      case 'studio-kick':
      case 'studio-state':
      case 'home-device':
      case 'home-meta':
      case 'home-set':
      case 'home-expand':
      case 'studio-invite':
      case 'studio-invite-response':
        studios.handle(p, msg);
        break;
      case 'avatar-update': {
        const r = applyAvatarUpdate(p.userId, msg);
        if (!r.ok) game.send(p, { type: 'notice', text: r.error });
        else game.send(p, { type: 'notice', text: '✨ New look saved!' });
        break;
      }
      case 'mix-list':
        game.send(p, { type: 'mixes', mixes: music.listMixes(p.userId) });
        break;
      case 'mix-save': {
        const r = music.saveMix(p.userId, msg.slot, msg.data);
        if (!r.ok) {
          game.send(p, { type: 'mix-error', error: r.error });
        } else {
          game.send(p, { type: 'mix-saved', mix: r.mix });
          game.send(p, { type: 'mixes', mixes: music.listMixes(p.userId) });
        }
        break;
      }
      case 'mix-delete': {
        const before = music.listMixes(p.userId).find(m => m.slot === msg.slot);
        const r = music.deleteMix(p.userId, msg.slot);
        if (!r.ok) game.send(p, { type: 'mix-error', error: r.error });
        else if (before) recordsModule.onMixDeleted(p.userId, before.id); // its CDs go with it
        game.send(p, { type: 'mixes', mixes: music.listMixes(p.userId) });
        break;
      }
      case 'buy-blanks':
      case 'burn-cd':
      case 'delete-cd':
      case 'cds':
      case 'chart':
        stages.handle(p, msg);
        break;
      case 'tip':
        stages.handleTip(p, msg.amount);
        break;
      case 'tip-dancer':
        // v1.4: Club Mirage — tip a dancer (amount presets and the
        // dancer id are validated server-side in club.js).
        club.handle(p, msg);
        break;
      case 'visitor-talk':
        // v1.9: speak with Orenius / Agent Sims (proximity and
        // presence are validated in visitors.js).
        visitors.talk(p, msg.id);
        break;
      case 'visitor-choice':
        // v1.9: the red fruit / the blue fruit.
        visitors.choice(p, msg.choice);
        break;
      case 'visitor-code':
        // v1.9: the access code, typed into the box for Agent Sims.
        visitors.code(p, msg.code);
        break;
      case 'visitor-summon':
        // v1.9: the owner's call — Zantheon's account only,
        // enforced in visitors.js.
        visitors.summon(p, msg.id);
        break;
      case 'stage-join':
        stages.handleJoin(p, msg.mixId);
        break;
      case 'stage-leave':
        stages.handleLeave(p);
        break;
      case 'vote':
        // Phase 5: strict — only the numbers 1 and -1 are votes.
        // Anything else (objects, strings, 0, 999) is dropped, not coerced.
        if (msg.value === 1 || msg.value === -1) stages.handleVote(p, msg.value);
        break;
      case 'debug-fish':
        // TEST MODE ONLY (v1.1.1): pin the next cast's outcome and/or
        // fast-forward a live cast, so the fishing suite can assert
        // the catch flow deterministically (dead in production).
        if (TEST_MODE) {
          if (msg.op === 'force-catch') p.fishForce = 'catch';
          else if (msg.op === 'force-miss') p.fishForce = 'miss';
          else if (msg.op === 'resolve-now' && p.casting) p.casting.until = 1;
        }
        break;
      case 'debug-teleport':
        if (TEST_MODE && Number.isFinite(msg.x) && Number.isFinite(msg.y) &&
            Math.abs(msg.x) < 10000 && Math.abs(msg.y) < 10000) {
          p.x = msg.x; p.y = msg.y;
          game.checkGateway(p);
        }
        break;
      case 'debug-seed-perf':
        // Test-only: seed today's performance-earnings ledger so the
        // daily-cap branch can be exercised without 70 performances.
        if (TEST_MODE && Number.isFinite(msg.earned)) {
          music.setPerfEarned(p.userId, localDay(), Math.min(100000, Math.max(0, msg.earned)));
        }
        break;
      case 'debug-bonus':
        // Test-only (SOLARION_TEST=1): rewind the caller's last
        // bonus day so the next connect exercises the next-day
        // (+100z, not the 5,000z welcome) claim path.
        if (TEST_MODE && msg.op === 'rewind-day') {
          q.setLastBonusDay.run('2000-01-01', p.userId);
        }
        break;
      case 'debug-casino':
        // Test-only (SOLARION_TEST=1): set the caller's z-coin balance
        // or seated stack so side-pot / insufficient-funds branches
        // can be exercised deterministically.
        if (TEST_MODE) {
          if (msg.op === 'set-balance' && Number.isFinite(msg.zcoins)) {
            q.setZCoins.run(Math.min(10000000, Math.max(0, Math.floor(msg.zcoins))), p.userId);
            game.send(p, { type: 'zcoins', zcoins: casino.zcoinsOf(p.userId) });
          } else if (msg.op === 'set-chips' && Number.isFinite(msg.chips)) {
            const found = casino.findSeatByUser(p.userId);
            if (found) {
              found.seat.chips = Math.min(10000000, Math.max(0, Math.floor(msg.chips)));
              found.table.persistSeat(found.seat);
              found.table.broadcast();
            } else {
              // v1.5: the same hook reaches blackjack stacks.
              const bjFound = blackjack.findSeatByUser(p.userId);
              if (bjFound) {
                bjFound.seat.chips = Math.min(10000000, Math.max(0, Math.floor(msg.chips)));
                bjFound.table.persistSeat(bjFound.seat);
                bjFound.table.broadcast();
              }
            }
          }
        }
        break;
      default:
        break;
    }
    } catch (e) {
      // Phase 5: a handler bug on one frame must never kill the server
      // for everyone. Log (bounded) and drop the frame.
      console.error(`[solarion] ws handler error (${msg.type}): ${e && e.message}`);
    }
  });

  // Phase 5: only the LIVE socket may remove the player. addPlayer()
  // closes the previous socket when an account reconnects; that stale
  // socket's close event arriving afterwards must not delete the fresh
  // player (pre-fix it also cashed out their poker seat mid-hand).
  const dropIfLive = () => {
    const cur = game.getPlayer(session.user.id);
    if (cur && cur.ws === ws) game.removePlayer(session.user.id);
  };
  ws.on('close', dropIfLive);
  ws.on('error', dropIfLive);
});

server.listen(PORT, () => {
  console.log(`[solarion] listening on http://localhost:${PORT} (test-mode: ${TEST_MODE})`);
  // Friend-launch fix: q.deleteExpiredSessions existed but was never
  // called — resolveSession only deletes a token when it is presented
  // again, so abandoned/expired tokens would pile up in the sessions
  // table forever (every login mints a fresh 30-day row). Sweep once
  // at boot, then hourly. unref'd so the timer never keeps a test
  // process alive on its own; failures are non-fatal by design.
  const sweepExpiredSessions = () => {
    try { q.deleteExpiredSessions.run(Date.now()); } catch (e) { /* non-fatal */ }
  };
  sweepExpiredSessions();
  const sessionSweep = setInterval(sweepExpiredSessions, 60 * 60 * 1000);
  if (typeof sessionSweep.unref === 'function') sessionSweep.unref();
  game.start();
  stages.start();
  casino.start();
  blackjack.start();
  club.start();
});

function shutdown() {
  try { casino.stop(); } catch (e) { /* ignore */ }
  try { blackjack.stop(); } catch (e) { /* ignore */ }
  try { stages.stop(); } catch (e) { /* ignore */ }
  try { game.stop(); } catch (e) { /* ignore */ }
  try { server.close(); } catch (e) { /* ignore */ }
  try { wss.close(); } catch (e) { /* ignore */ }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { server, game };

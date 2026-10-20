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
const { Game, localDay } = require('./game');
const { MAPS, clientMap } = require('./maps');
const { q } = require('./db');
const music = require('./music');
const { StageManager } = require('./stage');
const casinoModule = require('./casino');
const { CasinoSystem } = casinoModule;
const studioModule = require('./studio');
const { StudioSystem } = studioModule;

music.init();
casinoModule.initLedger();
studioModule.init();

const PORT = parseInt(process.env.SOLARION_PORT || process.env.PORT || '3000', 10);
const TEST_MODE = process.env.SOLARION_TEST === '1';

const app = express();
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
// Phase 4: private studios — instanced scenes (see studio.js). No
// per-studio registration anywhere: game.js resolves `studio:<id>`
// scene ids on demand, and this system only handles studio messages.
const studios = new StudioSystem(game);
game.onPlayerGone = (userId) => { stages.handlePlayerGone(userId); casino.handlePlayerGone(userId); };
game.onMapEntered = (p) => { stages.syncPlayer(p); casino.syncPlayer(p); };

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
    phase: 8,
    version: require('../package.json').version,
    uptime_s: Math.floor((Date.now() - startedAt) / 1000),
    players_online: total,
    maps: counts,
    tick: game.tickStats,
  });
});

const server = http.createServer(app);
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

  // Daily login bonus: atomic one-claim-per-day in the DB.
  const bonusGranted = game.claimDailyBonus(session.user.id);
  if (bonusGranted) {
    const fresh = q.avatarByUser.get(session.user.id);
    if (fresh) session.avatar.zcoins = fresh.zcoins;
  }

  const map = MAPS[p.mapId];
  game.send(p, {
    type: 'hello',
    you: game.publicPlayer(p),
    map: clientMap(map),
    players: game.playersInMap(p.mapId),
    chat: game.historyFor(p.mapId),
    zcoins: q.avatarByUser.get(session.user.id).zcoins,
    bonusGranted,
  });
  stages.syncPlayer(p);
  casino.syncPlayer(p);
  game.send(p, { type: 'mixes', mixes: music.listMixes(session.user.id) });

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
        // Seated at a poker table? Movement is locked until you stand.
        if (!casino.isSeated(p.userId)) game.handleInput(p, msg.keys);
        else p.keys = {};
        break;
      case 'poker':
        casino.handlePoker(p, msg);
        break;
      case 'slots':
        casino.handleSlots(p, msg);
        break;
      case 'chat':
        game.handleChat(p, msg.text);
        break;
      case 'interact':
        // Phase B sitting. Poker seats are managed by the casino
        // panel — a poker-seated player stands from there, not here.
        if (casino.isSeated(p.userId)) {
          game.send(p, { type: 'notice', text: 'Use Stand / Cash out in the casino panel to leave the poker table.' });
        } else {
          game.handleInteract(p);
        }
        break;
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
        const r = music.deleteMix(p.userId, msg.slot);
        if (!r.ok) game.send(p, { type: 'mix-error', error: r.error });
        game.send(p, { type: 'mixes', mixes: music.listMixes(p.userId) });
        break;
      }
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
  game.start();
  stages.start();
  casino.start();
});

function shutdown() {
  try { casino.stop(); } catch (e) { /* ignore */ }
  try { stages.stop(); } catch (e) { /* ignore */ }
  try { game.stop(); } catch (e) { /* ignore */ }
  try { server.close(); } catch (e) { /* ignore */ }
  try { wss.close(); } catch (e) { /* ignore */ }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { server, game };

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
 *
 * Game messages (server -> client):
 *   hello / map / snapshot / chat / notice / bonus
 */

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const auth = require('./auth');
const { Game } = require('./game');
const { MAPS, clientMap } = require('./maps');
const { q } = require('./db');

const PORT = parseInt(process.env.SOLARION_PORT || process.env.PORT || '3000', 10);
const TEST_MODE = process.env.SOLARION_TEST === '1';

const app = express();
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const game = new Game();
const startedAt = Date.now();

function sendAvatar(res, result) {
  res.json({
    ok: true,
    token: result.token,
    avatar: result.avatar,
    zcoins: result.avatar.zcoins,
  });
}

app.post('/api/register', (req, res) => {
  const { username, password, shirt, pants, skin_tone, hair_style, hair_color } = req.body || {};
  const r = auth.register(username, password, { shirt, pants, skin_tone, hair_style, hair_color });
  if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
  return sendAvatar(res, r);
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const r = auth.login(username, password, req.ip);
  if (!r.ok) return res.status(r.code || 401).json({ ok: false, error: r.error });
  return sendAvatar(res, r);
});

app.post('/api/me', (req, res) => {
  const s = auth.resolveSession((req.body || {}).token);
  if (!s) return res.status(401).json({ ok: false, error: 'Invalid or expired session.' });
  return res.json({ ok: true, avatar: auth.publicAvatar(s.avatar) });
});

app.get('/health', (req, res) => {
  const counts = game.mapCounts();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  res.json({
    ok: true,
    game: 'solarion',
    phase: 1,
    version: require('../package.json').version,
    uptime_s: Math.floor((Date.now() - startedAt) / 1000),
    players_online: total,
    maps: counts,
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  const session = auth.resolveSession(token);
  if (!session) {
    ws.close(4401, 'unauthorized');
    return;
  }

  const p = game.addPlayer(ws, session);

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

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'input':
        game.handleInput(p, msg.keys);
        break;
      case 'chat':
        game.handleChat(p, msg.text);
        break;
      case 'debug-teleport':
        if (TEST_MODE && Number.isFinite(msg.x) && Number.isFinite(msg.y)) {
          p.x = msg.x; p.y = msg.y;
          game.checkGateway(p);
        }
        break;
      default:
        break;
    }
  });

  ws.on('close', () => game.removePlayer(session.user.id));
  ws.on('error', () => game.removePlayer(session.user.id));
});

server.listen(PORT, () => {
  console.log(`[solarion] listening on http://localhost:${PORT} (test-mode: ${TEST_MODE})`);
  game.start();
});

function shutdown() {
  try { game.stop(); } catch (e) { /* ignore */ }
  try { server.close(); } catch (e) { /* ignore */ }
  try { wss.close(); } catch (e) { /* ignore */ }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { server, game };

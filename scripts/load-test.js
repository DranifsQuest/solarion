'use strict';

/**
 * Solarion Phase 5 — load sanity script.
 *
 * Spawns a throwaway server and drives ~50 concurrent WebSocket bots:
 * all of them moving, most chatting (within the rate limit), one full
 * stage queue -> performance -> vote cycle in Solstice Bay, a few slot
 * players, and a few studio visits. Reports:
 *   - errors seen (ws errors, unexpected closes, HTTP failures)
 *   - client-observed latency: input->next-snapshot and chat echo RTT
 *     (p50 / p95 / max)
 *   - server tick health from /health (tick count, overruns, max tick)
 *   - peak server RSS (sampled from /proc)
 *
 * The server is spawned with SOLARION_TEST=1 (for debug-teleport role
 * placement) AND SOLARION_TEST_NO_ABUSE_LIMITS=1 — 50 fresh accounts
 * from one IP is exactly what the production registration throttle is
 * designed to stop, so the harness opts out explicitly, same pattern
 * as the game test suites. Production never sets either var.
 *
 * Usage: node scripts/load-test.js [bots] [seconds]
 * Exit code 0 = completed (numbers in the report), 1 = harness failure.
 */

const { spawn } = require('node:child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const BOTS = parseInt(process.argv[2] || process.env.SOLARION_LOAD_BOTS || '50', 10);
const RUN_S = parseInt(process.argv[3] || process.env.SOLARION_LOAD_SECONDS || '40', 10);
const PORT = parseInt(process.env.SOLARION_LOAD_PORT || '48250', 10);
const DB_PATH = path.join(ROOT, 'data', `load-test-${process.pid}.db`);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main() {
  for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
  const child = spawn('node', ['src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      SOLARION_PORT: String(PORT),
      SOLARION_DB_PATH: DB_PATH,
      SOLARION_TEST: '1',
      SOLARION_TEST_NO_ABUSE_LIMITS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverErr = '';
  child.stderr.on('data', d => { serverErr += d.toString(); });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start: ' + serverErr)), 15000);
    child.stdout.on('data', d => { if (d.toString().includes('listening on')) { clearTimeout(t); resolve(); } });
    child.on('error', reject);
  });

  // Peak RSS sampler.
  let peakRssKb = 0;
  const rssTimer = setInterval(() => {
    try {
      const status = fs.readFileSync(`/proc/${child.pid}/status`, 'utf8');
      const m = /VmRSS:\s+(\d+)\s*kB/.exec(status);
      if (m) peakRssKb = Math.max(peakRssKb, Number(m[1]));
    } catch (e) { /* child gone */ }
  }, 500);

  const errors = [];
  const api = (route, body) => fetch(`http://localhost:${PORT}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));

  // ------------------------------------------------------------ bots
  const bots = [];
  const t0 = Date.now();
  for (let i = 0; i < BOTS; i++) {
    const name = `loadbot_${i}`;
    const reg = await api('/api/register', { username: name, password: 'secretpw' });
    if (reg.status !== 200) { errors.push(`register ${name}: HTTP ${reg.status}`); continue; }
    // Phase 6 gate: no world entry before character creation.
    const cc = await api('/api/create-character', { token: reg.json.token, name, gender: i % 2 ? 'F' : 'M' });
    if (cc.status !== 200) { errors.push(`create ${name}: HTTP ${cc.status}`); continue; }
    const bot = {
      i, name, token: reg.json.token, id: null, ws: null, msgs: [],
      counts: {}, lastMapId: null,
      pendingInputAt: 0, pendingChat: new Map(), seq: 0,
      snapLat: [], chatLat: [], snaps: 0, closed: false,
    };
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${encodeURIComponent(bot.token)}`);
    bot.ws = ws;
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`bot ${i} no hello`)), 8000);
      ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
        bot.counts[m.type] = (bot.counts[m.type] || 0) + 1;
        if (m.type === 'map' && m.map) bot.lastMapId = m.map.id;
        bot.msgs.push(m);
        if (bot.msgs.length > 400) bot.msgs.splice(0, 200);
        if (m.type === 'hello') { bot.id = m.you.id; clearTimeout(t); resolve(); }
        if (m.type === 'snapshot') {
          bot.snaps++;
          if (bot.pendingInputAt) { bot.snapLat.push(Date.now() - bot.pendingInputAt); bot.pendingInputAt = 0; }
        }
        if (m.type === 'chat' && m.fromId === bot.id && bot.pendingChat.has(m.text)) {
          bot.chatLat.push(Date.now() - bot.pendingChat.get(m.text));
          bot.pendingChat.delete(m.text);
        }
      });
      ws.on('error', (e) => errors.push(`bot ${i} ws error: ${e.message}`));
      ws.on('close', () => { bot.closed = true; });
    }).catch(e => errors.push(e.message));
    bots.push(bot);
  }
  const connected = bots.filter(b => b.id != null);
  console.log(`[load] ${connected.length}/${BOTS} bots connected in ${Date.now() - t0}ms`);

  const send = (bot, m) => { try { bot.ws.send(JSON.stringify(m)); } catch (e) { errors.push(`bot ${bot.i} send: ${e.message}`); } };

  // ------------------------------------------------------------ roles
  const performer = connected[0];
  const audience = connected.slice(1, 5);
  const slotBots = connected.slice(5, 8);
  const studioOwner = connected[10];
  const studioGuests = connected.slice(8, 10);
  const wanderers = connected.filter(b => ![performer, ...audience, ...slotBots, studioOwner, ...studioGuests].includes(b));

  send(performer, {
    type: 'mix-save', slot: 1,
    data: { name: 'Load Mix', bpm: 160, bars: 2, tracks: [{ loopId: 'pop-drums-1', startBar: 0 }] },
  });
  await sleep(600);
  const savedMix = performer.msgs.filter(m => m.type === 'mix-saved').pop();
  for (const b of [performer, ...audience, ...slotBots]) send(b, { type: 'debug-teleport', x: 1120, y: 48 }); // -> Solstice Bay
  await sleep(1800); // portal debounce
  for (const b of slotBots) send(b, { type: 'debug-teleport', x: 496, y: 1200 }); // -> Casino building door
  await sleep(1800); // portal debounce
  for (const b of slotBots) send(b, { type: 'debug-teleport', x: 528, y: 112 }); // slot machine 1's stool
  await sleep(1700); // let the 3s transfer lock from the door hop expire
  for (const b of slotBots) send(b, { type: 'interact' }); // sit on the stool to spin
  send(studioOwner, { type: 'enter-studio', owner: studioOwner.name });
  await sleep(500);
  for (const g of studioGuests) send(g, { type: 'enter-studio', owner: studioOwner.name });

  let stageCycleDone = false;
  let votesAcked = 0;

  // ------------------------------------------------------------ activity loop
  const stopAt = Date.now() + RUN_S * 1000;
  const timers = [];
  // Wanderers + everyone else in public maps: move + chat.
  for (const b of wanderers) {
    timers.push(setInterval(() => {
      if (b.closed) return;
      const dirs = [{ up: true }, { down: true }, { left: true }, { right: true }, { up: true, left: true }, { down: true, right: true }, {}];
      b.pendingInputAt = Date.now();
      send(b, { type: 'input', keys: pick(dirs) });
    }, 250));
    timers.push(setInterval(() => {
      if (b.closed) return;
      const text = `lt-${b.i}-${++b.seq} load hello`;
      b.pendingChat.set(text, Date.now());
      send(b, { type: 'chat', text });
    }, rand(5000, 9000)));
  }
  for (const b of [...audience, ...studioGuests]) {
    timers.push(setInterval(() => {
      if (b.closed) return;
      const text = `lt-${b.i}-${++b.seq} cheering`;
      b.pendingChat.set(text, Date.now());
      send(b, { type: 'chat', text });
    }, rand(6000, 10000)));
  }
  // Slots.
  for (const b of slotBots) {
    timers.push(setInterval(() => { if (!b.closed) send(b, { type: 'slots', action: 'spin', bet: pick([5, 10, 25]) }); }, 2600));
  }
  // Stage: join at +3s, audience votes when the performance starts.
  setTimeout(() => { if (savedMix) send(performer, { type: 'stage-join', mixId: savedMix.mix.id }); }, 3000);
  const stageWatcher = setInterval(() => {
    for (const b of audience) {
      if ((b.counts['performance-start'] || 0) > 0 && !b._voted) {
        b._voted = true;
        send(b, { type: 'vote', value: 1 });
      }
    }
    votesAcked = audience.filter(x => (x.counts['vote-ack'] || 0) > 0).length;
    if (audience.some(b => (b.counts['performance-end'] || 0) > 0)) stageCycleDone = true;
  }, 400);
  timers.push(stageWatcher);

  // Health snapshots mid-run.
  const healthSamples = [];
  while (Date.now() < stopAt) {
    await sleep(5000);
    try {
      const h = await fetch(`http://localhost:${PORT}/health`).then(r => r.json());
      healthSamples.push({ at_s: Math.round((Date.now() - t0) / 1000), players: h.players_online, tick: h.tick });
    } catch (e) { errors.push(`health poll: ${e.message}`); }
  }

  for (const t of timers) clearInterval(t);
  clearInterval(rssTimer);

  // ------------------------------------------------------------ report
  const snapLat = bots.flatMap(b => b.snapLat).sort((a, b2) => a - b2);
  const chatLat = bots.flatMap(b => b.chatLat).sort((a, b2) => a - b2);
  const slotResults = slotBots.reduce((n, b) => n + (b.counts['slot-result'] || 0), 0);
  const finalHealth = await fetch(`http://localhost:${PORT}/health`).then(r => r.json()).catch(() => null);
  const report = {
    botsRequested: BOTS,
    botsConnected: connected.length,
    botsStillConnected: bots.filter(b => !b.closed).length,
    durationS: RUN_S,
    errors,
    errorCount: errors.length,
    stageCycleCompleted: stageCycleDone,
    audienceVotesAcked: votesAcked,
    slotResults,
    studioGuestsInStudio: studioGuests.filter(g => g.lastMapId && String(g.lastMapId).startsWith('studio:')).length,
    totalSnapshotsReceived: bots.reduce((n, b) => n + b.snaps, 0),
    snapshotLatencyMs: { n: snapLat.length, p50: pct(snapLat, 50), p95: pct(snapLat, 95), max: snapLat.length ? snapLat[snapLat.length - 1] : null },
    chatEchoLatencyMs: { n: chatLat.length, p50: pct(chatLat, 50), p95: pct(chatLat, 95), max: chatLat.length ? chatLat[chatLat.length - 1] : null },
    serverTick: finalHealth ? finalHealth.tick : null,
    healthSamples,
    peakServerRssMB: Math.round((peakRssKb / 1024) * 10) / 10,
    serverStderrTail: serverErr.slice(-500) || null,
  };
  console.log(JSON.stringify(report, null, 2));

  for (const b of bots) { try { b.ws.close(); } catch (e) {} }
  child.kill('SIGTERM');
  await sleep(600);
  for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
  if (child.exitCode === null) child.kill('SIGKILL');
  process.exit(errors.length ? 1 : 0);
}

main().catch(e => { console.error('[load] harness failure:', e); process.exit(1); });

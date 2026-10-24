'use strict';
/**
 * Solarion LIVE verification harness.
 *
 * Drives the real production service (or any base URL) end-to-end with
 * two fresh accounts and prints one PASS/FAIL line per check.
 *
 *   SOLARION_BASE=https://solarion.onrender.com node scripts/live-verify.mjs
 *
 * Optional remote-DB leg: when DATABASE_URL (libsql://…) and
 * DATABASE_AUTH_TOKEN are present in the harness env (wired from
 * GitHub secrets in .github/workflows/live-verify.yml — never
 * echoed), one extra leg verifies that the deployed service, when
 * running on the remote DB, keeps a fresh account + character
 * intact across a re-login. When the env vars are absent the leg
 * is reported as SKIPPED and does not affect the pass count.
 *
 * No test-only hooks are used (no debug-teleport): all travel is done
 * by steering with snapshot feedback, exactly like a real player.
 */
import WebSocket from 'ws';

const BASE = (process.env.SOLARION_BASE || 'https://solarion.onrender.com').replace(/\/$/, '');
const WS_BASE = BASE.replace(/^http/, 'ws');
const SFX = Date.now().toString(36).slice(-6);
const NAME_A = `TestBot${SFX}a`;
const NAME_B = `TestBot${SFX}b`;
const PW = 'verify-pass-1';

const results = [];
function report(name, ok, evidence) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${evidence ? ` — ${evidence}` : ''}`);
}
function reportSkip(name, evidence) {
  // Skipped legs are NOT pushed to results: the "N/N checks passed"
  // total behaves exactly as before when an optional leg is off.
  console.log(`SKIP  ${name}${evidence ? ` — ${evidence}` : ''}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(cond, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for: ${label}`);
    await sleep(60);
  }
}

async function api(route, body) {
  const r = await fetch(`${BASE}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

function connectClient(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(token)}`);
    const client = { ws, msgs: [], hello: null, send: (m) => { try { ws.send(JSON.stringify(m)); } catch (e) {} } };
    const t = setTimeout(() => { try { ws.terminate(); } catch (e) {} reject(new Error('no hello within 10s')); }, 10000);
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      client.msgs.push(m);
      if (m.type === 'hello') { client.hello = m; clearTimeout(t); resolve(client); }
    });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

const lastOf = (client, type, pred) => client.msgs.filter(m => m.type === type && (!pred || pred(m))).pop() || null;

function selfPos(client) {
  const s = lastOf(client, 'snapshot');
  if (s) { const me = s.players.find(p => p.id === client.hello.you.id); if (me) return me; }
  return client.hello ? client.hello.you : null;
}

/** Closed-loop steering toward (tx,ty); stops early when stopWhen() is truthy. */
async function walkTo(client, tx, ty, { timeout = 40000, arrive = 14, stopWhen = null, deadband = 6, strafeMs = 650 } = {}) {
  const start = Date.now();
  let lastPos = null, lastMove = Date.now(), strafeUntil = 0, strafeDir = 1, strafeAxis = 'right';
  while (Date.now() - start < timeout) {
    if (stopWhen && stopWhen()) { client.send({ type: 'input', keys: {} }); return selfPos(client); }
    const p = selfPos(client);
    if (!p) { await sleep(100); continue; }
    const dx = tx - p.x, dy = ty - p.y;
    if (Math.abs(dx) <= arrive && Math.abs(dy) <= arrive) { client.send({ type: 'input', keys: {} }); return p; }
    if (lastPos && Math.hypot(p.x - lastPos.x, p.y - lastPos.y) > 2) lastMove = Date.now();
    lastPos = { x: p.x, y: p.y };
    const keys = {};
    if (Date.now() < strafeUntil) { keys[strafeAxis] = true; }
    else {
      if (dx > deadband) keys.right = true; else if (dx < -deadband) keys.left = true;
      if (dy > deadband) keys.down = true; else if (dy < -deadband) keys.up = true;
      if (Date.now() - lastMove > 1600) {
        // Stuck: strafe PERPENDICULAR to the dominant remaining delta —
        // sliding along a wall face is what finds gaps like doorways.
        strafeAxis = Math.abs(dx) >= Math.abs(dy)
          ? (strafeDir > 0 ? 'down' : 'up')
          : (strafeDir > 0 ? 'right' : 'left');
        strafeUntil = Date.now() + strafeMs; strafeDir *= -1; lastMove = Date.now();
      }
    }
    client.send({ type: 'input', keys });
    await sleep(120);
  }
  client.send({ type: 'input', keys: {} });
  throw new Error(`walk to ${tx},${ty} timed out`);
}

/**
 * Walk onto a gateway/door rect and wait for the map switch.
 * Every transfer runs a fixed load-screen window during which the
 * server locks movement (3s in Phase B; 1.5s since v1.2 Item T) —
 * so after each arrival we wait out the full window (which also
 * covers the 1.5s portal debounce) before walking again.
 */
async function travel(client, tx, ty, expectMap, label) {
  await sleep(1750);
  const marker = client.msgs.length;
  const arrived = () => client.msgs.slice(marker).some(m => m.type === 'map' && m.map.id === expectMap) ? true : null;
  await walkTo(client, tx, ty, { timeout: 60000, stopWhen: arrived });
  const m = await waitFor(() => client.msgs.slice(marker).filter(x => x.type === 'map' && x.map.id === expectMap).pop(), 8000, label);
  await sleep(2000); // 1.5s transfer lock (v1.2 Item T) + debounce margin for the next hop
  return m;
}

// Mixer rework: the verify mix is saved in the v2 per-cell format
// (one bubble per line at bar 0), so the music leg below also proves
// the new format round-trips save -> burn -> perform byte-identical.
const SHORT_MIX = {
  name: 'Verify Banger', bpm: 160, bars: 2,
  tracks: [
    { cells: [{ loopId: 'pop-drums-1', bar: 0 }] },
    { cells: [{ loopId: 'pop-bass-1', bar: 0 }] },
  ],
};

let A = null, B = null; // { name, token, client, id }

async function main() {
  // ---- warm-up: free plan sleeps; poll /health until it answers
  let health = null;
  const warmStart = Date.now();
  while (Date.now() - warmStart < 150000) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) { health = await r.json(); break; } } catch (e) {}
    await sleep(3000);
  }
  report('health: service answers, phase 10, thirteen maps', !!(health && health.ok && health.phase === 10 && Object.keys(health.maps).length === 13),
    health ? `uptime ${health.uptime_s}s, phase ${health.phase}` : 'no response in 150s');
  if (!health) return finish();

  const loops = await fetch(`${BASE}/api/music/loops`).then(r => r.json()).catch(() => null);
  report('music catalog: GET /api/music/loops serves 40+ loops', !!(loops && loops.ok && loops.loops.length >= 40),
    loops && loops.loops ? `${loops.loops.length} loops` : 'no catalog');

  // ---- accounts
  try {
    const ra = await api('/api/register', { username: NAME_A, password: PW });
    if (ra.status !== 200 || !ra.json.token) throw new Error(`register A -> ${ra.status} ${JSON.stringify(ra.json)}`);
    if (ra.json.avatar.created !== false) throw new Error('fresh account A should start uncreated');
    const rb = await api('/api/register', { username: NAME_B, password: PW });
    if (rb.status !== 200 || !rb.json.token) throw new Error(`register B -> ${rb.status} ${JSON.stringify(rb.json)}`);
    if (rb.json.avatar.created !== false) throw new Error('fresh account B should start uncreated');
    A = { name: NAME_A, token: ra.json.token };
    B = { name: NAME_B, token: rb.json.token };
    report('register: two fresh verify_* accounts created over HTTPS POST', true, `A=${NAME_A} B=${NAME_B}`);
  } catch (e) { report('register: two fresh verify_* accounts created over HTTPS POST', false, e.message); return finish(); }

  // ---- character creation (Phase 6): A becomes F, B becomes M
  try {
    const lookA = {
      token: A.token, name: NAME_A, gender: 'F', face: 'heart', eyes: 'lash',
      eye_color: '#1e4d8f', nose: 'tiny', lips: 'rose', skin_tone: '#c68642',
      hair_style: 'ponytail', hair_color: '#c0392b', top_style: 'hoodie',
      body_color: '#e5639e', bottom_style: 'skirt', accent_color: '#2b3a55',
      shoe_color: '#ffd23f', accessory: 'glasses',
    };
    const ca = await api('/api/create-character', lookA);
    if (ca.status !== 200 || !ca.json.avatar || ca.json.avatar.created !== true) throw new Error(`create A -> ${ca.status} ${JSON.stringify(ca.json)}`);
    for (const k of ['gender', 'face', 'eyes', 'nose', 'lips', 'hair_style', 'bottom_style']) {
      if (ca.json.avatar[k] !== lookA[k]) throw new Error(`A avatar.${k} = ${ca.json.avatar[k]}, expected ${lookA[k]}`);
    }
    const lookB = {
      token: B.token, name: NAME_B, gender: 'M', face: 'square', eyes: 'bold',
      eye_color: '#20242c', nose: 'long', lips: 'smirk', skin_tone: '#f1c27d',
      hair_style: 'mohawk', hair_color: '#222222', top_style: 'jacket',
      body_color: '#3aa7e0', bottom_style: 'cargo', accent_color: '#003366',
      shoe_color: '#23262b', accessory: 'cap',
    };
    const cb = await api('/api/create-character', lookB);
    if (cb.status !== 200 || !cb.json.avatar || cb.json.avatar.created !== true) throw new Error(`create B -> ${cb.status} ${JSON.stringify(cb.json)}`);
    for (const k of ['gender', 'face', 'eyes', 'nose', 'lips', 'hair_style', 'bottom_style']) {
      if (cb.json.avatar[k] !== lookB[k]) throw new Error(`B avatar.${k} = ${cb.json.avatar[k]}, expected ${lookB[k]}`);
    }
    const dup = await api('/api/create-character', lookA);
    if (dup.status !== 409) throw new Error(`second create for A -> ${dup.status}, expected 409`);
    report('character creation: F + M characters created over POST, one-shot enforced', true, 'A=F heart/lash/ponytail/skirt, B=M square/bold/mohawk/cargo');
  } catch (e) { report('character creation: F + M characters created over POST, one-shot enforced', false, e.message); return finish(); }

  try {
    const li = await api('/api/login', { username: NAME_A, password: PW });
    if (li.status !== 200 || !li.json.token) throw new Error(`login -> ${li.status}`);
    A.token = li.json.token;
    const me = await api('/api/me', { token: A.token });
    if (me.status !== 200 || me.json.avatar.name !== NAME_A) throw new Error(`/api/me -> ${me.status}`);
    report('login + /api/me: POST auth round-trip works live', true, 'login 200, /api/me returns A avatar');
  } catch (e) { report('login + /api/me: POST auth round-trip works live', false, e.message); return finish(); }

  // ---- WS connect + welcome bonus (exactly once)
  try {
    A.client = await connectClient(A.token);
    A.id = A.client.hello.you.id;
    const h = A.client.hello;
    if (h.map.id !== 'the-gateway') throw new Error(`spawn map ${h.map.id}`);
    if (h.bonusGranted !== true || h.bonusAmount !== 5000 || h.zcoins !== 5000) throw new Error(`bonus=${h.bonusGranted} amount=${h.bonusAmount} z=${h.zcoins}`);
    if (h.you.gender !== 'F' || h.you.face !== 'heart' || h.you.hair_style !== 'ponytail' || h.you.bottom_style !== 'skirt') {
      throw new Error(`hello appearance mismatch: ${JSON.stringify({ g: h.you.gender, f: h.you.face, hair: h.you.hair_style, b: h.you.bottom_style })}`);
    }
    report('ws connect A: hello in The Gateway, +5,000z welcome bonus granted', true, `zcoins=${h.zcoins}, appearance F/heart/ponytail/skirt in hello`);
  } catch (e) { report('ws connect A: hello in The Gateway, +5,000z welcome bonus granted', false, e.message); return finish(); }

  try {
    B.client = await connectClient(B.token);
    B.id = B.client.hello.you.id;
    if (B.client.hello.zcoins !== 5000) throw new Error(`B z=${B.client.hello.zcoins}`);
    if (B.client.hello.you.gender !== 'M' || B.client.hello.you.face !== 'square' || B.client.hello.you.hair_style !== 'mohawk') {
      throw new Error('B hello appearance mismatch');
    }
    report('ws connect B: hello received, +5,000z welcome bonus granted', true, `zcoins=${B.client.hello.zcoins}, appearance M/square/mohawk in hello`);
  } catch (e) { report('ws connect B: hello received, +5,000z welcome bonus granted', false, e.message); return finish(); }

  // ---- presence + chat + movement
  try {
    await waitFor(() => { const s = lastOf(A.client, 'snapshot'); return s && s.players.some(p => p.id === B.id); }, 6000, 'A sees B');
    await waitFor(() => { const s = lastOf(B.client, 'snapshot'); return s && s.players.some(p => p.id === A.id); }, 6000, 'B sees A');
    report('presence: A and B see each other in snapshots', true, 'mutual snapshot presence');
  } catch (e) { report('presence: A and B see each other in snapshots', false, e.message); }

  // Politeness (X, 2026-10-21): the chat exchange happens inside
  // B's PRIVATE home instance, not a public room — a verify bot's
  // "hello" line in the Gateway crossed a real player's session.
  // Homes are instanced rooms on the same per-map chat broadcast
  // path (handleChat -> broadcastToMap), so the check keeps its
  // meaning: A's line must reach B with the sender name attached.
  // Both bots return to the Gateway afterwards for the legs below.
  try {
    B.client.send({ type: 'enter-studio', owner: NAME_B });
    await waitFor(() => lastOf(B.client, 'map', m => m.map.id === `studio:${B.id}`), 8000, 'B enters own home');
    B.client.send({ type: 'studio-invite', username: NAME_A });
    await waitFor(() => lastOf(A.client, 'studio-invite', i => i.fromId === B.id), 6000, 'A got B\'s home invite');
    A.client.send({ type: 'studio-invite-response', ownerId: B.id, accept: true });
    await waitFor(() => lastOf(A.client, 'map', m => m.map.id === `studio:${B.id}`), 8000, 'A lands in B\'s home');
    await sleep(2200); // ride out the 1.5s invite transfer window
    B.client.msgs.length = 0;
    A.client.send({ type: 'chat', text: 'hello from verify A' });
    await waitFor(() => B.client.msgs.some(m => m.type === 'chat' && m.text === 'hello from verify A' && m.from === NAME_A), 6000, 'chat delivered');
    report('chat: A message delivered to B with sender name', true, 'chat received by B inside B\'s private home (no public-room chatter)');
    A.client.send({ type: 'leave-studio' });
    await waitFor(() => lastOf(A.client, 'map', m => m.map.id === 'the-gateway'), 8000, 'A back in the Gateway');
    B.client.send({ type: 'leave-studio' });
    await waitFor(() => lastOf(B.client, 'map', m => m.map.id === 'the-gateway'), 8000, 'B back in the Gateway');
  } catch (e) { report('chat: A message delivered to B with sender name', false, e.message); }

  try {
    // RIDER FIX (v1.3): this leg used to fail intermittently as the
    // FIRST walk of the run — three consecutive production runs
    // (39716507864 tail, 39717523862, 39722881485) timed out here
    // while every later walk leg passed. Cause: the chat leg above
    // ends with TWO scene transfers (leave-studio x2), and every
    // transfer sets the server-side movement lock
    // (game.js switchScene: transferUntil = now + 1.5s; the tick
    // and input handler both skip locked players). This leg started
    // immediately and held {right} for a FIXED 900ms — the residual
    // lock could eat the entire input window, so the server never
    // moved A and the (correct) assertion timed out. Every other
    // walk goes through travel(), which sleeps 1750ms before
    // walking — exactly the ride-out this leg was missing.
    // Fix: ride out the lock first (parity with travel()), then
    // HOLD the input until the server snapshot proves the movement
    // instead of releasing on a fixed timer. The assertion itself
    // is unchanged and unweakened: a server snapshot must still
    // show A more than 50px east of the start.
    await sleep(1750);
    const before = selfPos(A.client);
    A.client.send({ type: 'input', keys: { right: true } });
    let after;
    try {
      after = await waitFor(() => { const p = selfPos(A.client); return p && p.x > before.x + 50 ? p : null; }, 6000, 'A moved east');
    } finally {
      A.client.send({ type: 'input', keys: {} });
    }
    report('movement: server-authoritative walk moves A east', true, `x ${before.x} -> ${after.x}`);
  } catch (e) { report('movement: server-authoritative walk moves A east', false, e.message); }

  try {
    A.client.ws.close();
    await sleep(500);
    A.client = await connectClient(A.token);
    const h = A.client.hello;
    if (h.bonusGranted !== false || h.zcoins !== 5000) throw new Error(`relog bonus=${h.bonusGranted} z=${h.zcoins}`);
    report('welcome bonus exactly once: relog grants no second bonus, balance stays 5,000z', true, `bonusGranted=false zcoins=${h.zcoins}`);
  } catch (e) { report('welcome bonus exactly once: relog grants no second bonus, balance stays 5,000z', false, e.message); }

  // ---- travel to Solstice Bay (both)
  try {
    const m = await travel(A.client, 1120, 48, 'solstice-bay', 'A gateway -> solstice-bay');
    if (m.map.name !== 'Solstice Bay') throw new Error(`map name ${m.map.name}`);
    await travel(B.client, 1120, 48, 'solstice-bay', 'B gateway -> solstice-bay');
    report('gateway travel: A and B walked Gateway -> Solstice Bay', true, 'map switch confirmed for both');
  } catch (e) { report('gateway travel: A and B walked Gateway -> Solstice Bay', false, e.message); return finish(); }

  // ---- music: save -> burn CD -> perform -> vote -> payout (Phase 9 ritual)
  try {
    A.client.send({ type: 'mix-save', slot: 1, data: SHORT_MIX });
    const saved = await waitFor(() => lastOf(A.client, 'mix-saved'), 6000, 'mix saved');
    const mixId = saved.mix.id;
    A.client.send({ type: 'buy-blanks' });
    await waitFor(() => lastOf(A.client, 'cds', c => c.blanks >= 10), 6000, 'blank pack bought');
    A.client.send({ type: 'burn-cd', mixId });
    await waitFor(() => lastOf(A.client, 'cds', c => c.cds.some(cd => cd.mixId === mixId)), 6000, 'CD burned');
    A.client.send({ type: 'stage-join', mixId });
    await waitFor(() => lastOf(B.client, 'stage-queue', q => q.queue.some(e => e.userId === A.id)), 8000, 'B sees queue');
    const startB = await waitFor(() => lastOf(B.client, 'performance-start', s => s.performerId === A.id), 8000, 'performance start');
    if (JSON.stringify(startB.mix) !== JSON.stringify(SHORT_MIX)) throw new Error('audience received different mix data');
    // Phase 9 audibility (the hard requirement): the PERFORMER's own
    // client receives the same performance-start, identical timing.
    const startA = await waitFor(() => lastOf(A.client, 'performance-start', s => s.performerId === A.id), 8000, 'performer start');
    if (startA.startAt !== startB.startAt || JSON.stringify(startA.mix) !== JSON.stringify(startB.mix)) {
      throw new Error('performer start differs from audience start');
    }
    report('audibility: performer + audience receive identical performance-start', true, `startAt match, mix data match`);
    B.client.send({ type: 'vote', value: 1 });
    await waitFor(() => lastOf(B.client, 'vote-ack'), 6000, 'vote ack');
    const end = await waitFor(() => lastOf(B.client, 'performance-end'), 35000, 'performance end');
    if (end.up !== 1 || end.earned !== 5) throw new Error(`end up=${end.up} earned=${end.earned}`);
    const z = await waitFor(() => lastOf(A.client, 'zcoins', z => z.zcoins === 4985), 6000, 'A paid');
    report('music: save -> burn CD -> stage perform -> audience vote -> +5z payout', true, `earned=${end.earned} A balance=5000-20(pack)+5=${z.zcoins}`);
  } catch (e) { report('music: save -> burn CD -> stage perform -> audience vote -> +5z payout', false, e.message); }

  // ---- casino: slots
  const balA = async () => (await api('/api/me', { token: A.token })).json.avatar.zcoins;
  const balB = async () => (await api('/api/me', { token: B.token })).json.avatar.zcoins;
  try {
    // A: bay -> Casino building door -> Casino Lounge scene -> slot 1 spot
    const dm = await travel(A.client, 496, 1200, 'casino-lounge', 'A bay -> casino lounge door');
    if (dm.map.name !== 'Casino Lounge') throw new Error(`lounge name ${dm.map.name}`);
    if (!dm.map.casino || dm.map.casino.tables.length !== 6 || dm.map.casino.slots.length !== 10) {
      throw new Error(`lounge payload tables=${dm.map.casino && dm.map.casino.tables.length} slots=${dm.map.casino && dm.map.casino.slots.length}`);
    }
    await walkTo(A.client, 624, 112); // slot 1's stool in the slots section
    A.client.send({ type: 'interact' }); // sit to spin (Phase B amendment)
    await waitFor(() => {
      const s = lastOf(A.client, 'snapshot');
      const me2 = s && s.players.find(p => p.id === A.id);
      return me2 && me2.seated ? true : null;
    }, 6000, 'A seated at slot machine 1');
    const beforeBal = await balA();
    A.client.msgs.length = 0;
    A.client.send({ type: 'slots', action: 'spin', bet: 5 });
    const res = await waitFor(() => lastOf(A.client, 'slot-result'), 6000, 'slot result');
    if (res.bet !== 5 || !Array.isArray(res.reels) || res.reels.length !== 3) throw new Error(`bad result ${JSON.stringify(res)}`);
    if (res.zcoins !== beforeBal - 5 + res.win) throw new Error(`math: ${beforeBal} -5 +${res.win} != ${res.zcoins}`);
    if ((await balA()) !== res.zcoins) throw new Error('DB balance mismatch after spin');
    report('casino slots: spin settles with exact balance math', true, `bet 5, win ${res.win}, balance ${beforeBal} -> ${res.zcoins}`);
    await sleep(1600); // slot cooldown
  } catch (e) { report('casino slots: spin settles with exact balance math', false, e.message); }

  // ORDER NOTE (Phase 10, kept for determinism): poker runs
  // BEFORE the bar ritual. The original reason — the bar's 45z
  // of drinks could drop A under the table's 50z minimum buy-in
  // — no longer binds now that fresh accounts start at 5,000z,
  // but the order is harmless and keeps the balance trail
  // easy to follow.
  // ---- casino: poker hand with chip conservation
  // Per-table buy-ins (v1.1.2): the FIRST player SETS the table's
  // buy-in through the offer flow; the second JOINS at exactly that
  // amount. Conservation is derived from the amounts actually
  // debited, never hardcoded to 200z stacks.
  try {
    const T1 = 'casino-lounge-poker-1';
    const SET_BUYIN = 100; // the amount A chooses when setting the table
    const preA = await balA(), preB = await balB();
    await travel(B.client, 496, 1200, 'casino-lounge', 'B bay -> casino lounge door');
    await walkTo(A.client, 176, 176);
    await walkTo(B.client, 176, 176);
    const tbl = (u) => lastOf(u.client, 'poker-state', s => s.id === T1);
    // The offer flow: E at the table snaps you into a chair and pops
    // the buy-in offer. One retry — a first interact can land while
    // the player is still standing up from a previous seat.
    const offerFor = async (u, tag) => {
      u.client.send({ type: 'interact' });
      try {
        return await waitFor(() => lastOf(u.client, 'poker-offer'), 3000, `${tag} offer (first try)`);
      } catch (e) {
        u.client.send({ type: 'interact' });
        return await waitFor(() => lastOf(u.client, 'poker-offer'), 9000, `${tag} buy-in offer`);
      }
    };
    // A starts the table and SETS the buy-in at SET_BUYIN.
    const offerA = await offerFor(A, 'A');
    if (offerA.established !== false || offerA.amount !== null) throw new Error(`A's offer should start an unset table: ${JSON.stringify(offerA)}`);
    A.client.send({ type: 'poker', action: 'buyin', amount: SET_BUYIN });
    await waitFor(() => { const s = tbl(A); return s && s.chairs.some(c => c.name === A.name); }, 10000, 'A seated after setting the buy-in');
    const debA = preA - (await balA());
    if (debA !== SET_BUYIN) throw new Error(`A debited ${debA}, want exactly the chosen ${SET_BUYIN}`);
    if (tbl(A).buyin !== SET_BUYIN) throw new Error(`table buy-in reads ${tbl(A).buyin}, want ${SET_BUYIN}`);
    // B joins at A's amount — exactly SET_BUYIN, not B's own cap.
    const offerB = await offerFor(B, 'B');
    if (offerB.established !== true || offerB.amount !== SET_BUYIN) throw new Error(`B's offer should quote the table's ${SET_BUYIN}: ${JSON.stringify(offerB)}`);
    const midB = await balB();
    B.client.send({ type: 'poker', action: 'buyin' });
    await waitFor(() => { const s = tbl(B); return s && s.chairs.some(c => c.name === B.name); }, 10000, 'B seated after joining');
    const debB = midB - (await balB());
    if (debB !== SET_BUYIN) throw new Error(`B debited ${debB}, want exactly the table's ${SET_BUYIN}`);
    await waitFor(() => lastOf(A.client, 'poker-cards'), 30000, 'hole cards dealt');
    // check/call the hand down
    const start = Date.now();
    let doneState = null;
    while (Date.now() - start < 90000) {
      const sA = tbl(A), sB = tbl(B);
      if ((sA && sA.state === 'done') || (sB && sB.state === 'done')) { doneState = sA && sA.state === 'done' ? sA : sB; break; }
      for (const u of [A, B]) {
        const s = tbl(u);
        if (!s) continue;
        const idx = s.chairs.findIndex(c => c.name === u.name);
        if (idx >= 0 && s.chairs[idx].acting) {
          u.client.send({ type: 'poker', action: 'act', table: T1, act: s.toCall > 0 ? 'call' : 'check' });
          await sleep(450);
        }
      }
      await sleep(200);
    }
    if (!doneState) throw new Error('hand did not finish in 90s');
    const won = doneState.winners.reduce((s, w) => s + w.amount, 0);
    if (won !== doneState.pot) throw new Error(`winners ${won} != pot ${doneState.pot}`);
    await waitFor(() => { const s = tbl(A); return s && s.state === 'idle'; }, 20000, 'table idle');
    A.client.send({ type: 'poker', action: 'stand', table: T1 });
    B.client.send({ type: 'poker', action: 'stand', table: T1 });
    await sleep(800);
    const postA = await balA(), postB = await balB();
    if (postA + postB !== preA + preB) throw new Error(`conservation: before ${preA}+${preB}=${preA + preB}, after ${postA}+${postB}=${postA + postB}`);
    report('casino poker: full hand to showdown, pot paid in full, chips conserved', true, `A set the buy-in at ${SET_BUYIN}z, B joined at ${SET_BUYIN}z, pot=${doneState.pot} winners=${doneState.winners.map(w => w.name + ':' + w.amount).join(',')} totals ${preA + preB} -> ${postA + postB}`);
  } catch (e) { report('casino poker: full hand to showdown, pot paid in full, chips conserved', false, e.message); }

  // ---- v1.5 Feature 1: the board is IN the table state, street
  // by street (the client renders it on the felt from exactly
  // this). Pure read-back of the hand just played — the verify
  // hand always checks/calls to showdown, so the flop (3) and
  // the full board (5) must both appear in A's state stream.
  try {
    const states = A.client.msgs.filter(m => m.type === 'poker-state' && m.id === 'casino-lounge-poker-1');
    const lens = new Set(states.map(s => (s.community || []).length));
    if (!lens.has(3)) throw new Error(`flop never broadcast (lengths seen: ${[...lens].join(',')})`);
    if (!lens.has(5)) throw new Error('full board never broadcast');
    const doneS = states.filter(s => s.state === 'done').pop();
    if (!doneS || doneS.community.length !== 5) throw new Error('showdown state does not carry all five board cards');
    report('casino poker: community board broadcasts street by street (3 -> 5)', true, `board lengths seen: ${[...lens].sort().join(', ')}`);
  } catch (e) { report('casino poker: community board broadcasts street by street (3 -> 5)', false, e.message); }

  // ---- v1.5 Feature 3: blackjack — sit at the converted table,
  // bet, stand-always to settlement; the stack delta must equal
  // the server's reported net and cash-out must be exact.
  try {
    const BJT = 'casino-lounge-blackjack-1';
    const pre = await balA();
    await walkTo(A.client, 400, 368); // south of the blackjack table (400, 336)
    const btbl = () => lastOf(A.client, 'blackjack-state', s => s.id === BJT);
    A.client.send({ type: 'interact' });
    let offer = null;
    try {
      offer = await waitFor(() => lastOf(A.client, 'blackjack-offer'), 3000, 'blackjack offer (first try)');
    } catch (e) {
      A.client.send({ type: 'interact' });
      offer = await waitFor(() => lastOf(A.client, 'blackjack-offer'), 9000, 'blackjack buy-in offer');
    }
    if (offer.established !== false || offer.amount !== null) throw new Error(`first sitter should start an unset table: ${JSON.stringify(offer)}`);
    A.client.send({ type: 'blackjack', action: 'buyin', amount: 100 });
    await waitFor(() => { const s = btbl(); return s && s.chairs.some(c => c.name === A.name && Number.isFinite(c.chips)); }, 10000, 'A seated at blackjack with chips');
    if ((await balA()) !== pre - 100) throw new Error(`buy-in debit wrong (${pre} -> ${await balA()})`);
    // One full round, stand-always.
    let betSent = false;
    let payout = null;
    const rStart = Date.now();
    while (Date.now() - rStart < 90000) {
      const s = btbl();
      if (s) {
        const mine = s.chairs.find(c => c.name === A.name);
        if (mine) {
          if (s.state === 'betting' && !mine.bet && !betSent) {
            A.client.send({ type: 'blackjack', action: 'bet', table: BJT, amount: 10 });
            betSent = true;
          } else if (s.state === 'playing' && mine.acting) {
            A.client.send({ type: 'blackjack', action: 'act', table: BJT, act: 'stand' });
            await sleep(300);
          } else if (s.state === 'payout' && mine.result) { payout = s; break; }
        }
      }
      await sleep(200);
    }
    if (!payout) throw new Error('blackjack round did not settle in 90s');
    const mine = payout.chairs.find(c => c.name === A.name);
    const res = (payout.results || []).find(r => r.name === A.name);
    if (!res) throw new Error('no result reported for A');
    if (mine.bet !== 0) throw new Error(`bet left on the felt after settlement (${mine.bet})`);
    if (mine.chips !== 100 + res.amount) throw new Error(`stack ${mine.chips} != 100 + net ${res.amount}`);
    A.client.send({ type: 'blackjack', action: 'stand' });
    await waitFor(() => { const s = btbl(); return s && !s.chairs.some(c => c.name === A.name); }, 10000, 'A cashed out of blackjack');
    const post = await balA();
    if (post !== pre + res.amount) throw new Error(`cash-out math: ${pre} + net ${res.amount} != ${post}`);
    report('casino blackjack: full round settles, stack delta == reported net, cash-out exact', true, `result=${res.result} net=${res.amount} balance ${pre} -> ${post}`);
  } catch (e) { report('casino blackjack: full round settles, stack delta == reported net, cash-out exact', false, e.message); }

  // ---- casino bar: the day's first drink is the Phase 9 treat
  // (free + 10z tip); drinks after cost exactly 5z; the 10th passes
  // A out cold. v1.1 rule: the WHOLE drunk state (count, haze,
  // pass-out) expires 30s after the last drink — A wakes sober (0).
  try {
    await walkTo(A.client, 208, 656); // bar patron spot (movement stands A up from the stool)
    const b0 = await balA();
    A.client.msgs.length = 0;
    A.client.send({ type: 'buy-drink' });
    const vs1 = await waitFor(() => lastOf(A.client, 'vice-state'), 6000, 'vice-state after drink 1');
    if (vs1.drinks !== 1) throw new Error(`drinks after 1st = ${vs1.drinks}`);
    if ((await balA()) !== b0 + 10) throw new Error(`first drink of the day was not the free treat +10z tip (${b0} -> ${await balA()})`);
    report('casino bar: first drink of the day is free + a 10z house tip (Phase 9 ritual)', true, `balance ${b0} -> ${b0 + 10}, drinks=1`);
    for (let i = 0; i < 9; i++) A.client.send({ type: 'buy-drink' });
    const lastDrinkAt = Date.now(); // the 30s drunk window runs from the LAST drink
    const vsOut = await waitFor(() => lastOf(A.client, 'vice-state', v => v.passedOut), 8000, 'A passed out at drink 10');
    if (vsOut.drinks !== 10) throw new Error(`drinks at pass-out = ${vsOut.drinks}`);
    if ((await balA()) !== b0 + 10 - 45) throw new Error(`ten drinks math wrong (${b0} -> ${await balA()}, want ${b0 - 35}: treat +10, then 9 x 5z)`);
    const fallen = await waitFor(() => {
      const s = lastOf(A.client, 'snapshot');
      const me2 = s && s.players.find(p => p.id === A.id);
      return me2 && me2.fallen ? me2 : null;
    }, 6000, 'fallen pose in snapshots');
    if (!fallen) throw new Error('no fallen snapshot');
    // v1.1: the whole drunk state expires 30s after the last drink.
    // Wait past that envelope (32s from the 10th drink) before
    // asserting: A must be awake AND sober — count 0, not the old 2.
    // (Polling starts after the deadline so the last vice-state on
    // file is the expiry broadcast, not a mid-drinking one.)
    await sleep(Math.max(0, lastDrinkAt + 32000 - Date.now()));
    const vsWake = await waitFor(() => lastOf(A.client, 'vice-state', v => !v.passedOut), 10000, 'A wakes sober as the 30s window expires');
    if (vsWake.drinks !== 0) throw new Error(`drinks after waking = ${vsWake.drinks} (want 0: the 30s window expired the whole drunk state)`);
    report('casino bar: 10th drink passes A out cold; drunk state expires 30s after the last drink, A wakes sober (0 drinks)', true, 'pass-out + fallen broadcast, waited out the 30s envelope, count 0 on waking');
  } catch (e) { report('casino bar: 10th drink passes A out cold; drunk state expires 30s after the last drink, A wakes sober (0 drinks)', false, e.message); }

  // ---- studio: buy -> place -> relog persistence
  try {
    A.client.send({ type: 'enter-studio', owner: NAME_A });
    const entered = await waitFor(() => lastOf(A.client, 'map', m => m.map.id === `studio:${A.id}`), 8000, 'A enters own studio');
    if (!entered) throw new Error('no studio map payload');
    const st0 = await waitFor(() => lastOf(A.client, 'studio-state', s => s.isOwner), 6000, 'owner studio-state');
    if (!st0.catalog || st0.catalog.length < 12) throw new Error(`catalog ${st0.catalog && st0.catalog.length}`);
    const preBal = await balA();
    A.client.send({ type: 'studio-buy', itemId: 'cozy-chair' });
    const zMsg = await waitFor(() => lastOf(A.client, 'zcoins', z => z.zcoins === preBal - 40), 6000, 'chair debit');
    const st1 = await waitFor(() => lastOf(A.client, 'studio-state', s => s.inventory && s.inventory.length === 1), 6000, 'chair in inventory');
    const chair = st1.inventory[0];
    A.client.send({ type: 'studio-place', instanceItemId: chair.instanceId, x: 5, y: 5, rot: 1 });
    await waitFor(() => lastOf(A.client, 'studio-furniture', f => f.furniture.length === 1), 6000, 'chair placed');
    A.client.send({ type: 'leave-studio' });
    await waitFor(() => lastOf(A.client, 'map', m => !m.map.id.startsWith('studio:')), 8000, 'A leaves studio');
    // relog and re-enter: furniture must persist
    A.client.ws.close();
    await sleep(500);
    A.client = await connectClient(A.token);
    A.client.send({ type: 'enter-studio', owner: NAME_A });
    const re = await waitFor(() => lastOf(A.client, 'map', m => m.map.id === `studio:${A.id}`), 8000, 'A re-enters studio after relog');
    const f = re.furniture || [];
    if (f.length !== 1 || f[0].itemId !== 'cozy-chair' || f[0].x !== 5 || f[0].y !== 5 || f[0].rot !== 1) throw new Error(`furniture after relog: ${JSON.stringify(f)}`);
    if ((await balA()) !== preBal - 40) throw new Error('balance not persisted');
    A.client.send({ type: 'leave-studio' });
    await waitFor(() => lastOf(A.client, 'map', m => !m.map.id.startsWith('studio:')), 8000, 'A leaves studio after relog');
    report('studio: buy chair (-40z) -> place -> relog persistence verified', true, `balance ${preBal} -> ${preBal - 40}, furniture intact after relog`);
  } catch (e) { report('studio: buy chair (-40z) -> place -> relog persistence verified', false, e.message); }

  // ---- player homes (Phase 8): catalog, room invite, radio sync.
  // Fresh account D (5,000z welcome bonus) buys a boombox (80z);
  // B — sitting in the Casino Lounge — accepts D's invite from
  // across the world and watches the radio state change. (TV
  // purchase/playback is covered by the local suite; the live
  // catalog check asserts TVs and radios are on sale.)
  try {
    const NAME_D = NAME_A.slice(0, -1) + 'd';
    const rd = await api('/api/register', { username: NAME_D, password: PW });
    if (rd.status !== 200 || !rd.json.token) throw new Error(`register D -> ${rd.status}`);
    const cd = await api('/api/create-character', { token: rd.json.token, name: NAME_D, gender: 'F' });
    if (cd.status !== 200) throw new Error(`create D -> ${cd.status}`);
    const D = { name: NAME_D, token: rd.json.token, client: await connectClient(rd.json.token) };
    D.id = D.client.hello.you.id;
    const balD = async () => (await api('/api/me', { token: D.token })).json.avatar.zcoins;
    D.client.send({ type: 'enter-studio', owner: NAME_D });
    await waitFor(() => lastOf(D.client, 'map', m => m.map.id === `studio:${D.id}`), 8000, 'D enters own studio');
    const dst = await waitFor(() => lastOf(D.client, 'studio-state', s => s.isOwner), 6000, 'D owner studio-state');
    if (!dst.catalog || dst.catalog.length < 40) throw new Error(`homes catalog ${dst.catalog && dst.catalog.length}`);
    if (!dst.catalog.some(i => i.type === 'tv') || !dst.catalog.some(i => i.type === 'radio')) throw new Error('catalog lacks TVs or radios');
    report('homes catalog: 40+ items on sale incl. TVs and radios', true, `${dst.catalog.length} items`);
    D.client.send({ type: 'studio-buy', itemId: 'boombox' });
    const dst1 = await waitFor(() => lastOf(D.client, 'studio-state', s => s.inventory && s.inventory.length === 1), 6000, 'boombox in inventory');
    // Derive from D's actual hello balance so this survives future
    // welcome-bonus changes (5,000z today -> expect start - 80).
    const dStart = D.client.hello.zcoins;
    const dAfter = await balD();
    if (dAfter !== dStart - 80) throw new Error(`D balance after boombox = ${dAfter} (want hello ${dStart} - 80 = ${dStart - 80})`);
    const boom = dst1.inventory[0];
    D.client.send({ type: 'studio-place', instanceItemId: boom.instanceId, x: 5, y: 5, rot: 0 });
    await waitFor(() => lastOf(D.client, 'studio-furniture', f => f.furniture.length === 1), 6000, 'boombox placed');

    // invite: B is across the world in the Casino Lounge
    B.client.msgs.length = 0;
    D.client.send({ type: 'studio-invite', username: NAME_B });
    const prompt = await waitFor(() => lastOf(B.client, 'studio-invite'), 6000, 'B invite prompt');
    if (prompt.fromName !== NAME_D || prompt.ownerId !== D.id) throw new Error(`invite payload ${JSON.stringify(prompt)}`);
    B.client.send({ type: 'studio-invite-response', ownerId: D.id, accept: true });
    const bArr = await waitFor(() => lastOf(B.client, 'map', m => m.map.id === `studio:${D.id}`), 8000, 'B lands in D studio');
    if (bArr.transferMs !== 1500) throw new Error(`invite transferMs ${bArr.transferMs}`);
    report('room invite: B accepted from the Casino Lounge and landed in D\'s home via the 1.5s transfer', true, 'prompt -> accept -> map studio:<D> transferMs=1500');
    await sleep(3400); // ride out B's transfer window

    // radio: D plays the loop library; B watches play + next; B stops it
    const dev0 = await waitFor(() => lastOf(B.client, 'studio-state', s => s.devices && s.devices.length === 1), 6000, 'B studio-state devices');
    if (dev0.devices[0].kind !== 'radio' || dev0.devices[0].playing !== false) throw new Error('radio default state wrong');
    D.client.send({ type: 'home-device', instanceId: boom.instanceId, action: 'play' });
    const play = await waitFor(() => lastOf(B.client, 'home-device', m => m.device && m.device.playing === true), 6000, 'B sees radio play');
    const firstLoop = play.device.track && play.device.track.loopId;
    if (!firstLoop || !play.device.startedAt) throw new Error(`play payload ${JSON.stringify(play.device)}`);
    D.client.send({ type: 'home-device', instanceId: boom.instanceId, action: 'next' });
    const nxt = await waitFor(() => lastOf(B.client, 'home-device', m => m.device && m.device.track && m.device.track.loopId && m.device.track.loopId !== firstLoop), 6000, 'B sees next track');
    B.client.send({ type: 'home-device', instanceId: boom.instanceId, action: 'stop' });
    await waitFor(() => lastOf(D.client, 'home-device', m => m.device && m.device.playing === false), 6000, 'D sees B stop the radio');
    report('home radio: play/next state syncs to a visitor with server start times; a visitor can stop it', true, `${firstLoop} -> ${nxt.device.track.loopId}, startedAt set`);
    // B heads back to the Casino Lounge (its return point) for later checks
    B.client.send({ type: 'leave-studio' });
    await waitFor(() => lastOf(B.client, 'map', m => m.map.id === 'casino-lounge'), 8000, 'B returns to the lounge');
    await sleep(3400);
    D.client.ws.close();
  } catch (e) { report('player homes (Phase 8): catalog / invite / radio', false, e.message); }

  // ---- return A to The Gateway (the studio step leaves A wherever
  // A entered from — currently the Casino Lounge)
  try {
    let cur = (lastOf(A.client, 'map') || {}).map;
    let curId = cur && cur.id;
    const fromId = curId;
    if (curId && curId.startsWith('studio:')) {
      A.client.send({ type: 'leave-studio' });
      const m = await waitFor(() => lastOf(A.client, 'map', x => !x.map.id.startsWith('studio:')), 8000, 'A exits studio');
      curId = m.map.id;
    }
    if (curId === 'casino-lounge') {
      await travel(A.client, 544, 720, 'solstice-bay', 'lounge door back to the bay');
      curId = 'solstice-bay';
    }
    if (curId === 'solstice-bay') {
      await travel(A.client, 1152, 1392, 'the-gateway', 'bay return gateway');
    } else if (curId !== 'the-gateway') {
      throw new Error(`unexpected map before city tours: ${curId}`);
    }
    report('positioning: A returned to The Gateway for the city tours', true, `arrived from ${fromId}`);
  } catch (e) { report('positioning: A returned to The Gateway for the city tours', false, e.message); return finish(); }

  // ---- sitting: A sits on a Gateway bench and stands back up
  try {
    const seatedInSnapshots = () => {
      const s = lastOf(A.client, 'snapshot');
      const me2 = s && s.players.find(p => p.id === A.id);
      return me2 && me2.seated ? true : null;
    };
    await walkTo(A.client, 1008, 624, { arrive: 10 });
    A.client.send({ type: 'interact' });
    try {
      await waitFor(seatedInSnapshots, 6000, 'A seated in snapshots');
    } catch (e) {
      // One honest retry: a first interact can land while the walk
      // is still settling (observed live — this leg timed out on an
      // attempt where everything else passed). Re-approach the
      // bench and interact once more; the assertion stays
      // observational (seated=true must appear in snapshots).
      await walkTo(A.client, 1008, 624, { arrive: 10 });
      A.client.send({ type: 'interact' });
      await waitFor(seatedInSnapshots, 6000, 'A seated in snapshots (retry)');
    }
    A.client.send({ type: 'interact' });
    await waitFor(() => {
      const s = lastOf(A.client, 'snapshot');
      const me2 = s && s.players.find(p => p.id === A.id);
      return me2 && me2.seated === false ? true : null;
    }, 6000, 'A stood back up');
    report('sitting: A sat on a Gateway bench (seated in snapshots) and stood back up', true, 'seated=true -> interact -> seated=false');
  } catch (e) { report('sitting: A sat on a Gateway bench (seated in snapshots) and stood back up', false, e.message); }

  // ---- Phase 10: the home door — walk in through your own front
  // door on the Gateway, and back out through your home's own door.
  try {
    const inHome = await travel(A.client, 240, 720, `studio:${A.id}`, 'gateway home door -> A home');
    if (!inHome.map.studio || !inHome.map.studio.door) throw new Error('home payload has no door');
    const hd = inHome.map.studio.door;
    const out = await travel(A.client, hd.x + hd.w / 2, hd.y + hd.h / 2, 'the-gateway', 'home door -> gateway');
    // Landed outside the front door (one tile south of its pad).
    if (Math.abs(out.you.x - 240) > 3 || Math.abs(out.you.y - 752) > 3) {
      throw new Error(`landed at ${out.you.x},${out.you.y} instead of outside the front door`);
    }
    // Step away from the doorstep before the tours: the door stands
    // in the x~240 column, and a beeline north from the doorstep
    // crosses its own pad (a door working as a door should) — walk
    // back east into the plaza, to the same ground the tours have
    // always started from (its line to the Neon arch clears the
    // north houses block, unlike a start further south).
    await walkTo(A.client, 1008, 700, { arrive: 16 });
    report('home door: Gateway front door -> home -> out the home door, landing outside it', true, 'real doors both ways, no warp pads');
  } catch (e) { report('home door: Gateway front door -> home -> out the home door, landing outside it', false, e.message); }

  // ---- travel: remaining four cities and back
  const cities = [
    { arch: [224, 48], id: 'neon-district', name: 'Neon District', back: [1152, 1392] },
    { arch: [672, 48], id: 'cinder-mesa', name: 'Cinder Mesa', back: [128, 1392] },
    { arch: [1568, 48], id: 'frosthaven', name: 'Frosthaven', back: [1152, 48] },
    { arch: [2016, 48], id: 'verdant-hollow', name: 'Verdant Hollow', back: [2144, 1392] },
  ];
  for (const c of cities) {
    try {
      // Approach along the terrace lane in front of the gatehouses
      // (y=176, row 5½), then turn north into the arch. A beeline
      // from the previous gatehouse's doorstep runs along the tower
      // row instead: it presses intermediate towers and the slide
      // funnels it through an intermediate gatehouse's passage into
      // the WRONG city. A player walks the lane, not the wall line —
      // so the bot does the same. The check is unchanged: A still
      // walks into the arch and the map switch must fire.
      await walkTo(A.client, c.arch[0], 176, { arrive: 16 });
      const m = await travel(A.client, c.arch[0], c.arch[1], c.id, `gateway -> ${c.id}`);
      if (m.map.name !== c.name) throw new Error(`name ${m.map.name}`);
      if (!m.map.stage) throw new Error('no stage in city payload');
      if (c.id === 'neon-district') {
        // Phase B amendment: the second casino, through its door.
        try {
          const nc = await travel(A.client, 1968, 1232, 'neon-casino', 'neon -> neon casino door'); // FRONT (south) face since v1.2.2 Item 8
          if (!nc.map.casino || nc.map.casino.tables.length !== 6 || nc.map.casino.slots.length !== 10) {
            throw new Error('neon casino payload incomplete');
          }
          if (!nc.map.casino.bartender || nc.map.casino.bartender.name !== 'Vex') throw new Error('neon bartender missing');
          await travel(A.client, 544, 720, 'neon-district', 'neon casino door back');
          report('travel: Neon District -> Neon Casino -> Neon District (doors both ways)', true, 'second casino: 6 tables, 10 slots, bartender Vex');
        } catch (e) { report('travel: Neon District -> Neon Casino -> Neon District (doors both ways)', false, e.message); }
      }
      await travel(A.client, c.back[0], c.back[1], 'the-gateway', `${c.id} -> gateway`);
      report(`travel: Gateway -> ${c.name} -> Gateway (walking)`, true, 'round trip by walking, stage present');
    } catch (e) { report(`travel: Gateway -> ${c.name} -> Gateway (walking)`, false, e.message); }
  }

  // ---- hookah lounge: a fresh visitor C puffs 5z x10, turns hippy
  // (server-broadcast override). v1.1 rule: the hippy state holds
  // through the window and reverts 30s after the LAST puff.
  try {
    const NAME_C = NAME_A.slice(0, -1) + 'c'; // vfy<sfx>a -> vfy<sfx>c (A/B end a/b)
    const rc = await api('/api/register', { username: NAME_C, password: PW });
    if (rc.status !== 200 || !rc.json.token) throw new Error(`register C -> ${rc.status}`);
    const cc = await api('/api/create-character', { token: rc.json.token, name: NAME_C, gender: 'M', accessory: 'cap', body_color: '#39b06e' });
    if (cc.status !== 200) throw new Error(`create C -> ${cc.status}`);
    const C = { name: NAME_C, token: rc.json.token, client: await connectClient(rc.json.token) };
    C.id = C.client.hello.you.id;
    const balC = async () => (await api('/api/me', { token: C.token })).json.avatar.zcoins;
    await travel(C.client, 672, 48, 'cinder-mesa', 'C gateway -> cinder mesa');
    // Swing wide to the building's north side — its door faces
    // north. One steering retry: the mesa's cacti can trap the
    // bot's strafe for a whole walk window; a player just re-paths.
    try { await walkTo(C.client, 1250, 976); }
    catch (e) { await walkTo(C.client, 1250, 976); }
    const hm = await travel(C.client, 976, 1232, 'hookah-lounge', 'C cinder -> hookah lounge door'); // FRONT (south) face since v1.2.2 Item 8
    if (!hm.map.hookahs || hm.map.hookahs.length !== 4) throw new Error('hookah payload incomplete');
    await walkTo(C.client, 208, 224, { arrive: 12 }); // station 1's seats
    C.client.send({ type: 'interact' });
    await waitFor(() => {
      const s = lastOf(C.client, 'snapshot');
      const me2 = s && s.players.find(p => p.id === C.id);
      return me2 && me2.seated ? true : null;
    }, 6000, 'C seated at the hookah');
    for (let i = 0; i < 10; i++) { C.client.send({ type: 'interact' }); await sleep(120); }
    const lastPuffAt = Date.now(); // the 30s hippy window runs from the LAST puff
    const vsH = await waitFor(() => lastOf(C.client, 'vice-state', v => v.hippy), 8000, 'C turned hippy at puff 10');
    if (vsH.puffs !== 0) throw new Error(`puffs after trip = ${vsH.puffs} (want reset to 0)`);
    // Derive from C's actual hello balance (5,000z welcome bonus
    // today -> expect start - 10*5z), not a hardcoded 100z start.
    const cStart = C.client.hello.zcoins;
    const cAfter = await balC();
    if (cAfter !== cStart - 50) throw new Error(`C balance after 10 puffs = ${cAfter} (want hello ${cStart} - 10*5z = ${cStart - 50})`);
    // Hippy must be ON inside the window (headband in snapshots)...
    const hip = await waitFor(() => {
      const s = lastOf(C.client, 'snapshot');
      const me2 = s && s.players.find(p => p.id === C.id);
      return me2 && me2.hippy && me2.accessory === 'headband' ? me2 : null;
    }, 6000, 'hippy override in snapshots');
    if (!hip) throw new Error('no hippy snapshot');
    // ...and revert only once the window lapses: 30s after the last
    // puff (+2s buffer), not the old flat 20s.
    await sleep(Math.max(0, lastPuffAt + 32000 - Date.now()));
    const back = await waitFor(() => {
      const s = lastOf(C.client, 'snapshot');
      const me2 = s && s.players.find(p => p.id === C.id);
      return me2 && !me2.hippy && me2.accessory === 'cap' ? me2 : null;
    }, 10000, 'C reverts after the 30s window');
    if (!back) throw new Error('hippy did not revert');
    report('hookah lounge: 10 puffs at 5z turn C hippy (broadcast); hippy holds in the window and reverts 30s after the last puff', true, `puffs reset, balance ${cStart} -> ${cAfter}, headband inside window -> real look after 30s`);
    C.client.ws.close();
  } catch (e) { report('hookah lounge: 10 puffs at 5z turn C hippy (broadcast); hippy holds in the window and reverts 30s after the last puff', false, e.message); }

  // ---- club mirage (v1.4): a fresh visitor D walks Neon -> the
  // club's front door, drinks at Mira's bar (the shared vice path:
  // the day's first pour is on the house), and tips Roxy — the
  // room gets the flourish broadcast and the tip is a pure sink.
  try {
    const NAME_D = NAME_A.slice(0, -1) + 'e'; // visitor E — 'd' is already registered by the homes leg above
    const rd = await api('/api/register', { username: NAME_D, password: PW });
    if (rd.status !== 200 || !rd.json.token) throw new Error(`register D -> ${rd.status}`);
    const cd2 = await api('/api/create-character', { token: rd.json.token, name: NAME_D, gender: 'F' });
    if (cd2.status !== 200) throw new Error(`create D -> ${cd2.status}`);
    const D = { name: NAME_D, token: rd.json.token, client: await connectClient(rd.json.token) };
    D.id = D.client.hello.you.id;
    const balD = async () => (await api('/api/me', { token: D.token })).json.avatar.zcoins;
    const dStart = D.client.hello.zcoins;
    await walkTo(D.client, 224, 176, { arrive: 16 }); // the terrace lane, like the city legs
    await travel(D.client, 224, 48, 'neon-district', 'D gateway -> neon');
    const cm = await travel(D.client, 304, 1232, 'club-mirage', 'D neon -> club mirage door'); // FRONT (south) face
    if (!cm.map.club || cm.map.club.stages.length !== 3) throw new Error('club payload incomplete');
    const dancerNames = cm.map.club.stages.map(s => s.dancer && s.dancer.name).join(',');
    if (dancerNames !== 'Roxy,Vega,Lola') throw new Error(`dancers ${dancerNames}`);
    if (!cm.map.club.bartender || cm.map.club.bartender.name !== 'Mira') throw new Error('club bartender missing');
    // a drink at the bar: the day's first is on the house (+10z tip)
    await walkTo(D.client, cm.map.club.bar.x, cm.map.club.bar.y, { arrive: 12 });
    D.client.send({ type: 'buy-drink' });
    await waitFor(() => D.client.msgs.filter(m => m.type === 'notice' && /on the house/.test(m.text)).pop(), 8000, 'D free drink at the club');
    const dAfterDrink = await balD();
    if (dAfterDrink !== dStart + 10) throw new Error(`D balance after free drink = ${dAfterDrink} (want hello ${dStart} + 10)`);
    // tip Roxy 25 from her stage front: guarded debit + flourish
    const stg = cm.map.club.stages[0];
    await walkTo(D.client, stg.x + stg.w / 2, stg.y + stg.h + 40, { arrive: 12 });
    D.client.send({ type: 'tip-dancer', dancer: stg.dancer.id, amount: 25 });
    await waitFor(() => D.client.msgs.filter(m => m.type === 'dancer-flourish' && m.dancer === stg.dancer.id && m.amount === 25).pop(), 8000, 'D sees Roxy flourish');
    const dAfterTip = await balD();
    if (dAfterTip !== dStart + 10 - 25) throw new Error(`D balance after tip = ${dAfterTip} (want ${dStart - 15})`);
    // back out the front door
    await travel(D.client, 976, 784, 'neon-district', 'D club -> neon door back');
    report('club mirage: Neon -> Club Mirage -> Neon (doors both ways); free first drink at the club bar; a 25z dancer tip flourishes and sinks', true, `3 stages (Roxy, Vega, Lola), bartender Mira, balance ${dStart} -> ${dAfterTip}`);
    D.client.ws.close();
  } catch (e) { report('club mirage: Neon -> Club Mirage -> Neon (doors both ways); free first drink at the club bar; a 25z dancer tip flourishes and sinks', false, e.message); }

  // ---- positioning: B walked home. The homes leg ends with B
  // back in the Casino Lounge (its leave-studio return point), but
  // the Phase 9 legs below premise B at the Gateway with A (the
  // navigator count) — and B is a regular account, so no warping
  // home: B walks, lounge door -> Bay -> gatehouse -> Gateway.
  try {
    let bMap = lastOf(B.client, 'map');
    let bId = bMap && bMap.map.id;
    if (bId && bId.startsWith('studio:')) {
      B.client.send({ type: 'leave-studio' });
      const m = await waitFor(() => lastOf(B.client, 'map', x => !x.map.id.startsWith('studio:')), 8000, 'B exits studio');
      bId = m.map.id;
    }
    if (bId === 'casino-lounge') {
      await travel(B.client, 544, 720, 'solstice-bay', 'B lounge door back to the bay');
      bId = 'solstice-bay';
    }
    if (bId === 'solstice-bay') {
      await travel(B.client, 1152, 1392, 'the-gateway', 'B bay return gateway');
      bId = 'the-gateway';
    }
    if (bId !== 'the-gateway') throw new Error(`unexpected B map before Phase 9: ${bId}`);
    const bm = lastOf(B.client, 'map');
    if (!bm || bm.map.id !== 'the-gateway') throw new Error(`B map after walking home: ${bm && bm.map.id}`);
    report('positioning: B walked home from the Casino Lounge to The Gateway', true, 'lounge door -> bay gatehouse, on foot');
  } catch (e) { report('positioning: B walked home from the Casino Lounge to The Gateway', false, e.message); }

  // ---- Phase 9: friends + navigator (v1.2 Item J: fast travel is
  // owner-only now — these legs assert the NEW contract: regular
  // accounts keep the who's-where INFO but their join-friend /
  // navigate warps are refused server-side, so B WALKS instead.)
  try {
    A.client.send({ type: 'friend-request', username: B.name });
    await waitFor(() => lastOf(B.client, 'friend-request', f => f.fromId === A.id), 6000, 'B got friend request');
    B.client.send({ type: 'friend-respond', userId: A.id, accept: true });
    await waitFor(() => lastOf(A.client, 'friends', f => f.friends.some(u => u.id === B.id && u.online)), 6000, 'A sees B as online friend');
    // Read the connect-time hello (client.hello is stored separately
    // at connect and never cleared) — the msgs buffer gets cleared
    // by earlier legs, so lastOf(..., 'hello') can be null here.
    if (B.client.hello.you.isOwner !== false) throw new Error('harness account B should NOT be flagged owner');
    const mark = B.client.msgs.length;
    B.client.send({ type: 'join-friend', userId: A.id });
    const refusal = await waitFor(() => B.client.msgs.slice(mark).filter(m => m.type === 'notice' && /Fast travel is owner-only/.test(m.text)).pop(), 6000, 'join-friend refused for a regular account');
    if (!refusal) throw new Error('no owner-only refusal notice');
    if (B.client.msgs.slice(mark).some(m => m.type === 'map')) throw new Error('a forged join-friend MOVED a regular account');
    report('friends + join: request/accept + presence work; join-friend warp is owner-only (B refused, stays put)', true, 'refusal notice received, no map change');
  } catch (e) { report('friends + join: request/accept + presence work; join-friend warp is owner-only (B refused, stays put)', false, e.message); }

  try {
    B.client.send({ type: 'navigator' });
    const nav = await waitFor(() => lastOf(B.client, 'navigator'), 6000, 'navigator payload');
    if (!nav.places || nav.places.length !== 11) throw new Error(`places=${nav.places && nav.places.length}`);
    const gw = nav.places.find(p => p.id === 'the-gateway');
    if (!gw || gw.count < 2) throw new Error(`gateway count=${gw && gw.count} (A and B are there)`);
    if (!gw.friends.includes(A.name)) throw new Error('navigator does not mark A as a friend in the Gateway');
    const mark2 = B.client.msgs.length;
    B.client.send({ type: 'navigate', mapId: 'frosthaven' });
    const refusal2 = await waitFor(() => B.client.msgs.slice(mark2).filter(m => m.type === 'notice' && /Fast travel is owner-only/.test(m.text)).pop(), 6000, 'navigate refused for a regular account');
    if (!refusal2) throw new Error('no owner-only refusal notice for navigate');
    // So B walks the gatehouse like everyone else (this also sets
    // up the reconnect leg's premise: B respawns in Frosthaven).
    const nm = await travel(B.client, 1568, 48, 'frosthaven', 'B walks the Frosthaven gatehouse');
    if (nm.transferMs !== 1500) throw new Error(`walk transferMs=${nm.transferMs}`);
    report('navigator: 11 places with live counts + friend markers for everyone; travel owner-only — B walks the gatehouse', true, 'B refused the warp, then walked Gateway -> Frosthaven (1.5s transfer)');
  } catch (e) { report('navigator: 11 places with live counts + friend markers for everyone; travel owner-only — B walks the gatehouse', false, e.message); }

  // ---- abrupt-drop reconnect
  try {
    // B is in Frosthaven after the navigator check; kill the socket
    // without a close handshake.
    B.client.ws.terminate();
    await sleep(1200);
    const re = await connectClient(B.token);
    B.client = re;
    if (re.hello.map.id !== 'frosthaven') throw new Error(`respawn map ${re.hello.map.id}`);
    const meB = await api('/api/me', { token: B.token });
    if (re.hello.zcoins !== meB.json.avatar.zcoins) throw new Error('balance mismatch after reconnect');
    report('reconnect: abrupt WS drop -> reconnect with same token, state intact', true, `respawned in ${re.hello.map.id}, zcoins=${re.hello.zcoins}`);
  } catch (e) { report('reconnect: abrupt WS drop -> reconnect with same token, state intact', false, e.message); }

  // ---- remote persistence (persistent-DB build): runs ONLY when
  // the harness env carries the remote-DB credentials (GitHub
  // secrets DATABASE_URL + DATABASE_AUTH_TOKEN). The deployed
  // service under test is expected to be running with those same
  // values, i.e. on the Turso remote DB. A local harness cannot
  // restart the production service, so this is the
  // restart-equivalent: register a fresh account with a
  // distinctive character look, drop the session entirely, then
  // log in again from scratch and prove the account + the full
  // look come back intact over HTTPS + WS. Without the env vars
  // the leg is SKIPPED (not counted, not failed) and the harness
  // total is exactly what it was before this leg existed.
  const REMOTE_DB_SET = !!((process.env.DATABASE_URL || '').trim() && (process.env.DATABASE_AUTH_TOKEN || '').trim());
  if (!REMOTE_DB_SET) {
    reportSkip('remote persistence: register -> re-login -> account + character intact on the remote DB', 'DATABASE_URL / DATABASE_AUTH_TOKEN not set in the harness env');
  } else {
    try {
      const NAME_R = NAME_A.slice(0, -1) + 'f';
      const rr = await api('/api/register', { username: NAME_R, password: PW });
      if (rr.status !== 200 || !rr.json.token) throw new Error(`register R -> ${rr.status} ${JSON.stringify(rr.json)}`);
      const lookR = {
        token: rr.json.token, name: NAME_R, gender: 'F', face: 'heart', eyes: 'lash',
        eye_color: '#1e4d8f', nose: 'tiny', lips: 'rose', skin_tone: '#c68642',
        hair_style: 'ponytail', hair_color: '#c0392b', top_style: 'hoodie',
        body_color: '#e5639e', bottom_style: 'skirt', accent_color: '#2b3a55',
        shoe_color: '#ffd23f', accessory: 'glasses',
      };
      const cr = await api('/api/create-character', lookR);
      if (cr.status !== 200 || !cr.json.avatar || cr.json.avatar.created !== true) throw new Error(`create R -> ${cr.status} ${JSON.stringify(cr.json)}`);
      // Restart-equivalent: brand-new login, fresh token, then the
      // character must come back with every look axis intact.
      const liR = await api('/api/login', { username: NAME_R, password: PW });
      if (liR.status !== 200 || !liR.json.token) throw new Error(`re-login R -> ${liR.status}`);
      const meR = await api('/api/me', { token: liR.json.token });
      if (meR.status !== 200 || !meR.json.avatar) throw new Error(`/api/me R -> ${meR.status}`);
      for (const k of ['gender', 'face', 'eyes', 'eye_color', 'nose', 'lips', 'skin_tone', 'hair_style', 'hair_color', 'top_style', 'body_color', 'bottom_style', 'accent_color', 'shoe_color', 'accessory']) {
        if (meR.json.avatar[k] !== lookR[k]) throw new Error(`R avatar.${k} = ${meR.json.avatar[k]} after re-login, expected ${lookR[k]}`);
      }
      if (meR.json.avatar.created !== true) throw new Error('R avatar no longer marked created after re-login');
      const rc2 = await connectClient(liR.json.token);
      try {
        if (rc2.hello.you.name !== NAME_R || rc2.hello.you.gender !== 'F' || rc2.hello.you.hair_style !== 'ponytail' || rc2.hello.you.bottom_style !== 'skirt') {
          throw new Error('R hello appearance mismatch after re-login');
        }
      } finally { rc2.ws.close(); }
      report('remote persistence: register -> re-login -> account + character intact on the remote DB', true, `R=${NAME_R} full look intact over re-login + WS hello (remote DB env present)`);
    } catch (e) { report('remote persistence: register -> re-login -> account + character intact on the remote DB', false, e.message); }
  }

  finish();
}

function finish() {
  const passed = results.filter(r => r.ok).length;
  console.log(`\n== LIVE VERIFY: ${passed}/${results.length} checks passed ==`);
  try { if (A && A.client) A.client.ws.close(); } catch (e) {}
  try { if (B && B.client) B.client.ws.close(); } catch (e) {}
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(e => { console.log(`FAIL  harness crashed — ${e.stack || e.message}`); process.exit(1); });

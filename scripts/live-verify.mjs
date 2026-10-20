'use strict';
/**
 * Solarion LIVE verification harness.
 *
 * Drives the real production service (or any base URL) end-to-end with
 * two fresh accounts and prints one PASS/FAIL line per check.
 *
 *   SOLARION_BASE=https://solarion.onrender.com node scripts/live-verify.mjs
 *
 * No test-only hooks are used (no debug-teleport): all travel is done
 * by steering with snapshot feedback, exactly like a real player.
 */
import WebSocket from 'ws';

const BASE = (process.env.SOLARION_BASE || 'https://solarion.onrender.com').replace(/\/$/, '');
const WS_BASE = BASE.replace(/^http/, 'ws');
const SFX = Date.now().toString(36).slice(-6);
const NAME_A = `vfy${SFX}a`;
const NAME_B = `vfy${SFX}b`;
const PW = 'verify-pass-1';

const results = [];
function report(name, ok, evidence) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${evidence ? ` — ${evidence}` : ''}`);
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
async function walkTo(client, tx, ty, { timeout = 40000, arrive = 14, stopWhen = null } = {}) {
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
      if (dx > 6) keys.right = true; else if (dx < -6) keys.left = true;
      if (dy > 6) keys.down = true; else if (dy < -6) keys.up = true;
      if (Date.now() - lastMove > 1600) {
        // Stuck: strafe PERPENDICULAR to the dominant remaining delta —
        // sliding along a wall face is what finds gaps like doorways.
        strafeAxis = Math.abs(dx) >= Math.abs(dy)
          ? (strafeDir > 0 ? 'down' : 'up')
          : (strafeDir > 0 ? 'right' : 'left');
        strafeUntil = Date.now() + 650; strafeDir *= -1; lastMove = Date.now();
      }
    }
    client.send({ type: 'input', keys });
    await sleep(120);
  }
  client.send({ type: 'input', keys: {} });
  throw new Error(`walk to ${tx},${ty} timed out`);
}

/** Walk onto a gateway rect and wait for the map switch. Respects the 1.5s gateway debounce. */
async function travel(client, tx, ty, expectMap, label) {
  await sleep(1750);
  const marker = client.msgs.length;
  const arrived = () => client.msgs.slice(marker).some(m => m.type === 'map' && m.map.id === expectMap) ? true : null;
  await walkTo(client, tx, ty, { timeout: 45000, stopWhen: arrived });
  const m = await waitFor(() => client.msgs.slice(marker).filter(x => x.type === 'map' && x.map.id === expectMap).pop(), 8000, label);
  await sleep(1750); // debounce for the next hop
  return m;
}

const SHORT_MIX = {
  name: 'Verify Banger', bpm: 160, bars: 2,
  tracks: [
    { loopId: 'pop-drums-1', startBar: 0 },
    { loopId: 'pop-bass-1', startBar: 0 },
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
  report('health: service answers, phase 6, six maps', !!(health && health.ok && health.phase === 6 && Object.keys(health.maps).length === 6),
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

  // ---- WS connect + daily bonus (exactly once)
  try {
    A.client = await connectClient(A.token);
    A.id = A.client.hello.you.id;
    const h = A.client.hello;
    if (h.map.id !== 'the-gateway') throw new Error(`spawn map ${h.map.id}`);
    if (h.bonusGranted !== true || h.zcoins !== 100) throw new Error(`bonus=${h.bonusGranted} z=${h.zcoins}`);
    if (h.you.gender !== 'F' || h.you.face !== 'heart' || h.you.hair_style !== 'ponytail' || h.you.bottom_style !== 'skirt') {
      throw new Error(`hello appearance mismatch: ${JSON.stringify({ g: h.you.gender, f: h.you.face, hair: h.you.hair_style, b: h.you.bottom_style })}`);
    }
    report('ws connect A: hello in The Gateway, +100z daily bonus granted', true, `zcoins=${h.zcoins}, appearance F/heart/ponytail/skirt in hello`);
  } catch (e) { report('ws connect A: hello in The Gateway, +100z daily bonus granted', false, e.message); return finish(); }

  try {
    B.client = await connectClient(B.token);
    B.id = B.client.hello.you.id;
    if (B.client.hello.zcoins !== 100) throw new Error(`B z=${B.client.hello.zcoins}`);
    if (B.client.hello.you.gender !== 'M' || B.client.hello.you.face !== 'square' || B.client.hello.you.hair_style !== 'mohawk') {
      throw new Error('B hello appearance mismatch');
    }
    report('ws connect B: hello received, +100z daily bonus granted', true, `zcoins=${B.client.hello.zcoins}, appearance M/square/mohawk in hello`);
  } catch (e) { report('ws connect B: hello received, +100z daily bonus granted', false, e.message); return finish(); }

  // ---- presence + chat + movement
  try {
    await waitFor(() => { const s = lastOf(A.client, 'snapshot'); return s && s.players.some(p => p.id === B.id); }, 6000, 'A sees B');
    await waitFor(() => { const s = lastOf(B.client, 'snapshot'); return s && s.players.some(p => p.id === A.id); }, 6000, 'B sees A');
    report('presence: A and B see each other in snapshots', true, 'mutual snapshot presence');
  } catch (e) { report('presence: A and B see each other in snapshots', false, e.message); }

  try {
    B.client.msgs.length = 0;
    A.client.send({ type: 'chat', text: 'hello from verify A' });
    await waitFor(() => B.client.msgs.some(m => m.type === 'chat' && m.text === 'hello from verify A' && m.from === NAME_A), 6000, 'chat delivered');
    report('chat: A message delivered to B with sender name', true, 'chat received by B');
  } catch (e) { report('chat: A message delivered to B with sender name', false, e.message); }

  try {
    const before = selfPos(A.client);
    A.client.send({ type: 'input', keys: { right: true } });
    await sleep(900);
    A.client.send({ type: 'input', keys: {} });
    const after = await waitFor(() => { const p = selfPos(A.client); return p && p.x > before.x + 50 ? p : null; }, 4000, 'A moved east');
    report('movement: server-authoritative walk moves A east', true, `x ${before.x} -> ${after.x}`);
  } catch (e) { report('movement: server-authoritative walk moves A east', false, e.message); }

  try {
    A.client.ws.close();
    await sleep(500);
    A.client = await connectClient(A.token);
    const h = A.client.hello;
    if (h.bonusGranted !== false || h.zcoins !== 100) throw new Error(`relog bonus=${h.bonusGranted} z=${h.zcoins}`);
    report('daily bonus exactly once: relog grants no second bonus, balance stays 100z', true, `bonusGranted=false zcoins=${h.zcoins}`);
  } catch (e) { report('daily bonus exactly once: relog grants no second bonus, balance stays 100z', false, e.message); }

  // ---- travel to Solstice Bay (both)
  try {
    const m = await travel(A.client, 480, 48, 'solstice-bay', 'A gateway -> solstice-bay');
    if (m.map.name !== 'Solstice Bay') throw new Error(`map name ${m.map.name}`);
    await travel(B.client, 480, 48, 'solstice-bay', 'B gateway -> solstice-bay');
    report('gateway travel: A and B walked Gateway -> Solstice Bay', true, 'map switch confirmed for both');
  } catch (e) { report('gateway travel: A and B walked Gateway -> Solstice Bay', false, e.message); return finish(); }

  // ---- music: save -> perform -> vote -> payout
  try {
    A.client.send({ type: 'mix-save', slot: 1, data: SHORT_MIX });
    const saved = await waitFor(() => lastOf(A.client, 'mix-saved'), 6000, 'mix saved');
    const mixId = saved.mix.id;
    A.client.send({ type: 'stage-join', mixId });
    await waitFor(() => lastOf(B.client, 'stage-queue', q => q.queue.some(e => e.userId === A.id)), 8000, 'B sees queue');
    const startB = await waitFor(() => lastOf(B.client, 'performance-start', s => s.performerId === A.id), 8000, 'performance start');
    if (JSON.stringify(startB.mix) !== JSON.stringify(SHORT_MIX)) throw new Error('audience received different mix data');
    B.client.send({ type: 'vote', value: 1 });
    await waitFor(() => lastOf(B.client, 'vote-ack'), 6000, 'vote ack');
    const end = await waitFor(() => lastOf(B.client, 'performance-end'), 35000, 'performance end');
    if (end.up !== 1 || end.earned !== 5) throw new Error(`end up=${end.up} earned=${end.earned}`);
    const z = await waitFor(() => lastOf(A.client, 'zcoins', z => z.zcoins === 105), 6000, 'A paid');
    report('music: save -> stage perform -> audience vote -> +5z payout', true, `earned=${end.earned} A balance=${z.zcoins}`);
  } catch (e) { report('music: save -> stage perform -> audience vote -> +5z payout', false, e.message); }

  // ---- casino: slots
  const balA = async () => (await api('/api/me', { token: A.token })).json.avatar.zcoins;
  const balB = async () => (await api('/api/me', { token: B.token })).json.avatar.zcoins;
  try {
    // A: bay -> casino doorway -> slot 1 standing spot
    await walkTo(A.client, 430, 496);
    await walkTo(A.client, 360, 496, { timeout: 60000, arrive: 10 });
    await walkTo(A.client, 144, 560);
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

  // ---- casino: poker hand with chip conservation
  try {
    const T1 = 'solstice-bay-poker-1';
    const preA = await balA(), preB = await balB();
    await walkTo(A.client, 176, 464);
    await walkTo(B.client, 430, 496);
    await walkTo(B.client, 360, 496, { timeout: 60000, arrive: 10 });
    await walkTo(B.client, 176, 464);
    const tbl = (u) => lastOf(u.client, 'poker-state', s => s.id === T1);
    A.client.send({ type: 'poker', action: 'sit', table: T1, chair: 'N' });
    await waitFor(() => { const s = tbl(A); return s && s.chairs.some(c => c.name === NAME_A); }, 8000, 'A seated');
    B.client.send({ type: 'poker', action: 'sit', table: T1, chair: 'S' });
    await waitFor(() => { const s = tbl(B); return s && s.chairs.some(c => c.name === NAME_B); }, 8000, 'B seated');
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
    report('casino poker: full hand to showdown, pot paid in full, chips conserved', true, `pot=${doneState.pot} winners=${doneState.winners.map(w => w.name + ':' + w.amount).join(',')} totals ${preA + preB} -> ${postA + postB}`);
  } catch (e) { report('casino poker: full hand to showdown, pot paid in full, chips conserved', false, e.message); }

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

  // ---- return A to The Gateway (the studio step leaves A in Solstice Bay)
  try {
    let cur = (lastOf(A.client, 'map') || {}).map;
    let curId = cur && cur.id;
    if (curId && curId.startsWith('studio:')) {
      A.client.send({ type: 'leave-studio' });
      const m = await waitFor(() => lastOf(A.client, 'map', x => !x.map.id.startsWith('studio:')), 8000, 'A exits studio');
      curId = m.map.id;
    }
    if (curId === 'solstice-bay') {
      await travel(A.client, 512, 560, 'the-gateway', 'bay return gateway');
    } else if (curId !== 'the-gateway') {
      throw new Error(`unexpected map before city tours: ${curId}`);
    }
    report('positioning: A returned to The Gateway for the city tours', true, `arrived from ${curId}`);
  } catch (e) { report('positioning: A returned to The Gateway for the city tours', false, e.message); return finish(); }

  // ---- travel: remaining four cities and back
  const cities = [
    { arch: [160, 48], id: 'neon-district', name: 'Neon District', back: [512, 592] },
    { arch: [288, 48], id: 'cinder-mesa', name: 'Cinder Mesa', back: [96, 592] },
    { arch: [672, 48], id: 'frosthaven', name: 'Frosthaven', back: [512, 48] },
    { arch: [800, 48], id: 'verdant-hollow', name: 'Verdant Hollow', back: [928, 592] },
  ];
  for (const c of cities) {
    try {
      const m = await travel(A.client, c.arch[0], c.arch[1], c.id, `gateway -> ${c.id}`);
      if (m.map.name !== c.name) throw new Error(`name ${m.map.name}`);
      if (!m.map.stage) throw new Error('no stage in city payload');
      await travel(A.client, c.back[0], c.back[1], 'the-gateway', `${c.id} -> gateway`);
      report(`travel: Gateway -> ${c.name} -> Gateway (walking)`, true, 'round trip by walking, stage present');
    } catch (e) { report(`travel: Gateway -> ${c.name} -> Gateway (walking)`, false, e.message); }
  }

  // ---- abrupt-drop reconnect
  try {
    // B is in Solstice Bay; kill the socket without a close handshake.
    B.client.ws.terminate();
    await sleep(1200);
    const re = await connectClient(B.token);
    B.client = re;
    if (re.hello.map.id !== 'solstice-bay') throw new Error(`respawn map ${re.hello.map.id}`);
    const meB = await api('/api/me', { token: B.token });
    if (re.hello.zcoins !== meB.json.avatar.zcoins) throw new Error('balance mismatch after reconnect');
    report('reconnect: abrupt WS drop -> reconnect with same token, state intact', true, `respawned in ${re.hello.map.id}, zcoins=${re.hello.zcoins}`);
  } catch (e) { report('reconnect: abrupt WS drop -> reconnect with same token, state intact', false, e.message); }

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

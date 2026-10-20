'use strict';

/**
 * Solarion Phase 8 — player homes test suite.
 *
 * Spawns real server processes and drives them over HTTP + WebSocket:
 *   a. catalog: 44 items with per-category counts (beds 4, chairs 9,
 *      shelves 5, rugs 6, tvs 3, radios 3, decor 14); representative
 *      purchases from each NEW category debit exactly and place
 *   b. a Phase 8 chair (dining chair) is sittable inside a home via
 *      the Phase B sitting system
 *   c. TV: default state in the entry payload, power/channel set by
 *      the owner is observed live by a visitor, a VISITOR can change
 *      the channel (anyone-in-room rule), state persists across an
 *      owner relog
 *   d. radio: default state lists the owner's saved mixes; source
 *      switch to mixes resolves the full mix payload; play/next/stop
 *      state syncs to a visitor; empty-mix play is refused
 *   e. invites: unknown/offline targets rejected, decline keeps the
 *      invitee put, accept rides the 3s transfer into the right
 *      instance, and a fresh invite overrides a kick block
 *
 * Run:  TEST_RUN=<n> node --test test/homes.test.js (or npm test)
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const RUN = process.env.TEST_RUN || '0';
const ROOT = path.join(__dirname, '..');
const DB = path.join(ROOT, 'data', `hometest-run-${RUN}.db`);
const PORT = 50300 + Number(RUN) * 20;

const children = [];
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(cond, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for: ${label}`);
    await sleep(50);
  }
}

function startServer(port, dbPath) {
  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    try { fs.unlinkSync(f); } catch (e) { /* fresh */ }
  }
  const child = spawn('node', ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, SOLARION_PORT: String(port), SOLARION_DB_PATH: dbPath, SOLARION_TEST: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  child.stderr.on('data', d => { out += d.toString(); });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start on ${port}; stderr: ${out}`)), 15000);
    child.stdout.on('data', d => {
      if (d.toString().includes('listening on')) { clearTimeout(t); resolve(child); }
    });
    child.on('error', reject);
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null, 5000, 'server exit');
  const i = children.indexOf(child);
  if (i >= 0) children.splice(i, 1);
}

function api(port, route, body) {
  return fetch(`http://localhost:${port}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, json: await r.json() }));
}

function connectClient(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?token=${encodeURIComponent(token)}`);
    const client = { ws, msgs: [], hello: null, send: (m) => ws.send(JSON.stringify(m)) };
    const t = setTimeout(() => { ws.close(); reject(new Error('no hello within 5s')); }, 5000);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      client.msgs.push(m);
      if (m.type === 'hello') { client.hello = m; clearTimeout(t); resolve(client); }
    });
    ws.on('error', reject);
    ws.on('close', () => { if (!client.hello) { clearTimeout(t); reject(new Error('ws closed before hello')); } });
  });
}

async function makeUser(name) {
  const r = await api(PORT, '/api/register', {
    username: name, password: 'secretpw',
    shirt: '#aa0000', pants: '#003366', skin_tone: '#f1c27d',
    hair_style: 'short', hair_color: '#222222',
  });
  assert.equal(r.status, 200, `register ${name}: ${JSON.stringify(r.json)}`);
  const c = await api(PORT, '/api/create-character', { token: r.json.token, name, gender: 'M' });
  assert.equal(c.status, 200, `create ${name}: ${JSON.stringify(c.json)}`);
  const client = await connectClient(PORT, r.json.token);
  return { name, token: r.json.token, client, id: client.hello.you.id };
}

/** Test-mode funding: set an exact z-coin balance over the WS. */
async function fund(user, amount) {
  user.client.send({ type: 'debug-casino', op: 'set-balance', zcoins: amount });
  await waitFor(() => user.client.msgs.filter(m => m.type === 'zcoins' && m.zcoins === amount).pop(),
    5000, `${user.name} funded to ${amount}`);
}

async function enterOwnStudio(user) {
  user.client.send({ type: 'enter-studio', owner: user.name });
  const entered = await waitFor(
    () => user.client.msgs.filter(m => m.type === 'map' && m.map.id === `studio:${user.id}`).pop(),
    5000, `${user.name} enters own studio`);
  const state = await waitFor(
    () => user.client.msgs.filter(m => m.type === 'studio-state' && m.isOwner).pop(),
    5000, `${user.name} owner studio-state`);
  return { entered, state };
}

async function buyAndPlace(user, itemId, x, y) {
  user.client.send({ type: 'studio-buy', itemId });
  const state = await waitFor(
    () => user.client.msgs.filter(m => m.type === 'studio-state'
      && m.inventory && m.inventory.some(i => i.itemId === itemId && !i.placed)).pop(),
    5000, `${user.name} bought ${itemId}`);
  const item = state.inventory.find(i => i.itemId === itemId && !i.placed);
  user.client.send({ type: 'studio-place', instanceItemId: item.instanceId, x, y, rot: 0 });
  await waitFor(
    () => user.client.msgs.filter(m => m.type === 'studio-furniture'
      && m.furniture.some(f => f.instanceId === item.instanceId)).pop(),
    5000, `${user.name} placed ${itemId}`);
  return item;
}

const SHORT_MIX = {
  name: 'Home Test Mix', bpm: 160, bars: 2,
  tracks: [
    { loopId: 'pop-drums-1', startBar: 0 },
    { loopId: 'pop-bass-1', startBar: 0 },
  ],
};

before(async () => { await startServer(PORT, DB); });
after(async () => { for (const c of [...children]) await stopServer(c).catch(() => {}); });

// ------------------------------------------------------------------ (a)
test('catalog: 44 items, category counts, representative buys debit exactly and place', { timeout: 90000 }, async () => {
  const owner = await makeUser('catalog_p8');
  await fund(owner, 100000);
  const { state } = await enterOwnStudio(owner);
  const catalog = state.catalog;
  assert.equal(catalog.length, 44, `catalog has 44 items, got ${catalog.length}`);
  const byCat = {};
  for (const i of catalog) byCat[i.cat] = (byCat[i.cat] || 0) + 1;
  assert.deepEqual(byCat, { chairs: 9, decor: 14, rugs: 6, shelves: 5, beds: 4, tvs: 3, radios: 3 },
    'per-category counts: beds 4, chairs 9, shelves 5, rugs 6, tvs 3, radios 3, decor 14');
  // Every item carries the fields the client renders from.
  for (const i of catalog) {
    assert.ok(i.id && i.name && i.price > 0 && i.type && i.color && i.accent && i.icon && i.footprint === 1,
      `catalog item complete: ${i.id}`);
  }

  // One representative purchase from each NEW category, exact debits.
  const picks = [
    ['single-bed', 90], ['dining-chair', 45], ['cube-shelf', 65],
    ['wave-rug', 40], ['floor-lamp', 70], ['tube-tv', 150], ['boombox', 80],
  ];
  let expected = 100000;
  const placedIds = [];
  let tx = 3;
  for (const [itemId, price] of picks) {
    const item = await buyAndPlace(owner, itemId, tx, 4);
    placedIds.push(item.instanceId);
    expected -= price;
    const bal = (await api(PORT, '/api/me', { token: owner.token })).json.avatar.zcoins;
    assert.equal(bal, expected, `balance after buying ${itemId}`);
    tx += 1;
  }
  const furn = await waitFor(
    () => owner.client.msgs.filter(m => m.type === 'studio-furniture' && m.furniture.length === picks.length).pop(),
    5000, 'all seven items placed');
  assert.deepEqual(furn.furniture.map(f => f.itemId).sort(), picks.map(p => p[0]).sort());
  // Placing a TV/radio also published their default device states.
  const devState = await waitFor(
    () => owner.client.msgs.filter(m => m.type === 'studio-state' && m.devices && m.devices.length === 2).pop(),
    5000, 'default device states in studio-state');
  const tv = devState.devices.find(d => d.kind === 'tv');
  const radio = devState.devices.find(d => d.kind === 'radio');
  assert.equal(tv.on, false);
  assert.equal(tv.channelId, 'news');
  assert.equal(radio.playing, false);
  assert.equal(radio.source, 'loops');
  assert.equal(radio.loopCount, 48, 'radio sees the full 48-loop library');
  owner.client.ws.close();
});

// ------------------------------------------------------------------ (b)
test('sitting: a Phase 8 dining chair is sittable inside a home', { timeout: 60000 }, async () => {
  const owner = await makeUser('sitter_p8');
  await enterOwnStudio(owner);
  const chair = await buyAndPlace(owner, 'dining-chair', 5, 5);
  assert.ok(chair);
  await sleep(3300); // entry transfer window: interact is locked while it runs
  owner.client.send({ type: 'debug-teleport', x: 5 * 32 + 16, y: 5 * 32 + 16 });
  await sleep(150);
  owner.client.send({ type: 'interact' });
  const seated = await waitFor(() => {
    const s = owner.client.msgs.filter(m => m.type === 'snapshot').pop();
    const p = s && s.players.find(pl => pl.id === owner.id);
    return p && p.seated ? p : null;
  }, 5000, 'seated on the dining chair');
  assert.ok(Math.abs(seated.x - 176) < 1 && Math.abs(seated.y - 176) < 1, 'snapped onto the chair tile');
  owner.client.send({ type: 'interact' });
  await waitFor(() => {
    const s = owner.client.msgs.filter(m => m.type === 'snapshot').pop();
    const p = s && s.players.find(pl => pl.id === owner.id);
    return p && p.seated === false ? p : null;
  }, 5000, 're-interact stands back up');
  owner.client.ws.close();
});

// ------------------------------------------------------------------ (c)
test('TV: state syncs to a visitor, visitor can change channel, persists across owner relog', { timeout: 90000 }, async () => {
  const owner = await makeUser('tvowner_p8');
  const visitor = await makeUser('tvguest_p8');
  await fund(owner, 1000);
  await enterOwnStudio(owner);
  const tvItem = await buyAndPlace(owner, 'tube-tv', 7, 6);

  // Visitor enters and gets the TV's default state in the entry payload.
  visitor.client.send({ type: 'enter-studio', owner: 'tvowner_p8' });
  const vEntered = await waitFor(
    () => visitor.client.msgs.filter(m => m.type === 'map' && m.map.id === `studio:${owner.id}`).pop(),
    5000, 'visitor enters TV studio');
  const vTv0 = (vEntered.devices || []).find(d => d.instanceId === tvItem.instanceId);
  assert.ok(vTv0, 'visitor entry payload carries the TV device');
  assert.equal(vTv0.on, false);
  assert.equal(vTv0.channel, 0);

  // Owner powers on: BOTH occupants receive the resolved state.
  owner.client.send({ type: 'home-device', instanceId: tvItem.instanceId, action: 'power' });
  const onMsg = await waitFor(
    () => visitor.client.msgs.filter(m => m.type === 'home-device' && m.device && m.device.on === true).pop(),
    5000, 'visitor sees the TV turn on');
  assert.equal(onMsg.device.channelId, 'news');
  assert.equal(onMsg.device.channelName, 'Solarion News 24/7');

  // The VISITOR changes the channel (anyone-in-room rule): owner sees it.
  visitor.client.send({ type: 'home-device', instanceId: tvItem.instanceId, action: 'channel-set', channel: 2 });
  const chMsg = await waitFor(
    () => owner.client.msgs.filter(m => m.type === 'home-device' && m.device && m.device.channel === 2).pop(),
    5000, 'owner sees the visitor channel change');
  assert.equal(chMsg.device.channelId, 'cooking');
  assert.equal(chMsg.device.on, true);

  // A non-occupant cannot work the TV from outside the room.
  const outsider = await makeUser('tvout_p8');
  outsider.client.send({ type: 'home-device', instanceId: tvItem.instanceId, action: 'power' });
  await waitFor(
    () => outsider.client.msgs.filter(m => m.type === 'notice' && /only work inside a home/.test(m.text)).pop(),
    5000, 'outsider device attempt rejected');
  await sleep(300);
  const stillOn = owner.client.msgs.filter(m => m.type === 'home-device').pop();
  assert.equal(stillOn.device.on, true, 'TV untouched by the outsider attempt');

  // Persistence across owner RELOG: state comes back from the DB.
  owner.client.ws.close();
  await sleep(400);
  const relog = await connectClient(PORT, owner.token);
  relog.send({ type: 'enter-studio', owner: 'tvowner_p8' });
  const reState = await waitFor(
    () => relog.msgs.filter(m => m.type === 'studio-state' && m.devices && m.devices.length === 1).pop(),
    5000, 'owner relog studio-state has the TV');
  assert.equal(reState.devices[0].on, true, 'TV still on after relog');
  assert.equal(reState.devices[0].channel, 2, 'TV still on channel 2 after relog');
  assert.equal(reState.devices[0].channelId, 'cooking');
  relog.ws.close();
  visitor.client.ws.close();
  outsider.client.ws.close();
});

// ------------------------------------------------------------------ (d)
test('radio: owner mixes resolve, play/next/stop sync to a visitor, empty source refused', { timeout: 90000 }, async () => {
  const owner = await makeUser('dj_p8');
  const visitor = await makeUser('listener_p8');
  // The owner saves a mix BEFORE the radio exists (Phase 2 CRUD).
  owner.client.send({ type: 'mix-save', slot: 1, data: SHORT_MIX });
  const saved = await waitFor(() => owner.client.msgs.filter(m => m.type === 'mix-saved').pop(), 5000, 'mix saved');
  const mixId = saved.mix.id;

  await enterOwnStudio(owner);
  const radioItem = await buyAndPlace(owner, 'boombox', 6, 6);

  // Default state: loops source, owner's mix listed by name.
  const st0 = await waitFor(
    () => owner.client.msgs.filter(m => m.type === 'studio-state' && m.devices && m.devices.length === 1).pop(),
    5000, 'radio in studio-state');
  const d0 = st0.devices[0];
  assert.equal(d0.source, 'loops');
  assert.equal(d0.playing, false);
  assert.equal(d0.track.loopId, 'pop-drums-1');
  assert.deepEqual(d0.mixes, [{ id: mixId, name: 'Home Test Mix' }], "radio lists the owner's saved mixes");

  // Switch source to the owner's mixes: the full mix payload resolves.
  owner.client.send({ type: 'home-device', instanceId: radioItem.instanceId, action: 'source', source: 'mixes' });
  const dMix = await waitFor(
    () => owner.client.msgs.filter(m => m.type === 'home-device' && m.device && m.device.source === 'mixes').pop(),
    5000, 'source switched to mixes');
  assert.equal(dMix.device.track.kind, 'mix');
  assert.equal(dMix.device.track.mixId, mixId);
  assert.deepEqual(dMix.device.track.mix, SHORT_MIX, 'full mix data rides the radio state');

  // Visitor enters and sees the same radio state.
  visitor.client.send({ type: 'enter-studio', owner: 'dj_p8' });
  const vState = await waitFor(
    () => visitor.client.msgs.filter(m => m.type === 'studio-state' && m.devices && m.devices.length === 1).pop(),
    5000, 'visitor studio-state has the radio');
  assert.equal(vState.devices[0].source, 'mixes');

  // Play: the visitor receives the playing state with a server start time.
  const before = Date.now();
  owner.client.send({ type: 'home-device', instanceId: radioItem.instanceId, action: 'play' });
  const playMsg = await waitFor(
    () => visitor.client.msgs.filter(m => m.type === 'home-device' && m.device && m.device.playing === true).pop(),
    5000, 'visitor sees the radio start playing');
  assert.ok(playMsg.device.startedAt >= before && playMsg.device.startedAt <= Date.now() + 3000,
    `startedAt is a near-future server timestamp (${playMsg.device.startedAt} vs now ${Date.now()})`);
  assert.equal(playMsg.device.track.mixId, mixId);

  // Back to loops + next track: the visitor watches the track change.
  owner.client.send({ type: 'home-device', instanceId: radioItem.instanceId, action: 'source', source: 'loops' });
  await waitFor(
    () => visitor.client.msgs.filter(m => m.type === 'home-device' && m.device && m.device.source === 'loops').pop(),
    5000, 'visitor sees the source switch back to loops');
  owner.client.send({ type: 'home-device', instanceId: radioItem.instanceId, action: 'next' });
  const nextMsg = await waitFor(
    () => visitor.client.msgs.filter(m => m.type === 'home-device' && m.device && m.device.track && m.device.track.loopId === 'pop-drums-2').pop(),
    5000, 'visitor sees next track');
  assert.equal(nextMsg.device.playing, true, 'still playing after next');

  // The VISITOR stops the radio (anyone-in-room): the owner sees it.
  visitor.client.send({ type: 'home-device', instanceId: radioItem.instanceId, action: 'stop' });
  await waitFor(
    () => owner.client.msgs.filter(m => m.type === 'home-device' && m.device && m.device.playing === false).pop(),
    5000, 'owner sees the visitor stop the radio');

  // Empty mix source refuses to play.
  const quiet = await makeUser('quiet_p8');
  await fund(quiet, 1000);
  await enterOwnStudio(quiet);
  const qRadio = await buyAndPlace(quiet, 'retro-radio', 6, 6);
  quiet.client.send({ type: 'home-device', instanceId: qRadio.instanceId, action: 'source', source: 'mixes' });
  await waitFor(
    () => quiet.client.msgs.filter(m => m.type === 'home-device' && m.device && m.device.source === 'mixes').pop(),
    5000, 'quiet radio source switched');
  quiet.client.send({ type: 'home-device', instanceId: qRadio.instanceId, action: 'play' });
  await waitFor(
    () => quiet.client.msgs.filter(m => m.type === 'notice' && /no saved mixes/.test(m.text)).pop(),
    5000, 'empty-mix play refused with a notice');
  await sleep(300);
  assert.equal(
    quiet.client.msgs.filter(m => m.type === 'home-device' && m.device && m.device.playing === true).length, 0,
    'radio never entered a playing state');
  owner.client.ws.close();
  visitor.client.ws.close();
  quiet.client.ws.close();
});

// ------------------------------------------------------------------ (e)
test('invites: decline, accept via the transfer, kick-block override', { timeout: 120000 }, async () => {
  const owner = await makeUser('host_p8');
  const guest = await makeUser('guest_p8');
  const offline = await makeUser('offline_p8');
  offline.client.ws.close();
  await sleep(300);

  // Unknown and offline targets are rejected with notices.
  owner.client.send({ type: 'studio-invite', username: 'no_such_user_p8' });
  await waitFor(
    () => owner.client.msgs.filter(m => m.type === 'notice' && /No player by that name/.test(m.text)).pop(),
    5000, 'unknown invitee rejected');
  owner.client.send({ type: 'studio-invite', username: 'offline_p8' });
  await waitFor(
    () => owner.client.msgs.filter(m => m.type === 'notice' && /isn't online/.test(m.text)).pop(),
    5000, 'offline invitee rejected');

  // The invite arrives as a prompt; declining keeps the guest put and
  // tells the owner.
  owner.client.send({ type: 'studio-invite', username: 'guest_p8' });
  const prompt = await waitFor(
    () => guest.client.msgs.filter(m => m.type === 'studio-invite').pop(),
    5000, 'guest receives the invite prompt');
  assert.equal(prompt.fromName, 'host_p8');
  assert.equal(prompt.ownerId, owner.id);
  guest.client.send({ type: 'studio-invite-response', ownerId: owner.id, accept: false });
  await waitFor(
    () => owner.client.msgs.filter(m => m.type === 'notice' && /declined your studio invite/.test(m.text)).pop(),
    5000, 'owner hears the decline');
  await sleep(400);
  assert.equal(
    guest.client.msgs.filter(m => m.type === 'map' && m.map.id === `studio:${owner.id}`).length, 0,
    'declining did not transport the guest');

  // Accept: the guest rides the standard transfer (transferMs) into
  // the owner's exact instance.
  owner.client.send({ type: 'studio-invite', username: 'guest_p8' });
  await waitFor(() => guest.client.msgs.filter(m => m.type === 'studio-invite').pop(), 5000, 'second invite arrives');
  guest.client.send({ type: 'studio-invite-response', ownerId: owner.id, accept: true });
  const arrived = await waitFor(
    () => guest.client.msgs.filter(m => m.type === 'map' && m.map.id === `studio:${owner.id}`).pop(),
    5000, 'guest transported into the host studio');
  assert.equal(arrived.transferMs, 3000, 'invite transport uses the standard 3s load-screen transfer');
  const gState = await waitFor(
    () => guest.client.msgs.filter(m => m.type === 'studio-state').pop(),
    5000, 'guest studio-state');
  assert.equal(gState.isOwner, false);
  assert.equal(gState.ownerName, 'host_p8');

  // The owner joins, kicks the guest: direct re-entry is blocked...
  await enterOwnStudio(owner);
  owner.client.send({ type: 'studio-kick', userId: guest.id });
  await waitFor(
    () => guest.client.msgs.filter(m => m.type === 'map' && m.map.id === 'the-gateway').pop(),
    5000, 'kicked guest lands in the Gateway');
  guest.client.send({ type: 'enter-studio', owner: 'host_p8' });
  await waitFor(
    () => guest.client.msgs.filter(m => m.type === 'notice' && /try again in/.test(m.text)).pop(),
    5000, 'direct re-entry blocked after kick');

  // ...but a FRESH invite overrides the block.
  owner.client.send({ type: 'studio-invite', username: 'guest_p8' });
  await waitFor(() => guest.client.msgs.filter(m => m.type === 'studio-invite').pop(), 5000, 'fresh invite after kick');
  guest.client.send({ type: 'studio-invite-response', ownerId: owner.id, accept: true });
  await waitFor(
    () => guest.client.msgs.filter(m => m.type === 'map' && m.map.id === `studio:${owner.id}`).pop(),
    5000, 'fresh invite overrides the kick block');

  // And the invite was consumed — re-answering it does nothing.
  guest.client.msgs.length = 0;
  guest.client.send({ type: 'studio-invite-response', ownerId: owner.id, accept: true });
  await waitFor(
    () => guest.client.msgs.filter(m => m.type === 'notice' && /no longer valid/.test(m.text)).pop(),
    5000, 'consumed invite cannot be replayed');
  owner.client.ws.close();
  guest.client.ws.close();
});

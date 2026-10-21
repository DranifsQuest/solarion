'use strict';

/**
 * Solarion — regression test for the playtest bug: W/A/S/D could not
 * be typed into the login username/password fields (or the creation
 * display-name field, chat box, etc.) because the client's global
 * movement-key handler preventDefaulted keydowns regardless of
 * focus. The fix is the extracted guard in public/input-guard.js:
 * global key handlers ignore events whose target is a text-entry
 * element. This suite unit-tests that real guard module (the same
 * file the browser loads) and asserts client.js / index.html are
 * actually wired to use it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isTextEntryTarget, screenToWorldKeys } = require('../public/input-guard.js');

const el = (tagName, type, extra) => ({ tagName, type, ...(extra || {}) });

test('guard: every text-entry element in the app is protected', () => {
  // The actual fields (ids from public/index.html):
  const fields = [
    ['#username (login)', el('INPUT', 'text')],
    ['#password (login)', el('INPUT', 'password')],
    ['#createName (creation display name)', el('INPUT', 'text')],
    ['#chatInput', el('INPUT', 'text')],
    ['#raiseAmt (poker raise)', el('INPUT', 'number')],
    ['#visitName (studio visit)', el('INPUT', 'text')],
    ['#mixName', el('INPUT', 'text')],
    ['#joinMixSel', el('SELECT', undefined)],
    ['#kickSel', el('SELECT', undefined)],
    ['#mixBars', el('SELECT', undefined)],
    ['textarea (generic)', el('TEXTAREA', undefined)],
    ['contentEditable div', el('DIV', undefined, { isContentEditable: true })],
    ['input with no type attr (defaults to text)', el('INPUT', undefined)],
    ['lowercase tag from some browsers', el('input', 'text')],
  ];
  for (const [label, target] of fields) {
    assert.equal(isTextEntryTarget(target), true, `${label} must be guarded`);
  }
});

test('guard: game surfaces and non-text controls are NOT guarded', () => {
  const gameTargets = [
    ['canvas', el('CANVAS', undefined)],
    ['body', el('BODY', undefined)],
    ['plain div', el('DIV', undefined)],
    ['button', el('BUTTON', undefined)],
    ['range slider (#mixBpm — arrow keys stay movement, as before)', el('INPUT', 'range')],
    ['checkbox', el('INPUT', 'checkbox')],
    ['null target', null],
    ['undefined target', undefined],
    ['empty object', {}],
  ];
  for (const [label, target] of gameTargets) {
    assert.equal(isTextEntryTarget(target), false, `${label} must not be guarded`);
  }
});

test('guard: simulated keydown flow — letters reach login + name fields, movement still works on canvas', () => {
  // Mirror the client handler's decision order (guard first, then
  // KEYMAP + preventDefault) to prove the end behavior for the exact
  // keys in the bug report.
  const KEYMAP = {
    ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
    ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  };
  function simulateKeydown(target, code) {
    let prevented = false;
    let moved = null;
    if (isTextEntryTarget(target)) return { prevented, moved, ignored: true };
    const k = KEYMAP[code];
    if (k) { moved = k; prevented = true; }
    return { prevented, moved, ignored: false };
  }
  for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) {
    const login = simulateKeydown(el('INPUT', 'text'), code);
    assert.equal(login.ignored, true, `${code} ignored in #username`);
    assert.equal(login.prevented, false, `${code} not preventDefaulted in #username`);
    const pass = simulateKeydown(el('INPUT', 'password'), code);
    assert.equal(pass.ignored, true, `${code} ignored in #password`);
    const name = simulateKeydown(el('INPUT', 'text'), code);
    assert.equal(name.ignored, true, `${code} ignored in #createName`);
    const world = simulateKeydown(el('CANVAS', undefined), code);
    assert.equal(world.ignored, false, `${code} still drives movement on the canvas`);
    assert.equal(world.moved, KEYMAP[code], `${code} maps to ${KEYMAP[code]}`);
    assert.equal(world.prevented, true, `${code} preventDefaulted on the canvas (scroll guard)`);
  }
});

test('wiring: client.js consults the guard before any preventDefault; index.html loads it first', () => {
  const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');
  // The GLOBAL handler (the password field has its own local Enter
  // handler earlier in the file — anchor on KEYMAP, defined just
  // above the global one).
  const kdStart = clientSrc.indexOf("addEventListener('keydown'", clientSrc.indexOf('KEYMAP'));
  assert.ok(kdStart >= 0, 'global keydown handler exists');
  const kdBody = clientSrc.slice(kdStart, kdStart + 1500);
  const guardAt = kdBody.indexOf('isTextEntryTarget');
  const preventAt = kdBody.indexOf('preventDefault');
  assert.ok(guardAt >= 0, 'keydown handler calls isTextEntryTarget');
  assert.ok(preventAt > guardAt, 'guard is consulted before any preventDefault in the keydown handler');
  // The v1.1 Enter-to-chat routing consults activeElement, but only
  // AFTER the guard has had its say — never as an exemption from it.
  const activeAt = kdBody.indexOf('activeElement');
  assert.ok(activeAt === -1 || activeAt > guardAt, 'no focus-based exemption ahead of the guard');

  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const guardTag = html.indexOf('input-guard.js');
  const clientTag = html.indexOf('client.js');
  assert.ok(guardTag >= 0 && clientTag > guardTag, 'index.html loads input-guard.js before client.js');
});

// ---------------------------------------------------------- movement mapping
// Regression pin for the second playtest bug: pressing "up" moved
// the avatar diagonally on screen. The server walks WORLD axes; the
// client renders through proj(x, y) = [(x - y), (x + y) * 0.5] (the
// ZOOM factor cancels). screenToWorldKeys must turn each pressed
// SCREEN direction into the world key set whose projected velocity
// points that way on screen.

const K = (up, down, left, right) => ({ up: !!up, down: !!down, left: !!left, right: !!right });
const NONE = K(0, 0, 0, 0);

/** What the server does with a sent key set (src/game.js tick). */
function worldVelocity(sent) {
  let dx = 0, dy = 0;
  if (sent.left) dx -= 1;
  if (sent.right) dx += 1;
  if (sent.up) dy -= 1;
  if (sent.down) dy += 1;
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}
/** The client's projection (public/client.js proj, ZOOM dropped). */
function proj([x, y]) { return [x - y, (x + y) * 0.5]; }
/** Screen velocity direction (unit vector) for a pressed key set. */
function screenVelocity(screenKeys) {
  const [sx, sy] = proj(worldVelocity(screenToWorldKeys(screenKeys)));
  const len = Math.hypot(sx, sy) || 1;
  return [sx / len, sy / len];
}

test('movement: each cardinal key produces exactly that SCREEN direction', () => {
  // [label, pressed, expected screen velocity sign pattern]
  const cases = [
    ['up',    K(1, 0, 0, 0), [0, -1]],
    ['down',  K(0, 1, 0, 0), [0, 1]],
    ['left',  K(0, 0, 1, 0), [-1, 0]],
    ['right', K(0, 0, 0, 1), [1, 0]],
  ];
  for (const [label, pressed, [ex, ey]] of cases) {
    const [sx, sy] = screenVelocity(pressed);
    assert.ok(Math.abs(sx - ex) < 1e-9 && Math.abs(sy - ey) < 1e-9,
      `${label}: screen velocity (${sx.toFixed(3)}, ${sy.toFixed(3)}) must be exactly (${ex}, ${ey}) — cardinal on screen, not a diagonal`);
  }
});

test('movement: the raw key sets sent to the server are the iso-compensated ones', () => {
  assert.deepEqual(screenToWorldKeys(K(1, 0, 0, 0)), K(1, 0, 1, 0), 'screen up = world up+left');
  assert.deepEqual(screenToWorldKeys(K(0, 1, 0, 0)), K(0, 1, 0, 1), 'screen down = world down+right');
  assert.deepEqual(screenToWorldKeys(K(0, 0, 1, 0)), K(0, 1, 1, 0), 'screen left = world down+left');
  assert.deepEqual(screenToWorldKeys(K(0, 0, 0, 1)), K(1, 0, 0, 1), 'screen right = world up+right');
});

test('movement: two keys give a screen diagonal in the right quadrant (iso edge direction)', () => {
  const cases = [
    ['up+right',    K(1, 0, 0, 1), [1, -1]],
    ['up+left',     K(1, 0, 1, 0), [-1, -1]],
    ['down+right',  K(0, 1, 0, 1), [1, 1]],
    ['down+left',   K(0, 1, 1, 0), [-1, 1]],
  ];
  for (const [label, pressed, [qx, qy]] of cases) {
    const [sx, sy] = screenVelocity(pressed);
    assert.ok(Math.sign(sx) === qx && Math.sign(sy) === qy && sx !== 0 && sy !== 0,
      `${label}: screen velocity (${sx.toFixed(3)}, ${sy.toFixed(3)}) must be a diagonal in quadrant (${qx}, ${qy})`);
  }
});

test('movement: opposing keys cancel and garbage input is inert', () => {
  assert.deepEqual(screenToWorldKeys(K(1, 1, 0, 0)), NONE, 'up+down cancels');
  assert.deepEqual(screenToWorldKeys(K(0, 0, 1, 1)), NONE, 'left+right cancels');
  assert.deepEqual(screenToWorldKeys(K(1, 1, 1, 1)), NONE, 'all four cancel');
  assert.deepEqual(screenToWorldKeys(NONE), NONE, 'no keys -> no keys');
  assert.deepEqual(screenToWorldKeys(null), NONE, 'null is inert');
  assert.deepEqual(screenToWorldKeys(undefined), NONE, 'undefined is inert');
  assert.deepEqual(screenToWorldKeys({}), NONE, 'empty object is inert');
});

test('movement wiring: client.js converts through screenToWorldKeys at send time', () => {
  const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');
  assert.ok(clientSrc.includes('screenToWorldKeys'), 'client.js uses the shared mapping');
  assert.ok(clientSrc.includes("send({ type: 'input', keys: wk })"), 'the send interval ships the converted keys');
  assert.ok(!clientSrc.includes("send({ type: 'input', keys })"), 'no raw screen-intent key set is ever sent');
});

// ------------------------------------------------------------ v1.1

test('facing (v1.1): screen direction of travel names the sprite view', () => {
  const { screenFacing } = require('../public/input-guard.js');
  // The Lane B quirk, pinned: walking screen-RIGHT is world (+1,-1)
  // — a world-axis tie the old server code resolved to 'up'.
  assert.equal(screenFacing(1, -1), 'right', 'world (+1,-1) = screen-right travel');
  assert.equal(screenFacing(-1, 1), 'left', 'world (-1,+1) = screen-left travel');
  assert.equal(screenFacing(-1, -1), 'up', 'world (-1,-1) = screen-up travel');
  assert.equal(screenFacing(1, 1), 'down', 'world (+1,+1) = screen-down travel');
  // Pure world axes are the screen diagonals; they resolve by their
  // dominant SCREEN component (x travels 2x the y under the 2:1 iso).
  assert.equal(screenFacing(0, -1), 'right');
  assert.equal(screenFacing(0, 1), 'left');
  assert.equal(screenFacing(-1, 0), 'left');
  assert.equal(screenFacing(1, 0), 'right');
  assert.equal(screenFacing(0, 0), 'down', 'no travel keeps a neutral facing');
});

test('facing round-trip: each screen key yields its own facing end-to-end', () => {
  const { screenFacing } = require('../public/input-guard.js');
  for (const dir of ['up', 'down', 'left', 'right']) {
    const wk = screenToWorldKeys({ [dir]: true });
    const dx = (wk.right ? 1 : 0) - (wk.left ? 1 : 0);
    const dy = (wk.down ? 1 : 0) - (wk.up ? 1 : 0);
    assert.equal(screenFacing(dx, dy), dir, `press ${dir} -> face ${dir}`);
  }
  // Screen diagonals: under the 2:1 iso a down-right press travels
  // twice as far right as down on screen, so it faces right.
  const wk = screenToWorldKeys({ right: true, down: true });
  const dx = (wk.right ? 1 : 0) - (wk.left ? 1 : 0);
  const dy = (wk.down ? 1 : 0) - (wk.up ? 1 : 0);
  assert.equal(screenFacing(dx, dy), 'right', 'screen down-right diagonal faces its dominant axis');
});

test('facing wiring: the server sim names dir via the shared screenFacing', () => {
  const gameSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'game.js'), 'utf8');
  assert.ok(gameSrc.includes("require('../public/input-guard')"), 'game.js imports the shared mapping module');
  assert.ok(gameSrc.includes('p.dir = screenFacing(dx, dy)'), 'tick assigns facing from screenFacing');
});

test('vice fade (v1.1): haze is full inside the window and gone at 30s', () => {
  const { viceFade } = require('../public/input-guard.js');
  assert.equal(viceFade(0), 1, 'a fresh drink = full haze');
  assert.equal(viceFade(10000), 1, 'still full at 10s');
  assert.equal(viceFade(25000), 1, 'still full at the fade edge (25s)');
  assert.ok(viceFade(27500) > 0 && viceFade(27500) < 1, 'fading through the last 5s');
  assert.equal(viceFade(30000), 0, 'haze fully lifted at 30s');
  assert.equal(viceFade(45000), 0, 'and stays gone');
  assert.equal(viceFade(-5), 0, 'no timestamp = no haze');
  assert.equal(viceFade(15000, 20000, 4000), 1, 'custom window honoured');
  assert.equal(viceFade(20000, 20000, 4000), 0, 'custom window edge honoured');
});

test('enter toggles chat (v1.1): the state machine + client wiring', () => {
  const { enterAction } = require('../public/input-guard.js');
  assert.equal(enterAction(false), 'focus', 'inactive + Enter activates the chat box');
  assert.equal(enterAction(true), 'submit', 'active + Enter submits (client then blurs)');
  const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');
  assert.ok(clientSrc.includes('enterAction(document.activeElement'), 'client routes Enter through the contract');
  assert.ok(clientSrc.includes("$('chatInput').focus()"), 'Enter focuses the chat input');
  // The submit half of the contract: send (if text) + blur, so
  // movement keys are live again immediately after sending.
  const submit = clientSrc.slice(clientSrc.indexOf("$('chatForm').addEventListener('submit'"));
  assert.ok(submit.includes("$('chatInput').blur()"), 'submit blurs the chat box');
  assert.ok(submit.includes("if (v) send({ type: 'chat', text: v })"), 'empty Enter sends nothing');
});

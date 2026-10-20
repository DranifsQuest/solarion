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

const { isTextEntryTarget } = require('../public/input-guard.js');

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
  const kdBody = clientSrc.slice(kdStart, kdStart + 700);
  const guardAt = kdBody.indexOf('isTextEntryTarget');
  const preventAt = kdBody.indexOf('preventDefault');
  assert.ok(guardAt >= 0, 'keydown handler calls isTextEntryTarget');
  assert.ok(preventAt > guardAt, 'guard is consulted before any preventDefault in the keydown handler');
  assert.ok(!kdBody.includes("activeElement === $('chatInput')"), 'the old chat-only exemption is gone (guard covers all fields)');

  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const guardTag = html.indexOf('input-guard.js');
  const clientTag = html.indexOf('client.js');
  assert.ok(guardTag >= 0 && clientTag > guardTag, 'index.html loads input-guard.js before client.js');
});

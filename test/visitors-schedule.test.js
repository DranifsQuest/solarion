'use strict';
/*
 * test/visitors-schedule.test.js — per-visitor daily windows
 * (X's call 2026-10-25: offset Sims to 8:05–8:08 PM CT).
 *
 * Orenius keeps 8:00–8:03 PM; Sims moves to 8:05–8:08 PM, so a
 * red-fruit eater — 2:00 Threshold scene + 15s arrival vignette
 * included — always lands in Elsewhere while Sims is present.
 * The trap the shared window had: eat after ~8:00:45 and you
 * landed after Sims left at 8:03, stranded until tomorrow.
 *
 * scheduledNow(id, mins) takes an explicit Chicago minute so
 * these legs prove the windows without waiting for 8 PM. No
 * server boot: the presence path is pure here (the expiry suite
 * covers summon/expiry over a live server).
 *
 * Run: node --test test/visitors-schedule.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { VisitorSystem, VISITOR_WINDOWS } = require('../src/visitors');

const vs = new VisitorSystem({}); // stub game: scheduledNow touches none of it
clearInterval(vs.timer);

test('windows are as X ruled them', () => {
  assert.deepEqual(VISITOR_WINDOWS.orenius, { startMin: 1200, lenMin: 3 });
  assert.deepEqual(VISITOR_WINDOWS.sims, { startMin: 1205, lenMin: 3 });
});

test('Orenius: present 8:00–8:02, gone at 8:03', () => {
  assert.equal(vs.scheduledNow('orenius', 1159), false);
  assert.equal(vs.scheduledNow('orenius', 1200), true);
  assert.equal(vs.scheduledNow('orenius', 1201), true);
  assert.equal(vs.scheduledNow('orenius', 1202), true);
  assert.equal(vs.scheduledNow('orenius', 1203), false);
});

test('Sims: absent while Orenius is out, present 8:05–8:07, gone at 8:08', () => {
  assert.equal(vs.scheduledNow('sims', 1200), false);
  assert.equal(vs.scheduledNow('sims', 1202), false);
  assert.equal(vs.scheduledNow('sims', 1204), false);
  assert.equal(vs.scheduledNow('sims', 1205), true);
  assert.equal(vs.scheduledNow('sims', 1206), true);
  assert.equal(vs.scheduledNow('sims', 1207), true);
  assert.equal(vs.scheduledNow('sims', 1208), false);
});

test('the whole red-fruit range lands while Sims is present', () => {
  // Earliest eater (talks at 8:00) frees ~8:02:15; latest eater
  // (talks at 8:02:59, just before Orenius leaves) frees ~8:05:14.
  // Sims covers 8:05–8:08, so the late eater is met on arrival
  // and the early eater waits under three minutes — never stranded.
  assert.equal(vs.scheduledNow('sims', 1205), true);
  assert.equal(vs.scheduledNow('sims', 1206), true);
  assert.equal(vs.scheduledNow('sims', 1207), true);
});

test('unknown visitor ids are never scheduled', () => {
  assert.equal(vs.scheduledNow('nobody', 1201), false);
});

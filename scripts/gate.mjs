#!/usr/bin/env node
'use strict';

/**
 * SOLARION GATEKEEPER — tiered verification for the Solarion suite.
 *
 *   node scripts/gate.mjs fast      [--base <git-ref>]   iteration gate
 *   node scripts/gate.mjs standard                       pre-push gate
 *   node scripts/gate.mjs release   [--dispatch]         live-release gate
 *
 * Tiers (see docs/gatekeeper.md):
 *   fast     — run only the tests mapped to the files you changed.
 *   standard — the full suite once + the 50-bot load smoke.
 *   release  — the full suite 3x; with --dispatch it also fires the
 *              GitHub Actions live-verify and records the run URL.
 *
 * WHY THIS EXISTS: the suite's test files each derive their server
 * ports and DB paths from the TEST_RUN env var
 * (port = FILE_BASE + TEST_RUN * STRIDE, db = data/<file>-run-<RUN>.db).
 * Run serially with the same TEST_RUN that's fine — but several files
 * SHARE port bases (casino & phase9 both start at 49700; expansion &
 * studios both at 49900; vice's window overlaps creation's), so naive
 * parallel runs collide with EADDRINUSE. The PORT PLAN below gives
 * every file its own TEST_RUN offset so all port windows are disjoint;
 * the plan is asserted at startup, so a future test file that breaks
 * the invariant fails loudly here instead of flaking in CI.
 *
 * Node standard library only — this codebase is dependency-free.
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// TEST FILE REGISTRY — every test file in the suite, with its port plan.
//
//   base/stride/extra describe the file's own arithmetic (read from its
//   source): it binds ports [base + stride*RUN,  base + stride*RUN + extra].
//   run is the TEST_RUN value THIS tool assigns so windows never overlap.
//   extra = highest offset the file binds above its base port
//   (restart/second servers). Files with base=null bind no port.
// ---------------------------------------------------------------------------
const TEST_FILES = [
  // file                    base   stride extra  run   (port window)
  ['test/test.js',           48000, 20,    2,     0],   // 48000-48002
  ['test/vice.test.js',      48900, 20,    0,     0],   // 48900
  ['test/creation.test.js',  49100, 20,    3,     0],   // 49100-49103
  ['test/security.test.js',  49300, 20,    10,    0],   // 49300-49310
  ['test/music.test.js',     49500, 10,    0,     0],   // 49500
  ['test/audibility.test.js',49600, 10,    0,     0],   // 49600
  ['test/casino.test.js',    49700, 20,    6,     0],   // 49700-49706
  ['test/expansion.test.js', 49900, 20,    0,     0],   // 49900
  ['test/phase9.test.js',    49700, 10,    0,     40],  // 50100
  ['test/homes.test.js',     50300, 20,    0,     0],   // 50300
  ['test/studios.test.js',   49900, 20,    6,     30],  // 50500-50506
  ['test/phase10.test.js',   50500, 20,    0,     2],   // 50540
  ['test/sprites.test.js',   null,  0,     0,     0],   // no server
  ['test/input-guard.test.js', null, 0,    0,     0],   // no server
  ['test/slotgui.test.js',   null,  0,     0,     0],   // no server (v1.2 Item H)
  ['test/audio.test.js',     null,  0,     0,     0],   // no server (v1.2 Items D/S)
  ['test/seasons.test.js',   null,  0,     0,     0],   // no server (seasonal themes)
].map(([file, base, stride, extra, run]) => ({ file, base, stride, extra, run }));

const ALL_TESTS = TEST_FILES.map(t => t.file);

// The fallback for core/engine changes and anything unmapped: the
// broad protocol suites. A code change NEVER maps to zero tests.
const CORE_SET = ['test/test.js', 'test/expansion.test.js', 'test/phase9.test.js', 'test/phase10.test.js'];

// ---------------------------------------------------------------------------
// CHANGE → TEST MAPPING (fast gate). First matching rules win per file;
// a changed file may match several rules — the union runs.
// `match` is a RegExp tested against the repo-relative path.
// ---------------------------------------------------------------------------
const MAPPING = [
  { match: /^src\/(music|stage)\.js$/,            tests: ['test/music.test.js', 'test/audibility.test.js'], why: 'music/stage engine' },
  { match: /^src\/casino\.js$/,                   tests: ['test/casino.test.js', 'test/vice.test.js'], why: 'casino engine (vice covers the casino bars/hookah)' },
  { match: /^src\/studio\.js$/,                   tests: ['test/studios.test.js', 'test/homes.test.js'], why: 'studios/homes engine' },
  { match: /^src\/appearance\.js$/,               tests: ['test/creation.test.js', 'test/sprites.test.js'], why: 'appearance options feed creation + sprite rendering' },
  { match: /^src\/(game|maps|server|db)\.js$/,    tests: CORE_SET, why: 'core engine/map/server — broad protocol set' },
  { match: /^public\/sprites\.js$/,                tests: ['test/sprites.test.js', 'test/creation.test.js'], why: 'sprite renderer' },
  { match: /^public\/input-guard\.js$/,           tests: ['test/input-guard.test.js'], why: 'keyboard input guard' },
  { match: /^public\/(client|audio|mixer|studio)\.js$/, tests: ['test/input-guard.test.js', 'test/audibility.test.js', 'test/test.js'], why: 'client/audio surface' },
  { match: /^public\//,                           tests: ['test/input-guard.test.js', 'test/sprites.test.js'], why: 'other client assets', fallback: true },
  { match: /^test\/(.+)$/,                        tests: null, why: 'the changed test file itself' }, // tests = the file itself
  { match: /^src\//,                              tests: CORE_SET, why: 'UNMAPPED source file — core fallback', fallback: true },
  { match: /^scripts\/live-verify\.mjs$/,         tests: [], why: 'live-verify harness is exercised by the release tier, not the local suite' },
  { match: /^scripts\//,                          tests: CORE_SET, why: 'tooling/scripts change — core fallback', fallback: true },
];
const DOCS_RE = /^(docs\/|README\.md$|.*\.md$)/;

// ---------------------------------------------------------------------------

function assertPortPlan() {
  const windows = [];
  for (const t of TEST_FILES) {
    if (t.base == null) continue;
    const lo = t.base + t.stride * t.run;
    const hi = lo + t.extra;
    for (const w of windows) {
      if (lo <= w.hi && w.lo <= hi) {
        throw new Error(`PORT PLAN COLLISION: ${t.file} [${lo}-${hi}] overlaps ${w.file} [${w.lo}-${w.hi}]. Fix the run offsets in scripts/gate.mjs.`);
      }
    }
    windows.push({ file: t.file, lo, hi });
  }
  return windows;
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

function changedFiles(baseRef) {
  const set = new Set();
  // Committed changes vs the base ref (default HEAD = just the worktree state).
  const diff = git(['diff', '--name-only', baseRef]).trim();
  if (diff) diff.split('\n').forEach(f => set.add(f));
  // Untracked files count as changes too.
  const untracked = git(['ls-files', '--others', '--exclude-standard']).trim();
  if (untracked) untracked.split('\n').forEach(f => set.add(f));
  // The gate's own report files are not game changes.
  return [...set].filter(f => !f.startsWith('gate-reports/') && f !== 'scripts/gate.mjs');
}

function selectFastTests(changed) {
  const selected = new Map(); // test file -> [reasons]
  const notes = [];
  let codeChanges = 0;
  for (const f of changed) {
    if (DOCS_RE.test(f)) { notes.push({ file: f, kind: 'docs', detail: 'documentation only — no tests required' }); continue; }
    codeChanges++;
    // Specific rules stack; fallback rules fire only if nothing specific matched.
    let matched = false;
    for (const pass of [false, true]) {
      for (const rule of MAPPING) {
        if (Boolean(rule.fallback) !== pass) continue;
        if (matched && pass) break;
        const m = rule.match.exec(f);
        if (!m) continue;
        matched = true;
        const tests = rule.tests === null ? [f] : rule.tests;
        for (const t of tests) {
          if (!selected.has(t)) selected.set(t, []);
          selected.get(t).push(`${f} (${rule.why})`);
        }
        notes.push({ file: f, kind: rule.fallback ? 'fallback' : 'mapped', detail: `${tests.length ? tests.join(', ') : 'no local tests'} ← ${rule.why}` });
      }
    }
    if (!matched) {
      for (const t of CORE_SET) { if (!selected.has(t)) selected.set(t, []); selected.get(t).push(`${f} (unmapped — core fallback)`); }
      notes.push({ file: f, kind: 'fallback', detail: `no mapping rule — core fallback ${CORE_SET.join(', ')}` });
    }
  }
  return { selected, notes, codeChanges };
}

// ---------------------------------------------------------------------------

function runShard(testFile) {
  const plan = TEST_FILES.find(t => t.file === testFile);
  return new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn('node', ['--test', testFile], {
      cwd: ROOT,
      env: { ...process.env, TEST_RUN: String(plan ? plan.run : 0) },
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => {
      const pass = (out.match(/ℹ pass (\d+)/) || [])[1];
      const fail = (out.match(/ℹ fail (\d+)/) || [])[1];
      resolve({
        file: testFile,
        run: plan ? plan.run : 0,
        ok: code === 0,
        code,
        pass: pass != null ? Number(pass) : null,
        fail: fail != null ? Number(fail) : null,
        ms: Date.now() - t0,
        tail: code === 0 ? '' : out.split('\n').slice(-40).join('\n'),
      });
    });
  });
}

async function runShards(files, concurrency) {
  const results = [];
  const queue = [...files];
  async function worker() {
    while (queue.length) {
      const f = queue.shift();
      results.push(await runShard(f));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  return results.sort((a, b) => files.indexOf(a.file) - files.indexOf(b.file));
}

function runLoadTest() {
  return new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn('node', ['scripts/load-test.js', '50', '40'], {
      cwd: ROOT,
      env: { ...process.env, SOLARION_LOAD_PORT: '48250' },
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => resolve({ ok: code === 0, code, ms: Date.now() - t0, out: out.trim().split('\n').slice(-12).join('\n') }));
  });
}

function ghAvailable() {
  try { execFileSync('gh', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return true; }
  catch { return false; }
}

function dispatchLiveVerify() {
  // Fire the Actions live-verify and capture the newest run URL.
  execFileSync('gh', ['workflow', 'run', 'live-verify.yml', '--repo', 'DranifsQuest/solarion'], { cwd: ROOT, encoding: 'utf8' });
  const list = execFileSync('gh', ['run', 'list', '--workflow', 'live-verify.yml', '--repo', 'DranifsQuest/solarion', '--limit', '1', '--json', 'url,databaseId'], { cwd: ROOT, encoding: 'utf8' });
  const runs = JSON.parse(list);
  return runs.length ? runs[0].url : null;
}

// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const tier = ['fast', 'standard', 'release'].includes(args[0]) ? args[0] : 'fast';
  const baseIdx = args.indexOf('--base');
  const baseRef = baseIdx >= 0 ? args[baseIdx + 1] : 'HEAD';
  const dispatch = args.includes('--dispatch');
  const concurrency = Math.max(2, Math.min(os.cpus().length, 6));

  assertPortPlan();
  const head = git(['rev-parse', '--short', 'HEAD']).trim();
  const changed = changedFiles(baseRef);
  const t0 = Date.now();

  const L = [];
  const say = s => { L.push(s); console.log(s); };
  say(`# Solarion Gatekeeper — ${tier.toUpperCase()} gate`);
  say(`- HEAD: \`${head}\` · base ref: \`${baseRef}\` · concurrency: ${concurrency} shards`);
  say(`- Changed files (${changed.length}): ${changed.length ? changed.map(f => `\`${f}\``).join(', ') : '_none_'}`);

  let verdict = 'PASS';
  const skipped = [];
  const allResults = [];

  async function suitePass(label, files) {
    say(`\n## ${label}`);
    const results = await runShards(files, concurrency);
    allResults.push(...results);
    for (const r of results) {
      say(`- ${r.ok ? '✅' : '❌'} \`${r.file}\` (TEST_RUN=${r.run}) — ${r.pass != null ? `${r.pass} passed, ${r.fail} failed` : `exit ${r.code}`} in ${(r.ms / 1000).toFixed(1)}s`);
      if (!r.ok) { verdict = 'FAIL'; say('```\n' + r.tail + '\n```'); }
    }
    return results;
  }

  if (tier === 'fast') {
    const { selected, notes, codeChanges } = selectFastTests(changed);
    say('\n## Selection');
    for (const n of notes) say(`- \`${n.file}\` — ${n.detail}`);
    if (!changed.length) say('- No changes vs base — nothing to run.');
    const files = [...selected.keys()];
    if (codeChanges > 0 && files.length === 0) {
      verdict = 'FAIL';
      say('\n> ⚠️ **UNSAFE-SKIP**: code changed but mapped to ZERO tests. Refusing to pass.');
    } else if (files.length === 0) {
      skipped.push('Entire suite skipped — docs-only change (no code touched), so there is nothing behavioral to verify. Safe because documentation cannot change runtime behavior.');
      say('\nDocs-only change: no tests selected (safe skip — see report).');
    } else {
      const notRun = ALL_TESTS.filter(t => !files.includes(t));
      if (notRun.length) skipped.push(`Not run in FAST tier: ${notRun.join(', ')} — safe for iteration only because the changed files map to the selected suites; STANDARD remains required pre-push and RELEASE before anything is called live.`);
      await suitePass(`FAST — ${files.length} mapped test file(s)`, files);
    }
  }

  if (tier === 'standard' || tier === 'release') {
    const passes = tier === 'release' ? 3 : 1;
    for (let i = 1; i <= passes; i++) {
      await suitePass(`${tier.toUpperCase()} — full suite pass ${i}/${passes} (all ${ALL_TESTS.length} files)`, ALL_TESTS);
    }
    say('\n## Load smoke (50 bots, 40s)');
    const load = await runLoadTest();
    say(load.ok ? `- ✅ load test passed in ${(load.ms / 1000).toFixed(1)}s` : `- ❌ load test FAILED (exit ${load.code})`);
    say('```\n' + load.out + '\n```');
    if (!load.ok) verdict = 'FAIL';

    if (tier === 'release') {
      say('\n## Live verify (GitHub Actions)');
      if (dispatch) {
        if (ghAvailable()) {
          try {
            const url = dispatchLiveVerify();
            say(`- Dispatched live-verify workflow.${url ? ` Run: ${url}` : ''}`);
            skipped.push('Live-verify RESULT not awaited by this tool — the gate verdict covers local suites; the Actions run must still be read and green before anything is called live.');
          } catch (e) {
            verdict = 'FAIL';
            say(`- ❌ gh dispatch failed: ${String(e.message).slice(0, 300)}`);
          }
        } else {
          say('- ⚠️ `gh` not available on this machine — dispatch skipped.');
          skipped.push('Live-verify dispatch skipped: gh CLI unavailable here. NOT safe to call the build live until `gh workflow run live-verify.yml --repo DranifsQuest/solarion` has been run and its result read.');
        }
      } else {
        say('- Not dispatched (no `--dispatch` flag). To finish the release: `gh workflow run live-verify.yml --repo DranifsQuest/solarion`, then read the run result.');
        skipped.push('Live-verify not dispatched (no --dispatch). The local 3x suite passed; the external live verdict is still required before calling anything live.');
      }
    }
  }

  const wallS = ((Date.now() - t0) / 1000).toFixed(1);
  const serialS = (allResults.reduce((a, r) => a + r.ms, 0) / 1000).toFixed(1);
  const totalPass = allResults.reduce((a, r) => a + (r.pass || 0), 0);
  const totalFail = allResults.reduce((a, r) => a + (r.fail || 0), 0);

  say('\n## Summary');
  say(`- Tests run: ${allResults.length} file-run(s) — ${totalPass} passed, ${totalFail} failed`);
  say(`- Wall time: **${wallS}s** (sum of shard times: ${serialS}s — that sum is the serial-equivalent for the files run)`);
  for (const s of skipped) say(`- Skipped: ${s}`);
  say(`\n## VERDICT: ${verdict === 'PASS' ? '✅ PASS' : '❌ FAIL'}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(ROOT, 'gate-reports');
  fs.mkdirSync(dir, { recursive: true });
  const reportPath = path.join(dir, `${stamp}-${tier}.md`);
  fs.writeFileSync(reportPath, L.join('\n') + '\n');
  console.log(`\nReport written: gate-reports/${stamp}-${tier}.md`);
  process.exit(verdict === 'PASS' ? 0 : 1);
}

main().catch(e => { console.error('gatekeeper error:', e.message); process.exit(2); });

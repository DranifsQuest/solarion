#!/usr/bin/env node
// Solarion Playtest Gate — the visual level of the Gatekeeper.
//
//   node scripts/playtest.mjs [--skip-capture]
//
// Pipeline (target: well under 3 minutes):
//   1. POSED CAPTURES — the Bake Shop renders every public room at
//      play zoom with sample avatars seated at every seat kind,
//      standing in doorways and at pit fronts (day everywhere,
//      night for the lit interiors) into previews/playtest/.
//   2. CHECKER SELFTEST — every image-space check must fail by
//      name on a doctored fixture before its verdicts are trusted.
//   3. IMAGE-SPACE CHECKS — scripts/playtest-check.mjs over the
//      captures + manifest (row alignment, back visibility, legs
//      under tables, clear zones, crowding, edge margin).
//   4. CONTACT SHEET + REPORT — previews/playtest/contact-sheet.html
//      (every capture at readable size; the parent eyeballs and
//      signs it before any deploy) and gate-reports/<ts>-playtest.md.
//
// --skip-capture reuses the existing captures (checker iteration).
// Exit code: 0 = PASS, 1 = a check failed, 2 = the run itself broke.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks, runSelftest, formatReport, PT_DIR } from './playtest-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skipCapture = process.argv.includes('--skip-capture');

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit' });
    p.on('close', (code) => resolve(code ?? 1));
    p.on('error', () => resolve(1));
  });
}

function contactSheet(manifest) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const byMap = new Map();
  for (const e of manifest.entries) {
    if (!byMap.has(e.map)) byMap.set(e.map, []);
    byMap.get(e.map).push(e);
  }
  const parts = [`<!doctype html><meta charset="utf-8"><title>Solarion Playtest — contact sheet</title>
<style>body{background:#171310;color:#e8ded2;font:14px/1.45 system-ui;margin:24px}h1{font-size:20px}h2{margin-top:32px;color:#f0b35e}figure{display:inline-block;margin:8px;vertical-align:top}img{width:470px;border:1px solid #4a3b2c;border-radius:6px}figcaption{max-width:470px;color:#bfae99;font-size:12px;margin-top:4px}</style>
<h1>Solarion Playtest Gate — contact sheet</h1>
<p>Every posed capture at play zoom. Posed actors wear neon-green pants (#2bff5e) so legs are machine-findable. Sign-off: eyeball rows, chair backs, laps at tables, doorways — then check gate-reports/ for the machine verdict.</p>`];
  for (const [map, entries] of byMap) {
    parts.push(`<h2>${esc(map)}</h2>`);
    for (const e of entries) {
      const file = path.basename(e.file);
      const who = e.actors.map(a => a.seated
        ? `${a.name} sits ${a.seatId || ''} facing ${a.dir}`
        : `${a.name} stands ${a.stand || ''}`).join('; ');
      parts.push(`<figure><img src="${esc(file)}" alt="${esc(map)} ${esc(e.shot)}"><figcaption><b>${esc(e.shot)}</b> · ${esc(e.phase)} — ${esc(who)}</figcaption></figure>`);
    }
  }
  const out = path.join(PT_DIR, 'contact-sheet.html');
  fs.writeFileSync(out, parts.join('\n'));
  return out;
}

async function main() {
  const t0 = Date.now();
  if (!skipCapture) {
    console.log('[playtest] capturing posed scenes (Bake Shop, play zoom)…');
    const code = await run('node', ['scripts/preview.mjs', '--scene', 'playtest']);
    if (code !== 0) { console.error('[playtest] capture step failed'); process.exit(2); }
  } else {
    console.log('[playtest] --skip-capture: reusing previews/playtest/');
  }

  console.log('[playtest] checker selftest (negative fixtures)…');
  const self = runSelftest();
  for (const c of self.cases) console.log(`- ${c.ok ? '✅' : '❌'} SELFTEST ${c.name} — ${c.detail}`);
  if (!self.ok) { console.error('[playtest] checker selftest FAILED — its verdicts cannot be trusted'); process.exit(2); }

  const manifestPath = path.join(PT_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) { console.error('[playtest] no manifest — captures missing'); process.exit(2); }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const sheet = contactSheet(manifest);
  console.log(`[playtest] contact sheet: ${path.relative(ROOT, sheet)} (${manifest.entries.length} captures)`);

  console.log('[playtest] running image-space checks…');
  const run1 = runChecks();
  let head = '';
  try {
    const { execFileSync } = await import('node:child_process');
    head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch { /* report still works without it */ }
  let report = formatReport(run1, { head });
  report = report.replace('## VERDICT', `## Checker selftest: ✅ PASS (${self.cases.length}/${self.cases.length} negative fixtures fail by name)\n\n## VERDICT`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(ROOT, 'gate-reports');
  fs.mkdirSync(dir, { recursive: true });
  const reportPath = path.join(dir, `${stamp}-playtest.md`);
  fs.writeFileSync(reportPath, report);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  for (const r of run1.results) console.log(`- ${r.ok ? '✅' : '❌'} ${r.name}${r.failures.length ? ` (${r.failures.length} failure(s))` : ''}`);
  console.log(`\nPLAYTEST VERDICT: ${run1.ok ? '✅ PASS' : '❌ FAIL'} in ${secs}s`);
  console.log(`Report written: gate-reports/${stamp}-playtest.md`);
  process.exit(run1.ok ? 0 : 1);
}
main();

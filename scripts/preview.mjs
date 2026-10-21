'use strict';

/**
 * Solarion Bake Shop — preview renderer.
 *
 * Boots the game server in test mode (SOLARION_TEST=1) on a scratch
 * port + throwaway DB, then screenshots maps through the REAL client
 * (headless Chromium loads /preview/:mapId, which drives the actual
 * public/client.js render path — see public/preview.js). Output:
 * previews/<map>-day.png and previews/<map>-night.png for every map,
 * so a build agent can SEE its own art instead of drawing blind.
 *
 * Usage:
 *   npm run preview                  # all maps, day + night
 *   npm run preview -- solstice-bay  # one map
 *   npm run preview -- --phase night # one phase only
 *   npm run preview -- --factory     # also the factory demo scene
 *
 * Chrome binary: $SOLARION_CHROME, else the first of the known
 * locations / PATH names below. Exit 1 if the server won't boot, a
 * page errors, or a screenshot comes out implausibly small.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'previews');
const VIEW = { w: 2800, h: 1500 }; // covers a full 72x45 iso map at ZOOM 0.72

function findChrome() {
  const cands = [
    process.env.SOLARION_CHROME,
    '/opt/meta-chromium/chrome',
    'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable',
  ].filter(Boolean);
  for (const c of cands) {
    if (c.includes('/')) { if (fs.existsSync(c)) return c; continue; }
    const r = spawnSync('which', [c], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split('\n')[0];
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function waitHealth(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return r.json();
    } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('server did not answer /health in 30s');
}

function shoot(chrome, url, out) {
  const args = [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required',
    `--window-size=${VIEW.w},${VIEW.h}`, '--virtual-time-budget=12000',
    `--screenshot=${out}`, url,
  ];
  const r = spawnSync(chrome, args, { encoding: 'utf8', timeout: 90000 });
  if (r.status !== 0) throw new Error(`chrome failed (${r.status}): ${(r.stderr || '').slice(-400)}`);
  const sz = fs.existsSync(out) ? fs.statSync(out).size : 0;
  if (sz < 20000) throw new Error(`screenshot suspiciously small (${sz} bytes): ${out}`);
  return sz;
}

async function main() {
  const argv = process.argv.slice(2);
  const phases = argv.includes('--phase')
    ? [argv[argv.indexOf('--phase') + 1]]
    : ['day', 'night'];
  const wantFactory = argv.includes('--factory');
  const named = argv.filter(a => !a.startsWith('--') && a !== phases[0]);

  const chrome = findChrome();
  if (!chrome) { console.error('No Chromium found (set SOLARION_CHROME).'); process.exit(1); }
  console.log(`chrome: ${chrome}`);

  const port = await freePort();
  const dbPath = path.join(os.tmpdir(), `solarion-preview-${process.pid}.db`);
  const env = { ...process.env, SOLARION_TEST: '1', SOLARION_PORT: String(port), SOLARION_DB_PATH: dbPath };
  const server = spawn('node', ['src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
  const cleanup = () => { try { server.kill('SIGTERM'); } catch (e) { /* gone */ } };
  process.on('exit', cleanup);

  try {
    const health = await waitHealth(port);
    const allMaps = Object.keys(health.maps || {});
    const maps = named.length ? named : allMaps;
    for (const m of maps) {
      if (!allMaps.includes(m)) { console.error(`unknown map: ${m}`); process.exitCode = 1; return; }
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const rows = [];
    for (const m of maps) {
      for (const ph of phases) {
        const out = path.join(OUT_DIR, `${m}-${ph}.png`);
        const sz = shoot(chrome, `http://127.0.0.1:${port}/preview/${m}?phase=${ph}`, out);
        rows.push(`  ${m} (${ph}) -> previews/${m}-${ph}.png (${Math.round(sz / 1024)} KB)`);
      }
    }
    if (wantFactory) {
      const out = path.join(OUT_DIR, 'factory-demo.png');
      const sz = shoot(chrome, `http://127.0.0.1:${port}/factory-demo`, out);
      rows.push(`  factory demo -> previews/factory-demo.png (${Math.round(sz / 1024)} KB)`);
    }
    console.log(`previews written to ${OUT_DIR}:`);
    console.log(rows.join('\n'));
  } finally {
    cleanup();
    for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + suf); } catch (e) { /* absent */ } }
  }
}

main().catch(e => { console.error(`preview failed: ${e.message}`); process.exit(1); });

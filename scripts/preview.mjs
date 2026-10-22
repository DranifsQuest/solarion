'use strict';

/**
 * Solarion Bake Shop — preview renderer.
 *
 * Boots the game server in test mode (SOLARION_TEST=1) on a scratch
 * port + throwaway DB, then screenshots maps through the REAL client
 * in headless Chromium: public/preview.js feeds a synthetic hello
 * (from the server's test-only /preview-data route, built with the
 * real clientMap serializer) through the client's own message
 * handler, so public/client.js's draw() paints the frame. Output:
 * previews/<map>-day.png and previews/<map>-night.png — a build
 * agent can SEE its own art instead of drawing blind.
 *
 * Two environment lessons are baked in (both cost real time):
 *  - `chrome --screenshot` (one-shot) hangs forever in this VM, in
 *    every GPU mode. A daemonized chrome driven over CDP (via the
 *    repo's existing `ws` dependency) answers in ~2s. No new deps.
 *  - Chrome's Local Network Access checks block navigations to
 *    http://localhost here (ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_
 *    CHECKS — the initiator is classified "public"). So the preview
 *    page is generated to a temp file and loaded from file:// (a
 *    LOCAL initiator); only the JSON hello crosses http, as a
 *    local->local fetch the test-only route CORS-allows.
 *
 * Usage:
 *   npm run preview                  # all maps, day + night
 *   npm run preview -- solstice-bay  # one map
 *   npm run preview -- --phase night # one phase only
 *   npm run preview -- --season halloween  # force a seasonal layer
 *                             (halloween | christmas | none; output
 *                             files gain a -<season> suffix)
 *   npm run preview -- --scene sit         # sample players seated
 *                             (occupied-seat rendering; output
 *                             files gain a -sit suffix)
 *   npm run preview -- --factory     # also the factory demo scene
 *
 * Chrome binary: $SOLARION_CHROME, else the first of the known
 * locations / PATH names below. Exit 1 if the server won't boot, a
 * page reports an error, or a screenshot is implausibly small.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

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

/** Minimal CDP client over the repo's ws: one page target, reused. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.on('message', (data) => {
      const m = JSON.parse(String(data));
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(`CDP ${m.error.message}`));
        else resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return new Cdp(ws);
  }
  close() { try { this.ws.close(); } catch (e) { /* gone */ } }
}

async function shootOverCdp(cdp, fileUrl, out, expectTitle) {
  await cdp.send('Page.navigate', { url: fileUrl });
  // Wait until THIS page says it's ready — the exact title match
  // (preview.js sets `preview:<map>:<phase>`) guards against reading
  // the previous page's ready flag mid-navigation; the factory demo
  // instead ends its script by setting a 'ready' title. Then give
  // the rAF draw loop a few frames to paint.
  const deadline = Date.now() + 25000;
  for (;;) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `({ title: document.title, ready: !!window.__PREVIEW_READY__, err: window.__PREVIEW_ERROR__ || null })`,
      returnByValue: true,
    });
    const v = r && r.result && r.result.value;
    if (v && v.err) throw new Error(`page reported error: ${v.err}`);
    const titleOk = expectTitle ? (v && v.title === expectTitle) : (v && v.title.endsWith('ready'));
    if (v && titleOk && (v.ready || !expectTitle)) break;
    if (Date.now() > deadline) throw new Error(`page never became ready: ${fileUrl}`);
    await new Promise(r2 => setTimeout(r2, 250));
  }
  await new Promise(r => setTimeout(r, 700));
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  const sz = fs.statSync(out).size;
  if (sz < 20000) throw new Error(`screenshot suspiciously small (${sz} bytes): ${out}`);
  return sz;
}

/** Build a preview page (the real index.html + injected config) in
 *  dir; its assets resolve against public/ via a file:// <base>. */
function writePreviewPage(dir, apiBase, mapId, phase, season, scene) {
  const pub = path.join(ROOT, 'public');
  let html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  html = html.replace('<head>', `<head>\n<base href="file://${pub}/">`);
  const cfg = { mapId, phase, apiBase };
  if (season) cfg.season = season;
  if (scene) cfg.scene = scene;
  const inject = `<script>window.__PREVIEW_CFG__ = ${JSON.stringify(cfg)};</script>\n<script src="preview.js"></script>\n</body>`;
  const file = path.join(dir, `${mapId}-${phase}.html`);
  fs.writeFileSync(file, html.replace('</body>', inject));
  return `file://${file}`;
}

function writeFactoryPage(dir) {
  const pub = path.join(ROOT, 'public');
  let html = fs.readFileSync(path.join(ROOT, 'scripts', 'factory-demo.html'), 'utf8');
  html = html.replace('<head>', `<head>\n<base href="file://${pub}/">`);
  const file = path.join(dir, 'factory-demo.html');
  fs.writeFileSync(file, html);
  return `file://${file}`;
}

async function main() {
  const argv = process.argv.slice(2);
  const phaseIdx = argv.indexOf('--phase');
  const phases = phaseIdx >= 0 ? [argv[phaseIdx + 1]] : ['day', 'night'];
  const seasonIdx = argv.indexOf('--season');
  const season = seasonIdx >= 0 ? argv[seasonIdx + 1] : null;
  if (season && !['halloween', 'christmas', 'none'].includes(season)) {
    console.error(`unknown season: ${season} (halloween | christmas | none)`);
    process.exit(1);
  }
  const sceneIdx = argv.indexOf('--scene');
  const scene = sceneIdx >= 0 ? argv[sceneIdx + 1] : null;
  if (scene && !['sit'].includes(scene)) {
    console.error(`unknown scene: ${scene} (sit)`);
    process.exit(1);
  }
  const wantFactory = argv.includes('--factory');
  const named = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--phase' || argv[i] === '--season' || argv[i] === '--scene') { i++; continue; }
    if (argv[i].startsWith('--')) continue;
    named.push(argv[i]);
  }

  const chrome = findChrome();
  if (!chrome) { console.error('No Chromium found (set SOLARION_CHROME).'); process.exit(1); }
  console.log(`chrome: ${chrome}`);

  const port = await freePort();
  const cdpPort = await freePort();
  const dbPath = path.join(os.tmpdir(), `solarion-preview-${process.pid}.db`);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solarion-preview-chrome-'));
  const pageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solarion-preview-pages-'));
  const env = { ...process.env, SOLARION_TEST: '1', SOLARION_PORT: String(port), SOLARION_DB_PATH: dbPath };
  const server = spawn('node', ['src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
  const browser = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--disable-component-update', '--disable-background-networking',
    // This VM exports http_proxy env vars; localhost must go direct.
    '--no-proxy-server',
    `--user-data-dir=${profileDir}`, `--remote-debugging-port=${cdpPort}`,
    `--window-size=${VIEW.w},${VIEW.h}`, 'about:blank',
  ], { stdio: 'ignore' });
  const cleanup = () => {
    try { server.kill('SIGTERM'); } catch (e) { /* gone */ }
    try { browser.kill('SIGTERM'); } catch (e) { /* gone */ }
  };
  process.on('exit', cleanup);

  let cdp = null;
  try {
    const health = await waitHealth(port);
    // Attach to chrome's initial page target over CDP.
    let pageTarget = null;
    for (let i = 0; i < 40 && !pageTarget; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
        pageTarget = list.find(t => t.type === 'page');
      } catch (e) { /* not up yet */ }
      if (!pageTarget) await new Promise(r => setTimeout(r, 500));
    }
    if (!pageTarget) throw new Error('chrome CDP endpoint never came up');
    cdp = await Cdp.connect(pageTarget.webSocketDebuggerUrl);
    await cdp.send('Page.enable');

    const allMaps = Object.keys(health.maps || {});
    const maps = named.length ? named : allMaps;
    for (const m of maps) {
      if (!allMaps.includes(m)) { console.error(`unknown map: ${m}`); process.exitCode = 1; return; }
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const apiBase = `http://127.0.0.1:${port}`;
    const rows = [];
    for (const m of maps) {
      for (const ph of phases) {
        const suffix = (season ? `-${season}` : '') + (scene ? `-${scene}` : '');
        const out = path.join(OUT_DIR, `${m}-${ph}${suffix}.png`);
        const sz = await shootOverCdp(cdp, writePreviewPage(pageDir, apiBase, m, ph, season, scene), out, `preview:${m}:${ph}`);
        rows.push(`  ${m} (${ph}${season ? `, ${season}` : ''}${scene ? `, scene=${scene}` : ''}) -> previews/${m}-${ph}${suffix}.png (${Math.round(sz / 1024)} KB)`);
      }
    }
    if (wantFactory) {
      const out = path.join(OUT_DIR, 'factory-demo.png');
      const sz = await shootOverCdp(cdp, writeFactoryPage(pageDir), out);
      rows.push(`  factory demo -> previews/factory-demo.png (${Math.round(sz / 1024)} KB)`);
    }
    console.log(`previews written to ${OUT_DIR}:`);
    console.log(rows.join('\n'));
  } finally {
    if (cdp) cdp.close();
    cleanup();
    for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + suf); } catch (e) { /* absent */ } }
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* chrome may hold files */ }
    try { fs.rmSync(pageDir, { recursive: true, force: true }); } catch (e) { /* absent */ }
  }
}

main().catch(e => { console.error(`preview failed: ${e.message}`); process.exit(1); });

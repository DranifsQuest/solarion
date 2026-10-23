'use strict';

/**
 * Solarion — Bake Shop preview driver (TEST-ONLY).
 *
 * This file is a static asset, but nothing in the normal game loads
 * it: the only page that includes it is the server's test-only
 * /preview/:mapId route (registered only under SOLARION_TEST=1).
 * It fetches a synthetic hello payload from /preview-data/:mapId —
 * built server-side from the real serializers (clientMap + the
 * publicPlayer shape) — and feeds it through the client's OWN
 * message handler, so the screenshot that tooling takes is the real
 * client render path (public/client.js draw()), not a re-drawing.
 *
 * The payload's dayCycle anchor is pre-shifted server-side, so
 * ?phase=day renders full day and ?phase=night renders deep night
 * with the lamp-glow pass lit.
 */
(function () {
  const cfg = window.__PREVIEW_CFG__;
  if (!cfg) return;

  // Screenshot hygiene only: hide every HUD/chrome element inside
  // #game except the canvas itself, and any top-level overlays.
  // The world pixels are untouched — client.js draws them.
  const style = document.createElement('style');
  style.textContent = [
    '#game > *:not(#cv) { display: none !important; }',
    '#wake, #loadScreen, #toast, #areaPlate { display: none !important; }',
  ].join('\n');
  document.head.appendChild(style);

  // Mixer scene (mixer rework): the hygiene CSS above hides every
  // DOM panel by design — the world is canvas — so this scene
  // deliberately un-hides JUST the mixer panel, feeds the real
  // SolarionMixer the live loop catalog (its own attach-time fetch
  // resolves against the file:// base and fails), and builds a
  // draft through the mixer's own gridClick path: a line holding
  // three bubbles of the SAME loop at different bars, a one-cell
  // bubble of the 4-bar pad, and a two-bubble melody line.
  async function openMixerScene(base) {
    const M = window.SolarionMixer;
    if (!M) throw new Error('mixer module missing');
    const j = await (await fetch(`${base}/api/music/loops`)).json();
    if (!j.ok) throw new Error('loop catalog unavailable');
    M.loops = j.loops;
    M.loopsById = new Map(j.loops.map(l => [l.id, l]));
    M.limits = { bpmMin: j.bpmMin, bpmMax: j.bpmMax, maxBars: j.maxBars, maxTracks: j.maxTracks };
    const style = document.createElement('style');
    style.textContent = '#game > #mixerPanel { display: block !important; visibility: visible !important; }';
    document.head.appendChild(style);
    M.openPanel();
    M.el.name.value = 'Three Of The Same';
    if (M.draft) M.draft.name = 'Three Of The Same';
    M.selLoopId = 'pop-drums-1'; // Sunny Beat — the same loop x3 on line 1
    M.gridClick(0, 0);
    M.gridClick(0, 2);
    M.gridClick(0, 5);
    M.selLoopId = 'pop-pad-1'; // Warm Chords — 4 bars long, still ONE cell
    M.gridClick(1, 1);
    M.selLoopId = 'pop-mel-1';
    M.gridClick(2, 0);
    M.gridClick(2, 4);
    M.renderBrowser();
  }

  async function boot() {
    try {
      const base = cfg.apiBase || '';
      const seasonQ = cfg.season ? `&season=${encodeURIComponent(cfg.season)}` : '';
      const sceneQ = cfg.scene ? `&scene=${encodeURIComponent(cfg.scene)}` : '';
      const shotQ = cfg.shot ? `&shot=${encodeURIComponent(cfg.shot)}` : '';
      const r = await fetch(`${base}/preview-data/${encodeURIComponent(cfg.mapId)}?phase=${encodeURIComponent(cfg.phase)}${seasonQ}${sceneQ}${shotQ}`);
      const hello = await r.json();
      // The client's real handlers: hello places us + the map,
      // snapshot registers the sample companions' render positions.
      window.handle(hello);
      window.handle({ type: 'snapshot', players: hello.players });
      // v1.5: synthetic table states for the mid-hand playtest
      // shots (poker board on the felt, blackjack hands down) —
      // fed through the same real handlers, after hello, so the
      // felt renders a frozen live hand.
      if (Array.isArray(hello.tableFx)) for (const m of hello.tableFx) window.handle(m);
      // v1.6: synthetic stage states (the club-perform shot's live
      // set) — same treatment, through the real handlers.
      if (Array.isArray(hello.fx)) for (const m of hello.fx) window.handle(m);
      // Playtest Gate: expose the posed-actor manifest (shot id,
      // camera anchor, per-actor seat/stand data) for the capture
      // driver to record alongside the screenshot.
      if (hello.playtest) window.__PREVIEW_MANIFEST__ = hello.playtest;
      if (cfg.scene === 'mixer') await openMixerScene(base);
      document.title = `preview:${cfg.mapId}:${cfg.phase}`;
      window.__PREVIEW_READY__ = true;
    } catch (e) {
      document.title = `preview-error:${e && e.message}`;
      window.__PREVIEW_ERROR__ = String(e && e.message || e);
    }
  }

  if (document.readyState === 'complete') boot();
  else addEventListener('load', boot);
})();

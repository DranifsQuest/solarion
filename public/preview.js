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

  async function boot() {
    try {
      const base = cfg.apiBase || '';
      const r = await fetch(`${base}/preview-data/${encodeURIComponent(cfg.mapId)}?phase=${encodeURIComponent(cfg.phase)}`);
      const hello = await r.json();
      // The client's real handlers: hello places us + the map,
      // snapshot registers the sample companions' render positions.
      window.handle(hello);
      window.handle({ type: 'snapshot', players: hello.players });
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

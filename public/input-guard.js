'use strict';

/**
 * Solarion — keyboard focus guard (Phase B fix, from live playtest
 * feedback: W/A/S/D could not be typed into the login username /
 * password fields because the client's global movement-key handler
 * preventDefaulted every keydown regardless of focus).
 *
 * Rule: global game key handlers (movement, interact) must IGNORE
 * any key event whose target is a text-entry element — and never
 * preventDefault it — so typing works everywhere: login, register,
 * the character-creation display-name field, the chat box, the poker
 * raise amount, the studio visit field, the mix-name field, and any
 * <select> (whose arrow keys / type-ahead belong to the control).
 *
 * Loaded as a plain script before client.js in the browser; also
 * require()-able from the Node test suite (same file, both worlds).
 *
 * This module also owns the movement key mapping
 * (screenToWorldKeys, below) — the second playtest fix that lives
 * here so the suite can pin it without a browser.
 */
(function (global) {
  var TEXT_INPUT_TYPES = {
    text: true, password: true, search: true, email: true,
    number: true, tel: true, url: true, '': true, // '' = missing type attr (defaults to text)
  };

  function isTextEntryTarget(t) {
    if (!t || typeof t !== 'object') return false;
    if (t.isContentEditable) return true;
    var tag = String(t.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      var type = String(t.type || '').toLowerCase();
      return Object.prototype.hasOwnProperty.call(TEXT_INPUT_TYPES, type);
    }
    return false;
  }

  /**
   * Screen-cardinal movement mapping (live-playtest fix: pressing
   * "up" walked the avatar up a world diagonal — on screen it slid
   * up-RIGHT, because the server walks world axes and the client
   * renders them through the 2:1 iso projection
   *   proj(x, y) = [(x - y), (x + y) * 0.5]  (times ZOOM).
   *
   * The player thinks in SCREEN directions; the server walks WORLD
   * axes. This converts the pressed screen keys to the world-axis
   * key set that PRODUCES that screen direction:
   *
   *   screen intent   world velocity   keys sent
   *   up    (N)       (-1,-1)          up+left
   *   right (E)       (+1,-1)          up+right
   *   down  (S)       (+1,+1)          down+right
   *   left  (W)       (-1,+1)          down+left
   *   N+E             ( 0,-1)          up     (along a tile edge)
   *   N+W             (-1, 0)          left
   *   S+E             (+1, 0)          right
   *   S+W             ( 0,+1)          down
   *
   * Algebra: with screen intent (sx, sy) in screen space (y down),
   * inverting proj gives world intent (wx, wy) = (sx + sy, sy - sx)
   * up to scale; the sent keys are the signs of (wx, wy). Opposing
   * keys cancel; the server normalizes diagonals, so speed is
   * uniform in every direction.
   */
  function screenToWorldKeys(screen) {
    var sx = (screen && screen.right ? 1 : 0) - (screen && screen.left ? 1 : 0);
    var sy = (screen && screen.down ? 1 : 0) - (screen && screen.up ? 1 : 0);
    var wx = sx + sy;
    var wy = sy - sx;
    return { up: wy < 0, down: wy > 0, left: wx < 0, right: wx > 0 };
  }

  global.SolarionInput = { isTextEntryTarget: isTextEntryTarget, screenToWorldKeys: screenToWorldKeys };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { isTextEntryTarget: isTextEntryTarget, screenToWorldKeys: screenToWorldKeys };
  }
})(typeof window !== 'undefined' ? window : globalThis);

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

  global.SolarionInput = { isTextEntryTarget: isTextEntryTarget };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { isTextEntryTarget: isTextEntryTarget };
  }
})(typeof window !== 'undefined' ? window : globalThis);

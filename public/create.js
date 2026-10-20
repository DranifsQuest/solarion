'use strict';

/**
 * Solarion — character creation screen (Phase 6).
 *
 * Shown after login whenever the account has no created character
 * yet (avatar.created === false). The soul of it (docs/coke-soul.md
 * §4): this is the V-ego ritual — you are becoming someone, not
 * filling in a form. Big live preview, instant updates on every pick,
 * rotate + walk preview, randomize for the indecisive, and a name
 * that is YOUR name in the world.
 *
 * On submit: POST /api/create-character (server validates name +
 * every axis against src/appearance.js), then onDone() drops the
 * player into The Gateway.
 */

const Create = {
  _shown: false,
  _anim: null,
  _state: null,

  async show(avatar, onDone) {
    const $ = (id) => document.getElementById(id);
    $('auth').classList.add('hidden');
    $('game').classList.add('hidden');
    const screen = $('create');
    screen.classList.remove('hidden');
    $('createErr').textContent = '';
    if (this._shown) return; // already up (e.g. double route-in)
    this._shown = true;

    let options;
    try {
      options = await window.SolarionLooks.loadOptions();
    } catch (e) {
      $('createErr').textContent = 'Could not load the creation studio — check your connection and refresh.';
      return;
    }

    // Start from the account's current values (v1-migrated accounts
    // never see this screen; fresh accounts start from defaults).
    const g = avatar && avatar.gender === 'F' ? 'F' : 'M';
    const state = { ...options.defaults[g] };
    if (avatar) {
      for (const k of Object.keys(state)) {
        if (avatar[k] !== undefined) state[k] = avatar[k];
      }
    }
    this._state = state;
    $('createName').value = avatar && avatar.name ? avatar.name : '';

    const canvas = $('createPreview');
    if (this._anim) this._anim.stop();
    // animatePreview reads opts.walk live each frame, so the Walk
    // toggle below just mutates this object.
    this._animOpts = { rotate: false, walk: false, scale: 3.6 };
    this._anim = window.SolarionLooks.animatePreview(
      canvas, () => this._state, this._animOpts);

    window.SolarionLooks.createEditor($('createEditor'), options, state, () => {});

    $('createTurnL').onclick = () => this._anim.turn(-1);
    $('createTurnR').onclick = () => this._anim.turn(1);
    $('createWalk').onclick = () => {
      this._animOpts.walk = !this._animOpts.walk;
      $('createWalk').classList.toggle('sel', this._animOpts.walk);
      $('createWalk').textContent = this._animOpts.walk ? '🚶 Walking…' : '🚶 Walk';
    };
    $('createRandom').onclick = () => {
      window.SolarionLooks.randomize(options, state, Math.random);
      // rebuild chips/swatches to match the new state
      window.SolarionLooks.createEditor($('createEditor'), options, state, () => {});
    };
    $('createGo').onclick = async () => {
      $('createErr').textContent = '';
      const name = $('createName').value.trim();
      if (!name) { $('createErr').textContent = 'Give your character a name first.'; return; }
      const tok = localStorage.getItem('solarion_token');
      try {
        const r = await fetch('/api/create-character', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: tok, name, ...state }),
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || 'Creation failed');
        if (this._anim) this._anim.stop();
        screen.classList.add('hidden');
        this._shown = false;
        onDone(j.avatar);
      } catch (e) {
        $('createErr').textContent = e.message;
      }
    };
  },
};

window.SolarionCreate = Create;

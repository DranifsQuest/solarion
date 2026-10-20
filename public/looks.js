'use strict';

/**
 * Solarion — shared look editor (Phase 6).
 *
 * Builds the axis pickers + live preview used by BOTH the character
 * creation screen (create.js) and the in-game Look panel (studio.js).
 * The option lists come from GET /api/appearance, which is generated
 * from src/appearance.js — the same module the server validates
 * against. One list, three consumers, zero drift.
 *
 * Editor model: the caller owns a plain `state` look object (canonical
 * axis names). The editor mutates it and calls onChange(state) after
 * every pick. Switching gender re-normalizes per-gender axes exactly
 * like the server's mergeLook: anything invalid for the new gender
 * falls back to that gender's default.
 */

const Looks = {
  _options: null,

  async loadOptions() {
    if (this._options) return this._options;
    const r = await fetch('/api/appearance');
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'Could not load appearance options');
    this._options = j;
    return j;
  },

  pretty(id) {
    return String(id).replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  },

  /** Mirror of server normalization for a gender switch. */
  normalize(options, state, gender) {
    const d = options.defaults[gender];
    const perGender = [
      ['face', options.faces[gender]], ['eyes', options.eyes[gender]],
      ['nose', options.noses[gender]], ['lips', options.lips[gender]],
      ['hair_style', options.hairStyles[gender]], ['bottom_style', options.bottomStyles[gender]],
    ];
    for (const [axis, list] of perGender) {
      if (!list.includes(state[axis])) state[axis] = d[axis];
    }
    state.gender = gender;
    return state;
  },

  randomize(options, state, rand) {
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const g = state.gender === 'F' ? 'F' : 'M';
    state.face = pick(options.faces[g]);
    state.eyes = pick(options.eyes[g]);
    state.eye_color = pick(options.eyeColors);
    state.nose = pick(options.noses[g]);
    state.lips = pick(options.lips[g]);
    state.skin_tone = pick(options.skinTones);
    state.hair_style = pick(options.hairStyles[g]);
    state.hair_color = pick(options.hairColors);
    state.top_style = pick(options.topStyles);
    state.body_color = pick(options.clothColors);
    state.bottom_style = pick(options.bottomStyles[g]);
    state.accent_color = pick(options.clothColors);
    state.shoe_color = pick(options.shoeColors);
    state.accessory = pick(options.accessories);
    return state;
  },

  /**
   * Build the picker UI into `container`. Returns { refresh() } —
   * call refresh after external state changes (e.g. Randomize).
   */
  createEditor(container, options, state, onChange) {
    const groups = [
      { title: 'Body', axes: [
        { axis: 'skin_tone', label: 'Skin tone', kind: 'swatch', list: () => options.skinTones },
      ] },
      { title: 'Face', axes: [
        { axis: 'face', label: 'Face shape', kind: 'chip', list: (g) => options.faces[g] },
        { axis: 'eyes', label: 'Eyes', kind: 'chip', list: (g) => options.eyes[g] },
        { axis: 'eye_color', label: 'Eye color', kind: 'swatch', list: () => options.eyeColors },
        { axis: 'nose', label: 'Nose', kind: 'chip', list: (g) => options.noses[g] },
        { axis: 'lips', label: 'Lips', kind: 'chip', list: (g) => options.lips[g] },
      ] },
      { title: 'Hair', axes: [
        { axis: 'hair_style', label: 'Style', kind: 'chip', list: (g) => options.hairStyles[g] },
        { axis: 'hair_color', label: 'Color', kind: 'color', palette: () => options.hairColors },
      ] },
      { title: 'Outfit', axes: [
        { axis: 'top_style', label: 'Top', kind: 'chip', list: () => options.topStyles },
        { axis: 'body_color', label: 'Top color', kind: 'color', palette: () => options.clothColors },
        { axis: 'bottom_style', label: 'Bottoms', kind: 'chip', list: (g) => options.bottomStyles[g] },
        { axis: 'accent_color', label: 'Bottom color', kind: 'color', palette: () => options.clothColors },
        { axis: 'shoe_color', label: 'Shoes', kind: 'swatch', list: () => options.shoeColors },
        { axis: 'accessory', label: 'Accessory', kind: 'chip', list: () => options.accessories },
      ] },
    ];

    let genderRow = null;
    const axisRows = new Map(); // axis -> { def, rowEl }

    function build() {
      container.innerHTML = '';
      // gender toggle
      const gWrap = document.createElement('div');
      gWrap.className = 'lookGroup';
      const gh = document.createElement('div');
      gh.className = 'lookGroupTitle';
      gh.textContent = 'Who are you?';
      gWrap.appendChild(gh);
      genderRow = document.createElement('div');
      genderRow.className = 'genderRow';
      for (const g of options.genders) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'genderBtn' + (state.gender === g ? ' sel' : '');
        b.textContent = g === 'M' ? '♂ Male' : '♀ Female';
        b.onclick = () => {
          if (state.gender === g) return;
          Looks.normalize(options, state, g);
          build();
          onChange(state);
        };
        genderRow.appendChild(b);
      }
      gWrap.appendChild(genderRow);
      container.appendChild(gWrap);

      for (const group of groups) {
        const wrap = document.createElement('div');
        wrap.className = 'lookGroup';
        const h = document.createElement('div');
        h.className = 'lookGroupTitle';
        h.textContent = group.title;
        wrap.appendChild(h);
        for (const def of group.axes) {
          const row = document.createElement('div');
          row.className = 'lookRow';
          const lab = document.createElement('span');
          lab.className = 'lookLabel';
          lab.textContent = def.label;
          row.appendChild(lab);
          const opts = document.createElement('span');
          opts.className = 'lookOpts';
          row.appendChild(opts);
          axisRows.set(def.axis, { def, optsEl: opts });
          wrap.appendChild(row);
        }
        container.appendChild(wrap);
      }
      refreshSelections();
    }

    function refreshSelections() {
      if (genderRow) {
        [...genderRow.children].forEach((b, i) => {
          b.classList.toggle('sel', state.gender === options.genders[i]);
        });
      }
      for (const [axis, { def, optsEl }] of axisRows) {
        optsEl.innerHTML = '';
        const g = state.gender === 'F' ? 'F' : 'M';
        if (def.kind === 'chip') {
          for (const v of def.list(g)) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'chip' + (state[axis] === v ? ' sel' : '');
            b.textContent = Looks.pretty(v);
            b.onclick = () => { state[axis] = v; refreshSelections(); onChange(state); };
            optsEl.appendChild(b);
          }
        } else if (def.kind === 'swatch') {
          for (const v of def.list(g)) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'sw' + (state[axis] === v ? ' sel' : '');
            b.style.background = v;
            b.title = v;
            b.onclick = () => { state[axis] = v; refreshSelections(); onChange(state); };
            optsEl.appendChild(b);
          }
        } else if (def.kind === 'color') {
          for (const v of def.palette()) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'sw' + (state[axis] === v ? ' sel' : '');
            b.style.background = v;
            b.title = v;
            b.onclick = () => { state[axis] = v; refreshSelections(); onChange(state); };
            optsEl.appendChild(b);
          }
          const custom = document.createElement('input');
          custom.type = 'color';
          custom.className = 'customColor';
          custom.value = /^#[0-9a-fA-F]{6}$/.test(state[axis] || '') ? state[axis] : '#888888';
          custom.title = 'Custom color';
          custom.addEventListener('input', () => {
            state[axis] = custom.value;
            for (const el of optsEl.querySelectorAll('.sw')) el.classList.remove('sel');
            onChange(state);
          });
          optsEl.appendChild(custom);
        }
      }
    }

    build();
    return { refresh: refreshSelections, rebuild: build };
  },

  /** Draw one sprite (state + dir) centered on a canvas at `scale`. */
  drawPreview(canvas, state, dir, scale, flip) {
    const S = window.SolarionSprites;
    if (!S || !canvas) return;
    const spr = S.makeSprite(state, dir === 'down' || dir === 'up' ? dir : 'side');
    const w = Math.round(spr.width * scale), h = Math.round(spr.height * scale);
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.imageSmoothingEnabled = false;
    g.save();
    g.translate(canvas.width / 2, canvas.height - 6);
    if (flip) g.scale(-1, 1);
    g.drawImage(spr, -w / 2, -h, w, h);
    g.restore();
  },

  /**
   * Animated preview: gentle idle bob, a walk cycle while `walk` is
   * on, and manual/auto facing rotation. Returns { stop, setDir }.
   */
  animatePreview(canvas, getState, opts) {
    opts = opts || {};
    const dirs = ['down', 'left', 'up', 'right'];
    let dirIdx = 0;
    let raf = 0;
    let lastFlip = performance.now();
    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      if (opts.rotate && now - lastFlip > 1500) { dirIdx = (dirIdx + 1) % 4; lastFlip = now; }
      const dir = dirs[dirIdx];
      const state = getState();
      const S = window.SolarionSprites;
      if (!S) return;
      const spr = S.makeSprite(state, dir === 'down' || dir === 'up' ? dir : 'side');
      const scale = opts.scale || 3.4;
      const w = Math.round(spr.width * scale), h = Math.round(spr.height * scale);
      const g = canvas.getContext('2d');
      g.clearRect(0, 0, canvas.width, canvas.height);
      g.imageSmoothingEnabled = false;
      const bob = opts.walk ? Math.abs(Math.sin(now / 110)) * 5 : Math.sin(now / 600) * 1.5;
      g.save();
      g.translate(canvas.width / 2, canvas.height - 8 - bob);
      if (dir === 'right') g.scale(-1, 1);
      // soft ground shadow
      g.fillStyle = 'rgba(0,0,0,.35)';
      g.beginPath();
      g.ellipse(0, -2 + bob * 0.4, w * 0.32, 6, 0, 0, Math.PI * 2);
      g.fill();
      g.drawImage(spr, -w / 2, -h, w, h);
      g.restore();
    };
    raf = requestAnimationFrame(frame);
    return {
      stop() { cancelAnimationFrame(raf); },
      turn(step) { dirIdx = (dirIdx + step + 4) % 4; lastFlip = performance.now(); },
      get dir() { return dirs[dirIdx]; },
    };
  },
};

window.SolarionLooks = Looks;

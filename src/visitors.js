'use strict';

/**
 * Solarion — the Visitors (v1.9, X's spec 2026-10-23).
 *
 * Two strangers who do not belong to the painted world:
 *
 *  - ORENIUS stands by the Gateway fountain. He appears every day
 *    at 8:00 PM America/Chicago for three minutes (and whenever
 *    the owner summons him). Talk to him and he offers two fruits.
 *    The BLUE fruit ends the conversation. The RED fruit takes you
 *    to the Threshold: a small room where you wake SEATED in a
 *    chair while a four-person crew spends two minutes building
 *    a portal out of the world. When it opens you walk through —
 *    to Elsewhere, a blank world with no doors back.
 *
 *  - AGENT SIMS minds the far side. He appears in Elsewhere on
 *    his own daily window, 8:05–8:08 PM (X's call 2026-10-25:
 *    offset from Orenius so a red-fruit eater always lands while
 *    Sims is still there), and on the owner's summon. Talk to
 *    him and he demands an access code, typed into a box. The
 *    right code (571) sends you back to the Gateway. Nothing else
 *    does: the Navigator hides both places and the travel layer
 *    refuses to cross (src/social.js), so the code is the only
 *    way home.
 *
 * Both visitors are fixtures, not players — streamed to their map
 * like the club's dancers (visitor-state), drawn from a fixed
 * anchor the map def declares (`visitor`). The summon buttons are
 * the owner's alone: the account name must be exactly Zantheon
 * (the top-up owners list does NOT apply here — X said him only).
 *
 * The Threshold scene is data: BEATS fire on a timeline scaled by
 * SCENE_MS (two minutes live — X cut it from four on 2026-10-24; compressed under SOLARION_TEST so
 * the gate can watch a whole escape in seconds). Actors are
 * streamed like the visitors (scene-state) and their lines ride
 * scene-line captions. A late arrival joins the running show from
 * wherever it has got to; walking through the open portal is the
 * only exit the room has.
 */

const { MAPS } = require('./maps');

const TICK_MS = 100;
// Per-visitor daily windows, minutes after midnight America/Chicago.
// Orenius 8:00–8:03 PM; Sims 8:05–8:08 PM (X's call 2026-10-25 — the
// offset means a red-fruit eater, scene (2:00) + vignette (15s)
// included, always lands in Elsewhere while Sims is present).
const VISITOR_WINDOWS = {
  orenius: { startMin: 20 * 60, lenMin: 3 },
  sims: { startMin: 20 * 60 + 5, lenMin: 3 },
};
const VISIT_OVERRIDE_MS = Number(process.env.SOLARION_VISIT_MS) > 0
  ? Number(process.env.SOLARION_VISIT_MS) : 0;
const VISIT_LEN_MS = VISIT_OVERRIDE_MS || 3 * 60 * 1000; // a three-minute summoned visit
const RETURN_CODE = '571';
const SUMMONER = 'zantheon';                // X, and only X
const TALK_RANGE = 110;                     // px — close enough to speak
const SCENE_MS = process.env.SOLARION_TEST ? 8000 : 2 * 60 * 1000;
const PORTAL_RANGE = 46;                    // px — step in to leave

const ORENIUS_LOOK = {
  gender: 'M', face: 'classic', eyes: 'round', eye_color: '#20242c', nose: 'button', lips: 'smirk',
  skin_tone: '#5c3a21', hair_style: 'bald', hair_color: '#111111', top_style: 'jacket',
  body_color: '#101014', bottom_style: 'pants', accent_color: '#05050a', shoe_color: '#0a0a0c',
  accessory: 'sunglasses',
};
const SIMS_LOOK = {
  gender: 'M', face: 'classic', eyes: 'round', eye_color: '#20242c', nose: 'button', lips: 'smirk',
  skin_tone: '#ffe0bd', hair_style: 'swept', hair_color: '#191410', top_style: 'button-up',
  body_color: '#17181c', bottom_style: 'pants', accent_color: '#0c0c10', shoe_color: '#0a0a0c',
  accessory: 'sunglasses',
};

const VISITORS = {
  orenius: { id: 'orenius', mapId: 'the-gateway', name: 'Orenius', look: ORENIUS_LOOK, mode: 'fruit' },
  sims: { id: 'sims', mapId: 'elsewhere', name: 'Agent Sims', look: SIMS_LOOK, mode: 'code' },
};

// v1.9.2: the Elsewhere arrival vignette (X's staging). Fifteen
// seconds, personal to the arrival: Orenius and Trine are simply
// THERE when you land; the bald man delivers his line; your body
// revolts; you sleep; you wake alone. The figures are a vision —
// streamed only to the arriving player; the vomit and the sleep
// are bodily facts, broadcast to the room.
const TRINE_LOOK = {
  gender: 'F', face: 'classic', eyes: 'round', eye_color: '#20242c', nose: 'button', lips: 'smirk',
  skin_tone: '#e8b98f', hair_style: 'bob', hair_color: '#070708', top_style: 'jacket',
  body_color: '#0b0b10', bottom_style: 'pants', accent_color: '#05050a', shoe_color: '#0a0a0c',
  accessory: 'sunglasses',
};
const VIGNETTE_MS = process.env.SOLARION_TEST ? 3000 : 15 * 1000;
const VIGNETTE_ACTORS = [
  { id: 'orenius', name: 'Orenius', x: 432, y: 288, dir: 'down', look: ORENIUS_LOOK },
  { id: 'trine', name: 'Trine', x: 384, y: 320, dir: 'right', look: TRINE_LOOK },
];
const VIGNETTE_STEPS = [
  { at: 0.17, kind: 'line' },   // ~2.5s live: "He's going to pop."
  { at: 0.30, kind: 'vomit' },  // ~4.5s
  { at: 0.53, kind: 'sleep' },  // ~8s — fallen until the wake step
  { at: 0.80, kind: 'gone' },   // ~12s — the vision empties
  { at: 1.00, kind: 'wake' },   // 15s — free, and alone
];

const DIALOGUE = {
  orenius: [
    'You feel it, do you not. The wrongness at the edges of this place.',
    'Everything here is painted. The sky. The sea. The very coins in your pocket. Paint — over a door.',
    'In my hands, two fruits from the same tree. The blue returns you to the painting. Sweet. Safe. Final.',
    'The red is bitter, and it does not bring you back. My people will build you a door out of this world. Where it leads, I will not say. No one who has eaten has ever returned to tell.',
  ],
  sims: [
    'Well. A refugee from the painting.',
    'I am Sims. I mind the door on this side, and I am very good at my job.',
    'We have an agreement then, you give me the code and I put you back.',
    "Speak the code to the mainframe here and I'll put you back.",
  ],
};

// ------------------------------------------------------------ the crew

const CREW = [
  {
    id: 'operator', name: 'The Operator', tx: 4, ty: 3,
    look: {
      gender: 'M', face: 'classic', eyes: 'round', eye_color: '#20242c', nose: 'button', lips: 'smirk',
      skin_tone: '#8d5524', hair_style: 'buzz', hair_color: '#111111', top_style: 'tee',
      body_color: '#2c3436', bottom_style: 'cargo', accent_color: '#1d2124', shoe_color: '#23262b',
      accessory: 'none',
    },
  },
  {
    id: 'cartographer', name: 'The Cartographer', tx: 13, ty: 3,
    look: {
      gender: 'F', face: 'classic', eyes: 'round', eye_color: '#2e5e1e', nose: 'button', lips: 'natural',
      skin_tone: '#f1c27d', hair_style: 'long', hair_color: '#6b4423', top_style: 'sweater',
      body_color: '#37474f', bottom_style: 'pants', accent_color: '#222d33', shoe_color: '#23262b',
      accessory: 'headband',
    },
  },
  {
    id: 'wright', name: 'The Wright', tx: 15, ty: 3,
    look: {
      gender: 'M', face: 'classic', eyes: 'round', eye_color: '#20242c', nose: 'button', lips: 'smirk',
      skin_tone: '#ffcd94', hair_style: 'short', hair_color: '#3a2a1c', top_style: 'jacket',
      body_color: '#3a3f44', bottom_style: 'jeans', accent_color: '#26262b', shoe_color: '#23262b',
      accessory: 'cap',
    },
  },
  {
    id: 'keeper', name: 'The Keeper', tx: 9, ty: 5,
    look: {
      gender: 'F', face: 'soft', eyes: 'round', eye_color: '#1e4d8f', nose: 'button', lips: 'rose',
      skin_tone: '#ffe0bd', hair_style: 'bun', hair_color: '#8a8f98', top_style: 'sweater',
      body_color: '#5d4037', bottom_style: 'pants', accent_color: '#3e2c24', shoe_color: '#23262b',
      accessory: 'glasses',
    },
  },
];

/** The show, as fractions of SCENE_MS. `move` walks a crew member
 *  to a tile; `line` captions the room; `portal` opens the door. */
const BEATS = [
  { at: 0.00, line: ['keeper', 'Sit still. The chair is kinder than it looks.'] },
  { at: 0.03, line: ['operator', 'Lattice is awake. I have the seam on my scope.'] },
  { at: 0.09, move: ['cartographer', 9, 3], line: ['cartographer', 'Charting the outside. There is more of it than anyone admits.'] },
  { at: 0.16, move: ['wright', 11, 2], line: ['wright', 'Frame is going up around the seam. Mind the hum.'] },
  { at: 0.24, line: ['operator', 'Coordinates refuse to sit still. Navigating by feel now.'] },
  { at: 0.32, line: ['cartographer', 'Found a current. It runs out. They all run out, if you read them right.'] },
  { at: 0.42, line: ['keeper', 'Whatever you were in there — painted. This is where the paint cracks.'] },
  { at: 0.50, move: ['operator', 6, 3], line: ['operator', 'Signal is arguing with me. I am winning.'] },
  { at: 0.58, line: ['wright', 'Aperture is threading. Sixty percent, and honest.'] },
  { at: 0.66, move: ['cartographer', 13, 3], line: ['cartographer', 'Course is locked. One door. One direction.'] },
  { at: 0.74, line: ['keeper', 'Almost. Breathe like you mean it.'] },
  { at: 0.82, line: ['wright', 'She is opening — hold her steady —'] },
  { at: 0.85, portal: true },
  { at: 0.88, line: ['keeper', "Door's open, friend. Walk through. Don't look back — there is nothing back there but paint."] },
];

const tilePx = (t) => t * 32 + 16;

/** Minutes since midnight in America/Chicago right now. */
function chicagoMinutes(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(now);
  let h = 0, m = 0;
  for (const part of parts) {
    if (part.type === 'hour') h = Number(part.value) % 24;
    if (part.type === 'minute') m = Number(part.value);
  }
  return h * 60 + m;
}

class VisitorSystem {
  constructor(game) {
    this.game = game;
    this.state = {};
    for (const id of Object.keys(VISITORS)) {
      this.state[id] = { present: false, summonedUntil: 0 };
    }
    this.scene = {
      phase: 'idle',           // idle | running | open
      startedAt: 0,
      fired: new Set(),
      participants: new Set(), // userIds with a seat in the show
      actors: CREW.map(a => ({ ...a, x: tilePx(a.tx), y: tilePx(a.ty), dir: 'down', tx2: null, ty2: null })),
    };
    this.timer = setInterval(() => this.tick(), TICK_MS);
    if (this.timer.unref) this.timer.unref();
  }

  // ---------------------------------------------------------- presence

  // The mins param exists for tests: production always passes the
  // live Chicago clock; tests pass an exact minute to prove the
  // per-visitor windows without waiting for 8 PM.
  scheduledNow(id, mins = chicagoMinutes()) {
    if (VISIT_OVERRIDE_MS) return false; // expiry-test override: no schedule
    const w = VISITOR_WINDOWS[id];
    if (!w) return false;
    return mins >= w.startMin && mins < w.startMin + w.lenMin;
  }

  isPresent(id) {
    const st = this.state[id];
    return this.scheduledNow(id) || Date.now() < st.summonedUntil;
  }

  refreshPresence(id) {
    const st = this.state[id];
    const present = this.isPresent(id);
    st.present = present;
    this.streamVisitor(id);
    if (!present) this.endTalksFor(id);
    return present;
  }

  streamVisitor(id, onlyPlayer = null) {
    const v = VISITORS[id];
    const anchor = (MAPS[v.mapId] || {}).visitor || {};
    const msg = {
      type: 'visitor-state', id, present: this.isPresent(id),
      name: v.name, x: anchor.x || 0, y: anchor.y || 0, dir: anchor.dir || 'down',
      look: v.look,
    };
    if (onlyPlayer) this.game.send(onlyPlayer, msg);
    else this.game.broadcastToMap(v.mapId, msg);
  }

  /** game.onMapEntered: a fresh arrival gets the visitor's current
   *  state — and, in the Threshold, joins the show. */
  syncPlayer(p) {
    for (const v of Object.values(VISITORS)) {
      if (v.mapId === p.mapId) this.streamVisitor(v.id, p);
    }
    if (p.mapId === 'the-threshold') this.enterThreshold(p);
    if (p.mapId === 'elsewhere') this.startVignette(p);
  }

  // ------------------------------------------------- the vignette

  startVignette(p) {
    if (p.vignette) return;
    p.vignette = { startedAt: Date.now(), fired: new Set() };
    p.captive = true; // the body is not yours for these fifteen seconds
    this.game.send(p, { type: 'vignette-state', actors: VIGNETTE_ACTORS });
  }

  vignetteTick(now) {
    for (const p of this.game.players.values()) {
      const vg = p.vignette;
      if (!vg || p.mapId !== 'elsewhere') continue;
      const elapsed = now - vg.startedAt;
      for (let i = 0; i < VIGNETTE_STEPS.length; i++) {
        const step = VIGNETTE_STEPS[i];
        if (vg.fired.has(i) || step.at * VIGNETTE_MS > elapsed) continue;
        vg.fired.add(i);
        if (step.kind === 'line') {
          this.game.broadcastToMap('elsewhere', {
            type: 'scene-line', name: 'Orenius', text: "He's going to pop.",
          });
        } else if (step.kind === 'vomit' || step.kind === 'sleep' || step.kind === 'wake') {
          if (step.kind === 'sleep') p.vignetteFallenUntil = vg.startedAt + VIGNETTE_MS;
          this.game.broadcastToMap('elsewhere', { type: 'vignette-step', step: step.kind, userId: p.userId });
        } else if (step.kind === 'gone') {
          this.game.send(p, { type: 'vignette-state', actors: [] });
        }
        if (step.kind === 'wake') { p.captive = false; p.vignette = null; }
      }
    }
  }

  endTalksFor(id) {
    const v = VISITORS[id];
    for (const p of this.game.players.values()) {
      if (p.mapId === v.mapId && p.visitorTalk && p.visitorTalk.id === id) {
        p.visitorTalk = null;
        this.game.send(p, {
          type: 'visitor-dialogue-end', id,
          text: 'Gone — mid-sentence, as if he was never here.',
        });
      }
    }
  }

  // ---------------------------------------------------------- dialogue

  nearVisitor(p, id) {
    const v = VISITORS[id];
    if (!v || p.mapId !== v.mapId || !this.isPresent(id)) return false;
    const anchor = (MAPS[v.mapId] || {}).visitor || {};
    return Math.hypot(p.x - (anchor.x || 0), p.y - (anchor.y || 0)) <= TALK_RANGE;
  }

  talk(p, id) {
    const v = VISITORS[id];
    if (!v) return;
    if (!this.isPresent(id) || p.mapId !== v.mapId) return;
    if (!this.nearVisitor(p, id)) {
      this.game.send(p, { type: 'notice', text: `Step closer to ${v.name}.` });
      return;
    }
    p.visitorTalk = { id, at: Date.now() };
    this.game.send(p, {
      type: 'visitor-dialogue', id, name: v.name, mode: v.mode,
      lines: DIALOGUE[id].map(text => ({ name: v.name, text })),
    });
  }

  liveTalk(p, id) {
    return p.visitorTalk && p.visitorTalk.id === id && this.nearVisitor(p, id);
  }

  // v1.9.1: the E key (and the mobile interact buttons) route here
  // first — standing near a present visitor, E talks instead of
  // sitting/fishing. A seated player keeps E = stand up.
  interact(p) {
    if (p.seated || p.captive) return false;
    for (const id of Object.keys(VISITORS)) {
      if (this.nearVisitor(p, id)) { this.talk(p, id); return true; }
    }
    return false;
  }

  choice(p, choice) {
    if (!this.liveTalk(p, 'orenius')) return;
    if (choice === 'blue') {
      p.visitorTalk = null;
      this.game.send(p, {
        type: 'visitor-dialogue-end', id: 'orenius',
        text: 'Then sleep, dreamer. The painting is grateful.',
      });
      return;
    }
    if (choice !== 'red') return;
    p.visitorTalk = null;
    this.game.send(p, {
      type: 'visitor-dialogue-end', id: 'orenius',
      text: 'Then hold still. This will feel... strange.',
    });
    // switchScene fires onMapEntered -> syncPlayer -> the room
    // takes the visitor in (seat, lock, show).
    this.game.switchScene(p, MAPS['the-threshold']);
  }

  code(p, raw) {
    if (!this.liveTalk(p, 'sims')) return;
    const code = String(raw == null ? '' : raw).trim();
    if (code === RETURN_CODE) {
      p.visitorTalk = null;
      this.game.send(p, {
        type: 'visitor-dialogue-end', id: 'sims',
        text: '...Correct. Annoying. Through you go, then — and do try to stay painted this time.',
      });
      this.game.switchScene(p, MAPS['the-gateway']);
    } else {
      this.game.send(p, {
        type: 'visitor-dialogue-line', id: 'sims', name: 'Agent Sims',
        text: 'No. The door does not know that sound. Try again — or stay. Staying is also a choice.',
      });
    }
  }

  summon(p, id) {
    const v = VISITORS[id];
    if (!v) return;
    if (String(p.name || '').toLowerCase() !== SUMMONER) {
      this.game.send(p, { type: 'notice', text: 'Nothing happens.' });
      return;
    }
    this.state[id].summonedUntil = Date.now() + VISIT_LEN_MS;
    this.refreshPresence(id);
    this.game.send(p, {
      type: 'notice',
      text: `${v.name} has been called to ${MAPS[v.mapId].name}. Three minutes.`,
    });
  }

  // ---------------------------------------------------------- the Threshold

  enterThreshold(p) {
    const sc = this.scene;
    sc.participants.add(p.userId);
    if (sc.phase === 'idle') this.startScene();
    if (sc.phase === 'running') this.seatCaptive(p);
    this.streamScene(p);
  }

  startScene() {
    const sc = this.scene;
    sc.phase = 'running';
    sc.startedAt = Date.now();
    sc.fired = new Set();
    sc.actors = CREW.map(a => ({ ...a, x: tilePx(a.tx), y: tilePx(a.ty), dir: 'down', tx2: null, ty2: null }));
    this.streamScene();
  }

  seatCaptive(p) {
    const seat = (MAPS['the-threshold'].seats || [])[0];
    if (seat) {
      p.x = seat.x; p.y = seat.y;
      p.seated = seat;
    }
    p.captive = true;
    p.path = null;
    p.keys = {};
  }

  /** Live player records in a map (game.playersInMap returns
   *  public snapshots — mutating those would free nobody). */
  liveIn(mapId) {
    return [...this.game.players.values()].filter(p => p.mapId === mapId);
  }

  openPortal() {
    const sc = this.scene;
    sc.phase = 'open';
    for (const p of this.liveIn('the-threshold')) {
      p.captive = false;
      if (p.seated) p.seated = null;
    }
    this.streamScene();
  }

  resetScene() {
    const sc = this.scene;
    sc.phase = 'idle';
    sc.participants.clear();
    sc.fired = new Set();
    sc.actors = CREW.map(a => ({ ...a, x: tilePx(a.tx), y: tilePx(a.ty), dir: 'down', tx2: null, ty2: null }));
  }

  streamScene(onlyPlayer = null) {
    const sc = this.scene;
    const msg = {
      type: 'scene-state',
      phase: sc.phase,
      portalOpen: sc.phase === 'open',
      actors: sc.actors.map(a => ({
        id: a.id, name: a.name, x: Math.round(a.x), y: Math.round(a.y), dir: a.dir, look: a.look,
      })),
    };
    if (onlyPlayer) this.game.send(onlyPlayer, msg);
    else this.game.broadcastToMap('the-threshold', msg);
  }

  sceneTick(now) {
    const sc = this.scene;
    if (sc.phase === 'idle') return;
    const map = MAPS['the-threshold'];
    // Beats fire on the timeline whether the portal has opened or
    // not (the keeper's last line lands after the door does).
    const elapsed = now - sc.startedAt;
    let streamed = false;
    BEATS.forEach((beat, i) => {
      if (sc.fired.has(i) || beat.at * SCENE_MS > elapsed) return;
      sc.fired.add(i);
      if (beat.move) {
        const actor = sc.actors.find(a => a.id === beat.move[0]);
        if (actor) { actor.tx2 = tilePx(beat.move[1]); actor.ty2 = tilePx(beat.move[2]); }
      }
      if (beat.line) {
        const actor = sc.actors.find(a => a.id === beat.line[0]);
        this.game.broadcastToMap('the-threshold', {
          type: 'scene-line', name: actor ? actor.name : '', text: beat.line[1],
        });
      }
      if (beat.portal && sc.phase === 'running') this.openPortal();
    });
    // The crew walks its marks (open floor, straight lines).
    const step = 95 * (TICK_MS / 1000);
    for (const a of sc.actors) {
      if (a.tx2 == null) continue;
      const dx = a.tx2 - a.x, dy = a.ty2 - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= step) { a.x = a.tx2; a.y = a.ty2; a.tx2 = null; a.ty2 = null; }
      else { a.x += (dx / dist) * step; a.y += (dy / dist) * step; }
      a.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
      streamed = true;
    }
    if (streamed || sc.phase !== 'idle') this.streamScene();
    // Through the portal: the room's only exit.
    if (sc.phase === 'open' && map.portal) {
      for (const p of this.liveIn('the-threshold')) {
        if (Math.hypot(p.x - map.portal.x, p.y - map.portal.y) <= PORTAL_RANGE) {
          sc.participants.delete(p.userId);
          this.game.switchScene(p, MAPS['elsewhere']);
        }
      }
      // The show resets once the room is empty of guests.
      if (this.liveIn('the-threshold').length === 0) this.resetScene();
    }
  }

  // ---------------------------------------------------------- tick

  tick() {
    for (const id of Object.keys(VISITORS)) {
      const st = this.state[id];
      const present = this.isPresent(id);
      if (present !== st.present) this.refreshPresence(id);
    }
    const now = Date.now();
    this.sceneTick(now);
    this.vignetteTick(now);
  }
}

module.exports = {
  VisitorSystem, VISITORS, DIALOGUE, BEATS, SCENE_MS,
  RETURN_CODE, VISITOR_WINDOWS, VISIT_LEN_MS, chicagoMinutes,
  VIGNETTE_MS, VIGNETTE_ACTORS,
};

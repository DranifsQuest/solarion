'use strict';

/**
 * Solarion — ambient NPCs (Phase 9, item 13).
 *
 * A couple of named locals per public scene who wander short
 * waypoint loops and occasionally say a flavor line. They are
 * SERVER-CHEAP by design: one 500ms timer for the whole world,
 * straight-line steps with the normal collision test, no pathing,
 * no per-frame work. NPCs are not players: they can't be chatted
 * with, voted on, or friended — they exist so the world never feels
 * empty at 3am. They ride the normal snapshot pipeline through
 * game.npcProvider, so clients render them with the same sprite
 * code as everyone else.
 */

const { TILE, collides } = require('./maps');

const TICK_MS = 500;
const SPEED = 55; // px/s — a stroll
const CHAT_MIN_MS = 50_000;
const CHAT_MAX_MS = 115_000;

const LOOKS = {
  guide: { gender: 'F', face: 'soft', eyes: 'bright', eye_color: '#1e4d8f', nose: 'button', lips: 'smile', skin_tone: '#f1c27d', hair_style: 'ponytail', hair_color: '#b5533c', top_style: 'blouse', body_color: '#e0a92e', bottom_style: 'skirt', accent_color: '#c25e1e', shoe_color: '#5b3a1e', accessory: 'none' },
  local: { gender: 'M', face: 'classic', eyes: 'round', eye_color: '#20242c', nose: 'button', lips: 'natural', skin_tone: '#8d5524', hair_style: 'short', hair_color: '#111111', top_style: 'tee', body_color: '#3aa7e0', bottom_style: 'pants', accent_color: '#2b3a55', shoe_color: '#23262b', accessory: 'cap' },
  artsy: { gender: 'F', face: 'sharp', eyes: 'lash', eye_color: '#20242c', nose: 'tiny', lips: 'bold', skin_tone: '#ffdbac', hair_style: 'bun', hair_color: '#7b4b94', top_style: 'tank', body_color: '#ff2e88', bottom_style: 'leggings', accent_color: '#23232e', shoe_color: '#ffd23f', accessory: 'sunglasses' },
  elder: { gender: 'M', face: 'round', eyes: 'calm', eye_color: '#3a2a1c', nose: 'wide', lips: 'natural', skin_tone: '#e0ac69', hair_style: 'bald', hair_color: '#cccccc', top_style: 'button-up', body_color: '#5b7a52', bottom_style: 'pants', accent_color: '#2b3a55', shoe_color: '#23262b', accessory: 'glasses' },
};

const LINES = {
  generic: [
    'Lovely day in Solarion, eh?',
    'Heard the stage at the Bay is heating up…',
    'Someone should check the Top 40 chart.',
    'I lost 20z at the slots and I\'d do it again.',
    'The bartender\'s first drink is free, you know. Every day.',
    'Burn a CD before you perform — trust me on this one.',
  ],
  'the-gateway': ['New around here? The arches take you anywhere.', 'Fountain plaza, best people-watching in the world.'],
  'solstice-bay': ['The water\'s fine. The stage is finer.', 'Mind the gulls. They\'ve unionized.'],
  'neon-district': ['Everything\'s brighter after dark here.', 'The Neon Casino\'s jackpot is SHAREDS with the Lounge. Wild.'],
  'cinder-mesa': ['Mind the hookah lounge. Time moves slower in there.', 'Forge keeps the whole mesa warm.'],
  frosthaven: ['Skates optional. Dignity also optional.', 'Hot cocoa. Stat.'],
  'verdant-hollow': ['The fireflies here answer to no one.', 'Best nap grass in Solarion.'],
  'gateway-cafe': ['Bea\'s coffee could raise the dead. Politely.', 'Try the corner booth.'],
  'hookah-lounge': ['One puff is plenty. Two is a lifestyle.', 'The cushions have heard everything.'],
};

const ROSTER = [
  { mapId: 'the-gateway', name: 'Maple the Guide', look: 'guide', route: [[20, 6], [48, 6], [36, 12]] },
  { mapId: 'the-gateway', name: 'Old Gus', look: 'elder', route: [[30, 26], [42, 26], [36, 32]] },
  { mapId: 'solstice-bay', name: 'Surfer Sal', look: 'local', route: [[12, 14], [58, 14], [36, 17]] },
  { mapId: 'solstice-bay', name: 'DJ Nova', look: 'artsy', route: [[38, 11], [34, 15], [30, 11]] },
  { mapId: 'neon-district', name: 'Pip', look: 'artsy', route: [[30, 28], [38, 22], [44, 28]] },
  { mapId: 'neon-district', name: 'The Nomad', look: 'elder', route: [[56, 32], [50, 36], [58, 38]] },
  { mapId: 'cinder-mesa', name: 'Forgehand Fran', look: 'local', route: [[24, 26], [30, 21], [34, 27]] },
  { mapId: 'cinder-mesa', name: 'Dust Devil Dan', look: 'guide', route: [[42, 24], [46, 19], [38, 20]] },
  { mapId: 'frosthaven', name: 'Ilsa', look: 'guide', route: [[18, 16], [28, 20], [22, 24]] },
  { mapId: 'frosthaven', name: 'Piotr', look: 'elder', route: [[44, 22], [38, 27], [46, 28]] },
  { mapId: 'verdant-hollow', name: 'Fern', look: 'artsy', route: [[32, 28], [40, 25], [36, 31]] },
  { mapId: 'verdant-hollow', name: 'Warden Wren', look: 'local', route: [[46, 28], [42, 32], [48, 33]] },
  { mapId: 'gateway-cafe', name: 'Barista Bea', look: 'guide', route: [[8, 6], [12, 8], [10, 10]] },
  { mapId: 'hookah-lounge', name: 'Sage', look: 'elder', route: [[9, 6], [13, 8], [10, 10]] },
];

const cx = (t) => t * TILE + TILE / 2;

class NpcSystem {
  constructor(game) {
    this.game = game;
    this.timer = null;
    this.npcs = ROSTER.map((r, i) => ({
      id: `npc:${r.mapId}:${i}`,
      name: r.name,
      mapId: r.mapId,
      look: LOOKS[r.look],
      route: r.route.map(([tx, ty]) => ({ x: cx(tx), y: cx(ty) })),
      wp: 0,
      x: cx(r.route[0][0]),
      y: cx(r.route[0][1]),
      dir: 'down',
      pauseUntil: Date.now() + 1500 + i * 700,
      nextChatAt: Date.now() + 20_000 + Math.random() * 60_000 + i * 4000,
      moving: false,
    }));
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    const now = Date.now();
    const step = (SPEED * TICK_MS) / 1000;
    for (const n of this.npcs) {
      const scene = this.game.sceneFor(n.mapId);
      if (!scene) continue;
      // Occasional flavor chat — only worth sending if someone's there.
      if (now >= n.nextChatAt) {
        n.nextChatAt = now + CHAT_MIN_MS + Math.random() * (CHAT_MAX_MS - CHAT_MIN_MS);
        if (this.game.mapCounts()[n.mapId] > 0) {
          const pool = [...(LINES[n.mapId] || []), ...LINES.generic];
          const text = pool[Math.floor(Math.random() * pool.length)];
          this.game.broadcastToMap(n.mapId, { type: 'chat', userId: n.id, name: n.name, text });
        }
      }
      if (now < n.pauseUntil) { n.moving = false; continue; }
      const target = n.route[(n.wp + 1) % n.route.length];
      const dx = target.x - n.x, dy = target.y - n.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= step) {
        n.x = target.x; n.y = target.y;
        n.wp = (n.wp + 1) % n.route.length;
        n.pauseUntil = now + 2000 + Math.random() * 4000;
        n.moving = false;
        continue;
      }
      const nx = n.x + (dx / dist) * step;
      const ny = n.y + (dy / dist) * step;
      if (!collides(scene, nx, ny, 12)) {
        n.x = nx; n.y = ny;
        n.moving = true;
        n.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
      } else {
        // Blocked (route drift / decor): skip to the next waypoint.
        n.wp = (n.wp + 1) % n.route.length;
        n.pauseUntil = now + 1500;
        n.moving = false;
      }
    }
  }

  /** Public snapshot-shaped entries for one scene. */
  forScene(sceneId) {
    return this.npcs.filter(n => n.mapId === sceneId).map(n => ({
      id: n.id,
      userId: n.id,
      name: n.name,
      x: Math.round(n.x),
      y: Math.round(n.y),
      dir: n.dir,
      moving: n.moving,
      npc: true,
      ...n.look,
      body_color: n.look.body_color,
      accent_color: n.look.accent_color,
      performing: false,
      emote: null,
      seated: null,
      drinks: 0,
      puffs: 0,
      fallen: false,
      hippy: false,
    }));
  }
}

module.exports = { NpcSystem, ROSTER };

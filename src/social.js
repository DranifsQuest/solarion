'use strict';

/**
 * Solarion — social systems (Phase 9): friends, the Navigator, and
 * profile cards.
 *
 * Friends: one row per relationship in `friends` — (requester →
 * target, 'pending') until accepted, then 'accepted'. Either side
 * can remove. Requests/accepts notify both players live and refresh
 * their friend payloads; the payload always carries online state +
 * current scene, which is what powers "where are my friends" in the
 * Navigator.
 *
 * Navigator: { type:'navigator' } answers with every public scene
 * (cities + interiors), live occupant counts with a 0–6 fullness
 * scale (soul doc §2 — the original showed 6 dots), which of the
 * requester's friends are in each place, and the open homes of
 * online owners. Travel ({ type:'navigate' } / 'navigate-home' /
 * 'join-friend') rides the standard scene switch — the fixed 3s
 * load screen included.
 *
 * Profiles: { type:'profile', userId } answers with a card payload:
 * display name, full look, their saved mix titles, online state +
 * where, friendship status, and whether their home is open.
 */

const { db, q } = require('./db');
const { MAPS, collides } = require('./maps');
const music = require('./music');

const SCENE_CAPACITY = 25; // soul doc §2: the original capped rooms at 25

let SQ = null;
function init() {
  if (SQ) return;
  db.exec(`
  CREATE TABLE IF NOT EXISTS friends (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, friend_id)
  );
  `);
  SQ = {
    row: db.prepare('SELECT * FROM friends WHERE user_id = ? AND friend_id = ?'),
    insert: db.prepare("INSERT INTO friends (user_id, friend_id, status, created_at) VALUES (?, ?, 'pending', ?)"),
    accept: db.prepare("UPDATE friends SET status = 'accepted' WHERE user_id = ? AND friend_id = ?"),
    del: db.prepare('DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)'),
    forUser: db.prepare('SELECT * FROM friends WHERE user_id = ? OR friend_id = ?'),
  };
}

function resolveUser(ref) {
  if (typeof ref === 'number') {
    if (!Number.isSafeInteger(ref) || ref < 0 || ref > 1e12) return null;
    return q.userById.get(ref) || null;
  }
  if (typeof ref === 'string') {
    if (!ref.length || ref.length > 64) return null;
    const byName = q.userByName.get(ref);
    if (byName) return byName;
    if (/^\d+$/.test(ref)) return q.userById.get(Number(ref)) || null;
  }
  return null;
}

/** 'friends' | 'pending-in' | 'pending-out' | 'none' for (me, other). */
function friendStatus(meId, otherId) {
  const a = SQ.row.get(meId, otherId);
  if (a) return a.status === 'accepted' ? 'friends' : 'pending-out';
  const b = SQ.row.get(otherId, meId);
  if (b) return b.status === 'accepted' ? 'friends' : 'pending-in';
  return 'none';
}

function areFriends(a, b) {
  return friendStatus(a, b) === 'friends';
}

function homeLocked(ownerId) {
  const st = require('./studio');
  return typeof st.isHomeLocked === 'function' ? st.isHomeLocked(ownerId) : false;
}

class SocialSystem {
  constructor(game, studios) {
    this.game = game;
    this.studios = studios;
  }

  sceneName(sceneId) {
    if (MAPS[sceneId]) return MAPS[sceneId].name;
    const st = require('./studio');
    const ownerId = st.parseStudioId(sceneId);
    if (ownerId != null) {
      const owner = q.userById.get(ownerId);
      return `${owner ? owner.username : 'Private'}'s Home`;
    }
    return sceneId;
  }

  // ---------------------------------------------------------- friends

  friendPayload(p) {
    const rows = SQ.forUser.all(p.userId, p.userId);
    const friends = [], incoming = [], outgoing = [];
    for (const r of rows) {
      const otherId = r.user_id === p.userId ? r.friend_id : r.user_id;
      const other = q.userById.get(otherId);
      if (!other) continue;
      const live = this.game.getPlayer(otherId);
      const entry = {
        id: otherId,
        name: other.username,
        online: Boolean(live),
        mapId: live ? live.mapId : null,
        mapName: live ? this.sceneName(live.mapId) : null,
      };
      if (r.status === 'accepted') friends.push(entry);
      else if (r.friend_id === p.userId) incoming.push(entry);
      else outgoing.push(entry);
    }
    friends.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    return { type: 'friends', friends, incoming, outgoing };
  }

  sendFriends(p) {
    if (p) this.game.send(p, this.friendPayload(p));
  }

  refreshBoth(aId, bId) {
    this.sendFriends(this.game.getPlayer(aId));
    this.sendFriends(this.game.getPlayer(bId));
  }

  handleRequest(p, msg) {
    const targetUser = resolveUser(msg.username !== undefined ? msg.username : msg.userId);
    if (!targetUser) { this.game.send(p, { type: 'notice', text: 'No player by that name.' }); return; }
    if (targetUser.id === p.userId) { this.game.send(p, { type: 'notice', text: "You can't friend yourself." }); return; }
    const st = friendStatus(p.userId, targetUser.id);
    if (st === 'friends') { this.game.send(p, { type: 'notice', text: `You and ${targetUser.username} are already friends.` }); return; }
    if (st === 'pending-out') { this.game.send(p, { type: 'notice', text: `Friend request already sent to ${targetUser.username}.` }); return; }
    if (st === 'pending-in') {
      // They already asked us — a reciprocal request accepts.
      SQ.accept.run(targetUser.id, p.userId);
      this.game.send(p, { type: 'notice', text: `🤝 You and ${targetUser.username} are now friends!` });
      const t = this.game.getPlayer(targetUser.id);
      if (t) this.game.send(t, { type: 'notice', text: `🤝 ${p.name} accepted your friend request!` });
      this.refreshBoth(p.userId, targetUser.id);
      return;
    }
    SQ.insert.run(p.userId, targetUser.id, Date.now());
    const t = this.game.getPlayer(targetUser.id);
    if (t) {
      this.game.send(t, { type: 'friend-request', fromId: p.userId, fromName: p.name });
      this.game.send(t, { type: 'notice', text: `👥 ${p.name} sent you a friend request — see the Friends panel.` });
    }
    this.game.send(p, { type: 'notice', text: `👥 Friend request sent to ${targetUser.username}.` });
    this.refreshBoth(p.userId, targetUser.id);
  }

  handleRespond(p, msg) {
    const fromId = Number.isInteger(msg.userId) ? msg.userId : null;
    if (fromId === null) return;
    const row = SQ.row.get(fromId, p.userId);
    if (!row || row.status !== 'pending') {
      this.game.send(p, { type: 'notice', text: 'That friend request is no longer pending.' });
      return;
    }
    const fromUser = q.userById.get(fromId);
    if (msg.accept) {
      SQ.accept.run(fromId, p.userId);
      this.game.send(p, { type: 'notice', text: `🤝 You and ${fromUser ? fromUser.username : 'they'} are now friends!` });
      const t = this.game.getPlayer(fromId);
      if (t) this.game.send(t, { type: 'notice', text: `🤝 ${p.name} accepted your friend request!` });
    } else {
      SQ.del.run(fromId, p.userId, fromId, p.userId);
    }
    this.refreshBoth(p.userId, fromId);
  }

  handleRemove(p, msg) {
    const otherId = Number.isInteger(msg.userId) ? msg.userId : null;
    if (otherId === null || otherId === p.userId) return;
    SQ.del.run(p.userId, otherId, p.userId, otherId);
    this.game.send(p, { type: 'notice', text: 'Friend removed.' });
    this.refreshBoth(p.userId, otherId);
  }

  // ---------------------------------------------------------- navigator

  navigatorPayload(p) {
    const counts = this.game.mapCounts();
    const myFriends = new Set(
      SQ.forUser.all(p.userId, p.userId)
        .filter(r => r.status === 'accepted')
        .map(r => (r.user_id === p.userId ? r.friend_id : r.user_id)),
    );
    const friendsIn = new Map(); // sceneId -> [names]
    for (const other of this.game.players.values()) {
      if (!myFriends.has(other.userId)) continue;
      if (!friendsIn.has(other.mapId)) friendsIn.set(other.mapId, []);
      friendsIn.get(other.mapId).push(other.name);
    }
    const doorTargets = new Set();
    for (const m of Object.values(MAPS)) for (const d of m.doors || []) doorTargets.add(d.target);
    const places = Object.values(MAPS).map(m => ({
      id: m.id,
      name: m.name,
      kind: m.casino ? 'casino' : m.id === 'the-gateway' ? 'hub' : doorTargets.has(m.id) ? 'interior' : 'city',
      count: counts[m.id] || 0,
      capacity: SCENE_CAPACITY,
      fullness: Math.max(0, Math.min(6, Math.round(((counts[m.id] || 0) / SCENE_CAPACITY) * 6))),
      friends: friendsIn.get(m.id) || [],
      here: p.mapId === m.id,
    }));
    // Open homes: homes of ONLINE owners that aren't locked (plus my
    // own), with live occupant counts.
    const homes = [];
    const seenOwners = new Set();
    for (const other of this.game.players.values()) {
      const st = require('./studio');
      const ownerId = st.parseStudioId(other.mapId);
      if (ownerId != null && !seenOwners.has(ownerId)) {
        seenOwners.add(ownerId);
        const ownerUser = q.userById.get(ownerId);
        homes.push({
          ownerId, ownerName: ownerUser ? ownerUser.username : 'Private',
          count: counts[other.mapId] || 0, locked: homeLocked(ownerId),
          here: p.mapId === other.mapId,
        });
      }
    }
    for (const ownerId of [p.userId]) {
      if (!seenOwners.has(ownerId)) {
        homes.push({
          ownerId, ownerName: p.name, count: counts[`studio:${ownerId}`] || 0,
          locked: homeLocked(ownerId), here: p.mapId === `studio:${ownerId}`, mine: true,
        });
      }
    }
    return { type: 'navigator', places, homes: homes.filter(h => !h.locked || h.mine || h.here) };
  }

  handleNavigate(p, msg) {
    const target = typeof msg.mapId === 'string' ? MAPS[msg.mapId] : null;
    if (!target) { this.game.send(p, { type: 'notice', text: 'No such place.' }); return; }
    if (p.mapId === target.id) { this.game.send(p, { type: 'notice', text: 'You are already here.' }); return; }
    this.game.switchScene(p, target);
  }

  handleNavigateHome(p, msg) {
    const ownerId = Number.isInteger(msg.ownerId) ? msg.ownerId : null;
    if (ownerId === null) return;
    // Same gate as walking in: lock rules live in the studio system.
    this.studios.handleEnter(p, { owner: ownerId });
  }

  handleJoinFriend(p, msg) {
    const friendId = Number.isInteger(msg.userId) ? msg.userId : null;
    if (friendId === null) return;
    if (!areFriends(p.userId, friendId)) {
      this.game.send(p, { type: 'notice', text: 'You can only join a friend.' });
      return;
    }
    const t = this.game.getPlayer(friendId);
    if (!t) { this.game.send(p, { type: 'notice', text: "That friend isn't online right now." }); return; }
    if (t.mapId === p.mapId) { this.game.send(p, { type: 'notice', text: 'Your friend is right here!' }); return; }
    const st = require('./studio');
    const studioOwner = st.parseStudioId(t.mapId);
    if (studioOwner != null) {
      // Into a home: locked homes only admit a join aimed at the
      // owner themselves (they're home — it's their call to kick).
      if (homeLocked(studioOwner) && studioOwner !== friendId && studioOwner !== p.userId) {
        this.game.send(p, { type: 'notice', text: "That home is locked — your friend is visiting someone else." });
        return;
      }
      this.studios.enterStudio(p, q.userById.get(studioOwner));
      return;
    }
    const target = MAPS[t.mapId];
    if (!target) return;
    // Land beside the friend when their spot is walkable, else spawn.
    const near = { x: t.x + 40, y: t.y };
    const spawn = !collides(target, near.x, near.y, 12) ? near : target.spawn;
    this.game.switchScene(p, target, { spawn });
  }

  // ---------------------------------------------------------- profiles

  handleProfile(p, msg) {
    const targetUser = resolveUser(msg.userId !== undefined ? msg.userId : msg.username);
    if (!targetUser) { this.game.send(p, { type: 'notice', text: 'No player by that name.' }); return; }
    const live = this.game.getPlayer(targetUser.id);
    const avatar = live ? null : q.avatarByUser.get(targetUser.id);
    const look = live
      ? this.game.publicPlayer(live)
      : {
          id: targetUser.id, name: avatar ? avatar.name : targetUser.username,
          gender: avatar.gender, face: avatar.face, eyes: avatar.eyes, eye_color: avatar.eye_color,
          nose: avatar.nose, lips: avatar.lips, body_color: avatar.body_color,
          accent_color: avatar.accent_color, skin_tone: avatar.skin_tone,
          hair_style: avatar.hair_style, hair_color: avatar.hair_color,
          top_style: avatar.top_style, bottom_style: avatar.bottom_style,
          shoe_color: avatar.shoe_color, accessory: avatar.accessory,
        };
    this.game.send(p, {
      type: 'profile',
      profile: {
        id: targetUser.id,
        username: targetUser.username,
        name: look.name,
        look,
        online: Boolean(live),
        mapId: live ? live.mapId : null,
        mapName: live ? this.sceneName(live.mapId) : null,
        mixes: music.listMixes(targetUser.id).map(m => ({ id: m.id, name: m.name })),
        friendStatus: targetUser.id === p.userId ? 'self' : friendStatus(p.userId, targetUser.id),
        homeLocked: homeLocked(targetUser.id),
      },
    });
  }

  // ---------------------------------------------------------- dispatch

  handle(p, msg) {
    switch (msg.type) {
      case 'friend-request': this.handleRequest(p, msg); break;
      case 'friend-respond': this.handleRespond(p, msg); break;
      case 'friend-remove': this.handleRemove(p, msg); break;
      case 'friend-list': this.sendFriends(p); break;
      case 'navigator': this.game.send(p, this.navigatorPayload(p)); break;
      case 'navigate': this.handleNavigate(p, msg); break;
      case 'navigate-home': this.handleNavigateHome(p, msg); break;
      case 'join-friend': this.handleJoinFriend(p, msg); break;
      case 'profile': this.handleProfile(p, msg); break;
      default: break;
    }
  }
}

module.exports = { init, SocialSystem, friendStatus, areFriends, SCENE_CAPACITY };

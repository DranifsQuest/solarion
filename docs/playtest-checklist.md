# Solarion v1 Playtest Checklist

Everything below is protocol-proven (22/22 automated live checks passed,
incl. the Phase 6 creation flow) but never touched by a human. Work
through it in any order; jot what hits wrong and v1.1 starts there.
Live at https://solarion.onrender.com

## Free-tier manners (not bugs)
- First load after idle takes ~50 seconds to wake — that's Render's free tier.
- Accounts, mixes, and furniture wipe on redeploys for now (ephemeral DB).
  Same tradeoff as Goleon; the Fly.io move fixes it later.

## Don't bother testing (deferred by design)
- Burn-to-CD ritual, Gold/Platinum trophies, Top-40 chart, jukebox playback,
  casino lounges in cities other than Solstice Bay.

## 1. First load
- [ ] Register a fresh account; log out and back in.
- [ ] Does the avatar look right (V-ego style, big expressive head)?
- [ ] Does the hub feel like a place — walkable, readable, inviting?

## 1b. Character creation (Phase 6 — NEW, never human-tested)
- [ ] Register a fresh account → after login you land on the creation
      screen, NOT in the world. It should feel like becoming someone,
      not filling in a form.
- [ ] Flip the Male/Female toggle — genuinely different characters
      (silhouette, hair, face options), not just a color swap?
- [ ] Face axes: 10 face shapes, 10 eye styles, 10 noses, 10 lip styles
      per gender. Flip through each — can you SEE the difference at
      sprite size? Which ones read as identical twins?
- [ ] Eye color, 8 skin tones, hair styles (buzz → mohawk / ponytail →
      braids), hair/top/bottom colors + custom color picker.
- [ ] Outfit: 6 tops, bottoms (incl. skirt on F), shoe colors,
      accessories (cap, beanie, glasses, sunglasses, headband).
- [ ] Preview: does it update instantly on every pick? Turn ◀ ▶ through
      all four directions; hit Walk — the stride bob reads okay?
- [ ] 🎲 Randomize a few times — any cursed combinations?
- [ ] Pick a display name (not your username) — you spawn in The
      Gateway with THAT name over your head.
- [ ] 🎨 Look panel in-game: same full option set as creation? Change
      gender mid-game — outfit/hair reset sensibly (skirt → pants)?
- [ ] Log out and back in — your character is exactly as created,
      and NO creation screen the second time.

## 2. Audio — the never-heard stuff
- [ ] Open the mixer, audition loops across the 48 synth loops.
- [ ] Any loops that sound broken, glitchy, or out of place?
- [ ] Perform a mix on a stage — how does it sound in the room?

## 3. World & movement
- [ ] Walk through a gateway into each city: Solstice Bay, Neon District,
      Cinder Mesa, Frosthaven, Verdant Hollow. Load screens behave?
- [ ] Chat with anyone around; presence/movement of other players sensible?

## 4. Music loop (the centerpiece)
- [ ] Build a 5-slot mix, save it, perform it on a stage.
- [ ] Vote on someone else's performance — +5z lands? Daily cap (350z)
      behaves?

## 5. Casino (Solstice Bay Casino Lounge)
- [ ] Slots: spin a while — payouts feel fair? (RTP tuned ~0.967)
- [ ] Poker: sit at a 4-chair table, play a full hand to showdown.
      Chips conserved? Side pots handled right?

## 6. Private studio
- [ ] Buy furniture from the 14-item catalog, place pieces by clicking tiles.
      (Tile-click placement was never human-tested — this is the big one.)
- [ ] Relog — is the room exactly as you left it?

## 7. Avatar & economy
- [ ] Edit your avatar — changes stick?
- [ ] Daily bonus: +100z exactly once per day?

## 8. Rough edges
- [ ] Kill the tab mid-session and reconnect — state intact?
- [ ] Anything that feels wrong, ugly, slow, or confusing — write it down
      verbatim. That's the v1.1 list.

# Solarion v1 Playtest Checklist

Everything below is protocol-proven (27/27 automated live checks pass end
to end from a clean external network, incl. the Phase 6 creation flow
and the whole Phase B world expansion) but never touched by a human.
Work through it in any order; jot what hits wrong and v1.1 starts there.
Live at https://solarion.onrender.com

## Free-tier manners (not bugs)
- First load after idle takes ~50 seconds to wake — that's Render's free tier.
- Accounts, mixes, and furniture wipe on redeploys for now (ephemeral DB).
  Same tradeoff as Goleon; the Fly.io move fixes it later.

## Don't bother testing (deferred by design)
- Burn-to-CD ritual, Gold/Platinum trophies, Top-40 chart, jukebox playback.

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

## 1c. World expansion (Phase B — NEW, never human-tested)
- [ ] The maps are ~5× bigger now. Walk each city: does it feel
      inhabited (plazas, streets, blocks) or stretched-and-empty?
      Camera follows you smoothly at the edges?
- [ ] EVERY transfer (gateway arches AND doors) shows a fixed ~3s
      load screen and lands you already placed — no pop-in, no
      sliding during the screen. Does 3s feel right or annoying?
- [ ] Doors: Casino Lounge door in Solstice Bay (east face of the
      casino building), Gateway Café door (SE building), Neon Casino
      door (SE block, Neon District), Hookah Lounge door (S-centre
      building, Cinder Mesa) — and every door back out. Clear to find?
- [ ] SITTING: press E (or the Sit button) by benches, chairs, sofas,
      café tables — in the cities, café, casinos, hookah lounge, and
      on studio chairs/sofas. Seated pose reads right for both
      genders? Chat while seated; walk or E to stand.
- [ ] CASINOS (only two — Solstice Bay + Neon District): grand
      enough? 6 poker tables west, 10 slots in their own NE section,
      bar SW. Slots: you must SIT on the machine's stool to spin.
- [ ] BAR (both casinos): stand at the counter, buy drinks (5z).
      Haze builds on YOUR screen, bubbles float around you, your
      walk sways. At 10 drinks you pass out cold for 20s (everyone
      sees you fall), then wake wobbly. Funny or too much?
- [ ] HOOKAH LOUNGE (Cinder Mesa): sit at a station, E to puff (5z).
      Your screen gets psychedelic as the count builds; at 10 puffs
      you turn hippy (tie-dye + headband, everyone sees it) for 20s.

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

## 5. Casinos (Solstice Bay Casino Lounge + Neon Casino)
- [ ] Slots: sit on a machine's stool and spin a while — payouts
      feel fair? (RTP tuned ~0.967)
- [ ] Poker: sit at a 4-chair table, play a full hand to showdown.
      Chips conserved? Side pots handled right?
- [ ] The bar: see section 1c.

## 6. Your home (Phase 8 — NEW, never human-tested)
- [ ] The catalog is 44 items now: beds, 9 chairs/sofas, shelves,
      rugs, lamps/plants/posters, TVs, radios. Buy a spread of them,
      place pieces by clicking tiles. (Tile-click placement was
      never human-tested — this is still the big one.)
- [ ] RUGS: place one under a chair — it lies flat, you walk over
      it, furniture and avatars draw on top. Right look?
- [ ] SIT on the new chairs (dining chair, armchair, beanbag,
      loveseat…) — E key next to one. Seated pose reads right?
- [ ] TV: buy a Tube TV, place it, turn it on from the 🏠 Studio
      panel's ROOM DEVICES section. Flip all 6 channels — fake news,
      the soap opera (read the captions), cooking, weather, Captain
      Comet, static. Do the little shows read as shows at that size?
      Which channel is your favorite?
- [ ] RADIO: save a mix in the 🎵 Mixer first. Buy a Boombox, hit
      ▶ Play (loop library), ⏭ through a few loops, then 🔀 to
      "Mixes" — your own mix should be listed and play. Does the
      room hear it start together (two tabs/devices if you can)?
- [ ] INVITE a friend: type their username in the Invite box (works
      from anywhere, you don't have to be home). They get a prompt —
      accept lands them in your room after the load screen. Kick
      them, then invite them back: the fresh invite should let them
      in despite the kick block.
- [ ] Have a VISITOR work your TV and radio — that's by design
      (anyone in the room can). Does it feel social or chaotic?
- [ ] Relog — is the room exactly as you left it, TV channel and
      all?

## 7. Avatar & economy
- [ ] Edit your avatar — changes stick?
- [ ] Daily bonus: +100z exactly once per day?

## 8. Rough edges
- [ ] Kill the tab mid-session and reconnect — state intact?
- [ ] Anything that feels wrong, ugly, slow, or confusing — write it down
      verbatim. That's the v1.1 list.

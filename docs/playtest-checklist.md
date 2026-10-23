# Solarion Playtest Checklist

Everything below is protocol-proven by the automated suite + live
checks but the newest layers have never been touched by a human.
Work through it in any order; jot what hits wrong.
Live at https://solarion.onrender.com

## Free-tier manners (not bugs)
- First load after idle takes ~50 seconds to wake — that's Render's free tier.
  You should now see the **wake screen with tips** while it spins up,
  never a dead page.
- Accounts, mixes, and furniture wipe on redeploys for now (ephemeral DB).

## 9. Phase 9 — the adjustments build (NEW, never human-tested)

### Audibility (the big one)
- [ ] Perform a mix on a stage — do YOU hear your own set, start to
      finish? Have someone else in the room: do they hear the SAME
      thing at the SAME time?
- [ ] Home radio: play one of your mixes on a Boombox — owner AND
      guest both hear it, starting together?
- [ ] First click/keypress after loading should "unlock" audio —
      any moment where music should play but the room is silent?

### Movement
- [ ] Click (or tap) a far tile — you pathfind there, around
      obstacles, through the world sensibly? Click INTO a wall —
      you stop at the nearest sensible spot?
- [ ] 🏃 Run toggle: clearly faster; keyboard + click both honor it.
- [ ] On a phone: tap-to-move + joystick + Sit/Chat buttons usable?
- [ ] Camera glides instead of locking — motion sickness or smooth?
- [ ] Place nameplates ("Fountain Plaza", "The Slots") pop on entry.

### Social
- [ ] 🧭 Navigator: counts look right? Fullness dots? Your friends
      marked in the places they're standing in? Travel feels right?
- [ ] Friends: add by username, accept/decline, Join lands you next
      to them. Remove works.
- [ ] Click a player → profile card: their look, their mix TITLES,
      Visit Home / Invite / Add Friend all wired?
- [ ] Emotes (right edge): wave/dance/laugh/thumbs-up read clearly?
      Dance anywhere. Chat bubbles fade instead of vanishing?

### The ritual (burn-to-CD)
- [ ] Save a mix, try to perform it WITHOUT a CD — the stage should
      refuse and explain. Buy blanks (10 for 20z), burn, perform.
- [ ] The CD is gone after your set (one CD = one performance).
- [ ] 🏆 Top 40 chart (Stage panel): your set charts after votes?
- [ ] Trophies are a long grind (25 / 100 lifetime 👍 on ONE mix) —
      the Gold Record should appear in your home items when earned.

### Homes v2
- [ ] Home panel: rename your home (door name changes), repaint
      walls, swap floors — visitors see the new look too?
- [ ] Expand Studio → Loft (1500z): room grows, furniture unmoved.
- [ ] Lock the home: a visitor is refused at the door; an invited
      guest still gets in; unlock reopens it.

### Casino + bar
- [ ] First drink of the day: FREE and the bartender tips YOU 10z.
      Second drink (even at the OTHER casino) costs the usual 5z.
- [ ] Slots: the JACKPOT counter climbs as anyone spins (shared by
      both casinos); three ☀️ pays the whole pool.
- [ ] Poker: watch a table without sitting (state updates live);
      table chat reaches your table only, not the room.

### Ambient life + sound
- [ ] NPCs wander (Maple at the Gateway, DJ Nova at the Bay…) and
      occasionally chat. Do they add life or get in the way?
- [ ] Day/night: ~12-minute cycle — at night the world tints WARM
      (plum + amber lamp glow, golden washes at sunrise/sunset —
      X's cozy direction). Cold or cozy? Water shimmers.
- [ ] Sounds: UI clicks, door chime, applause on a strong set,
      zone ambience (surf at the Bay!). 🔊 panel: volume + mute stick
      between visits?

## 10. Phase 10 — the Warm Home pass (NEW, never human-tested)

### Real doors
- [ ] Walk up to any door (café, both casinos, hookah lounge): it
      visibly SWINGS open as you approach — creak audible? — and
      closes behind you after the load screen. Nobody pops; no
      glowing pad anywhere.
- [ ] Inside each interior, the door back out does the same in
      reverse, and you arrive through it (door starts open, shuts
      behind you).
- [ ] The load screen itself: dark wood + lantern + the place's
      name as a welcome sign. Does it feel like stepping indoors?
- [ ] Gateway, west side: the **My Home** door with lanterns.
      Through it = your place. Inside, your door wears your home's
      name; walk onto it to leave — you land outside your front
      door, facing the world. Does the round trip feel like HOME?

### Cozy substance
- [ ] Gateway Café + Hookah Lounge: find **The Hearth Corner** —
      fire animated, seats by it sittable, crackle audible over the
      room tone? Too loud / too quiet?
- [ ] Buy a **Fireplace (300z)** for your home: flame, night glow,
      and the crackle starts when you're home. String Lights (65z)
      and a Porch Lantern (50z) — bulbs/lantern read at day, glow
      at night?
- [ ] Nooks in the cities (rug + lamp + sofas): do they pull you
      to sit with someone, or read as decoration?
- [ ] Night pass: doors, lamps, string lights, hearths all glow
      warm — anywhere still feel cold or flat?
- [ ] UI warmth: panels/auth/wake screen in amber + wood — still
      readable everywhere? Any spot that went muddy?

## Don't bother testing (deferred by design)
- Hearing a stage set you walk into mid-performance (radios catch
  you up on the next pass; stages start you at the next set).

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
- [ ] Open the mixer, audition loops across the 72 synth loops (24 new in Phase 9).
- [ ] Any loops that sound broken, glitchy, or out of place?
- [ ] Perform a mix on a stage — how does it sound in the room?

## 3. World & movement
- [ ] Walk through a gateway into each city: Solstice Bay, Neon District,
      Cinder Mesa, Frosthaven, Verdant Hollow. Load screens behave?
- [ ] Chat with anyone around; presence/movement of other players sensible?

## 4. Music loop (the centerpiece)
- [ ] Build a mix in the 5-track mixer, save it, burn it to a CD
      (Phase 9 ritual), perform it on a stage.
- [ ] Vote on someone else's performance — +5z per 👍 lands? Daily
      cap (350z) behaves?

## 5. Casinos (Solstice Bay Casino Lounge + Neon Casino)
- [ ] Slots: sit on a machine's stool and spin a while — payouts
      feel fair? (Base paytable RTP ~0.967; the shared jackpot makes
      the effective rate ≈0.96 — see README Phase 9.)
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

# Coke Music / Coke Studios — Design Soul
*An original-homage reference for building Solarion. Principles only — no Coke assets, names, or branding reproduced.*

This doc captures the FEEL of Coke Music / Coke Studios (2002–2007), the Coca-Cola–branded isometric virtual world built on Sulake's Habbo technology (later rebranded MyCoke), to guide Solarion's design. Everything below is reconstructed from the MyCoke Fandom wiki (archival screenshots + interface strings), the Little Miss Gamer retrospective, the Wikipedia summary, contemporary press, and video titles/descriptions. Nothing here is copied from the original assets.

**How to read the confidence notes:** each section ends with `Verified` / `Inferred` / `Mixed` so build agents know what they can rely on.

---

## 1. The core loop & session rhythm

The loop was brutally simple and it worked for five years:

**Log in → hang out in a public venue → queue at a stage → perform a mix you made → collect votes (thumbs up = currency) → spend on furniture/clothes → decorate your private studio → invite people to see it → show off → repeat.**

Concretely:

- **New accounts started with a starter sum of Decibels** (the in-game currency), historically around 1,000 dB (earlier 5,000 dB). You never earned Decibels *from other players directly* — Decibels were not tradeable — so the economy was a faucet economy, not player-to-player trade. Valuable items were traded *up* for rarer items instead of being priced in currency.
- **Decibel faucets, in rough importance order:**
  1. Performing your music and receiving "thumbs up" votes (5 dB per thumbs-up, doubled to 10 in the premium Red Room; daily cap ~350 dB from performing).
  2. Drinking virtual Cokes found at crates/vending machines/fridges/bartenders in rooms (up to 10 per day, 10 dB each in the later era; the drinking animation took time — a V-ego had to finish one before getting another, ~5 min each — so this was an ambient drip, not a grind).
  3. Playing the companion web minigames (V-ego San, Uncover The Music, Coaster, Recycler/Whale Wash, Pop Quiz) even when the main world was closed or full.
  4. Website surveys and polls; redeeming real-world bottle-cap codes (the famous physical↔digital bridge: cap codes gave ~1,000 dB or rare furniture).
- **A session was 16 minutes on average, ~3x per week** (reported by Coca-Cola's interactive marketing lead at the time). That short-session shape matters: you could log in, grab your Coke, vote on two performances, queue your own track, and leave feeling productive.
- **The world had operating hours** — it was not 24/7 for much of its life (the remake notes explicitly call out that the original limited open hours to ~10am–2am, while the modern recreation removed the limit). When the world was closed, the *web games* kept earning you Decibels. That's the design lesson: **always have an earning path even when the social core is unavailable.**
- **Rhythm of a long session:** regulars would "park" in a favorite public venue, chat, drink their daily Cokes, take turns performing, then retreat to private studios for smaller parties and decorating, then come back out. The evening arc was: public → private → public.

*Verified:* Decibel sources and amounts, starter amount, non-tradeable currency, minigames-as-earnings, session stats (from the contemporary NYT-era reporting quoting Coca-Cola). *Mixed:* the "evening arc" is reconstructed from room-usage descriptions (Free Greens rooms, party rooms) and the hours structure; plausible but not documented as a literal playbook.

Sources: https://mycoke.fandom.com/wiki/Decibels, https://mycoke.fandom.com/wiki/Coca-Cola, https://en.wikipedia.org/wiki/MyCoke, https://littlemissgamer.com/the-strange-rise-and-fall-of-coke-music/, https://mycoke.fandom.com/wiki/Studio

---

## 2. Room/stage layout, the queue ritual, and voting

This is the heart of the game. Get this right and everything else is decoration.

**Where the stage sat:** Public rooms ("public studios"/"venues") were isometric rooms rendered as a compressed painted background with higher-quality furniture layered on top for depth. Most public rooms had **a stage as the visual and functional anchor** — typically raised, often with speakers beside it that *animated* while someone performed. The stage was the room's "front"; the audience area was an open floor of tiles in front of it. Private studios had no built-in stage; performance there was informal (audience gathered around the performer wherever they stood).

**The queue ritual:**
1. You made music at home (see §3), "burned" it to a CD item.
2. In a public venue, you queued to perform — the interface text confirms you needed a burned CD to perform ("You need to create a CD in your personal studio before you can perform here").
3. Your V-ego took the stage. **In the original version, the performer visibly held a microphone** (this detail was later removed — the wiki notes headphones-while-mixing and mic-while-performing as v1 features that vanished, which players noticed and the remake restored).
4. The room's speakers animated; the music played for everyone in the room (~1 minute per track).
5. While performing, the performer's chat was forced into **"shout" mode** — every message they typed broadcast room-wide. This is a beautiful detail: the performer *became* the room's voice for a minute.

**Voting:** After (or during) the performance, other players voted via the **infostand** (bottom-right panel): big **thumbs-up / thumbs-down** buttons. The results window showed: `Thumbs up votes: N`, `Thumbs down votes: N`, `You receive N decibels.` The thumbs-up *was* the economy — each one paid the performer. Thumbs-down paid nothing and was a social signal (in player-run "Free Greens" rooms, voting down could get you *kicked* — players enforced a thumbs-up-only culture to farm Decibels cooperatively).

**What a performance felt like (reconstructed):** a 60-second spotlight where one person's week of tinkering got a room's undivided attention, then an instant public score. Low stakes per track, high frequency — you could perform, get judged, and queue again in minutes. The emotional texture was closer to karaoke night or open-mic than to a concert: the audience was *also* waiting for their turn, so attention was reciprocal. That reciprocity is the magic — everyone in the room is both performer and judge.

**Capacity & discovery:** rooms capped at **25 users**; popular rooms got numbered clones ("London I", "London II"). The Navigator (room browser) showed public venues with **6 dots indicating fullness** and user studios ranked by crowd (top 35 most crowded), plus featured/promotional rooms starred at the top. Scarcity of seats made a full room feel like an event.

*Verified:* stage + animated speakers, queue-via-CD, mic/headphones in v1, shout-while-performing, infostand voting UI strings, 5 dB/vote + 350 dB daily cap, 25-user cap, clones, Navigator fullness dots. *Inferred:* the karaoke-night emotional read and the "evening arc" — consistent with all documented mechanics but not stated in sources.

Sources: https://mycoke.fandom.com/wiki/Public_rooms, https://mycoke.fandom.com/wiki/Interface, https://mycoke.fandom.com/wiki/Interface/Text_English, https://mycoke.fandom.com/wiki/Decibels, https://mycoke.fandom.com/wiki/V-ego, https://en.wikipedia.org/wiki/MyCoke

---

## 3. The music mixer

The Mixer was the game's differentiator against Habbo — a Shockwave web app (not in-client) called the **"CC-3001 Deluxe — Five Slot Mixer CD Burner Device"** with a diegetic fiction: your studio contained a physical Mixer furniture item (unremovable, un-pickup-able, owner-only; many players hid it behind other furniture). Clicking it opened the web mixer.

**UI layout (from archived screenshots/descriptions):**
- Five song slots. Each slot: **PLAY / EDIT / BURN** buttons. Empty slots read `< Slot N empty >`.
- EDIT opened the track editor: a simple grid/tracker where **114 pre-made loops** ("sound bytes") snapped into fixed positions — modular, foolproof composition. You didn't place notes; you arranged blocks.
- Loops were organized by **genre folders: Country, Dance, Hip-Hop, Latin(o), Misc, Pop, Rock** — each with 10–16 named loops (e.g. Hip-Hop: "Downtown", "Rakim", "Skee"; Dance: "Electro", "Sonar pole"; Latin: "Conga Bells", "Maracas", "Saxophone"; Misc oddities like "Cow Bell", "Fast Scratch", "Getup!").
- Each loop had a fixed length: **half (0:02), whole (0:04), or double (0:08)** notes. Songs were ~1 minute long. The constraint set was tiny — which was the point: *anyone* could make something listenable in minutes.
- BURN wrote the finished mix to a **CD item** (blank CDs bought 10-for-50 dB — nearly free). The burn had its own little animation and confirmation dialog ("Ready to burn? You have N blank CDs in your backpack").
- You could keep **5 songs** (one per slot). Mixes could be shared/performed from the CD; popular mixes could earn **Gold/Platinum Records** — wall-hung trophies that were also rare furniture and status symbols. There was even a **Top 40 chart** poster item that linked to a real web chart of player songs; songs could be played *outside* the client via the Top 40 page.

**Design read:** the mixer was a *toy*, not a DAW — closer to a loop pedal than GarageBand. Its genius was the pipeline: **make (5 min) → burn (1 click) → perform (tonight) → get judged (instantly)**. The loop from creation to audience was under an hour, which is why the game retained creators: most music tools make you wait weeks for an audience; Coke gave you one the same evening. The 5-song limit forced curation ("which of my five is my *single*?") and the Gold/Platinum records gave mixes a second life as decor.

*Verified:* CC-3001 Deluxe name, 5 slots, PLAY/EDIT/BURN, 114 loops, genre list, note lengths, ~1-min tracks, 5-song cap, blank CD cost, Gold/Platinum records, Top 40. *Inferred:* the "toy not DAW" framing and the creation-to-audience timing claim — supported by contemporary press ("tracks only one minute long… you may spend hours crafting one").

Sources: https://mycoke.fandom.com/wiki/Mixer, https://mycoke.fandom.com/wiki/Interface/Text_English, https://vindyarchives.com/news/2003/aug/02/internet-site-cokemusic-gets-users-involved/, https://littlemissgamer.com/the-strange-rise-and-fall-of-coke-music/, https://mycoke.fandom.com/wiki/Versions

---

## 4. Avatar life: the V-ego

**Proportions/look:** The V-ego was a chunky isometric pixel avatar in the Sulake/Habbo lineage — big head, compact body, readable at tiny sizes. Customization (done on the website, not in-client): clothes in many colors, face, skin tone, hair. A ~30-character "mission"/motto displayed under your name in the infostand when someone clicked you. During the Shark Tale promo, *everyone's* avatar temporarily became a fish — the game was willing to reskin the entire population for an event.

**Actions & presence details (the good stuff):**
- **Walk** tile-to-tile with a yellow (private rooms) or colored (public) tile hilighter showing the destination.
- **Dance** — the ambient social action; rooms with music had dancing crowds.
- **Sit** on chairs/sofas (furniture interaction was real: chairs sat-able, teleporters teleported, CD players played).
- **Drink Coke** — the signature idle action: V-ego holds the bottle, drinking animation, must finish before getting another. It was both a ritual and an income drip.
- **Face tracking:** V-egos turned their *head* toward nearby speakers and turned their *body* toward whichever V-ego you clicked — tiny, cheap, and it made rooms feel alive.
- **Sleep:** after 5 minutes idle, the V-ego fell asleep (visible "away" state). Social presence was legible at a glance.
- **Expressions:** the client files contained smile/angry/sad/surprised face assets that were *never implemented* — the remake community restored one. Lesson: even unshipped, the team knew faces needed states.
- **No jump, no combat, no physics play.** The verb set was: move, sit, dance, drink, chat, vote, perform. That's it — and it sustained years.

**Chat bubbles:** Speech appeared as **white bubbles over the avatar's head** with the username beside the message; the bubble's nameplate background color matched the *shirt color* the V-ego was wearing — identity and fashion were literally linked in every utterance. Three chat modes: **Speak** (local, ~3–5 tile radius; beyond that your message arrived *corrupted*, letters dropping out with distance — an incredible anti-spam/anti-noise mechanic), **Shout** (room-wide), and **Sing** (room-wide, used automatically while performing). Profanity was censored to "blah". There was also a Messenger (DMs/friends list) with a flashing-red alert button for incoming messages.

*Verified:* customization options, mission text, fish reskin event, tile hilighter, dance/sit/drink/teleport, head/body tracking, 5-min sleep, unimplemented expressions, bubble style + shirt-color nameplate, Speak/Shout/Sing with distance corruption, "blah" censor, Messenger. *Inferred:* none significant — this section is unusually well documented.

Sources: https://mycoke.fandom.com/wiki/V-ego, https://mycoke.fandom.com/wiki/Interface, https://en.wikipedia.org/wiki/MyCoke, https://mycoke.fandom.com/wiki/Furni

---

## 5. Rooms & furniture: private studios

**The feel:** Your studio was your identity made spatial. Creation: pick a name, a description, a **layout (room shape: 36/60/72/84 tiles)** and a **window "location"** (purely cosmetic view: Miami beach, New York skyscrapers, London, Tokyo, etc. — many players covered the window with poster furniture anyway). Up to 6 studios per player, later raised to 10. Every studio came with the unremovable Mixer.

**The catalog:** ~15 pages, hundreds of items, priced 50–2,500 dB. Categories included: Walls & Floors (500 dB to reskin), Premiere (sleek studio furniture), 5001 Collection (comfort line), Studio Essentials (racks, samplers, mics, cables, TVs, blank CDs), Necessities (plants, rugs, separators — the room-divider pieces players used to *build architecture* inside rooms), the brand collection (vending machines, neon signs, polar bear statue, red couches — the expensive flex items, up to 2,500 dB), wall items (instruments, posters, the Top 40 chart), and a "create your own game" page (dice/number/letter podiums, Infinite Jukebox). Furniture could be **rotated 2–4 ways**, layered (posters/rugs), moved freely; max **100 items per room** (+ the Mixer). Preview-before-buy existed in v1, was removed in v2 (players noticed).

**Interaction feel:** furniture wasn't just visual. Chairs sat you, fridges/vending machines dispensed the daily Coke, CD players played mixes, **teleporters linked rooms** (players built teleporter networks and maze games), the Infinite Jukebox streamed real indie music, some posters were *hyperlinks to web pages*. The room was a machine, not a diorama.

**What players actually did with rooms (the emergent layer):**
- **"Free Greens" rooms** — cooperative Decibel farms: take turns performing, everybody votes thumbs-up, down-voters get kicked. The owner moderated from the center.
- **Storage rooms** — overflow backpacks for unwanted furniture.
- **Collections/galleries** — walls of Gold/Platinum records, pinball machines, discontinued promo items; the game's museums.
- **Roleplay** — restaurants, wedding chapels, chat rooms, clubs with bouncers.
- **Player-invented games** — mazes built from separators, "falling furniture" games, red-light-green-light, sumo (from the V-ego San minigame aesthetic).
- **Trading floors** — since Decibels weren't tradeable, rooms became bazaars where rare-for-rare barter happened face to face.

**Rares & status:** roughly half the catalog was always available; the other half was "rare" — from cap codes, limited promos (Shark Tale, American Idol, Batman Begins, NCAA), minigame prizes (the Gong for 7 straight V-ego San wins, pinball machines for beta testers). Rares were the true endgame wealth.

*Verified:* layouts, locations, room limits, catalog pages/prices, rotation/layering, 100-item cap, interactive furniture list, all five room-use archetypes, rares sources. *Inferred:* the "identity made spatial" framing; the bazaar dynamic is documented (trade only room-owner-initiated, in studios) with the social texture inferred from the mechanics.

Sources: https://mycoke.fandom.com/wiki/Studio, https://mycoke.fandom.com/wiki/Online_Catalogue, https://mycoke.fandom.com/wiki/Furni, https://mycoke.fandom.com/wiki/Studio/FAQ

---

## 6. Public spaces: city-themed venues

**The roster** (grew over versions): San Francisco, Mexico, Goa, Tokyo, London, New York, Miami, Seattle, Sydney, Rio, Mombasa, Moscow, Alaska, Central Park, New Orleans, Neptune, Club Cherry, Ray's Rooftop, the Coca-Cola Red Room (double Decibel rewards — the premium venue), American Idol rooms, the mycoke Arena (NCAA), Wal-Mart (promo), Whale Wash (Shark Tale reskin), Theatre… Each was a hand-designed isometric diorama evoking its city.

**Vibe differences (reconstructed from names + surviving screenshots/descriptions):** the *concept* was strong even where documentation is thin — Goa had bartender bots and an exotic-lounge feel; Tokyo had a neon-club look; London a pub/urban feel; the Red Room was a saturated red VIP club; Central Park had a "drinkstand"; Mombasa's internal asset name was literally "Cokebicycle". The design principle: **one strong read per room** (a color, a landmark silhouette, a furniture set) rather than deep simulation. Rooms were *evocative*, not accurate.

**Ambient details:** every public room had its own **Coke dispenser variant** — crates, vending machines, bartender bots (v1; many replaced by crates in v2), each skinned per location. Bartenders were actual bot characters you could "ask" for a Coke. Speakers animated during performances. Backgrounds were heavily compressed paintings with crisp furniture on top — a deliberate perf/look tradeoff that gave rooms a soft, hazy depth.

**Hours of operation:** the world itself kept hours (roughly daytime-to-late-night, ~10am–2am in the original; the exact window varied by era). When closed, a "now closed" screen appeared and the web minigames became the game. **Lesson, not a feature to copy blindly:** scheduled scarcity made login feel like *going out* — but it also frustrated players, which is why the minigames-as-overflow existed.

*Verified:* room list, Red Room double rewards, 25-cap + clones, per-room dispenser variants, bartender bots, animated speakers, compressed-background rendering, operating-hours existence. *Inferred:* per-city vibe descriptions (source screenshots exist but detailed write-ups don't); the "one strong read" principle is a design inference from the asset list.

Sources: https://mycoke.fandom.com/wiki/Public_rooms, https://mycoke.fandom.com/wiki/Coca-Cola, https://mycoke.fandom.com/wiki/Decibel, https://en.wikipedia.org/wiki/MyCoke

---

## 7. Color palette & UI chrome of the era

Reconstructed from the wiki's interface documentation and archived screenshots (no original assets reproduced):

- **Brand red:** the Coca-Cola red (~#E61E2B / #F40009 range) was everywhere — logo watermarks, the Red Room, Coke machines, neon signs. It was used as an *accent*, not a flood: rooms themselves were often dark/muted so the red popped.
- **Club darkness:** public venues leaned **dark — deep blues, purples, near-black backgrounds** with neon furniture highlights (the "Maximum Disco Fever" disco lights were a 2,500 dB prestige item). Private studios in v1 had a **grunge/punk texture** — distressed walls, dark floors — that softened in later years toward a "sleek light gray with red" MyCoke look.
- **Isometric tile palette:** warm wood floors, gray stone, dark stage woods; furniture in saturated accent colors (red couches, chrome, neon). The overall read: *dim venue, bright objects, brighter avatars*.
- **Typography:** **Verdana, "crushed" into a pixel font** — the wiki is explicit. Small, chunky, high-contrast white-on-dark chat bubbles. UI text was often ALL CAPS in v1 ("PREMIERE", "NECESSITIES"), shifting to lowercase in v2.
- **Buttons/chrome:** chunky pixel buttons, star icons for featured rooms, the 6-dot fullness meter in the Navigator, the bottom control bar with 8 icon buttons (Speak/Shout toggle, Navigator, Messenger, Backpack, Catalog, Decibels, Sound, Help). Infostands were dark panels with pixel icons. The mixer web app had a chunky "device" skeuomorphism (the CC-3001 Deluxe as a drawn hardware unit).
- **Watermark:** a persistent small logo watermark under the control bar marked the era (CokeMusic → Coke Studios → MyCoke) — the world always knew what it was.

**Palette direction for Solarion (principle, not copy):** dark rooms + saturated accents + white chat text; one signature accent color per city; pixel-crisp Verdana-like type; chunky tactile buttons. Never flat-design minimalism — the era's charm was *tactile density*.

*Mixed:* hex values are approximations from described screenshots, not sampled. The grunge→sleek shift and Verdana-pixel detail are verified from the Interface wiki.

Sources: https://mycoke.fandom.com/wiki/Interface, https://mycoke.fandom.com/wiki/Online_Catalogue, https://mycoke.fandom.com/wiki/Furni

---

## 8. Social texture: what people actually did for hours

- **The performance treadmill:** make a mix → queue → perform → collect greens → tweak the mix → perform again. An evening could be 10+ performances across rooms. The 1-minute track length meant *judgment was fast and cheap* — nobody dreaded a bad 60 seconds.
- **Regulars & rooms-as-bars:** players had "their" venue the way people have a bar. The Navigator's crowd ranking + fullness dots + room clones created visible scenes. Bartender bots and daily-Coke rituals gave even idle hanging-out a tiny progression drip.
- **Status symbols (in order of legibility):** (1) **Gold/Platinum Records** on your wall — proof your music was loved; (2) **Rare furniture** — pinball machines, promo items, the Coca-Cola Neon Sign (2,000 dB), Disco Lights (2,500 dB); (3) **Room rank** — a starred/featured room or a perpetually full studio; (4) **American Idol suites** — won by weekly vote leaders, kept permanently, with special lighting; (5) **The mission/motto** under your name — 30 characters of identity.
- **Events/promos as design lessons:** the Shark Tale takeover (entire population reskinned as fish, underwater rooms) proved players *love* temporary world-altering events; American Idol (vote-based weekly competitions with permanent suite prizes) proved **competitive ladders with persistent rewards** drive months of engagement; Batman Begins/NCAA/FIFA promos proved real-world tie-ins can fund content without breaking fiction if the items are desirable. **Lesson: run seasonal world events that temporarily change the rules, and give winners permanent visible trophies.**
- **The dark patterns to avoid:** "Free Greens" rooms show that when currency is tied to votes, players will *cooperate to farm* rather than judge honestly — fine, it was social, but it meant vote counts were inflated. Scammers preyed on traders ("no cheat codes" warnings were baked into the trade UI). Moderation was human + report buttons; the ignore command (`:ignore username`) was a chat-level tool players actually used.
- **Why it lasted:** it was never really about the music quality — the loops were primitive. It was about **being heard**: a guaranteed audience, instant feedback, and a room you could decorate to prove you belonged. The product was *attention with furniture*.

*Mixed:* the "regulars as bars" and "attention with furniture" reads are synthesis; the underlying facts (Navigator ranking, promos, status items, Free Greens, scam warnings) are verified.

Sources: https://mycoke.fandom.com/wiki/Studio, https://mycoke.fandom.com/wiki/Furni, https://en.wikipedia.org/wiki/MyCoke, https://mycoke.fandom.com/wiki/Decibels, https://littlemissgamer.com/the-strange-rise-and-fall-of-coke-music/

---

## 9. Apply to Solarion — 25 concrete design touches to steal (principles, not assets)

1. **Stage as the room's anchor.** Every public city map gets one raised stage zone with visible speakers that animate during playback. The audience floor faces it. No stage = no reason to gather.
2. **CD-queue ritual.** To perform, a player burns a mix to a portable item, walks to the stage, and joins a visible queue (show queue order + who's next in the UI). The walk-to-stage matters — it's a procession.
3. **Performer holds the mic.** While performing, the avatar visibly holds a microphone (or Solarion-equivalent focus prop) and the mixer/booth lights up. v1 had this; players mourned its removal. Ship it from day one.
4. **Performer auto-shouts.** During a performance, the performer's chat broadcasts room-wide regardless of their Speak/Shout toggle. The spotlight is social, not just visual.
5. **60-second tracks, fast judgment.** Keep mixes ~1 minute. After each performance, show the results panel immediately: thumbs up / thumbs down / z-coins earned. Fast cycles beat long ceremonies.
6. **Thumbs economy with a daily cap.** Pay the performer per thumbs-up with a daily earning ceiling (prevents farming, preserves value). Double payouts in one premium venue per cycle (the Red Room principle) to create a "tonight we go *there*" pull.
7. **Distance-corrupted Speak.** Local chat degrades with distance (letters dropping out beyond ~4 tiles); Shout/Sing is room-wide. This single mechanic kills spam, creates eavesdropping gameplay, and makes crowds feel physical. Steal it outright.
8. **Shirt-color nameplates.** The chat bubble's name background matches the avatar's shirt color. Identity + fashion fused into every utterance — cheap, beloved.
9. **Head-tracking.** Avatars turn heads toward the active speaker/stage; bodies turn toward whoever you click. Two lines of code, enormous aliveness payoff.
10. **Sleep state.** After 5 idle minutes, the avatar visibly sleeps. Presence legibility is a feature.
11. **Dance as a first-class verb.** One button, always available, syncs loosely to whatever's playing. Crowds that dance together stay together.
12. **The daily drink ritual.** A free, limited-per-day consumable (Solarion: something original, not a cola) obtained from per-city dispenser variants, with a drinking animation and a small z-coin drip. Gives every login a 2-minute opening ritual.
13. **5-slot mixer, loop blocks, no notes.** The mixer UI: 5 song slots → per-slot EDIT opens a block-arranging grid of ~100 genre-organized loops (2s/4s/8s blocks that snap into place). No piano roll. A newcomer makes something decent in 5 minutes.
14. **Burn-to-play pipeline.** Mixes must be "burned" to a portable item before performing. The tiny friction makes performance feel earned; the item becomes tradable/showable.
15. **Gold/Platinum wall trophies.** Top-voted mixes earn wall-hung records for the creator's room. Second life for music as decor + permanent status.
16. **Player chart.** A Top-40-style web-accessible chart of top mixes, with a poster item for rooms that links to it. Discovery beyond the room you're standing in.
17. **100-item rooms, owner-only mixer, hideable.** Cap furniture per room (~100), one unremovable creator-station per owned room, and let players hide it behind furniture. Constraints breed creativity.
18. **Teleporters + interactive furniture.** Chairs you sit in, machines that dispense, teleporters that link rooms, jukeboxes that play. Rooms are machines. Players will build mazes, games, and shops from these primitives — budget for it.
19. **Room archetypes, not just rooms.** Design onboarding to suggest the five proven uses: performance hall ("Free Greens" style), gallery, storage, roleplay venue, game maze. Templates > blank canvas for retention.
20. **Navigator with fullness dots + crowd ranking.** Room browser shows 6-dot fullness meters, ranks player rooms by occupancy, stars featured/event rooms. Scarcity (25-ish cap, numbered clones when full) makes full rooms feel like events.
21. **One-strong-read cities.** Each Solarion city gets one palette + one landmark silhouette + one dispenser skin + one ambient detail. Evocative, not accurate. (Solstice Bay = sunset pier; Neon District = night market glow; Cinder Mesa = ember forge; Frosthaven = aurora ice; Verdant Hollow = firefly grove.)
22. **Seasonal world takeovers.** Once a quarter, reskin the world for an event (everyone's avatar gets a themed variant, rooms get overlays) with exclusive earnable furniture. The fish-reskin proved players adore temporary shared absurdity.
23. **Competitive ladders with permanent prizes.** Weekly vote-leader competitions awarding permanent themed rooms/items with special lighting. American Idol suites drove months of grinding — the trophy must be *visible forever*.
24. **Rares economy, untradeable currency.** Keep z-coins untradeable; let rares be the trade good. ~Half the catalog always available, half rotating/limited/promo/minigame-earned. Endgame wealth = displayable scarcity.
25. **Minigames as overflow.** When venues are full (or during off-hours), web minigames that pay small z-coin/furniture rewards keep the loop alive. Never let "the world is full" be a dead end.

**Explicitly do NOT copy:** the Coca-Cola name/branding, "Decibels" as a currency name (Solarion: z-coins), "V-ego", "CC-3001", real city names as room identities, the Coke bottle/cup iconography, or any original loop audio, furniture art, or screenshots.

---

*Doc version: 2026-10-20. Sources re-checked at time of writing; wiki content is archival and stable. Where this doc says "reconstructed" or "inferred," treat as design hypothesis to validate in playtests, not as historical fact.*

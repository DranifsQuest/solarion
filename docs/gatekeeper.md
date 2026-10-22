# Solarion Gatekeeper — tiered verification

`scripts/gate.mjs` is the one entry point for checking Solarion before
anyone calls it done. It exists because the old way — run the whole
suite serially, three times, plus a load test, for *every* change —
took hours and still produced flaky EADDRINUSE failures when runs
overlapped. The Gatekeeper keeps the release standard exactly as
strict and makes iteration cheap.

## Run it

```sh
npm run gate              # fast tier (default) — tests for what changed
npm run gate:standard     # standard tier — full suite once + load smoke
npm run gate:release      # release tier — full suite 3x (+ live dispatch)
npm run gate:playtest     # playtest tier — posed captures + image-space checks
node scripts/gate.mjs fast --base main   # fast vs a different base ref
node scripts/gate.mjs release --dispatch # release + fire Actions live-verify
```

Every run prints a markdown report to stdout and writes it to
`gate-reports/<timestamp>-<tier>.md`: tier, git HEAD, changed files,
what ran and why, pass/fail counts, every skip with its safety reason,
wall time, and a final `VERDICT: PASS/FAIL`. Exit code is 0 only on PASS.

## The three tiers — when each is required

| Tier | What runs | Required when |
|---|---|---|
| **FAST** | Only the test files mapped to your changed files, in parallel shards | Iterating on a change. A fast PASS means "the affected area works", nothing more. |
| **STANDARD** | The full suite once (parallel shards) + the 50-bot load smoke | Before every push. |
| **RELEASE** | The full suite **3x** + load smoke + GitHub Actions live-verify dispatch (`--dispatch`) | Before anything is called **live**. This tier codifies the standing release rule — outside-network verdict or it didn't happen. It does not weaken it: the Actions run must still be read and green. |
| **PLAYTEST** | Posed play-zoom captures of every public room (avatars seated at every seat kind, standing in doorways, at pit fronts) + image-space checks over the renders: row alignment, chair-back visibility, legs under tables, clear zones, crowding, edge margin. Emits a contact sheet (`previews/playtest/contact-sheet.html`) + `gate-reports/<ts>-playtest.md` | Before any deploy that changes maps, seats, sprites or the renderer — the data validator cannot see render defects (jumbled rows, sitters painted over tabletops, backs hidden behind occupants). The parent eyeballs the contact sheet and signs before deploy. Runs in ~1–3 min; the checker self-tests against doctored fixtures on every run. |

## How FAST picks tests

Changed files come from `git diff --name-only <base>` plus untracked
files. Each maps through the `MAPPING` table at the top of
`scripts/gate.mjs`:

- `src/music.js`, `src/stage.js` → music + audibility tests
- `src/casino.js` → casino + vice tests
- `src/studio.js` → studios + homes tests
- `src/appearance.js` → creation + sprites tests
- `src/game.js`, `src/maps.js`, `src/server.js`, `src/db.js` → the core
  protocol set (test.js, expansion, phase9)
- `public/*` → the client-surface tests for that area
- a changed test file runs itself
- anything unmapped in `src/` or `scripts/` → the core set as fallback
- docs / `*.md` → no tests (reported as a docs-only safe skip)

A code change that somehow maps to **zero** tests is an
**UNSAFE-SKIP**: the fast gate fails on purpose. Silence is never a pass.

## How parallel shards avoid port collisions

Every suite file derives its server ports and DB paths from the
`TEST_RUN` env var (`port = base + stride * TEST_RUN`, DB files named
`...-run-<TEST_RUN>.db`). Serial runs reuse TEST_RUN=0 safely, but the
files were written independently and several share port bases
(casino/phase9 at 49700, expansion/studios at 49900, vice overlapping
creation) — so running two files with the same TEST_RUN binds the same
port and one dies with EADDRINUSE.

The Gatekeeper's **port plan** (the `TEST_FILES` table in
`scripts/gate.mjs`) assigns each file the TEST_RUN offset that puts
its whole port window in unique space (phase9 runs at TEST_RUN=40,
studios at 30, everything else at 0 — verify in the table). Unique
TEST_RUN also means unique DB files per shard. The plan is asserted
disjoint at startup: add a test file with a clashing window and the
gate refuses to run until the offsets are fixed. The load test runs
after the shards, on its own port (48250).

## Honest limits

- FAST is an iteration tool. Its report lists everything it did *not*
  run and why that skip is safe **for iteration only** — STANDARD is
  still required pre-push, RELEASE before "live".
- Parallel speed depends on the machine: the suite is part CPU-bound
  (bcrypt, sprite tests) and part wall-clock-bound (real timers for
  performances, pass-out windows, transfer locks). Sharding removes
  the serial sum of the CPU parts; the timer-bound files set the floor.
  The report prints wall time next to the sum of shard times (the
  serial equivalent for the files run) so the win — or lack of one —
  is measured, not asserted.

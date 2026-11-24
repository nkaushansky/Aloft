# Aloft

A serene browser flight game. You are a young crane who woke late; the flock
left without you. Six lands, one flight each, following its voice south.
Vite + TypeScript + Three.js (custom WebGL2 pipeline), no downloaded assets.

## Involvement: hands-off

Nate sets direction and plays. Claude makes the detail calls and logs them in
the design doc ("Detail calls made, open to veto") for him to overrule.
(Set Nov 24 2026: "you've got full creative control… trust in yourself".)

## The tone — read this first

**Calm, gentle, zen.** This is the overarching tone for the entire game, not
a phase note. Every mechanic, control response, visual, sound, and reward
must pass it. Practical rules that follow from it:

- When two tunings both work, ship the gentler one.
- Nothing snaps: inputs ease in, cameras drift, transitions swell. No hard
  steps, no jerks, no punishments.
- There is no fail state. No crash, reset or respawn. Touching down anywhere
  is rest. Consequences are soft and recoverable.
- Challenge is invitational — mastery is rewarded, never required.
- The day waits: light follows distance flown, never a clock.
- Words are few and plain. No exclamation marks, no instructions that nag.

## Architecture invariants

- `src/sim/` is pure logic and **never imports Three.js** (or any DOM API).
  Flight feel lives there and must stay testable and renderer-independent.
- The tuned glide in `src/sim/config.ts` (forces, control, stall) came from
  Nate's hands-on playtests. Don't retune it without a playtest reason.
- The stick never creates energy. Rising air, rest and feathers do.
- The sim consumes normalized `{ pitch, roll, beat }` — it never knows about
  keyboards. New devices are new sources in `src/input/`.
- Terrain and lift are consumed through provider interfaces — never a
  concrete source.
- `src/world/` is pure and worker-safe: a seed always rebuilds the same land.
- All art direction (palettes, color scripts, weather, words, music) is data
  in `src/game/days.ts`. Geography is in `src/world/lands.ts`.
- Every surface shader takes light, shadow and air from
  `src/render/glsl/common.ts`, so each frame belongs to one moment.
- In GLSL loops and branches use `textureLod` / `nz0`, never implicit-LOD
  `texture` (D3D unrolls it). Additive materials must output alpha 1.
- Fixed 60Hz sim timestep; renderer interpolates between sim states.

## Process

- The design doc (`docs/design-doc.html`) is a living document — update it
  in place when decisions land. v0.10 is archived beside it.
- Nothing here is a copy of another game. Keep it that way.

## Commands

- `npm run dev` — Vite dev server (`/?tune` opens the feel panel)
- `/dev.html?land=copper` — visual harness; `/?hold` stops the loop so a
  script can step `__game.frame(dt)` by hand
- `npm run build` — typecheck + production build to `dist/`
- `npm run build:single` — one self-contained `dist-single/index.html`
- `npm run build:arcade` — `dist-arcade/`, deployed to nk00.com/arcade/aloft
  (the staging area; use the dreamhost-upload skill, area `arcade`). Bump
  `version`/`updated` in `arcade/game.json` with each deploy
- `?day=N` on any build opens the road to land N
- `npm run test:sim` — flight model promises
- `npm run test:journey` — flies every land end to end on autopilot
- `npm run test:feathers` — feathers come to someone who isn't chasing them

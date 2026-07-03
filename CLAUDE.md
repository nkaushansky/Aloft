# Aloft

A serene browser gliding game. Vite + TypeScript + Three.js.

## The tone — read this first

**Calm, gentle, zen.** This is the overarching tone for the entire game, not
a phase note. Every mechanic, control response, visual, sound, and reward
must pass it. Practical rules that follow from it:

- When two tunings both work, ship the gentler one.
- Nothing snaps: inputs ease in, cameras drift, transitions swell. No hard
  steps, no jerks, no punishments.
- There is no fail state. Consequences (stall, ground contact, water) are
  soft and recoverable, never punitive.
- Challenge is invitational — mastery is rewarded, never required.

## Architecture invariants

- `src/sim/` is pure logic and **never imports Three.js** (or any DOM API).
  Flight feel lives there and must stay testable and renderer-independent.
- The sim consumes normalized `{ pitch, roll }` input in [-1, 1] — it never
  knows about keyboards. New devices are new files in `src/input/`.
- Terrain and (later) lift are consumed through provider interfaces
  (`TerrainProvider`, later `LiftProvider`) — never a concrete source.
- Every feel constant lives in `src/sim/config.ts`, commented in feel terms,
  and wired to the lil-gui panel. No magic numbers in the flight model.
- Fixed 60Hz sim timestep; renderer interpolates between sim states.

## Process

- The design doc (`docs/design-doc.html`) is a living document — update it
  in place when decisions land.
- Phase gates (in the design doc) are strict: nothing past a gate starts
  until the gate's question is answered yes. Resist the world-design trap.

## Commands

- `npm run dev` — Vite dev server
- `npm run build` — typecheck (`tsc --noEmit`) + production build

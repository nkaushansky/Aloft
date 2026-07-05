# Aloft

A serene, low-poly browser gliding game about reading the air and staying up.
The tone for everything: **calm, gentle, zen** (see `CLAUDE.md`).

Phase 0 (*does gliding feel good?*) and Phase 1 (*is finding and using
lift satisfying?*) both passed. This repo is currently **Phase 2**, which
answers exactly one question:

> **Can a player feel the wind without a HUD?**

Rolling procedural countryside with a hero hill, a seeded field of
thermals — each with its own personality — and the world's tells: dust
columns, birds circling in the lift, and wind streaks drifting downwind.
The flight model is built on one idea: **total energy = altitude +
airspeed**, bleeding to drag — and lift, found in the world, is the only
way to top the tank back up.

- Design doc: [`docs/design-doc.html`](docs/design-doc.html) (living document)
- Phase 0 brief: [`docs/phase0-kickoff.md`](docs/phase0-kickoff.md)

## Run it

```sh
npm install
npm run dev     # Vite dev server
npm run build   # typecheck + production build
```

## Controls

| Key | Action |
| --- | --- |
| `W` / `↑` | pitch down (dive — gain speed) |
| `S` / `↓` | pitch up (climb — spend speed) |
| `A` / `←`, `D` / `→` | roll / banked turn |
| `R` | reset to launch |
| `H` | toggle debug HUD |

Every feel constant is a live slider in the lil-gui panel (top right).
The canonical values live in [`src/sim/config.ts`](src/sim/config.ts) —
when a tuned value feels right in the panel, write it back there.

## Architecture

The simulation is completely separate from rendering — `src/sim/` never
imports Three.js, so the flight feel is testable and renderers/terrain
sources are swappable.

```
src/
  sim/        pure logic — config (all feel constants), state, flight model,
              seeded noise, TerrainProvider (Flat, Hill, Procedural) and
              LiftProvider (ThermalField, RidgeLift, CompositeLift)
  render/     Three.js scene (vertex-colored terrain, dust, birds, wind
              streaks, pylons) + chase cam
  input/      keyboard -> normalized { pitch, roll } (input-agnostic sim)
  ui/         toggleable debug HUD (vario: climb + lift readouts)
  main.ts     fixed-timestep (60Hz) loop with render interpolation
```

Still out of scope, on purpose: character art (bird vs cape is Phase 3),
audio, day cycle, menus, scoring, persistence, touch/gamepad. See the
phase gates in the design doc.

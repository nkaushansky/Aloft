# Aloft

A serene, low-poly browser gliding game about reading the air and staying up.
The tone for everything: **calm, gentle, zen** (see `CLAUDE.md`).

Phase 0 (*does gliding feel good?*) passed. This repo is currently
**Phase 1**, which answers exactly one question:

> **Is finding and using lift satisfying?**

One smooth hill, one thermal (marked by a column of drifting dust), and
ridge lift on the hill's windward face. The flight model is built on one
idea: **total energy = altitude + airspeed**, bleeding to drag — and lift,
found in the world, is the only way to top the tank back up.

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
              TerrainProvider (FlatTerrain, HillTerrain) and
              LiftProvider (ThermalLift, RidgeLift, CompositeLift)
  render/     Three.js scene (terrain mesh, thermal dust, pylons) + chase cam
  input/      keyboard -> normalized { pitch, roll } (input-agnostic sim)
  ui/         toggleable debug HUD (vario: climb + lift readouts)
  main.ts     fixed-timestep (60Hz) loop with render interpolation
```

Still out of scope, on purpose: readable wind tells beyond the dust column
(Phase 2), character art, audio, menus, scoring, persistence, touch/gamepad.
See the phase gates in the design doc.

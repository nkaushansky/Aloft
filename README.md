# Aloft

A serene, low-poly browser gliding game about reading the air and staying up.
This repo is currently **Phase 0**, which answers exactly one question:

> **Does gliding feel good?**

A flat-shaded wedge flies over a flat gridded plane, driven by an arcade
flight model built on one idea: **total energy = altitude + airspeed**,
bleeding to drag. Nose down trades height for speed; nose up trades it back.

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
              TerrainProvider interface (+ FlatTerrain for Phase 0)
  render/     Three.js scene + smoothed chase camera
  input/      keyboard -> normalized { pitch, roll } (input-agnostic sim)
  ui/         toggleable debug HUD
  main.ts     fixed-timestep (60Hz) loop with render interpolation
```

Out of scope for Phase 0, on purpose: terrain height, thermals/lift, character
art, audio, menus, scoring, persistence, touch/gamepad. See the phase gates in
the design doc.

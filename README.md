# Aloft

A serene, low-poly browser gliding game about reading the air and staying up.
The tone for everything: **calm, gentle, zen** (see `CLAUDE.md`).

Phases 0–2 passed (*gliding feels good · lift is satisfying · the air is
legible*). This repo is currently **Phase 3**, which answers exactly one
question:

> **Does it have heart, not just physics?**

You fly a low-poly soaring bird over rolling procedural countryside — a
seeded field of thermals marked by dust and circling birds, ridge lift on
every windward slope, wind streaks drifting downwind, a day cycle that
swings from golden dawn to golden dusk (never full night), and a quiet
ambient audio bed whose wind follows your airspeed. The flight model is
built on one idea: **total energy = altitude + airspeed**, bleeding to
drag — and lift, found in the world, is the only way to top the tank
back up.

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
| `M` | mute / unmute the ambient bed |
| `H` | toggle the debug/tuning readout (flight instruments are always on) |

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
  render/     Three.js scene (vertex-colored terrain, the player bird, dust,
              tell-birds, wind streaks, day cycle) + chase cam
  audio/      ambient bed (wind follows airspeed) — routed for adaptive later
  input/      keyboard -> normalized { pitch, roll } (input-agnostic sim)
  ui/         flight instruments + stick guide + hidden debug readout
  main.ts     fixed-timestep (60Hz) loop with render interpolation
```

Still out of scope, on purpose: goals/collectibles, the boost meter,
flocks, landing & perches, persistence, touch/gamepad (all slotted in the
design doc's phases and parking lot).

# Aloft

Two games now live in this repo, sharing one idea.

| | |
| --- | --- |
| **`/` (this project)** | **Aloft** — a serene, low-poly gliding game. Calm, gentle, zen. Phases 0–4. |
| **[`/crossing`](crossing/)** | **Aloft — The Crossing** — a reimagining. Same keystone equation, seven kinds of air, one day to cross a continent. |

The shared idea is one line from the design doc below: *lift is the only
source of new energy — found in the world, never made by the stick.* Aloft
proves it feels good. The Crossing takes it literally and builds the whole
atmosphere: thermals that drift and tilt and die, ridge lift, mountain wave,
rotor, convergence lines, sink — all visible, all sourced from the terrain and
the sun, under a day that is itself the difficulty curve. See
[`crossing/docs/design-doc.html`](crossing/docs/design-doc.html).

---

## Aloft (the original)

A serene, low-poly browser gliding game about reading the air and staying up.
The tone for everything: **calm, gentle, zen** (see `CLAUDE.md`).

Phases 0–3 passed (*gliding feels good · lift is satisfying · the air is
legible · face and voice landed*). This repo is currently **Phase 4**,
which answers exactly one question:

> **Can you name a place you love?**

You fly a low-poly soaring bird over seeded procedural country — lakes
with wind-ripples, forests whose trees lean downwind, sun-baked dry land
where the thermals are born (marked by dust and circling birds), ridge
lift on every windward slope, a cairn on the summit, a dawn-to-dusk day
cycle, and meditative generative chimes that quicken gently with speed.
A seed *is* a map: the "newWorld" button deals a fresh countryside, and
keeping a seed means you can always fly back. The flight model is one
idea: **total energy = altitude + airspeed**, bleeding to drag — and
lift, found in the world, is the only way to top the tank back up.

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

**On touch devices:** touch anywhere and drag — your touch point becomes a
floating stick (drag up = nose down). Round buttons replace `R` and `M`.

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

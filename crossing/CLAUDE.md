# Aloft — The Crossing

A reimagining of Aloft. Vite + TypeScript + Three.js. Same keystone equation,
radically larger ambition.

## The one-line pitch

**The air is the level.** You are a soaring bird crossing a continent in a
single day, and the atmosphere is a visible, sculpted, readable place with
seven distinct kinds of air — every one physically sourced from the terrain
and the sun, and every one you can see.

## What carried over from the original, and what didn't

Carried over — because it was right:

- **total energy = altitude + airspeed**, bleeding to drag. The keystone.
- **Lift is the only source of new energy**, and it is found in the world.
  The stick can never create energy. This is what makes the sky a place.
- **Provider interfaces.** `TerrainProvider`, `BiomeProvider`, `WindField`.
  The sim never learns where the ground or the air came from.
- **`src/sim/` is pure** — no Three.js, no DOM. Flight feel is testable.
- **A seed IS a map.** Deterministic worlds; the Logbook records seeds.
- **Fixed 60 Hz sim, interpolated render.**

Deliberately not carried over:

- **The calm-gentle-zen tone.** The Crossing is aiming at *sublime* rather
  than *serene*: awe, scale, and a real skill ceiling. There is still no fail
  state and no punishment, but the day has an arc and the night has stakes.
- **The bounded valley.** The world is infinite and streamed.
- **Two kinds of lift.** There are now seven.

## Architecture invariants

- `src/sim/**` never imports Three.js or touches the DOM.
- The sim consumes normalized `FlightInput { pitch, roll, tuck, spread }` in
  [-1,1] / [0,1]. New devices are new readers in `src/input/`.
- **One atmosphere.** `src/render/shaders/atmosphere.ts` owns the shared
  uniform block and the GLSL for sky colour, aerial perspective, surface
  shading and tonemapping. *Every* world material includes it and takes those
  uniforms **by reference**. Nothing is allowed its own fog or lighting model.
  This is the single reason the scene reads as one place.
- No allocation in per-frame hot paths. `WindField.sample()` runs thousands
  of times a frame; it uses `out` params and module-level scratch.
- Every feel constant lives in `src/sim/config.ts`, commented in feel terms.

## The seven kinds of air

All of these are real things a sailplane pilot learns to find.

| kind | source | how you use it | how you see it |
| --- | --- | --- | --- |
| **thermal** | sun-baked ground | circle tight, drift downwind with it | gold ribbons, a cumulus with a flat dark base |
| **ridge** | wind on a windward slope | beat along the face | trees leaning, pale ribbons hugging the slope |
| **wave** | standing wave downwind of a range | hold still and rise for miles | lenticular clouds that *do not move* |
| **rotor** | turbulence under the wave | the toll to reach the wave | torn, tumbling dark cloud; violent shake |
| **convergence** | air masses meeting (sea breeze, valley) | fly the line *straight* | a cloud street you can follow to the horizon |
| **sink** | the price of all of it | tuck and cross it fast | dark ribbons falling |
| **still** | — | glide and lose height | almost nothing |

## The day is the difficulty curve

One run is one day (`config.dayLength`). `SkyModel.thermalActivity` lags the
sun by `config.heatLag`, so the best air is mid-afternoon, exactly like real
air. Dawn is ridge-only. Evening kills thermals from the ground up. At night
**only wave and ridge remain** — and wave gets *stronger* (`waveNightGain`),
because stable air waves better. Reaching the night is the mastery moment.

## The skill layer

`tuck` and `spread` are the two extra buttons, and they are the whole
speed-to-fly idea made physical: tuck to cross sink cheaply, spread to core a
narrow thermal. Induced drag (`config.inducedDrag`) is what makes slow banked
circling genuinely expensive — without it spread is free and the skill layer
collapses.

## Commands

- `npm run dev` — Vite dev server on :5180
- `npm run build` — typecheck (`tsc --noEmit`) + production build
- `npm run typecheck`
- `node tools/shoot.mjs shots` — drive a real browser through nine times of
  day and write screenshots plus a console-error report. **Use this to verify
  any visual change.** Reading a shader and imagining the output is how you
  ship a brown screen.

## Console hooks

`window.__aloft` exposes `state()`, `config`, `sky()`, `session`, `wind`,
`terrain`, `biomes`, `flock`, `start(mode)`, `setTime(t)`, `setSeed(n)`,
`fps()`. The screenshot harness drives the game entirely through these.

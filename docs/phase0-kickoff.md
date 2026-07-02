# Aloft — Phase 0 Build Kickoff

*Paste everything below the line into Claude Code, in an empty project directory.*

---

You're building **Phase 0** of a browser-based flight game called **Aloft**. Aloft will eventually be a serene, low-poly gliding game, but Phase 0 has exactly one job and answers exactly one question:

> **Build a low-poly wedge that flies over a flat plane, driven by an arcade flight model based on trading altitude for airspeed. The only question this phase answers is: _does gliding feel good?_**

Everything else — terrain shaping, lift/thermals, character art, audio, menus, scoring — is explicitly out of scope. Do not build it. If you catch yourself adding it, stop.

## Tech
- **Vite + TypeScript + Three.js.** No other frameworks.
- Target 60fps in a desktop browser. Drive the loop with `requestAnimationFrame`.
- Keep dependencies minimal. The one recommended extra is `lil-gui` (see *Live tuning*).

## Architecture (this matters from day one)
Keep the **simulation logic completely separate from rendering**. The sim core must not import Three.js. This keeps the flight feel testable and lets us swap renderers and terrain sources later without touching the physics.

```
src/
  sim/
    config.ts        # ALL tunable feel constants, heavily commented — the heart of this phase
    state.ts         # AircraftState type (position, velocity, orientation, airspeed)
    terrain.ts       # TerrainProvider interface + FlatTerrain (returns height 0 everywhere)
    flightModel.ts   # pure step(state, input, dt) -> newState. NO Three.js.
  render/
    renderer.ts      # Three.js scene: wedge mesh, ground, sky, lighting
    chaseCamera.ts   # smoothed follow camera
  input/
    keyboard.ts      # maps keys -> { pitch, roll } in [-1, 1]
  ui/
    debugHud.ts      # toggleable on-screen readout
  main.ts            # game loop wiring: input -> sim.step(dt) -> render
index.html
```

Include the trivial `TerrainProvider` interface now (with a `FlatTerrain` that returns height 0) even though the world is flat. It sets the pattern for Phase 1's real terrain and costs nothing.

## The flight model (behavioral, not prescriptive)
An arcade-simplified glider. **Do not build a realistic 6DOF flight sim.** The feel we're after:

- The craft always carries a forward **airspeed**. Moving through the air generates **lift** opposing gravity — at sufficient speed it glides rather than falls.
- **Gravity** constantly pulls down. **Drag** constantly bleeds airspeed.
- **Pitch** (nose up/down) trades the two: nose down → faster + lower; nose up → climbs + slows.
- With no lift sources this phase, total energy only trends down (drag). That's correct — the player launches with altitude and manages a graceful descent, and can still zoom-climb by trading speed for height.
- **Roll** banks the craft, and banking produces a coordinated **turn** — no separate yaw input. Wings level flies straight.
- **Stall:** below a minimum airspeed, lift collapses, the nose drops, and control softens until speed recovers. Make it gentle and recoverable — a soft consequence, never a hard punish.
- Integrate against **delta time** so feel is framerate-independent. Prefer a **fixed-timestep accumulator** (e.g. 60Hz sim) with the renderer reading sim state.

## Tuning config — the point of this phase
Put every feel constant in `sim/config.ts` as one exported, commented object. This is what we iterate on. At minimum:

```ts
export const config = {
  // forces
  gravity: 9.8,          // downward acceleration
  liftPerSpeed: 0,       // how strongly airspeed becomes lift (tune so a cruise glide sustains)
  dragCoeff: 0,          // parasitic drag — bleeds airspeed
  // control authority
  pitchRate: 0,          // how fast pitch responds to input
  rollRate: 0,           // how fast roll responds to input
  bankTurnFactor: 0,     // how much bank angle produces turn
  autoLevel: 0,          // gentle return-to-level when no input (forgiveness)
  // limits
  minAirspeed: 0,        // stall threshold
  maxAirspeed: 0,        // terminal speed in a dive
  // launch / reset
  launchAltitude: 0,
  launchAirspeed: 0,
  // camera
  camDistance: 0,
  camHeight: 0,
  camLerp: 0,            // follow smoothing (0..1 per frame)
  camLookAhead: 0,
};
```
Fill these with sensible starting values, but assume every one gets re-tuned. Comment each in *feel* terms, not just units.

## Controls (keyboard now, input-agnostic by design)
- **W / S** (or ↑ / ↓): pitch down / up
- **A / D** (or ← / →): roll left / right
- **R:** reset — relaunch from `launchAltitude` at `launchAirspeed`, wings level
- **H:** toggle the debug HUD
- Read input into a normalized `{ pitch, roll }` in `[-1, 1]` so gamepad/touch can be added later without touching the sim.

## Visual instrumentation (not art)
Just enough to perceive speed and height — this is measurement, not the game's look:
- A large flat ground plane at y=0 with a subtle **grid texture** so motion reads.
- A scatter of tall thin **reference pylons** so the player can gauge speed, altitude, and turn.
- A simple gradient sky / solid horizon color, basic directional + ambient light.
- The player is a flat-shaded low-poly **wedge** (stretched tetrahedron / arrowhead) that clearly shows forward direction, pitch, and bank. No textures, no detail.

## Debug HUD + live tuning
- `debugHud.ts`: toggleable overlay showing **airspeed, altitude, total energy, bank angle, and a stall indicator**.
- **Recommended:** wire `config` to a **`lil-gui`** panel so every feel constant is a live slider. This is how we answer "does it feel good" fast — tune in real time instead of edit-save-reload.

## Out of scope (do not build)
Terrain height variation · thermals or any lift sources · collision beyond a simple ground-contact reset · character art beyond the wedge · audio · menus, HUD chrome, scoring · persistence · mobile/touch/gamepad · multiplayer.

## Done = this checklist feels right
Phase 0 passes when, after tuning, all of these are true:
1. Nose down accelerates and descends, nose up climbs and slows — and it reads as *trading energy*, not arbitrary numbers.
2. You can dive to build speed, then zoom-climb, and it's satisfying.
3. Banked turns are smooth and coordinated, not twitchy.
4. The chase cam keeps the wedge readable and conveys real speed and height.
5. Just holding a gentle glide is calming.
6. A stall is a soft, recoverable moment.

Build the scaffold, implement the model and loop, fill the config with starting values, and get it running on the Vite dev server. Then we tune together.

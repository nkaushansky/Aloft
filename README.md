# Aloft

You are a young crane. The flock left while you were sleeping.
It is a long way south, and you are one day behind.

A quiet flight in six movements, in the browser. No fail state, no clock:
the day moves when you do.

- Design doc: [`docs/design-doc.html`](docs/design-doc.html) (living document)
- The tone for everything: **calm, gentle, zen** (see `CLAUDE.md`)

## Run it

```sh
npm install
npm run dev            # Vite dev server
npm run build          # typecheck + static site in dist/ (relative paths, host anywhere)
npm run build:single   # the whole game as one HTML file in dist-single/
npm run test:sim       # flight model checks
npm run test:journey   # flies all six lands headlessly
```

## Controls

| | Keyboard | Touch | Gamepad |
| --- | --- | --- | --- |
| Lean, dive, climb | `WASD` / arrows | drag anywhere | left stick |
| Beat wings (costs breath) | hold `Space` | hold *wings* | `A` / right trigger |
| Call | `E` | *call* | `X` / `Y` |
| Look around | right-drag, `IJKL` | | right stick |
| Drift (the bird flies itself) | `Q` | pause menu | right stick click |
| Postcard | `P` | pause menu | Select |
| Rest (pause) | `Esc` | top left | Start |

`M` mutes, `H` hides the instruments. Mouse: drag to fly, same as touch.

## Layout

```
src/
  sim/      pure flight: config (feel), state, model, air, flock, autopilot
  world/    land recipes, erosion, baking (worker-safe, seeded)
  game/     the six movements, game flow, save
  render/   HDR pipeline: terrain, sky, clouds, water, forests, crane, fx
  audio/    generative score, crane voices, ambience
  input/    keyboard, pointer/touch, gamepad
  ui/       words and the few instruments
```

Everything is generated at runtime: no models, textures or audio files.

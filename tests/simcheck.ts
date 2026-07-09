/**
 * Pure-sim regression checks — no browser, no Three.js, just the flight
 * model stepped in Node. Run with `npm run test:sim`. This is the payoff of
 * keeping src/sim free of DOM imports: the feel is testable headlessly.
 */
import { config } from '../src/sim/config';
import { AircraftState, createLaunchState } from '../src/sim/state';
import { step } from '../src/sim/flightModel';
import { FlatTerrain } from '../src/sim/terrain';
import type { LiftProvider } from '../src/sim/lift';

const terrain = new FlatTerrain();
const still: LiftProvider = { liftAt: () => 0 };
const DT = 1 / 60;
const hands = { pitch: 0, roll: 0 };

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name} — ${detail}`);
  if (!ok) failures++;
}

function run(s: AircraftState, seconds: number, lift: LiftProvider = still): AircraftState {
  for (let i = 0; i < seconds * 60; i++) s = step(s, hands, DT, config, terrain, lift);
  return s;
}

// 1. Hands-off glide settles near cruise with a gentle sink — the zen baseline.
{
  const s = run(createLaunchState(config), 15);
  check(
    'glide settles',
    s.airspeed > 17 && s.airspeed < 23 && s.climbRate > -2.5 && s.climbRate < 0,
    `airspeed ${s.airspeed.toFixed(1)} m/s, sink ${(-s.climbRate).toFixed(2)} m/s`,
  );
}

// 2. Wind carries the craft: downwind ground speed = air speed + carried wind.
{
  let s = run(createLaunchState(config), 5);
  const z0 = s.position.z;
  s = run(s, 10);
  const ground = Math.abs(s.position.z - z0) / 10;
  const expected = s.airspeed * Math.cos(s.pitch) + config.windSpeed * config.windCarry;
  check(
    'wind carry',
    Math.abs(ground - expected) < 0.8,
    `ground ${ground.toFixed(1)} m/s vs expected ${expected.toFixed(1)} m/s`,
  );
}

// 3. Rising air lifts: a strong thermal core turns sink into solid climb.
{
  const core: LiftProvider = { liftAt: () => 7 };
  const s = run(run(createLaunchState(config), 5), 5, core);
  check('thermal climbs', s.climbRate > 3, `climb ${s.climbRate.toFixed(1)} m/s in a 7 m/s core`);
}

// 4. Stall is soft and self-recovering: slow to a stall, hands off, fly again.
{
  let s = run(createLaunchState(config), 3);
  s = { ...s, airspeed: 6 }; // force a deep stall
  s = run(s, 8);
  check(
    'stall recovers',
    s.flying > 0.99 && s.position.y > 0,
    `airspeed ${s.airspeed.toFixed(1)} m/s, flying ${s.flying.toFixed(2)}, alt ${s.position.y.toFixed(0)}m`,
  );
}

// 5. Total energy never rises in still air — the stick can't create energy (Q5).
{
  let s = run(createLaunchState(config), 2);
  const energy = () => config.gravity * s.position.y + 0.5 * s.airspeed * s.airspeed;
  let prev = energy();
  let violated = false;
  for (let i = 0; i < 20 * 60; i++) {
    // pump the stick as hard as possible
    s = step(s, { pitch: i % 240 < 120 ? -1 : 1, roll: 0 }, DT, config, terrain, still);
    const e = energy();
    if (e > prev + 0.5) violated = true; // small tolerance for integration noise
    prev = e;
  }
  check('no free energy', !violated, 'stick pumping never increased total energy in still air');
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall sim checks passed');

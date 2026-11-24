/**
 * Pure-sim regression checks — no browser, no Three.js, just the flight model
 * stepped in Node. `npm run test:sim`. The tuned glide from the prototype is
 * held to the same numbers it had then; the new verbs get their own promises.
 */
import { config } from '../src/sim/config';
import { BirdState, createState, totalEnergy } from '../src/sim/state';
import { FlightInput, step, World } from '../src/sim/flightModel';
import { FlatTerrain, TerrainProvider } from '../src/sim/terrain';
import type { LiftProvider } from '../src/sim/air';

const still: LiftProvider = { liftAt: () => 0 };
const DT = 1 / 60;
const hands: FlightInput = { pitch: 0, roll: 0, beat: false };
const low = new FlatTerrain(-400); // far below: open air
const world = (o: Partial<World> = {}): World => ({ terrain: low, lift: still, wind: { x: 0, z: 0 }, draft: 0, ...o });

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name} — ${detail}`);
  if (!ok) failures++;
}
const launch = (y = 300) => createState(config, 0, y, 0, 0);
function run(s: BirdState, seconds: number, w: World, inp: FlightInput = hands): BirdState {
  for (let i = 0; i < seconds * 60; i++) s = step(s, inp, DT, config, w);
  return s;
}

{
  const s = run(launch(), 15, world());
  check('glide settles', s.airspeed > 17 && s.airspeed < 23 && s.climbRate > -2.5 && s.climbRate < 0, `airspeed ${s.airspeed.toFixed(1)} m/s, sink ${(-s.climbRate).toFixed(2)} m/s`);
}
{
  const w = world({ wind: { x: 0, z: -9 } });
  let s = run(launch(), 5, w);
  const z0 = s.position.z;
  s = run(s, 10, w);
  const ground = Math.abs(s.position.z - z0) / 10;
  const expected = s.airspeed * Math.cos(s.pitch) + 9 * config.windCarry;
  check('wind carries', Math.abs(ground - expected) < 0.8, `ground ${ground.toFixed(1)} vs expected ${expected.toFixed(1)} m/s`);
}
{
  const w = world({ wind: { x: 0, z: -9 }, lift: { liftAt: () => 4 } });
  let s = run(launch(), 5, w);
  const z0 = s.position.z;
  s = run(s, 10, w);
  const drift = Math.abs(s.position.z - z0) / 10 - s.airspeed * Math.cos(s.pitch);
  check('rising air shelters', drift < 9 * config.windCarry * 0.3, `wind drift inside lift ${drift.toFixed(2)} m/s`);
}
{
  const s = run(run(launch(), 5, world()), 5, world({ lift: { liftAt: () => 6 } }));
  check('thermal climbs', s.climbRate > 3, `climb ${s.climbRate.toFixed(1)} m/s in a 6 m/s core`);
}
{
  let s = run(launch(), 3, world());
  s = run({ ...s, airspeed: 6 }, 8, world());
  check('stall recovers', s.flying > 0.99 && s.position.y > 150, `airspeed ${s.airspeed.toFixed(1)}, alt ${s.position.y.toFixed(0)} m`);
}
{
  let s = run(launch(), 2, world());
  let prev = totalEnergy(s, config);
  let violated = false;
  for (let i = 0; i < 20 * 60; i++) {
    s = step(s, { pitch: i % 240 < 120 ? -1 : 1, roll: 0, beat: false }, DT, config, world());
    const e = totalEnergy(s, config);
    if (e > prev + 0.5) violated = true;
    prev = e;
  }
  check('the stick makes no energy', !violated, 'pumping never raised total energy in still air');
}
{
  let s = run(launch(), 4, world());
  const y0 = s.position.y;
  s = run(s, 4, world(), { pitch: 0, roll: 0, beat: true });
  const spent = 1 - s.breath;
  check('wingbeats climb, and cost', s.position.y > y0 + 4 && spent > 0.3, `+${(s.position.y - y0).toFixed(1)} m for ${(spent * 100).toFixed(0)}% breath`);
  const b0 = s.breath;
  const l = run(s, 4, world({ lift: { liftAt: () => 4 } }));
  const g = run(s, 4, world());
  check('rising air returns breath', l.breath - b0 > (g.breath - b0) * 3, `lift +${((l.breath - b0) * 100).toFixed(0)}% vs glide +${((g.breath - b0) * 100).toFixed(0)}%`);
}
{
  // flown straight at the ground, hard: never a crash, never below the surface
  const w = world({ terrain: new FlatTerrain(20) });
  let s = createState(config, 0, 90, 0, 0);
  let minY = 1e9;
  let jerk = 0;
  for (let i = 0; i < 30 * 60; i++) {
    const n = step(s, { pitch: -1, roll: 0, beat: false }, DT, config, w);
    jerk = Math.max(jerk, Math.abs(n.position.y - s.position.y));
    s = n;
    minY = Math.min(minY, s.position.y);
  }
  check('the ground receives you', minY > 19.5 && s.mode === 'ground' && jerk < 1.2, `lowest ${(minY - 20).toFixed(2)} m above ground, ended ${s.mode}, max step ${jerk.toFixed(2)} m`);
  let up = run(s, 4, w);
  up = run(up, 3, w, { pitch: 0, roll: 0, beat: true });
  check('rest, then rise', up.mode === 'air' && up.agl > 4 && s.breath >= 0, `${up.mode}, ${up.agl.toFixed(1)} m up`);
}
{
  // deep water can't be stood in: it lifts you off its back
  const w = world({ terrain: new FlatTerrain(-20) });
  let s = createState(config, 0, 12, 0, 0);
  s = run(s, 40, w);
  check('deep water skims', s.mode === 'air' && s.position.y > 0 && s.airspeed > 9, `${s.mode}, ${s.position.y.toFixed(1)} m, ${s.airspeed.toFixed(1)} m/s`);
}
{
  // a cliff turns you along itself
  const cliff: TerrainProvider = { heightAt: (_x, z) => (z < -200 ? 260 : z < -160 ? 260 * ((-160 - z) / 40) : 5) };
  let s = createState(config, 0, 60, 0, 0);
  let worst = 0;
  for (let i = 0; i < 25 * 60; i++) {
    s = step(s, hands, DT, config, world({ terrain: cliff }));
    worst = Math.min(worst, s.position.y - Math.max(0, cliff.heightAt(s.position.x, s.position.z)));
  }
  check('cliffs turn you aside', worst > -3 && Number.isFinite(s.position.x), `deepest ${worst.toFixed(2)} m, now ${s.position.x.toFixed(0)},${s.position.z.toFixed(0)}`);
}
{
  const w = world();
  const a = run(launch(), 20, w);
  const b = run(launch(), 20, world({ draft: 0.2 }));
  check('company carries', totalEnergy(b, config) > totalEnergy(a, config), `+${((totalEnergy(b, config) - totalEnergy(a, config)) / config.gravity).toFixed(1)} m of height in 20 s`);
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall sim checks passed');

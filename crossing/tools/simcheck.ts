/**
 * Headless sim assertions. No browser, no renderer — just the pure layer,
 * asked whether it is telling the truth.
 *
 * This exists because the expensive bugs in a flight game are never the ones
 * you can see. A thermal that reports lift but sums to zero, a wave that
 * never triggers, a glide ratio of NaN at zero airspeed — all of those look
 * completely fine in a screenshot.
 *
 *   npm run test:sim
 */

import { config, cruiseSpeed, wingDragScale, wingLiftScale } from '../src/sim/config';
import { ProceduralTerrain, findLaunchSite, terrainRoughness } from '../src/sim/terrain';
import { ProceduralBiomes } from '../src/sim/biome';
import { AtmosphereField } from '../src/sim/wind';
import { SkyModel } from '../src/sim/sky';
import { stepFlight, glideRatio } from '../src/sim/flight';
import { Flock } from '../src/sim/flock';
import { createBirdState, cloneBirdState } from '../src/sim/state';
import { AirKind, makeWindSample } from '../src/sim/types';
import type { BirdState, FlightInput, TerrainSample, WindField } from '../src/sim/types';

let failures = 0;
let checks = 0;

function ok(cond: boolean, label: string, detail = ''): void {
  checks++;
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

const finite = (n: number): boolean => Number.isFinite(n);

// =====================================================================

const terrain = new ProceduralTerrain(config);
const biomes = new ProceduralBiomes(config, terrain);
const wind = new AtmosphereField(config, terrain, biomes);
const sky = new SkyModel(config);
const tSample: TerrainSample = { height: 0, nx: 0, ny: 1, nz: 0, slope: 0 };
const wSample = makeWindSample();

section('terrain');
{
  let min = Infinity;
  let max = -Infinity;
  let bad = 0;
  for (let i = 0; i < 4000; i++) {
    const x = (i * 977) % 60000 - 30000;
    const z = (i * 1487) % 60000 - 30000;
    const h = terrain.heightAt(x, z);
    if (!finite(h)) bad++;
    if (h < min) min = h;
    if (h > max) max = h;
  }
  ok(bad === 0, 'height is finite everywhere', `${bad} bad samples`);
  ok(max > 600, 'the world has real mountains', `max ${max.toFixed(0)} m`);
  ok(min < config.waterLevel, 'the world has water', `min ${min.toFixed(0)} m`);
  ok(max <= terrain.maxHeight(), 'maxHeight() is an honest bound', `${max.toFixed(0)} vs ${terrain.maxHeight()}`);

  // Determinism: the same seed must rebuild the identical continent.
  const t2 = new ProceduralTerrain(config);
  let drift = 0;
  for (let i = 0; i < 500; i++) {
    const x = i * 137.7 - 20000;
    const z = i * 91.3 - 15000;
    drift += Math.abs(terrain.heightAt(x, z) - t2.heightAt(x, z));
  }
  ok(drift === 0, 'a seed rebuilds the identical world', `drift ${drift}`);

  terrain.sampleAt(1234, -5678, tSample);
  const nlen = Math.hypot(tSample.nx, tSample.ny, tSample.nz);
  ok(Math.abs(nlen - 1) < 1e-3, 'normals are unit length', `|n| = ${nlen.toFixed(4)}`);
  ok(tSample.slope >= 0 && tSample.slope <= 1, 'slope is in 0..1');
  ok(finite(terrainRoughness(terrain, 0, 0, 400)), 'roughness is finite');

  const site = findLaunchSite(terrain, config);
  const groundAtSite = terrain.heightAt(site.x, site.z);
  ok(
    Math.abs(groundAtSite - site.groundHeight) < 1,
    'the launch site reports its own ground height',
    `${groundAtSite.toFixed(0)} vs ${site.groundHeight.toFixed(0)}`,
  );
  ok(site.groundHeight > config.waterLevel + 300, 'the launch site is high ground', `${site.groundHeight.toFixed(0)} m`);
  const dirLen = Math.hypot(site.ridgeDirX, site.ridgeDirZ);
  ok(Math.abs(dirLen - 1) < 0.01, 'the ridge direction is a unit vector', `|d| = ${dirLen.toFixed(3)}`);
}

section('biomes');
{
  let water = 0;
  let hot = 0;
  let bad = 0;
  const bs = {
    kind: 0 as AirKind extends never ? never : import('../src/sim/types').BiomeKind,
    heat: 0,
    forest: 0,
    moisture: 0,
    r: 0,
    g: 0,
    b: 0,
  };
  for (let i = 0; i < 3000; i++) {
    const x = (i * 613) % 40000 - 20000;
    const z = (i * 1103) % 40000 - 20000;
    biomes.sampleAt(x, z, bs);
    if (!finite(bs.heat) || bs.heat < 0 || bs.heat > 1) bad++;
    if (bs.r < 0 || bs.r > 1 || bs.g < 0 || bs.g > 1 || bs.b < 0 || bs.b > 1) bad++;
    if (terrain.heightAt(x, z) < config.waterLevel) water++;
    if (bs.heat > config.thermalMinHeat) hot++;
  }
  ok(bad === 0, 'heat and colour stay in range', `${bad} violations`);
  ok(water > 60, 'there is a meaningful amount of water', `${((water / 3000) * 100).toFixed(0)}%`);
  ok(hot > 300, 'there is enough hot ground to host thermals', `${((hot / 3000) * 100).toFixed(0)}%`);

  // heatAt is the hot path and must agree with the full sample.
  let disagree = 0;
  for (let i = 0; i < 400; i++) {
    const x = i * 313 - 8000;
    const z = i * 197 - 6000;
    biomes.sampleAt(x, z, bs);
    if (Math.abs(biomes.heatAt(x, z) - bs.heat) > 0.2) disagree++;
  }
  ok(disagree < 40, 'heatAt() agrees with sampleAt().heat', `${disagree}/400 disagree`);
}

section('the day');
{
  const activity: number[] = [];
  for (let i = 0; i <= 100; i++) {
    sky.setTime(i / 100);
    activity.push(sky.state.thermalActivity);
    if (!finite(sky.state.sunDir.y)) failures++;
  }
  const peakAt = activity.indexOf(Math.max(...activity)) / 100;
  ok(peakAt > 0.45 && peakAt < 0.7, 'thermal activity peaks mid-afternoon, not at noon', `peak at t=${peakAt.toFixed(2)}`);

  sky.setTime(0.02);
  ok(sky.state.thermalActivity < 0.05, 'the ground is cold before dawn', `${sky.state.thermalActivity.toFixed(3)}`);
  sky.setTime(0.95);
  ok(sky.state.thermalActivity < 0.02, 'thermals are gone at night', `${sky.state.thermalActivity.toFixed(3)}`);
  ok(sky.state.starVisibility > 0.5, 'the stars are out at night', `${sky.state.starVisibility.toFixed(2)}`);
  ok(sky.state.phase === 'night', 'phase reports night', sky.state.phase);
  sky.setTime(0.45);
  ok(sky.state.sunElevation > 0.7, 'the sun is high at noon', `${sky.state.sunElevation.toFixed(2)} rad`);
  ok(sky.state.cloudBase > 1200, 'cloudbase climbs through the day', `${sky.state.cloudBase.toFixed(0)} m`);

  // Colour must never go negative or the ACES curve will produce garbage.
  let negatives = 0;
  for (let i = 0; i <= 60; i++) {
    sky.setTime(i / 60);
    const s = sky.state;
    for (const c of [s.skyZenith, s.skyHorizon, s.sunColor, s.fogColor, s.ambient, s.groundBounce]) {
      if (c.x < 0 || c.y < 0 || c.z < 0) negatives++;
    }
  }
  ok(negatives === 0, 'no negative colours anywhere in the day', `${negatives}`);
}

section('the air');
{
  sky.setTime(0.55);
  wind.setFocus(0, 0);
  wind.update(0.016, sky.state);
  for (let i = 0; i < 400; i++) wind.update(0.05, sky.state); // let the field settle

  ok(wind.thermals().length > 0, 'thermals exist in the afternoon', `${wind.thermals().length}`);

  // Sample a dense volume and count what kinds of air actually turn up. If a
  // kind never appears, it may as well not be implemented.
  const seen = new Map<AirKind, number>();
  let maxUp = 0;
  let maxDown = 0;
  let bad = 0;
  const R = 6000;
  for (let i = 0; i < 60000; i++) {
    const x = ((i * 7919) % (R * 2)) - R;
    const z = ((i * 104729) % (R * 2)) - R;
    const y = terrain.heightAt(x, z) + ((i * 37) % 3500);
    wind.sample(x, y, z, wSample);
    if (!finite(wSample.vx) || !finite(wSample.vy) || !finite(wSample.vz)) bad++;
    seen.set(wSample.kind, (seen.get(wSample.kind) ?? 0) + 1);
    if (wSample.vy > maxUp) maxUp = wSample.vy;
    if (wSample.vy < maxDown) maxDown = wSample.vy;
  }
  ok(bad === 0, 'the wind field never produces NaN', `${bad} bad samples`);
  ok(maxUp > 3, 'there is real lift out there', `best ${maxUp.toFixed(1)} m/s`);
  ok(maxDown < -1, 'there is real sink out there', `worst ${maxDown.toFixed(1)} m/s`);

  // Wave and rotor live downwind of the big ranges, which may be tens of km
  // from the origin — so sample the volume around each wave system as well as
  // the box around home, or the assertion just measures where we happened to
  // stand rather than whether the air exists.
  for (const w of wind.waves()) {
    for (let d = 0; d < 90; d++) {
      for (let h = 0; h < 40; h++) {
        const dist = 200 + d * 260;
        const lateral = ((d * 613) % 2000) - 1000;
        const x = w.crestX + w.dirX * dist - w.dirZ * lateral;
        const z = w.crestZ + w.dirZ * dist + w.dirX * lateral;
        const y = w.base - 400 + h * 220;
        wind.sample(x, y, z, wSample);
        seen.set(wSample.kind, (seen.get(wSample.kind) ?? 0) + 1);
      }
    }
  }

  const kindNames = ['Still', 'Thermal', 'Ridge', 'Wave', 'Rotor', 'Convergence', 'Sink'];
  for (let k = 1; k <= 6; k++) {
    const n = seen.get(k as AirKind) ?? 0;
    ok(n > 0, `${kindNames[k]} air occurs in the world`, `${n} samples`);
  }

  // Thermals must actually tilt and drift, or the skill they teach is fake.
  const th = wind.thermals();
  if (th.length > 0) {
    const anyTilt = th.some((t) => Math.hypot(t.tiltX, t.tiltZ) > 1e-4);
    const anyDrift = th.some((t) => Math.hypot(t.x - t.sourceX, t.z - t.sourceZ) > 1);
    ok(anyTilt, 'thermals lean downwind with height');
    ok(anyDrift, 'thermals drift away from their source');
    ok(th.every((t) => t.top > t.base), 'every thermal has positive depth');
  }

  // Wave must be findable and must be stronger at night than in the day.
  const waves = wind.waves();
  ok(waves.length > 0, 'the terrain generates mountain wave', `${waves.length} systems`);
  if (waves.length > 0) {
    const w = waves[0];
    let dayBest = 0;
    let nightBest = 0;
    const probe = (): number => {
      let best = 0;
      for (let d = 0; d < 60; d++) {
        for (let hSteps = 0; hSteps < 24; hSteps++) {
          const dist = 400 + d * 220;
          const x = w.crestX + w.dirX * dist;
          const z = w.crestZ + w.dirZ * dist;
          const y = w.base + hSteps * 180;
          if (y > w.top) break;
          wind.sample(x, y, z, wSample);
          if (wSample.kind === AirKind.Wave && wSample.vy > best) best = wSample.vy;
        }
      }
      return best;
    };
    sky.setTime(0.55);
    wind.update(0.016, sky.state);
    dayBest = probe();
    sky.setTime(0.95);
    wind.update(0.016, sky.state);
    nightBest = probe();
    ok(dayBest > 1, 'wave lift is findable', `${dayBest.toFixed(1)} m/s`);
    ok(
      nightBest >= dayBest * 1.05,
      'wave is stronger at night — the whole late game depends on it',
      `day ${dayBest.toFixed(1)} vs night ${nightBest.toFixed(1)}`,
    );
  }
}

section('flight');
{
  sky.setTime(0.4);
  wind.update(0.016, sky.state);

  const cruise = cruiseSpeed(config, 0);
  ok(cruise > 15 && cruise < 30, 'cruise speed is in a sane band', `${cruise.toFixed(1)} m/s`);
  ok(wingLiftScale(config, 1) > wingLiftScale(config, 0), 'spread makes more lift');
  ok(wingLiftScale(config, -1) < wingLiftScale(config, 0), 'tuck makes less lift');
  ok(wingDragScale(config, -1) < wingDragScale(config, 0), 'tuck makes less drag');
  ok(wingDragScale(config, 1) > wingDragScale(config, 0), 'spread makes more drag');
  ok(cruiseSpeed(config, 1) < cruise, 'a spread wing flies slower');

  const site = findLaunchSite(terrain, config);
  const hands: FlightInput = { pitch: 0, roll: 0, tuck: 0, spread: 0 };

  /**
   * Still air. The flight-model assertions below are about the MODEL, and in
   * the real atmosphere a hands-off glide over a sunlit ridge at midday
   * quite correctly goes UP — which tells you the wind field works and
   * nothing whatsoever about the drag polar.
   */
  const stillAir: WindField = {
    sample: (_x, _y, _z, o) => {
      o.vx = 0;
      o.vy = 0;
      o.vz = 0;
      o.kind = AirKind.Still;
      o.intensity = 0;
      o.turbulence = 0;
      return o;
    },
    update: () => {},
    prevailingAt: (_y, o) => {
      o.x = 0;
      o.y = 0;
      o.z = 0;
      return o;
    },
    thermals: () => [],
    waves: () => [],
    convergences: () => [],
  };

  /** Fly hands-off for `secs` from a fresh launch and report what happened. */
  function glide(
    secs: number,
    input: FlightInput,
    wing = 0,
    field: WindField = stillAir,
  ): { a: BirdState; b: BirdState } {
    let cur = createBirdState(config, site.x, site.groundHeight + 2500, site.z);
    cur.wing = wing;
    const start = cloneBirdState(cur);
    let buf = cloneBirdState(cur);
    const dt = 1 / 60;
    for (let i = 0; i < secs * 60; i++) {
      const next = stepFlight(cur, input, dt, config, terrain, field, buf);
      buf = cur;
      cur = next;
      if (cur.landed) break;
    }
    return { a: start, b: cur };
  }

  const g = glide(45, hands);
  ok(finite(g.b.position.y) && finite(g.b.airspeed), 'a long glide stays finite');
  ok(g.b.position.y < g.a.position.y, 'a hands-off glide descends');
  ok(Math.abs(g.b.airspeed - cruise) < 9, 'a hands-off glide settles near cruise', `${g.b.airspeed.toFixed(1)} m/s`);

  const ld = glideRatio(g.b, config);
  ok(finite(ld) && ld > 4 && ld < 60, 'glide ratio is plausible', `L/D ${ld.toFixed(1)}`);

  // The tuck must actually buy speed, and the spread must actually buy time.
  const fast = glide(35, { pitch: 0, roll: 0, tuck: 1, spread: 0 }, -1);
  const slow = glide(35, { pitch: 0, roll: 0, tuck: 0, spread: 1 }, 1);
  ok(fast.b.airspeed > slow.b.airspeed + 4, 'tuck is meaningfully faster than spread',
     `${fast.b.airspeed.toFixed(1)} vs ${slow.b.airspeed.toFixed(1)} m/s`);
  const fastSink = fast.a.position.y - fast.b.position.y;
  const slowSink = slow.a.position.y - slow.b.position.y;
  ok(slowSink < fastSink, 'spread sinks more slowly than tuck', `${slowSink.toFixed(0)} m vs ${fastSink.toFixed(0)} m`);

  // Induced drag: a hard bank must cost energy, or the skill layer is a lie.
  const level = glide(30, hands);
  const banked = glide(30, { pitch: 0, roll: 1, tuck: 0, spread: 0 });
  ok(
    banked.a.position.y - banked.b.position.y > level.a.position.y - level.b.position.y,
    'circling costs more height than gliding straight',
  );

  // A stall must mush and recover, never lock the player out or explode.
  let s = createBirdState(config, site.x, site.groundHeight + 3000, site.z);
  s.airspeed = 3;
  let sb = cloneBirdState(s);
  let minSpeed = 999;
  for (let i = 0; i < 60 * 12; i++) {
    const n = stepFlight(s, hands, 1 / 60, config, terrain, wind, sb);
    sb = s;
    s = n;
    minSpeed = Math.min(minSpeed, s.airspeed);
    if (s.landed) break;
  }
  ok(finite(s.airspeed), 'a stall does not produce NaN');
  ok(s.airspeed > config.minAirspeed, 'a stall recovers on its own', `${s.airspeed.toFixed(1)} m/s`);

  // The ground must stop the bird, not swallow it.
  let d = createBirdState(config, site.x, site.groundHeight + 60, site.z);
  let db = cloneBirdState(d);
  for (let i = 0; i < 60 * 40; i++) {
    const n = stepFlight(d, { pitch: -1, roll: 0, tuck: 1, spread: 0 }, 1 / 60, config, terrain, wind, db);
    db = d;
    d = n;
    if (d.landed) break;
  }
  ok(d.landed, 'flying into the ground lands the bird');
  ok(
    d.position.y >= Math.max(terrain.heightAt(d.position.x, d.position.z), config.waterLevel) - 1,
    'the bird never ends up below the ground',
  );
}

section('the flock');
{
  const flock = new Flock(config, terrain, wind, config.seed);
  ok(flock.birds.length === config.flockMax, 'the pool is fixed size', `${flock.birds.length}`);
  ok(flock.count === 0, 'you start alone');

  const site = findLaunchSite(terrain, config);
  let bird = createBirdState(config, site.x, site.groundHeight + 900, site.z);
  flock.grant(12);
  for (let i = 0; i < 60 * 20; i++) {
    flock.update(1 / 60, bird, sky.state);
    bird.position.x += 18 / 60;
  }
  ok(flock.count > 0, 'granted companions actually show up', `${flock.count}`);
  let bad = 0;
  let far = 0;
  for (const b of flock.birds) {
    if (b.presence <= 0) continue;
    if (!finite(b.x) || !finite(b.y) || !finite(b.z)) bad++;
    if (Math.hypot(b.x - bird.position.x, b.z - bird.position.z) > 700) far++;
    if (b.y < terrain.heightAt(b.x, b.z) - 5) bad++;
  }
  ok(bad === 0, 'companions stay finite and above ground', `${bad}`);
  ok(far === 0, 'companions hold formation', `${far} strays`);

  // Dusk must empty the sky.
  sky.setTime(0.99);
  for (let i = 0; i < 60 * 90; i++) flock.update(1 / 60, bird, sky.state);
  ok(flock.count === 0, 'the flock roosts at nightfall — you finish alone', `${flock.count} left`);
}

// =====================================================================

console.log(`\n${failures === 0 ? '✓' : '✗'} ${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);

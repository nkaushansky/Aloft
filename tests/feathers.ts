/**
 * Are the feathers catchable by someone who isn't chasing them? Flies each
 * land on the drift autopilot, which knows nothing about feathers, and counts
 * what simply comes to it.
 */
import { bakeLand } from '../src/world/generate';
import { HALF, LAND_ORDER, makeLand, LandId } from '../src/world/lands';
import { MOVEMENTS } from '../src/game/days';
import { placeCurrents, placeThermals } from '../src/game/placement';
import { Trails } from '../src/game/trails';
import { Heightfield } from '../src/sim/terrain';
import { CompositeLift, GlassOff, GlowCurrents, RidgeLift, ThermalField } from '../src/sim/air';
import { config } from '../src/sim/config';
import { createState } from '../src/sim/state';
import { step } from '../src/sim/flightModel';
import { Autopilot } from '../src/sim/autopilot';

const only = process.argv[2]?.split(',') as LandId[] | undefined;
let bad = 0;
void (async () => {
  for (const id of only ?? LAND_ORDER) {
    const b = await bakeLand({ id, n: 1024 });
    const land = makeLand(id);
    const mv = MOVEMENTS[id];
    const hf = new Heightfield(b.height, b.n, HALF, b.far, b.nFar, b.farHalf);
    const th = new ThermalField(placeThermals(land, b, mv));
    const wk = mv.keys[Math.floor(mv.keys.length / 2)].wind ?? [0, -5];
    const wind = { x: wk[0], z: wk[1] };
    const glass = new GlassOff(hf);
    const cur = placeCurrents(land);
    const lift = new CompositeLift([th, new RidgeLift(config, hf, wind, () => mv.air.ridge), glass, ...(cur.length ? [new GlowCurrents(cur)] : [])]);
    const tr = new Trails({ seed: land.seed, route: land.route, terrain: hf, thermals: th, wind, roadThermals: mv.air.thermals, landmarks: b.landmarks });
    const [x, z] = land.route.at(0);
    const [dx, dz] = land.route.dir(0.01);
    let s = createState(config, x, Math.max(0, hf.heightAt(x, z)), z, Math.atan2(-dx, -dz));
    s.mode = 'ground';
    s.modeTime = 5;
    const ap = new Autopilot();
    const DT = 1 / 60;
    let prog = 0;
    let got = 0;
    let t = 0;
    const [ex, ez] = land.route.at(1);
    for (; t < 1500; t += DT) {
      const p = s.position;
      land.route.dist(p.x, p.z);
      if (land.route.qt > prog) prog += Math.min(land.route.qt - prog, DT * 0.04);
      glass.amount = mv.air.glass * Math.max(0, Math.min(1, (prog - 0.72) / 0.23));
      const inp = s.mode === 'air' ? ap.fly(s, hf, th, land.route, DT) : { pitch: 0, roll: 0, beat: s.mode === 'ground' && s.modeTime > 4 };
      s = step(s, inp, DT, config, { terrain: hf, lift, wind, draft: 0.1 });
      got += tr.step(s, prog, DT).length;
      if (Math.hypot(ex - s.position.x, ez - s.position.z) < 340 && s.agl < 230) break;
    }
    const shed = tr.feathers.filter((f) => f.laid && f.drift);
    const caught = shed.filter((f) => f.taken).length;
    const ok = caught / shed.length > 0.5;
    if (!ok) bad++;
    console.log(`${ok ? ' ok ' : 'FAIL'} ${id.padEnd(10)} caught ${caught} of the ${shed.length} shed ahead of it (${((100 * caught) / shed.length).toFixed(0)}%), ${got} in all, without trying`);
  }
  if (bad) process.exit(1);
})();

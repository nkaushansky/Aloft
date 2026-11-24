/**
 * Can the whole road be flown? Bakes each land, then lets the drift autopilot
 * fly it headlessly — the same sim, air and terrain the game uses.
 */
import { bakeLand } from '../src/world/generate';
import { HALF, LAND_ORDER, makeLand, LandId } from '../src/world/lands';
import { MOVEMENTS } from '../src/game/days';
import { placeCurrents, placeThermals } from '../src/game/placement';
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
    const [x, z] = land.route.at(0);
    const [dx, dz] = land.route.dir(0.01);
    let s = createState(config, x, Math.max(0, hf.heightAt(x, z)), z, Math.atan2(-dx, -dz));
    s.mode = 'ground';
    s.modeTime = 5;
    const ap = new Autopilot();
    const DT = 1 / 60;
    let t = 0;
    let landings = 0;
    let beatT = 0;
    let hi = 0;
    let low = 0;
    let prog = 0;
    let maxBack = 0;
    let arrived = false;
    const [ex, ez] = land.route.at(1);
    const prof: string[] = [];
    for (; t < 1500; t += DT) {
      const air = s.mode === 'air';
      const p = s.position;
      land.route.dist(p.x, p.z);
      if (land.route.qt > prog && land.route.qt - prog < 0.3) prog = land.route.qt;
      maxBack = Math.max(maxBack, prog - land.route.qt);
      th.vigor = id === 'darkwater' ? 0.9 : 1 - 0.5 * Math.max(0, (prog - 0.86) / 0.14);
      glass.amount = mv.air.glass * Math.max(0, Math.min(1, (prog - 0.72) / 0.23));
      const inp = air ? ap.fly(s, hf, th, land.route, DT) : { pitch: 0, roll: 0, beat: s.mode === 'ground' && s.modeTime > 4 };
      const m0 = s.mode;
      s = step(s, inp, DT, config, { terrain: hf, lift, wind, draft: 0.1 });
      if (m0 === 'air' && s.mode === 'ground') landings++;
      if (s.beat > 0.5) beatT += DT;
      if (s.agl < 12 && s.mode === 'air') low += DT;
      hi = Math.max(hi, s.position.y);
      if (Math.floor(t / 60) !== Math.floor((t - DT) / 60)) prof.push(`${Math.round(prog * 100)}%@${Math.round(s.agl)}m`);
      if (Math.hypot(ex - s.position.x, ez - s.position.z) < 300 && s.agl < 250) {
        arrived = true;
        break;
      }
      if (![s.position.x, s.position.y, s.airspeed].every(Number.isFinite)) break;
    }
    if (!arrived) bad++;
    console.log(`${arrived ? ' ok ' : 'FAIL'} ${id.padEnd(10)} ${(t / 60).toFixed(1)} min, landings ${landings}, beating ${beatT.toFixed(0)}s, skimming ${low.toFixed(0)}s, highest ${hi.toFixed(0)} m, progress ${(prog * 100).toFixed(0)}%\n      ${prof.join(' ')}`);
  }
  if (bad) process.exit(1);
})();

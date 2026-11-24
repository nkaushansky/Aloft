import * as THREE from 'three';
import { Engine, Quality } from '../render/engine';
import { TerrainMesh } from '../render/terrainMesh';
import { Water } from '../render/water';
import { Trees } from '../render/trees';
import { Grass } from '../render/grass';
import { Crane, FeatherField } from '../render/crane';
import { FarBirds, Multitude } from '../render/farBirds';
import { Fx } from '../render/fx';
import { Landmarks } from '../render/landmarks';
import { applyLight, Frame, makeFrame } from '../render/light';
import { G } from '../render/globals';
import type { BakedLand } from '../world/generate';
import { HALF, Land, LAND_ORDER, makeLand } from '../world/lands';
import { Heightfield, MaskField } from '../sim/terrain';
import { CompositeLift, GlassOff, GlowCurrents, RidgeLift, Thermal, ThermalField, Wind } from '../sim/air';
import { config } from '../sim/config';
import { MOVEMENTS, Movement } from './days';
import { placeCurrents, placeThermals } from './placement';

export const MAX_COMPANIONS = 8;

/**
 * One loaded country: its ground, air and light, wired to everything that
 * draws it. Loading swaps the whole world underneath the bird.
 */
export class World {
  readonly terrainMesh: TerrainMesh;
  readonly water: Water;
  readonly trees: Trees;
  readonly grass: Grass;
  readonly feathers: FeatherField;
  readonly player: Crane;
  readonly cranes: Crane[] = [];
  readonly farBirds: FarBirds;
  readonly multitude: Multitude;
  readonly fx: Fx;
  readonly landmarks: Landmarks;
  readonly frame: Frame = makeFrame();

  land!: Land;
  mv!: Movement;
  baked!: BakedLand;
  terrain!: Heightfield;
  mask!: MaskField;
  thermals!: ThermalField;
  glass!: GlassOff;
  lift!: CompositeLift;
  wind: Wind = { x: 0, z: -5 };
  loaded = false;

  constructor(readonly engine: Engine) {
    const e = engine;
    const q = e.quality;
    this.terrainMesh = new TerrainMesh(q.lodScale);
    e.opaque.add(this.terrainMesh.mesh);
    this.trees = new Trees(e.opaque, e.shadowScene);
    this.grass = new Grass(e.opaque, this.terrainMesh.style, q.grass);
    this.feathers = new FeatherField(MAX_COMPANIONS + 2);
    e.opaque.add(this.feathers.mesh);
    e.shadowScene.add(this.feathers.shadow);
    this.player = new Crane(this.feathers, e.opaque, e.shadowScene);
    for (let i = 0; i < MAX_COMPANIONS; i++) {
      const c = new Crane(this.feathers, e.opaque, e.shadowScene);
      c.group.visible = c.shadowGroup.visible = false;
      this.cranes.push(c);
    }
    this.farBirds = new FarBirds(220);
    e.opaque.add(this.farBirds.mesh);
    this.multitude = new Multitude(q.name === 'low' ? 900 : q.name === 'medium' ? 1800 : 3200);
    e.opaque.add(this.multitude.mesh);
    this.water = new Water(e.V);
    e.water.add(this.water.mesh);
    this.fx = new Fx(e.fx, e.V, q.name === 'low' ? 0.5 : q.name === 'medium' ? 0.75 : 1);
    this.landmarks = new Landmarks(e.opaque, e.shadowScene, e.fx, e.V);
    this.landmarks.onBlow = (x, y, z) => {
      for (let i = 0; i < 3; i++) this.fx.spark(x, y, z, (Math.random() - 0.5) * 1.6, 6 + Math.random() * 4, (Math.random() - 0.5) * 1.6, 0);
    };
    this.applyQuality(q);
  }

  applyQuality(q: Quality): void {
    this.trees.farR = q.treeFar;
    this.trees.nearR = q.name === 'low' ? 90 : q.name === 'medium' ? 140 : 190;
    this.terrainMesh.style.uTreeFar.value = q.treeFar;
    this.grass.setAmount(q.grass);
    this.grass.radius = q.name === 'low' ? 60 : q.name === 'medium' ? 85 : 110;
    this.water.u.uSsr.value = q.name === 'low' ? 10 : q.name === 'medium' ? 16 : 22;
  }

  load(baked: BakedLand, seed?: number): void {
    this.baked = baked;
    this.land = makeLand(baked.id, seed ?? baked.seed);
    this.mv = MOVEMENTS[baked.id];
    const li = LAND_ORDER.indexOf(baked.id);
    this.terrain = new Heightfield(baked.height, baked.n, HALF, baked.far, baked.nFar, baked.farHalf);
    this.mask = new MaskField(baked.mask, baked.n, HALF);
    const ts: Thermal[] = placeThermals(this.land, baked, this.mv);
    this.thermals = new ThermalField(ts);
    this.glass = new GlassOff(this.terrain);
    const currents = placeCurrents(this.land);
    this.lift = new CompositeLift([
      this.thermals,
      new RidgeLift(config, this.terrain, this.wind, () => this.mv.air.ridge),
      this.glass,
      ...(currents.length ? [new GlowCurrents(currents)] : []),
    ]);

    this.terrainMesh.load(baked);
    this.terrainMesh.setStyle(this.mv.style, li);
    this.water.setStyle(this.mv.water);
    this.water.setCurrents(currents);
    const clear = baked.landmarks.map((l) => ({ x: l.x, z: l.z, r: l.kind === 'oldtree' ? 30 : 42 }));
    const [sx, sz] = this.land.route.at(0);
    const [ex, ez] = this.land.route.at(1);
    clear.push({ x: sx, z: sz, r: 60 }, { x: ex, z: ez, r: 70 });
    this.trees.density = 1;
    this.trees.load(this.mv.trees, this.mv.treeGap, this.terrain, this.mask, this.land.seed, clear);
    this.grass.setStyle(this.mv.grass, li);
    this.engine.clouds.setWeather(this.mv.weather(this.land.route, ts, this.land.seed));
    this.fx.setMotes(this.mv.motes.kind, this.mv.motes.color, this.mv.motes.amount);
    this.landmarks.load(baked.landmarks, this.mv, this.terrain, this.trees.atlas);
    this.multitude.mesh.visible = false;
    this.engine.invalidateShadows();
    this.engine.clouds.cut();
    this.loaded = true;
  }

  /** Light the world for a point in its day. */
  light(p: number, night = 0): void {
    applyLight(this.mv.keys, p, this.frame, night);
    this.wind.x = G.uWind.value.x;
    this.wind.z = G.uWind.value.y;
    // thermals wake with the sun and tire with it
    const id = this.land.id;
    const v = id === 'darkwater' ? 0.9 : id === 'wintering' ? 0.55 + 0.45 * smooth(0.1, 0.4, p) : 0.35 + 0.65 * smooth(0.02, 0.16, p) * (1 - 0.6 * smooth(0.86, 1, p));
    this.thermals.vigor = v;
    this.glass.amount = this.mv.air.glass * smooth(0.72, 0.95, p);
  }

  surfaceY(x: number, z: number): number {
    return Math.max(0, this.terrain.heightAt(x, z));
  }

  /** Draw one frame around a focus point. */
  draw(dt: number, focus: THREE.Vector3, budget: number): void {
    const cam = this.engine.camera;
    cam.updateMatrixWorld();
    const agl = cam.position.y - this.surfaceY(cam.position.x, cam.position.z);
    this.terrainMesh.update(cam, agl);
    this.trees.update(cam, budget);
    this.grass.update(agl);
    this.water.update(cam.position);
    this.landmarks.update(dt);
    this.fx.update(dt, this.thermals.thermals, this.thermals.vigor, focus);
    this.engine.render(this.frame, focus, this.baked.maxH);
  }
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

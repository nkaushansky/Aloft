import * as THREE from 'three';
import type { AircraftState } from '../sim/state';
import type { TerrainProvider } from '../sim/terrain';
import type { ThermalField } from '../sim/lift';
import type { Biomes } from '../sim/biomes';
import { makeRng } from '../sim/noise';
import { config } from '../sim/config';

const WORLD_SIZE = 6000;
const TERRAIN_SEGMENTS = 200;
const DUST_PER_THERMAL = 80;
const BIRDS_PER_THERMAL = 2;
const STREAK_COUNT = 140;
const STREAK_BOX = 900; // wind streaks live in a box this wide around the craft
const RIPPLE_COUNT = 90;
const MAX_TREES = 1400;

/**
 * Phase 2 scene: the air made visible. Rolling vertex-colored terrain from
 * the provider, a dust column and circling birds marking every thermal, and
 * wind streaks drifting downwind so the wind is legible everywhere.
 */
export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly gl: THREE.WebGLRenderer;
  private readonly craft: THREE.Group;
  private readonly leftWing: THREE.Mesh;
  private readonly rightWing: THREE.Mesh;
  private wingFlex = 0;
  private sun!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private skyCanvas!: HTMLCanvasElement;
  private skyTex!: THREE.CanvasTexture;
  private lastSkyT = -1;
  private readonly terrainMesh: THREE.Mesh;
  private readonly waterMesh: THREE.Mesh;
  private readonly ripples: THREE.LineSegments;
  private readonly ripplePos: Float32Array;
  private trunks: THREE.InstancedMesh | null = null;
  private canopies: THREE.InstancedMesh | null = null;
  private readonly cairn: THREE.Group;
  private worldKey = '';
  private dust!: THREE.Points;
  private dustSeeds!: Float32Array;
  private birds!: THREE.Group;
  private readonly streaks: THREE.LineSegments;
  private readonly streakPos: Float32Array;
  private airKey = '';

  constructor(
    container: HTMLElement,
    private readonly terrain: TerrainProvider,
    private readonly thermalField: ThermalField,
    private readonly biomes: Biomes,
  ) {
    this.gl = new THREE.WebGLRenderer({ antialias: true });
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.gl.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(this.gl.domElement);

    this.camera = new THREE.PerspectiveCamera(
      config.camFov,
      window.innerWidth / window.innerHeight,
      0.1,
      8000,
    );

    this.skyCanvas = document.createElement('canvas');
    this.skyCanvas.width = 2;
    this.skyCanvas.height = 512;
    this.skyTex = new THREE.CanvasTexture(this.skyCanvas);
    this.skyTex.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = this.skyTex;
    this.scene.fog = new THREE.Fog(0xd7ddd2, 450, 3400);

    this.sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
    this.sun.position.set(300, 500, 200);
    this.scene.add(this.sun);
    this.hemi = new THREE.HemisphereLight(0xcfe0d8, 0x8a8468, 0.9);
    this.scene.add(this.hemi);
    this.applyTimeOfDay(config.timeOfDay);

    const terrainGeo = new THREE.PlaneGeometry(
      WORLD_SIZE, WORLD_SIZE, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS,
    );
    terrainGeo.rotateX(-Math.PI / 2);
    terrainGeo.setAttribute(
      'color',
      new THREE.BufferAttribute(new Float32Array(terrainGeo.attributes.position.count * 3), 3),
    );
    this.terrainMesh = new THREE.Mesh(
      terrainGeo,
      new THREE.MeshLambertMaterial({
        map: makeCheckerTexture(),
        vertexColors: true,
        flatShading: true,
      }),
    );
    this.scene.add(this.terrainMesh);

    // still water — a mirror-calm plane; the wind writes on it with ripples
    this.waterMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE),
      new THREE.MeshLambertMaterial({ color: 0x7fa3ab, transparent: true, opacity: 0.92 }),
    );
    this.waterMesh.geometry.rotateX(-Math.PI / 2);
    this.waterMesh.position.y = config.waterLevel;
    this.scene.add(this.waterMesh);

    const rippleParts = makeWaterRipples();
    this.ripples = rippleParts.lines;
    this.ripplePos = rippleParts.positions;
    this.scene.add(this.ripples);

    this.cairn = makeCairn();
    this.scene.add(this.cairn);

    this.rebuildTerrain();
    this.rebuildAir();

    const streakParts = makeWindStreaks();
    this.streaks = streakParts.lines;
    this.streakPos = streakParts.positions;
    // scatter the streaks around the launch area from frame one
    for (let i = 0; i < STREAK_COUNT; i++) {
      const x = (Math.random() - 0.5) * STREAK_BOX;
      const z = (Math.random() - 0.5) * STREAK_BOX;
      this.streakPos[i * 6] = x;
      this.streakPos[i * 6 + 1] = this.terrain.heightAt(x, z) + 6 + Math.random() * 130;
      this.streakPos[i * 6 + 2] = z;
    }
    this.scene.add(this.streaks);

    const bird = makePlayerBird();
    this.craft = bird.group;
    this.leftWing = bird.leftWing;
    this.rightWing = bird.rightWing;
    this.scene.add(this.craft);

    window.addEventListener('resize', () => this.onResize());
  }

  /** Re-displace + recolor the terrain from the providers, reseat the world. */
  rebuildTerrain(): void {
    const pos = this.terrainMesh.geometry.attributes.position;
    const col = this.terrainMesh.geometry.attributes.color;
    const meadow = new THREE.Color(0x8fa671);
    const dry = new THREE.Color(0xb5a678);
    const stone = new THREE.Color(0x9a9183);
    const sand = new THREE.Color(0xc9bb92);
    const lakebed = new THREE.Color(0x8a967c);
    const forestFloor = new THREE.Color(0x6c8757);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = this.terrain.heightAt(x, z);
      pos.setY(i, h);
      const shore = config.waterLevel;
      if (h < shore - 2) {
        c.copy(lakebed);
      } else if (h < shore + 4) {
        // a sandy ring where land meets water — shorelines read from altitude
        c.copy(sand);
      } else {
        c.copy(meadow).lerp(dry, this.biomes.drynessAt(x, z));
        c.lerp(forestFloor, this.biomes.forestAt(x, z) * 0.65);
        if (h > 110) c.lerp(stone, Math.min(1, (h - 110) / 130));
      }
      col.setXYZ(i, c.r, c.g, c.b);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.terrainMesh.geometry.computeVertexNormals();

    this.waterMesh.position.y = config.waterLevel;
    this.rebuildForest();

    // the cairn crowns the hero hill — one landmark you can steer by
    const cy = this.terrain.heightAt(config.hillX, config.hillZ);
    this.cairn.position.set(config.hillX, cy, config.hillZ);
  }

  /**
   * Scatter trees where the forest biome says so — seeded, so the same world
   * always grows the same woods. Trees lean gently downwind: a living tell.
   */
  private rebuildForest(): void {
    if (this.trunks) {
      this.scene.remove(this.trunks);
      this.scene.remove(this.canopies!);
      this.trunks.dispose();
      this.canopies!.dispose();
    }
    const trunkGeo = new THREE.CylinderGeometry(0.35, 0.55, 4, 5);
    trunkGeo.translate(0, 2, 0);
    const canopyGeo = new THREE.ConeGeometry(3.1, 9, 6);
    canopyGeo.translate(0, 8, 0);
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6e5a41, flatShading: true });
    const canopyMat = new THREE.MeshLambertMaterial({ flatShading: true });
    this.trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, MAX_TREES);
    this.canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, MAX_TREES);

    const rng = makeRng(config.terrainSeed * 101 + 7);
    const windDir = (config.windDirDeg * Math.PI) / 180;
    const leanAxis = new THREE.Vector3(-Math.cos(windDir), 0, Math.sin(windDir)); // ⊥ to wind
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const green = new THREE.Color();
    let n = 0;
    const step = 42;
    for (let gx = -WORLD_SIZE / 2; gx < WORLD_SIZE / 2 && n < MAX_TREES; gx += step) {
      for (let gz = -WORLD_SIZE / 2; gz < WORLD_SIZE / 2 && n < MAX_TREES; gz += step) {
        const x = gx + (rng() - 0.5) * step * 1.6;
        const z = gz + (rng() - 0.5) * step * 1.6;
        const density = this.biomes.forestAt(x, z);
        if (density < 0.25 || rng() > density) continue;
        const h = this.terrain.heightAt(x, z);
        const scale = 0.75 + rng() * 0.8;
        const lean = 0.05 + 0.06 * rng(); // downwind, gently — the forest shows the wind
        q.setFromAxisAngle(leanAxis, lean);
        m.compose(new THREE.Vector3(x, h, z), q, new THREE.Vector3(scale, scale, scale));
        this.trunks.setMatrixAt(n, m);
        this.canopies.setMatrixAt(n, m);
        green.setHSL(0.29 + rng() * 0.05, 0.32 + rng() * 0.12, 0.3 + rng() * 0.09);
        this.canopies.setColorAt(n, green);
        n++;
      }
    }
    this.trunks.count = n;
    this.canopies.count = n;
    this.trunks.instanceMatrix.needsUpdate = true;
    this.canopies.instanceMatrix.needsUpdate = true;
    if (this.canopies.instanceColor) this.canopies.instanceColor.needsUpdate = true;
    this.scene.add(this.trunks, this.canopies);
  }

  /** Rebuild dust + birds when the thermal field changes (count/seed/GUI). */
  rebuildAir(): void {
    const thermals = this.thermalField.list();

    if (this.dust) this.scene.remove(this.dust);
    const count = thermals.length * DUST_PER_THERMAL;
    const positions = new Float32Array(count * 3);
    this.dustSeeds = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      this.dustSeeds[i * 3] = Math.sqrt(Math.random()); // radius fraction
      this.dustSeeds[i * 3 + 1] = Math.random(); // rise-speed variation
      this.dustSeeds[i * 3 + 2] = Math.random() * Math.PI * 2; // start angle
      const t = thermals[Math.floor(i / DUST_PER_THERMAL)];
      positions[i * 3 + 1] = Math.random() * t.top;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.dust = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: 0xcfa05e,
        size: 5,
        transparent: true,
        opacity: 0.7,
        sizeAttenuation: true,
        depthWrite: false,
      }),
    );
    this.dust.frustumCulled = false;
    this.scene.add(this.dust);

    if (this.birds) this.scene.remove(this.birds);
    this.birds = new THREE.Group();
    for (const t of thermals) {
      const ground = this.terrain.heightAt(t.x, t.z);
      for (let b = 0; b < BIRDS_PER_THERMAL; b++) {
        const bird = makeBird();
        bird.userData = {
          cx: t.x,
          cz: t.z,
          r: t.radius * (0.35 + 0.25 * b),
          h: ground + t.top * (0.35 + 0.3 * Math.random()),
          angle: Math.random() * Math.PI * 2,
          speed: 0.35 + Math.random() * 0.15, // rad/s — an unhurried circle
        };
        this.birds.add(bird);
      }
    }
    this.scene.add(this.birds);
  }

  /** Draw one frame from (interpolated) sim state. */
  render(state: AircraftState, dt: number): void {
    this.craft.position.set(state.position.x, state.position.y, state.position.z);
    // YXZ: yaw about Y, then pitch about X, then roll about the nose.
    // Nose points -Z, so positive rotation.x is nose-up and roll flips sign.
    this.craft.rotation.set(state.pitch, state.yaw, -state.roll, 'YXZ');

    // Wing arch: not flapping — the tips flex gently upward while banking
    // and when the air is carrying the bird. Smoothed so it breathes.
    const liftCarry = Math.min(1, Math.max(0, state.lift) / 5);
    const flexTarget = 0.12 * Math.abs(state.roll) + 0.07 * liftCarry;
    this.wingFlex += (flexTarget - this.wingFlex) * Math.min(1, dt * 4);
    this.leftWing.rotation.z = -this.wingFlex;
    this.rightWing.rotation.z = this.wingFlex;

    this.applyTimeOfDay(config.timeOfDay);

    // Live-rebuild the air tells / world if their config changed.
    const key = `${config.thermalCount}|${config.thermalSeed}|${config.thermalStrength}|${config.thermalRadius}|${config.thermalTop}|${config.terrainSeed}|${config.waterLevel}`;
    if (key !== this.airKey) {
      this.airKey = key;
      this.rebuildAir();
    }
    const wKey = `${config.terrainSeed}|${config.terrainAmplitude}|${config.terrainScale}|${config.waterLevel}|${config.windDirDeg}|${config.hillHeight}|${config.hillX}|${config.hillZ}`;
    if (wKey !== this.worldKey) {
      if (this.worldKey !== '') this.rebuildTerrain();
      this.worldKey = wKey;
    }

    this.animateDust(dt);
    this.animateBirds(dt);
    this.animateStreaks(dt, state);
    this.animateRipples(dt, state);

    this.camera.fov = config.camFov;
    this.camera.updateProjectionMatrix();
    this.gl.render(this.scene, this.camera);
  }

  /** Drift the dust motes upward inside each thermal, wrapping at its top. */
  private animateDust(dt: number): void {
    const thermals = this.thermalField.list();
    const pos = this.dust.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const t = thermals[Math.floor(i / DUST_PER_THERMAL)];
      if (!t) break;
      const ground = this.terrain.heightAt(t.x, t.z);
      const s0 = this.dustSeeds[i * 3];
      const s1 = this.dustSeeds[i * 3 + 1];
      let y = pos.getY(i) + (2.2 + s1 * 1.6) * dt;
      if (y > ground + t.top) y = ground + 2;
      const r = s0 * t.radius;
      const angle = this.dustSeeds[i * 3 + 2] + y * 0.012;
      pos.setXYZ(i, t.x + Math.cos(angle) * r, y, t.z + Math.sin(angle) * r);
    }
    pos.needsUpdate = true;
  }

  /** Birds circle their thermal, banked into the turn — the oldest tell there is. */
  private animateBirds(dt: number): void {
    for (const bird of this.birds.children) {
      const d = bird.userData;
      d.angle += d.speed * dt;
      bird.position.set(
        d.cx + Math.cos(d.angle) * d.r,
        d.h + Math.sin(d.angle * 2.3) * 4, // a gentle rise-and-settle on the circle
        d.cz + Math.sin(d.angle) * d.r,
      );
      // face along the tangent of the circle, lean into it
      bird.rotation.set(0, -d.angle - Math.PI / 2, 0.35, 'YXZ');
    }
  }

  /** Short streaks drifting downwind around the craft — the wind, visible. */
  private animateStreaks(dt: number, state: AircraftState): void {
    const dir = (config.windDirDeg * Math.PI) / 180;
    const wx = -Math.sin(dir) * config.windSpeed;
    const wz = -Math.cos(dir) * config.windSpeed;
    const len = Math.max(2, config.windSpeed * 0.7);
    const half = STREAK_BOX / 2;
    const p = this.streakPos;
    for (let i = 0; i < STREAK_COUNT; i++) {
      let x = p[i * 6] + wx * dt;
      let z = p[i * 6 + 2] + wz * dt;
      let y = p[i * 6 + 1];
      // keep streaks in a box around the craft, at a modest height band
      const rx = x - state.position.x;
      const rz = z - state.position.z;
      if (Math.abs(rx) > half || Math.abs(rz) > half) {
        x = state.position.x + (Math.random() - 0.5) * STREAK_BOX;
        z = state.position.z + (Math.random() - 0.5) * STREAK_BOX;
        y = Math.max(this.terrain.heightAt(x, z), config.waterLevel) + 6 + Math.random() * 130;
      }
      p[i * 6] = x;
      p[i * 6 + 1] = y;
      p[i * 6 + 2] = z;
      p[i * 6 + 3] = x + (wx / config.windSpeed || 0) * len;
      p[i * 6 + 4] = y;
      p[i * 6 + 5] = z + (wz / config.windSpeed || 0) * len;
    }
    this.streaks.geometry.attributes.position.needsUpdate = true;
  }

  /**
   * The day cycle: the sun swings low→high→low (never full night — dusk is
   * as dark as Aloft gets), light warms toward amber at the ends of the day,
   * and the sky/fog palette follows. Driven by config.timeOfDay in [0, 1].
   */
  private applyTimeOfDay(t: number): void {
    if (Math.abs(t - this.lastSkyT) < 0.002) return;
    this.lastSkyT = t;

    const phase = t * Math.PI * 2;
    const elev = (32 + 28 * Math.sin(phase)) * (Math.PI / 180); // 4°..60°
    const azim = 0.9 + 0.4 * Math.cos(phase);
    this.sun.position.set(
      Math.cos(elev) * Math.sin(azim) * 800,
      Math.sin(elev) * 800,
      Math.cos(elev) * Math.cos(azim) * 800,
    );
    // warmth: 0 at high noon, 1 at the golden ends of the day
    const warmth = 1 - Math.min(1, (elev * (180 / Math.PI) - 4) / 40);
    this.sun.color.copy(new THREE.Color(0xfff2dd).lerp(new THREE.Color(0xf2b26a), warmth));
    this.sun.intensity = 2.2 - 0.7 * warmth;
    this.hemi.intensity = 0.9 - 0.25 * warmth;

    const mix = (a: number, b: number) => '#' + new THREE.Color(a).lerp(new THREE.Color(b), warmth).getHexString();
    const ctx = this.skyCanvas.getContext('2d')!;
    const grad = ctx.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0, mix(0xa8c4d8, 0xc98f6b));
    grad.addColorStop(0.55, mix(0xcfdcd8, 0xe0b98c));
    grad.addColorStop(1, mix(0xe3e6da, 0xead9b4));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 2, 512);
    this.skyTex.needsUpdate = true;

    (this.scene.fog as THREE.Fog).color.set(mix(0xd7ddd2, 0xe4c9a4));
  }

  /** Wind-aligned dashes drifting across the lakes — the water shows the wind. */
  private animateRipples(dt: number, state: AircraftState): void {
    const dir = (config.windDirDeg * Math.PI) / 180;
    const wx = -Math.sin(dir) * config.windSpeed * 0.45;
    const wz = -Math.cos(dir) * config.windSpeed * 0.45;
    const len = Math.max(3, config.windSpeed * 0.9);
    const y = config.waterLevel + 0.25;
    const half = 1100;
    const p = this.ripplePos;
    for (let i = 0; i < RIPPLE_COUNT; i++) {
      let x = p[i * 6] + wx * dt;
      let z = p[i * 6 + 2] + wz * dt;
      const rx = x - state.position.x;
      const rz = z - state.position.z;
      const overLand = this.terrain.heightAt(x, z) > config.waterLevel - 0.5;
      if (Math.abs(rx) > half || Math.abs(rz) > half || overLand) {
        // find a watery spot near the craft; hide the ripple if none found
        let placed = false;
        for (let tries = 0; tries < 6; tries++) {
          const cx = state.position.x + (Math.random() - 0.5) * half * 2;
          const cz = state.position.z + (Math.random() - 0.5) * half * 2;
          if (this.terrain.heightAt(cx, cz) < config.waterLevel - 1) {
            x = cx;
            z = cz;
            placed = true;
            break;
          }
        }
        if (!placed) {
          p[i * 6 + 1] = -50; // parked out of sight until water comes near
          p[i * 6 + 4] = -50;
          continue;
        }
      }
      p[i * 6] = x;
      p[i * 6 + 1] = y;
      p[i * 6 + 2] = z;
      p[i * 6 + 3] = x + (wx / (config.windSpeed * 0.45 || 1)) * len;
      p[i * 6 + 4] = y;
      p[i * 6 + 5] = z + (wz / (config.windSpeed * 0.45 || 1)) * len;
    }
    this.ripples.geometry.attributes.position.needsUpdate = true;
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.gl.setSize(window.innerWidth, window.innerHeight);
  }
}

/** Wind-ripple line pool for the lakes. */
function makeWaterRipples(): { lines: THREE.LineSegments; positions: Float32Array } {
  const positions = new Float32Array(RIPPLE_COUNT * 6);
  positions.fill(-50); // parked below the world until placed on water
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const lines = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({ color: 0xe8f2ee, transparent: true, opacity: 0.45 }),
  );
  lines.frustumCulled = false;
  return { lines, positions };
}

/** A stone cairn for the hero hill's summit — the world's first name-able landmark. */
function makeCairn(): THREE.Group {
  const group = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: 0x8d8578, flatShading: true });
  const stones: Array<[number, number]> = [
    [5.2, 3.4],
    [3.9, 2.9],
    [2.8, 2.5],
    [1.8, 2.2],
  ];
  let y = 0;
  for (const [w, h] of stones) {
    const stone = new THREE.Mesh(new THREE.BoxGeometry(w, h, w * 0.9), mat);
    stone.position.set((Math.random() - 0.5) * 0.5, y + h / 2, (Math.random() - 0.5) * 0.5);
    stone.rotation.y = Math.random() * 0.6;
    group.add(stone);
    y += h * 0.82;
  }
  return group;
}

/**
 * The player: a low-poly soaring bird, nose at -Z. Long swept wings with a
 * slight dihedral read bank instantly; the body line reads pitch. A soarer
 * barely moves — stillness is the luxury — so the geometry is static and
 * the sim's orientation does the acting.
 */
function makePlayerBird(): { group: THREE.Group; leftWing: THREE.Mesh; rightWing: THREE.Mesh } {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({
    color: 0x2f5d4e,
    flatShading: true,
    side: THREE.DoubleSide,
  });
  const wingMat = new THREE.MeshLambertMaterial({
    color: 0x417262,
    flatShading: true,
    side: THREE.DoubleSide,
  });

  // body: slim, keel-breasted diamond
  const nose = [0, 0.02, -2.1];
  const tail = [0, 0.1, 1.5];
  const left = [-0.38, -0.02, -0.3];
  const right = [0.38, -0.02, -0.3];
  const top = [0, 0.34, -0.55];
  const keel = [0, -0.32, -0.35];
  const bodyTris = [
    [nose, left, top], [nose, top, right],
    [nose, keel, left], [nose, right, keel],
    [tail, top, left], [tail, right, top],
    [tail, left, keel], [tail, keel, right],
  ].flat(2);
  const bodyGeo = new THREE.BufferGeometry();
  bodyGeo.setAttribute('position', new THREE.Float32BufferAttribute(bodyTris, 3));
  bodyGeo.computeVertexNormals();
  group.add(new THREE.Mesh(bodyGeo, bodyMat));

  // wings: long, swept back, slight dihedral — one mesh per side so each
  // can flex at the root (the turn-arch animation rotates them about Z)
  const buildWing = (s: -1 | 1): THREE.Mesh => {
    const rootFront = [s * 0.25, 0.08, -0.75];
    const rootBack = [s * 0.3, 0.06, 0.35];
    const mid = [s * 2.1, 0.32, 0.05];
    const tip = [s * 3.6, 0.6, 0.75];
    const tipBack = [s * 3.0, 0.5, 1.05];
    const tris =
      s < 0
        ? [rootFront, mid, rootBack, rootBack, mid, tipBack, mid, tip, tipBack]
        : [rootFront, rootBack, mid, rootBack, tipBack, mid, mid, tipBack, tip];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(tris.flat(), 3));
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, wingMat);
  };
  const leftWing = buildWing(-1);
  const rightWing = buildWing(1);
  group.add(leftWing, rightWing);

  // tail fan
  const tailTris = [
    [0, 0.1, 1.2], [-0.65, 0.16, 2.35], [0, 0.12, 2.15],
    [0, 0.1, 1.2], [0, 0.12, 2.15], [0.65, 0.16, 2.35],
  ].flat(2);
  const tailGeo = new THREE.BufferGeometry();
  tailGeo.setAttribute('position', new THREE.Float32BufferAttribute(tailTris, 3));
  tailGeo.computeVertexNormals();
  group.add(new THREE.Mesh(tailGeo, bodyMat));

  return { group, leftWing, rightWing };
}

/** A soaring silhouette: two swept triangles, dark against the sky. */
function makeBird(): THREE.Mesh {
  const tris = [
    // left wing
    [0, 0, -1.2], [-3.2, 0.5, 0.6], [0, 0, 0.9],
    // right wing
    [0, 0, -1.2], [0, 0, 0.9], [3.2, 0.5, 0.6],
  ].flat();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3));
  geo.computeVertexNormals();
  return new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ color: 0x39423a, side: THREE.DoubleSide }),
  );
}

/** Line segments reused every frame for the drifting wind streaks. */
function makeWindStreaks(): { lines: THREE.LineSegments; positions: Float32Array } {
  const positions = new Float32Array(STREAK_COUNT * 6);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const lines = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }),
  );
  lines.frustumCulled = false;
  return { lines, positions };
}

/** Subtle two-green checker so ground motion reads everywhere, hills included. */
function makeCheckerTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f4f6ee';
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = '#e9ecdd';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillRect(64, 64, 64, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(WORLD_SIZE / 50, WORLD_SIZE / 50); // one square ≈ 25m
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}


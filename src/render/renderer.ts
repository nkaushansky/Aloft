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
const MAX_TREES = 3200;

/** One placed plant/rock: position, scale, lean axis + angle, sway phase. */
interface VegItem {
  x: number;
  y: number;
  z: number;
  s: number;
  ax: number;
  az: number;
  base: number;
  phase: number;
}

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
  private readonly waterTex: THREE.CanvasTexture;
  private vegSway: Array<{
    meshes: THREE.InstancedMesh[];
    items: VegItem[];
    amp: number;
    freq: number;
  }> = [];
  private vegStatic: THREE.InstancedMesh[] = [];
  private time = 0;
  private swayParity = 0;
  private readonly cairn: THREE.Group;
  private readonly landmarksGroup = new THREE.Group();
  readonly landmarks: { tree: { x: number; z: number }; stones: { x: number; z: number } } = {
    tree: { x: 0, z: 0 },
    stones: { x: 0, z: 0 },
  };
  private clouds: Array<{ group: THREE.Group; shadow: THREE.Mesh; drifts: boolean }> = [];
  private readonly cloudLayer = new THREE.Group();
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

    // calm water: a plane whose faint ripple bands drift with the wind —
    // one smooth scrolling texture, nothing pops or teleports
    this.waterTex = makeWaterTexture();
    this.waterMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE),
      new THREE.MeshLambertMaterial({
        color: 0x7fa3ab,
        map: this.waterTex,
        transparent: true,
        opacity: 0.92,
      }),
    );
    this.waterMesh.geometry.rotateX(-Math.PI / 2);
    this.waterMesh.position.y = config.waterLevel;
    this.scene.add(this.waterMesh);

    this.cairn = makeCairn();
    this.scene.add(this.cairn);
    this.scene.add(this.landmarksGroup);
    this.scene.add(this.cloudLayer);

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
    this.rebuildVegetation();

    // the cairn crowns the hero hill — one landmark you can steer by
    const cy = this.terrain.heightAt(config.hillX, config.hillZ);
    this.cairn.position.set(config.hillX, cy, config.hillZ);

    this.rebuildLandmarks();
  }

  /** Seeded one-off landmarks: places with names waiting for them. */
  private rebuildLandmarks(): void {
    this.landmarksGroup.clear();
    const rng = makeRng(config.terrainSeed * 997 + 3);
    const findSpot = (ok: (x: number, z: number) => boolean): { x: number; z: number } => {
      let x = 800;
      let z = 800;
      for (let tries = 0; tries < 50; tries++) {
        const angle = rng() * Math.PI * 2;
        const dist = 500 + rng() * 950;
        x = Math.cos(angle) * dist;
        z = Math.sin(angle) * dist;
        if (ok(x, z)) break;
      }
      return { x, z };
    };

    // the old tree: a lone deciduous giant on open ground
    const treeSpot = findSpot(
      (x, z) =>
        !this.biomes.isWater(x, z) &&
        this.biomes.forestAt(x, z) < 0.3 &&
        this.terrain.heightAt(x, z) > config.waterLevel + 5,
    );
    this.landmarks.tree = treeSpot;
    const tree = makeLoneTree();
    tree.position.set(treeSpot.x, this.terrain.heightAt(treeSpot.x, treeSpot.z), treeSpot.z);
    this.landmarksGroup.add(tree);

    // the standing stones: a quiet ring out in the dry country
    const stoneSpot = findSpot(
      (x, z) => this.biomes.drynessAt(x, z) > 0.35 && !this.biomes.isWater(x, z),
    );
    this.landmarks.stones = stoneSpot;
    const stones = makeStandingStones(rng);
    stones.position.set(
      stoneSpot.x,
      this.terrain.heightAt(stoneSpot.x, stoneSpot.z),
      stoneSpot.z,
    );
    this.landmarksGroup.add(stones);
  }

  /**
   * The living layer: trees, shoreline reeds, bushes, rocks, and flower
   * meadows — all seeded (the same world always grows the same life), all
   * instanced. Trees and reeds sway gently in the wind (see
   * animateVegetation); everything leans downwind, a world-wide tell.
   */
  private rebuildVegetation(): void {
    for (const g of this.vegSway) {
      for (const mesh of g.meshes) {
        this.scene.remove(mesh);
        mesh.dispose();
      }
    }
    for (const mesh of this.vegStatic) {
      this.scene.remove(mesh);
      mesh.dispose();
    }
    this.vegSway = [];
    this.vegStatic = [];

    const rng = makeRng(config.terrainSeed * 101 + 7);
    const wl = config.waterLevel;
    const windDir = (config.windDirDeg * Math.PI) / 180;
    const ax = -Math.cos(windDir); // lean axis ⊥ to the wind
    const az = Math.sin(windDir);

    const trees: VegItem[] = [];
    const treeGreens: THREE.Color[] = [];
    const reeds: VegItem[] = [];
    const bushes: VegItem[] = [];
    const bushGreens: THREE.Color[] = [];
    const rocks: VegItem[] = [];
    const rockGreys: THREE.Color[] = [];
    const flowers: VegItem[] = [];
    const flowerTints: THREE.Color[] = [];

    const grasses: VegItem[] = [];
    const grassGreens: THREE.Color[] = [];

    const step = 30;
    for (let gx = -WORLD_SIZE / 2; gx < WORLD_SIZE / 2; gx += step) {
      for (let gz = -WORLD_SIZE / 2; gz < WORLD_SIZE / 2; gz += step) {
        const x = gx + (rng() - 0.5) * step * 1.5;
        const z = gz + (rng() - 0.5) * step * 1.5;
        const h = this.terrain.heightAt(x, z);
        if (h < wl - 0.8) continue; // open water

        // reed clumps in the shallows and on the wet shore
        if (h < wl + 2.2) {
          if (rng() < 0.55 && reeds.length < 1190) {
            const clump = 3 + Math.floor(rng() * 5);
            for (let k = 0; k < clump && reeds.length < 1196; k++) {
              const rx = x + (rng() - 0.5) * 8;
              const rz = z + (rng() - 0.5) * 8;
              reeds.push({
                x: rx,
                y: Math.max(this.terrain.heightAt(rx, rz), wl - 0.4),
                z: rz,
                s: 0.7 + rng() * 0.7,
                ax,
                az,
                base: 0.04,
                phase: rng() * Math.PI * 2,
              });
            }
          }
          continue;
        }

        const forest = this.biomes.forestAt(x, z);
        const dry = this.biomes.drynessAt(x, z);

        if (forest > 0.2 && rng() < forest * 1.25 && trees.length < MAX_TREES) {
          trees.push({
            x, y: h, z,
            s: 0.75 + rng() * 0.8,
            ax, az,
            base: 0.05 + 0.06 * rng(),
            phase: rng() * Math.PI * 2,
          });
          treeGreens.push(
            new THREE.Color().setHSL(0.29 + rng() * 0.05, 0.32 + rng() * 0.12, 0.3 + rng() * 0.09),
          );
          continue;
        }
        if (forest < 0.6 && rng() < 0.16 && bushes.length < 1200) {
          bushes.push({ x, y: h, z, s: 0.8 + rng() * 1.1, ax, az, base: 0, phase: 0 });
          bushGreens.push(
            new THREE.Color().setHSL(0.26 + rng() * 0.06, 0.28 + rng() * 0.1, 0.32 + rng() * 0.08),
          );
        }
        if (rng() < 0.09 && (dry > 0.25 || h < wl + 9) && rocks.length < 540) {
          rocks.push({ x, y: h, z, s: 0.7 + rng() * 1.9, ax, az, base: 0, phase: rng() * 6 });
          const g = 0.5 + rng() * 0.14;
          rockGreys.push(new THREE.Color(g, g * 0.97, g * 0.9));
        }
        if (dry < 0.4 && forest < 0.3 && rng() < 0.13 && flowers.length < 1050) {
          const clump = 2 + Math.floor(rng() * 4);
          for (let k = 0; k < clump && flowers.length < 1056; k++) {
            const fx = x + (rng() - 0.5) * 10;
            const fz = z + (rng() - 0.5) * 10;
            flowers.push({
              x: fx, y: this.terrain.heightAt(fx, fz), z: fz,
              s: 0.7 + rng() * 0.6, ax, az, base: 0, phase: 0,
            });
            flowerTints.push(
              new THREE.Color(rng() < 0.6 ? 0xe9e2c4 : 0xd9a35e).offsetHSL(0, 0, (rng() - 0.5) * 0.06),
            );
          }
        }
        // grass tufts everywhere the meadow runs — ground texture at speed
        if (forest < 0.5 && rng() < 0.28 && grasses.length < 2400) {
          grasses.push({
            x, y: h, z,
            s: 0.7 + rng() * 0.9,
            ax, az, base: 0.05, phase: 0,
          });
          grassGreens.push(
            new THREE.Color().setHSL(0.25 + rng() * 0.05, 0.3 + rng() * 0.08, 0.34 + rng() * 0.07),
          );
        }
      }
    }

    // --- build the instanced meshes ---------------------------------------
    const fill = (
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      items: VegItem[],
      colors?: THREE.Color[],
    ): THREE.InstancedMesh => {
      const mesh = new THREE.InstancedMesh(geo, mat, Math.max(items.length, 1));
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const axis = new THREE.Vector3();
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        axis.set(it.ax, 0, it.az).normalize();
        q.setFromAxisAngle(axis, it.base);
        if (it.phase && it.base === 0) q.setFromEuler(new THREE.Euler(0, it.phase, 0)); // rocks: random yaw
        m.compose(new THREE.Vector3(it.x, it.y, it.z), q, new THREE.Vector3(it.s, it.s, it.s));
        mesh.setMatrixAt(i, m);
        if (colors) mesh.setColorAt(i, colors[i]);
      }
      mesh.count = items.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.scene.add(mesh);
      return mesh;
    };

    const trunkGeo = new THREE.CylinderGeometry(0.35, 0.55, 4, 5);
    trunkGeo.translate(0, 2, 0);
    const canopyGeo = new THREE.ConeGeometry(3.1, 9, 6);
    canopyGeo.translate(0, 8, 0);
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6e5a41, flatShading: true });
    const canopyMat = new THREE.MeshLambertMaterial({ flatShading: true });
    const trunks = fill(trunkGeo, trunkMat, trees);
    const canopies = fill(canopyGeo, canopyMat, trees, treeGreens);
    this.vegSway.push({ meshes: [trunks, canopies], items: trees, amp: 0.022, freq: 0.8 });

    const reedGeo = new THREE.CylinderGeometry(0.05, 0.1, 2.6, 4);
    reedGeo.translate(0, 1.3, 0);
    const reedMat = new THREE.MeshLambertMaterial({ color: 0x5d7442, flatShading: true });
    const reedMesh = fill(reedGeo, reedMat, reeds);
    this.vegSway.push({ meshes: [reedMesh], items: reeds, amp: 0.11, freq: 1.4 });

    const bushGeo = new THREE.IcosahedronGeometry(1.4, 0);
    bushGeo.scale(1.2, 0.75, 1.2);
    bushGeo.translate(0, 0.8, 0);
    this.vegStatic.push(
      fill(bushGeo, new THREE.MeshLambertMaterial({ flatShading: true }), bushes, bushGreens),
    );

    const rockGeo = new THREE.IcosahedronGeometry(1.1, 0);
    rockGeo.scale(1.3, 0.8, 1);
    rockGeo.translate(0, 0.5, 0);
    this.vegStatic.push(
      fill(rockGeo, new THREE.MeshLambertMaterial({ flatShading: true }), rocks, rockGreys),
    );

    const flowerGeo = new THREE.OctahedronGeometry(0.34, 0);
    flowerGeo.translate(0, 0.65, 0);
    this.vegStatic.push(
      fill(flowerGeo, new THREE.MeshLambertMaterial({ flatShading: true }), flowers, flowerTints),
    );

    const grassGeo = new THREE.ConeGeometry(0.55, 1.3, 4);
    grassGeo.translate(0, 0.6, 0);
    this.vegStatic.push(
      fill(grassGeo, new THREE.MeshLambertMaterial({ flatShading: true }), grasses, grassGreens),
    );
  }

  /** Trees rock slowly, reeds flutter faster — the wind made visible, always.
   *  Each frame updates half the instances (alternating), so doubling the
   *  forest doesn't double the per-frame cost; at 60Hz the eye can't tell. */
  private animateVegetation(dt: number): void {
    this.time += dt;
    this.swayParity = 1 - this.swayParity;
    const windF = Math.min(1.6, config.windSpeed / 9);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const axis = new THREE.Vector3();
    const p = new THREE.Vector3();
    const sc = new THREE.Vector3();
    for (const g of this.vegSway) {
      for (let i = this.swayParity; i < g.items.length; i += 2) {
        const it = g.items[i];
        const angle = it.base + g.amp * windF * Math.sin(this.time * g.freq + it.phase);
        axis.set(it.ax, 0, it.az).normalize();
        q.setFromAxisAngle(axis, angle);
        p.set(it.x, it.y, it.z);
        sc.set(it.s, it.s, it.s);
        m.compose(p, q, sc);
        for (const mesh of g.meshes) mesh.setMatrixAt(i, m);
      }
      for (const mesh of g.meshes) mesh.instanceMatrix.needsUpdate = true;
    }
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

    // clouds: a cumulus cap over every thermal (the sky marks the lift, the
    // way real soaring pilots read it) plus free drifters for the postcard
    this.cloudLayer.clear();
    this.clouds = [];
    const addCloud = (x: number, y: number, z: number, size: number, drifts: boolean) => {
      const group = makeCloud(size);
      group.position.set(x, y, z);
      const shadow = makeCloudShadow(size);
      shadow.position.set(x, 0, z);
      this.cloudLayer.add(group, shadow);
      this.clouds.push({ group, shadow, drifts });
    };
    for (const t of thermals) {
      const ground = this.terrain.heightAt(t.x, t.z);
      addCloud(t.x, ground + t.top + 70, t.z, t.radius * 1.35, false);
    }
    for (let i = 0; i < config.cloudCount; i++) {
      addCloud(
        (Math.random() - 0.5) * 4200,
        420 + Math.random() * 160,
        (Math.random() - 0.5) * 4200,
        130 + Math.random() * 110,
        true,
      );
    }
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
    const key = `${config.thermalCount}|${config.thermalSeed}|${config.thermalStrength}|${config.thermalRadius}|${config.thermalTop}|${config.terrainSeed}|${config.waterLevel}|${config.cloudCount}`;
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
    this.animateWater(dt);
    this.animateClouds(dt, state);
    this.animateVegetation(dt);

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

  /** The lakes' ripple bands drift steadily downwind — smooth, never popping. */
  private animateWater(dt: number): void {
    const dir = (config.windDirDeg * Math.PI) / 180;
    const patch = WORLD_SIZE / this.waterTex.repeat.x; // meters per texture tile
    // plane UVs: u tracks +x, v tracks -z
    this.waterTex.offset.x -= (-Math.sin(dir) * config.windSpeed * 0.5 * dt) / patch;
    this.waterTex.offset.y += (-Math.cos(dir) * config.windSpeed * 0.5 * dt) / patch;
  }

  /** Drift the free clouds downwind; drape every cloud's shadow on the land. */
  private animateClouds(dt: number, state: AircraftState): void {
    const dir = (config.windDirDeg * Math.PI) / 180;
    const wx = -Math.sin(dir) * config.windSpeed * 0.5;
    const wz = -Math.cos(dir) * config.windSpeed * 0.5;
    for (const cloud of this.clouds) {
      if (cloud.drifts) {
        cloud.group.position.x += wx * dt;
        cloud.group.position.z += wz * dt;
        // wrap around the craft so the sky never empties
        const rx = cloud.group.position.x - state.position.x;
        const rz = cloud.group.position.z - state.position.z;
        if (Math.abs(rx) > 2400 || Math.abs(rz) > 2400) {
          cloud.group.position.x = state.position.x - Math.sign(rx || 1) * 2300 + (Math.random() - 0.5) * 600;
          cloud.group.position.z = state.position.z - Math.sign(rz || 1) * 2300 + (Math.random() - 0.5) * 600;
        }
      }
      const shadow = cloud.shadow;
      shadow.position.x = cloud.group.position.x;
      shadow.position.z = cloud.group.position.z;
      (shadow.material as THREE.MeshBasicMaterial).opacity = config.cloudShadow;
      // drape the shadow disc over the terrain beneath it
      const pos = shadow.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const wxV = shadow.position.x + pos.getX(i) * shadow.scale.x;
        const wzV = shadow.position.z + pos.getZ(i) * shadow.scale.z;
        pos.setY(
          i,
          Math.max(this.terrain.heightAt(wxV, wzV), config.waterLevel) + 1.2,
        );
      }
      pos.needsUpdate = true;
    }
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.gl.setSize(window.innerWidth, window.innerHeight);
  }
}

/** A lumpy flat-shaded cumulus: a few squashed spheres huddled together. */
function makeCloud(size: number): THREE.Group {
  const group = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: 0xf3f5f0, flatShading: true });
  const lumps = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < lumps; i++) {
    const lump = new THREE.Mesh(new THREE.SphereGeometry(1, 7, 5), mat);
    const s = size * (0.35 + Math.random() * 0.4);
    lump.scale.set(s, s * 0.45, s * 0.8);
    lump.position.set(
      (Math.random() - 0.5) * size * 1.1,
      (Math.random() - 0.5) * size * 0.12,
      (Math.random() - 0.5) * size * 0.5,
    );
    group.add(lump);
  }
  return group;
}

/** A soft dark disc, draped over the terrain each frame by animateClouds. */
function makeCloudShadow(size: number): THREE.Mesh {
  const geo = new THREE.CircleGeometry(1, 18);
  geo.rotateX(-Math.PI / 2);
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(64, 64, 8, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(0.7, 'rgba(0,0,0,0.7)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(canvas);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      color: 0x1c2620,
      alphaMap: tex,
      transparent: true,
      opacity: 0.13,
      depthWrite: false,
    }),
  );
  mesh.scale.set(size * 1.15, 1, size * 1.15);
  mesh.frustumCulled = false;
  return mesh;
}

/** The old tree: a lone deciduous giant — a place with a name waiting. */
function makeLoneTree(): THREE.Group {
  const group = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(1.2, 2.0, 16, 6),
    new THREE.MeshLambertMaterial({ color: 0x6e5a41, flatShading: true }),
  );
  trunk.position.y = 8;
  group.add(trunk);
  const canopyMat = new THREE.MeshLambertMaterial({ color: 0x4a7247, flatShading: true });
  const lumps: Array<[number, number, number, number]> = [
    [0, 21, 0, 10],
    [-6, 18, 2, 6.5],
    [5, 19, -3, 7],
    [2, 24, 3, 5.5],
  ];
  for (const [x, y, z, s] of lumps) {
    const lump = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), canopyMat);
    lump.scale.set(s, s * 0.75, s);
    lump.position.set(x, y, z);
    group.add(lump);
  }
  return group;
}

/** The standing stones: a quiet ring out in the dry country. */
function makeStandingStones(rng: () => number): THREE.Group {
  const group = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: 0x8d8578, flatShading: true });
  const count = 7;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const h = 5.5 + rng() * 3;
    const stone = new THREE.Mesh(new THREE.BoxGeometry(1.9, h, 1.1), mat);
    stone.position.set(Math.cos(angle) * 11, h / 2 - 0.3, Math.sin(angle) * 11);
    stone.rotation.set((rng() - 0.5) * 0.12, angle + rng() * 0.5, (rng() - 0.5) * 0.12);
    group.add(stone);
  }
  return group;
}

/** Faint irregular ripple bands, tiled across the water and scrolled by wind. */
function makeWaterTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  // soft light bands with a gentle wobble — reads as wind-brushed water
  for (let band = 0; band < 7; band++) {
    const y0 = (band / 7) * size + Math.random() * 14;
    ctx.beginPath();
    for (let x = 0; x <= size; x += 8) {
      const y = y0 + Math.sin((x / size) * Math.PI * 4 + band * 1.7) * 5;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = 'rgba(240,247,245,0.85)';
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(WORLD_SIZE / 90, WORLD_SIZE / 90); // one tile ≈ 90m of water
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
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


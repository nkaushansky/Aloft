import * as THREE from 'three';
import type { AircraftState } from '../sim/state';
import type { TerrainProvider } from '../sim/terrain';
import type { ThermalField } from '../sim/lift';
import { config } from '../sim/config';

const WORLD_SIZE = 6000;
const TERRAIN_SEGMENTS = 200;
const DUST_PER_THERMAL = 80;
const BIRDS_PER_THERMAL = 2;
const STREAK_COUNT = 140;
const STREAK_BOX = 900; // wind streaks live in a box this wide around the craft

/**
 * Phase 2 scene: the air made visible. Rolling vertex-colored terrain from
 * the provider, a dust column and circling birds marking every thermal, and
 * wind streaks drifting downwind so the wind is legible everywhere.
 */
export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly gl: THREE.WebGLRenderer;
  private readonly wedge: THREE.Mesh;
  private readonly terrainMesh: THREE.Mesh;
  private readonly pylons: THREE.Group;
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

    this.scene.background = makeSkyTexture();
    this.scene.fog = new THREE.Fog(0xd7ddd2, 450, 3400);

    const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
    sun.position.set(300, 500, 200);
    this.scene.add(sun);
    this.scene.add(new THREE.HemisphereLight(0xcfe0d8, 0x8a8468, 0.9));

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

    this.pylons = new THREE.Group();
    this.scene.add(this.pylons);
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

    this.wedge = makeWedge();
    this.scene.add(this.wedge);

    window.addEventListener('resize', () => this.onResize());
  }

  /** Re-displace + recolor the terrain and reseat pylons from the provider. */
  rebuildTerrain(): void {
    const pos = this.terrainMesh.geometry.attributes.position;
    const col = this.terrainMesh.geometry.attributes.color;
    const meadow = new THREE.Color(0x8fa671);
    const dry = new THREE.Color(0xa8a377);
    const stone = new THREE.Color(0x9a9183);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const h = this.terrain.heightAt(pos.getX(i), pos.getZ(i));
      pos.setY(i, h);
      // meadow low, dry grass mid, stone high — height itself becomes legible
      if (h < 90) c.copy(meadow).lerp(dry, h / 90);
      else c.copy(dry).lerp(stone, Math.min(1, (h - 90) / 140));
      col.setXYZ(i, c.r, c.g, c.b);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.terrainMesh.geometry.computeVertexNormals();

    if (this.pylons.children.length === 0) {
      const geo = new THREE.BoxGeometry(1.6, 1, 1.6);
      const mats = [
        new THREE.MeshLambertMaterial({ color: 0xc4bdac }),
        new THREE.MeshLambertMaterial({ color: 0xb3a184 }),
      ];
      for (let i = 0; i < 90; i++) {
        const pylon = new THREE.Mesh(geo, mats[i % 2]);
        pylon.userData.h = 12 + Math.random() * 34;
        pylon.userData.x = (Math.random() - 0.5) * 3600;
        pylon.userData.z = (Math.random() - 0.5) * 3600;
        this.pylons.add(pylon);
      }
    }
    for (const pylon of this.pylons.children) {
      const { h, x, z } = pylon.userData;
      pylon.scale.y = h;
      pylon.position.set(x, this.terrain.heightAt(x, z) + h / 2, z);
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
  }

  /** Draw one frame from (interpolated) sim state. */
  render(state: AircraftState, dt: number): void {
    this.wedge.position.set(state.position.x, state.position.y, state.position.z);
    // YXZ: yaw about Y, then pitch about X, then roll about the nose.
    // Nose points -Z, so positive rotation.x is nose-up and roll flips sign.
    this.wedge.rotation.set(state.pitch, state.yaw, -state.roll, 'YXZ');

    // Live-rebuild the air tells if the thermal field's config changed.
    const key = `${config.thermalCount}|${config.thermalSeed}|${config.thermalStrength}|${config.thermalRadius}|${config.thermalTop}`;
    if (key !== this.airKey) {
      this.airKey = key;
      this.rebuildAir();
    }

    this.animateDust(dt);
    this.animateBirds(dt);
    this.animateStreaks(dt, state);

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
        y = this.terrain.heightAt(x, z) + 6 + Math.random() * 130;
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

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.gl.setSize(window.innerWidth, window.innerHeight);
  }
}

/** Flat-shaded arrowhead: nose at -Z, a raised tail fin so bank reads. */
function makeWedge(): THREE.Mesh {
  const nose = [0, 0.25, -2.8];
  const left = [-1.5, 0, 1.4];
  const right = [1.5, 0, 1.4];
  const top = [0, 0.9, 1.0];
  const tris = [
    [nose, right, top],
    [nose, top, left],
    [nose, left, right],
    [left, top, right],
  ].flat(2);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({
    color: 0x2f5d4e,
    flatShading: true,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geo, mat);
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

/** Vertical gradient sky: haze at the horizon, up to pale blue. */
function makeSkyTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#a8c4d8');
  grad.addColorStop(0.55, '#cfdcd8');
  grad.addColorStop(1, '#e3e6da');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 2, 512);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

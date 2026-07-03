import * as THREE from 'three';
import type { AircraftState } from '../sim/state';
import type { TerrainProvider } from '../sim/terrain';
import { config } from '../sim/config';

const WORLD_SIZE = 6000;
const TERRAIN_SEGMENTS = 180;

/**
 * Everything visual for Phase 1. Still instrumentation over art: a faceted
 * terrain mesh built from the TerrainProvider, a dust column marking the
 * thermal, pylons for speed reference, and the wedge.
 */
export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly gl: THREE.WebGLRenderer;
  private readonly wedge: THREE.Mesh;
  private readonly terrainMesh: THREE.Mesh;
  private readonly pylons: THREE.Group;
  private readonly dust: THREE.Points;
  private readonly dustSeeds: Float32Array;

  constructor(
    container: HTMLElement,
    private readonly terrain: TerrainProvider,
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
    this.scene.fog = new THREE.Fog(0xd7ddd2, 500, 3600);

    const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
    sun.position.set(300, 500, 200);
    this.scene.add(sun);
    this.scene.add(new THREE.HemisphereLight(0xcfe0d8, 0x8a8468, 0.9));

    this.terrainMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS),
      new THREE.MeshLambertMaterial({ map: makeCheckerTexture(), flatShading: true }),
    );
    this.terrainMesh.geometry.rotateX(-Math.PI / 2);
    this.scene.add(this.terrainMesh);

    this.pylons = new THREE.Group();
    this.scene.add(this.pylons);
    this.rebuildTerrain();

    const dustParts = makeThermalDust();
    this.dust = dustParts.points;
    this.dustSeeds = dustParts.seeds;
    this.scene.add(this.dust);

    this.wedge = makeWedge();
    this.scene.add(this.wedge);

    window.addEventListener('resize', () => this.onResize());
  }

  /**
   * Re-displace the terrain mesh and reseat the pylons from the provider.
   * Called at startup and whenever hill parameters change in the GUI.
   */
  rebuildTerrain(): void {
    const pos = this.terrainMesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, this.terrain.heightAt(pos.getX(i), pos.getZ(i)));
    }
    pos.needsUpdate = true;
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

  /** Draw one frame from (interpolated) sim state. */
  render(state: AircraftState, dt: number): void {
    this.wedge.position.set(state.position.x, state.position.y, state.position.z);
    // YXZ: yaw about Y, then pitch about X, then roll about the nose.
    // Nose points -Z, so positive rotation.x is nose-up and roll flips sign.
    this.wedge.rotation.set(state.pitch, state.yaw, -state.roll, 'YXZ');

    this.animateDust(dt);

    this.camera.fov = config.camFov;
    this.camera.updateProjectionMatrix();
    this.gl.render(this.scene, this.camera);
  }

  /** Drift the dust motes upward inside the thermal column, wrapping at the top. */
  private animateDust(dt: number): void {
    const pos = this.dust.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const s0 = this.dustSeeds[i * 3];
      const s1 = this.dustSeeds[i * 3 + 1];
      let y = pos.getY(i) + (2.2 + s1 * 1.6) * dt; // each mote rises at its own pace
      if (y > config.thermalTop) y = 2;
      // Motes orbit the (config-live) thermal center so GUI moves carry them.
      const r = s0 * config.thermalRadius;
      const angle = this.dustSeeds[i * 3 + 2] + y * 0.012;
      pos.setXYZ(
        i,
        config.thermalX + Math.cos(angle) * r,
        y,
        config.thermalZ + Math.sin(angle) * r,
      );
    }
    pos.needsUpdate = true;
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

/** Sparse drifting dust motes that make the thermal findable without a HUD. */
function makeThermalDust(): { points: THREE.Points; seeds: Float32Array } {
  const COUNT = 260;
  const positions = new Float32Array(COUNT * 3);
  const seeds = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT; i++) {
    seeds[i * 3] = Math.sqrt(Math.random()); // radius fraction (denser near core)
    seeds[i * 3 + 1] = Math.random(); // rise-speed variation
    seeds[i * 3 + 2] = Math.random() * Math.PI * 2; // start angle
    positions[i * 3 + 1] = Math.random() * config.thermalTop; // start height
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xcfa05e,
    size: 5,
    transparent: true,
    opacity: 0.7,
    sizeAttenuation: true,
    depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false; // positions move every frame; skip stale-bounds culling
  return { points, seeds };
}

/** Subtle two-green checker so ground motion reads everywhere, hills included. */
function makeCheckerTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#93a878';
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = '#8aa06e';
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

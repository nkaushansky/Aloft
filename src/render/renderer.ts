import * as THREE from 'three';
import type { AircraftState } from '../sim/state';
import { config } from '../sim/config';

/**
 * Everything visual for Phase 0. This is instrumentation, not art: a gridded
 * plane and pylons so motion reads, a gradient sky, and a wedge whose only job
 * is to show forward direction, pitch, and bank at a glance.
 */
export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly gl: THREE.WebGLRenderer;
  private readonly wedge: THREE.Mesh;

  constructor(container: HTMLElement) {
    this.gl = new THREE.WebGLRenderer({ antialias: true });
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.gl.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(this.gl.domElement);

    this.camera = new THREE.PerspectiveCamera(
      config.camFov,
      window.innerWidth / window.innerHeight,
      0.1,
      6000,
    );

    this.scene.background = makeSkyTexture();
    this.scene.fog = new THREE.Fog(0xd7ddd2, 500, 3200);

    // light: one warm sun + soft sky/ground fill
    const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
    sun.position.set(300, 500, 200);
    this.scene.add(sun);
    this.scene.add(new THREE.HemisphereLight(0xcfe0d8, 0x8a8468, 0.9));

    // ground plane + grid so speed and height read
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(8000, 8000),
      new THREE.MeshLambertMaterial({ color: 0x9db287 }),
    );
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(8000, 320, 0x5e7250, 0x74875f);
    grid.position.y = 0.05;
    this.scene.add(grid);

    this.scene.add(makePylons());

    this.wedge = makeWedge();
    this.scene.add(this.wedge);

    window.addEventListener('resize', () => this.onResize());
  }

  /** Draw one frame from (interpolated) sim state. */
  render(state: AircraftState): void {
    this.wedge.position.set(state.position.x, state.position.y, state.position.z);
    // YXZ: yaw about Y, then pitch about X, then roll about the nose.
    // Nose points -Z, so positive rotation.x is nose-up and roll flips sign.
    this.wedge.rotation.set(state.pitch, state.yaw, -state.roll, 'YXZ');

    this.camera.fov = config.camFov;
    this.camera.updateProjectionMatrix();
    this.gl.render(this.scene, this.camera);
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
  // Non-indexed triangle soup; DoubleSide + flat shading keeps it simple.
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

/** A scatter of tall thin pylons — speed/altitude/turn reference posts. */
function makePylons(): THREE.Group {
  const group = new THREE.Group();
  const geo = new THREE.BoxGeometry(1.6, 1, 1.6);
  const mats = [
    new THREE.MeshLambertMaterial({ color: 0xc4bdac }),
    new THREE.MeshLambertMaterial({ color: 0xb3a184 }),
  ];
  for (let i = 0; i < 90; i++) {
    const h = 12 + Math.random() * 34;
    const pylon = new THREE.Mesh(geo, mats[i % 2]);
    pylon.scale.y = h;
    pylon.position.set(
      (Math.random() - 0.5) * 3200,
      h / 2,
      (Math.random() - 0.5) * 3200,
    );
    group.add(pylon);
  }
  return group;
}

/** Vertical gradient sky as a background texture: haze at the horizon, up to pale blue. */
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

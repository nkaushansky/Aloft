import * as THREE from 'three';
import type { Config } from '../../sim/config';
import type {
  BiomeProvider,
  BiomeSample,
  QualitySettings,
  SkyState,
  TerrainProvider,
  TerrainSample,
} from '../../sim/types';
import { BiomeKind } from '../../sim/types';
import { TAU, clamp, clamp01, damp, lerp, smoothstep } from '../../sim/math';
import { hash2 } from '../../sim/noise';
import {
  ATMOSPHERE_PRELUDE,
  ATMOSPHERE_UNIFORMS_GLSL,
  withAtmosphere,
  type AtmosphereUniforms,
} from '../shaders/atmosphere';

/**
 * GROUND DETAIL — and one piece of instrumentation hiding in it.
 *
 * Trees, boulders and dry grass, streamed around the camera on jittered grids
 * and placed entirely from the world's own providers, so a seed grows the same
 * forest every time it is flown. Nothing here is random at runtime: a cell's
 * contents are a pure function of its integer coordinates and the seed, which
 * is why a stand of pines you passed on the way out is still there, tree for
 * tree, on the way back.
 *
 * THE LEAN IS THE POINT. Every plant bends downwind in the vertex shader, by
 * an amount proportional to the wind and to its own height. A whole hillside
 * bending one way tells you which face of that ridge is windward — and the
 * windward face is where the ridge lift is. That is a wind sock the size of a
 * mountain, drawn for free, and it is the cheapest honest lift cue in the game.
 *
 * Three streaming grids, coarsening outward, because one grid cannot be both
 * dense enough to read as a wood underfoot and cheap enough to reach a
 * kilometre and a half:
 *
 *   detail  7 m cells to  266 m — dry grass clumps
 *   near   12 m cells to  420 m — full geometry: conifers, broadleaf, boulders
 *   far    30 m cells to 1350 m — camera-facing canopy billboards
 *
 * The near geometry dissolves out exactly where the far billboards dissolve
 * in, both tinted from the same biome colour, so the handover is a thickening
 * of the canopy rather than a line of popping trees. Past the far grid the
 * terrain's own forest colour carries it, which is the honest answer: at 1.5 km
 * an individual tree is a quarter of a pixel.
 */

// ============================================================== STREAMING

/** Grid pitch (m) and reach (m) of each reg. Reach is rounded to whole cells. */
const DETAIL_CELL = 7;
const DETAIL_REACH = 266;
const NEAR_CELL = 12;
const NEAR_REACH = 420;
const FAR_CELL = 30;
const FAR_REACH = 1350;

/** Field ids, which are also indices into the fill switch. */
const F_DETAIL = 0;
const F_NEAR = 1;
const F_FAR = 2;

/** Batch ids. A cell stores which batch its instance lives in. */
const B_CONIFER = 0;
const B_BROADLEAF = 1;
const B_ROCK = 2;
const B_GRASS = 3;
const B_BILLBOARD = 4;
const BATCH_COUNT = 5;

/**
 * How far off its cell centre a plant may sit, as a fraction of the cell. Below
 * about 0.8 the grid starts showing through as rows; at 1.0 neighbours would
 * be free to land on top of each other.
 */
const JITTER = 0.9;

/**
 * Acceptance ceilings, per cell, at full canopy. These and the cell sizes are
 * the whole density budget: near forest tops out around one tree per 230 m²,
 * which reads as woodland from a hundred metres up and costs ~3000 instances.
 */
const TREE_P = 0.62;
const FAR_TREE_P = 0.5;
const ROCK_P = 0.13;
const GRASS_P = 0.45;

/**
 * Slots reserved per batch, as a fraction of what its grid could ever accept.
 * Sized at construction and never grown — a region denser than its allowance
 * simply drops the overflow cells, which thins a forest instead of breaking it.
 */
const TREE_SHARE = 0.72;
const ROCK_SHARE = 0.7;
const GRASS_SHARE = 0.75;
const BILLBOARD_SHARE = 0.92;

/** Slots examined per grid per frame. Cheap: it is two integer compares. */
const SCAN_PER_FIELD = 2048;
/** Cells actually rebuilt per frame, once the world is up, and while it boots. */
const FILL_BUDGET = 260;
const FILL_BUDGET_BOOT = 2400;

/**
 * A camera jump further than this many cells means a new run or a teleport, not
 * flight. Everything is released at once rather than trickled, so no stale
 * forest is ever left standing a continent away from where the bird now is.
 */
const TELEPORT_CELLS = 3;

// =================================================================== LOD
//
// Every fade must finish before the NEAREST point a newly arrived cell can
// occupy, or something would blink into existence at full strength. That point
// is (r - 1.45) cells out: one cell because the camera sits somewhere inside
// its own cell, and 0.45 more because jitter can pull a plant that much toward
// the eye. Detail 255 m, near 402 m, far 1306 m — these sit just inside.

const GRASS_FADE = [172, 252] as const;
const TREE_FADE = [306, 398] as const;
const ROCK_FADE = [242, 386] as const;
/** Billboards fade in as the near geometry leaves, and out at the far edge. */
const BILLBOARD_FADE = [268, 400, 1090, 1300] as const;

// ================================================================== WIND
//
// Lean is in metres of downwind displacement per metre of plant height, at the
// day's reference wind. A 20 m conifer at 0.2 puts its crown 4 m downwind —
// about eleven degrees, which is unmistakable across a hillside and still
// looks like a tree rather than a flag.

const CONIFER_STYLE: PlantStyle = {
  bark: [0.042, 0.030, 0.024],
  trans: 0.55,
  lean: 0.2,
  swayAmp: 0.035,
  swayRate: 1.05,
  aoBase: 0.42,
  doubleSided: false,
};

const BROADLEAF_STYLE: PlantStyle = {
  bark: [0.055, 0.042, 0.031],
  // Broad leaves are thin and light comes straight through them; this is what
  // turns a wood into stained glass when the sun is on the deck.
  trans: 1.15,
  lean: 0.26,
  swayAmp: 0.055,
  swayRate: 1.35,
  aoBase: 0.4,
  doubleSided: false,
};

const ROCK_STYLE: PlantStyle = {
  bark: [0.12, 0.115, 0.125],
  trans: 0,
  lean: 0,
  swayAmp: 0,
  swayRate: 0,
  aoBase: 0.5,
  doubleSided: false,
};

const GRASS_STYLE: PlantStyle = {
  bark: [0.09, 0.08, 0.04],
  trans: 1.5,
  // Grass gives up completely — it lies down in a blow, which is what sells
  // the wind at the one scale the player can see individual blades bending.
  lean: 0.38,
  swayAmp: 0.16,
  swayRate: 2.7,
  aoBase: 0.3,
  doubleSided: true,
};

const BILLBOARD_STYLE: PlantStyle = {
  bark: [0.03, 0.026, 0.02],
  trans: 0.7,
  lean: 0.17,
  swayAmp: 0.02,
  swayRate: 0.9,
  aoBase: 0.45,
  doubleSided: true,
};

/** How much a far billboard stands in for: a clump, not a single tree. */
const CLUMP_WIDTH = 2.1;
const CLUMP_HEIGHT = 1.2;

/**
 * How far the billboard's up vector is allowed to tip toward the camera's own
 * up. Zero and a canopy vanishes edge-on the moment you fly over it; one and
 * every distant tree lies down flat on its side as you pass.
 */
const BILLBOARD_TILT = 0.42;

// ================================================================ SPECIES

/** Trunk half-width and crown radius are baked into the unit geometries. */
const CONIFER_GEOM_RADIUS = 0.3;
const BROADLEAF_GEOM_RADIUS = 0.4;

/** Real crown radius as a fraction of height, per species. */
const CONIFER_CROWN = [0.1, 0.155] as const;
const BROADLEAF_CROWN = [0.26, 0.38] as const;

// ================================================================ SCRATCH
//
// Placement runs a few hundred times a frame and may not allocate.

const _ts: TerrainSample = { height: 0, nx: 0, ny: 1, nz: 0, slope: 0 };
const _bs: BiomeSample = {
  kind: BiomeKind.Meadow,
  heat: 0,
  forest: 0,
  moisture: 0,
  r: 0.2,
  g: 0.2,
  b: 0.15,
};
const _col = { r: 0, g: 0, b: 0 };

/** How much grass a biome carries, before moisture and slope have their say. */
const GRASSINESS: Record<BiomeKind, number> = {
  [BiomeKind.Water]: 0,
  [BiomeKind.Shore]: 0.34,
  [BiomeKind.Meadow]: 1,
  [BiomeKind.Forest]: 0.42,
  [BiomeKind.Scrub]: 0.82,
  [BiomeKind.Desert]: 0.18,
  [BiomeKind.Rock]: 0.1,
  [BiomeKind.Snow]: 0,
};

/** How much loose stone a biome shows. Scree lives where the ground is bare. */
const ROCKINESS: Record<BiomeKind, number> = {
  [BiomeKind.Water]: 0,
  [BiomeKind.Shore]: 0.4,
  [BiomeKind.Meadow]: 0.16,
  [BiomeKind.Forest]: 0.2,
  [BiomeKind.Scrub]: 0.45,
  [BiomeKind.Desert]: 0.35,
  [BiomeKind.Rock]: 1,
  [BiomeKind.Snow]: 0.3,
};

// ================================================================ GEOMETRY
//
// Everything is built in code, flat-shaded and non-indexed: a face's three
// vertices carry its own normal, which is what gives these chunky little
// things their hard facets. A few dozen triangles each, all silhouette.

/** GLSL float literal from a JS number. */
const glf = (v: number): string => v.toFixed(4);

class GeomBuilder {
  private readonly pos: number[] = [];
  private readonly nrm: number[] = [];
  private readonly hgt: number[] = [];
  private readonly fol: number[] = [];
  private readonly invH: number;

  /** `height` is the tallest y the shape reaches; it normalizes the sway weight. */
  constructor(height: number) {
    this.invH = 1 / Math.max(height, 1e-4);
  }

  tri(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    foliage: number,
  ): void {
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    this.nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    this.hgt.push(
      clamp01(ay * this.invH),
      clamp01(by * this.invH),
      clamp01(cy * this.invH),
    );
    this.fol.push(foliage, foliage, foliage);
  }

  quad(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    foliage: number,
  ): void {
    this.tri(ax, ay, az, bx, by, bz, cx, cy, cz, foliage);
    this.tri(ax, ay, az, cx, cy, cz, dx, dy, dz, foliage);
  }

  /** A tapered prism trunk, `sides` wide. Cheap, and it holds the silhouette. */
  trunk(y0: number, y1: number, r0: number, r1: number, sides: number): void {
    for (let k = 0; k < sides; k++) {
      const a0 = (k / sides) * TAU;
      const a1 = ((k + 1) / sides) * TAU;
      const c0 = Math.cos(a0);
      const s0 = Math.sin(a0);
      const c1 = Math.cos(a1);
      const s1 = Math.sin(a1);
      this.quad(
        c0 * r0, y0, s0 * r0,
        c1 * r0, y0, s1 * r0,
        c1 * r1, y1, s1 * r1,
        c0 * r1, y1, s0 * r1,
        0,
      );
    }
  }

  /** One skirt of a conifer: an open cone plus its shadowed underside. */
  cone(yBase: number, yTop: number, radius: number, sides: number, phase: number): void {
    for (let k = 0; k < sides; k++) {
      const a0 = (k / sides) * TAU + phase;
      const a1 = ((k + 1) / sides) * TAU + phase;
      const x0 = Math.cos(a0) * radius;
      const z0 = Math.sin(a0) * radius;
      const x1 = Math.cos(a1) * radius;
      const z1 = Math.sin(a1) * radius;
      this.tri(0, yTop, 0, x1, yBase, z1, x0, yBase, z0, 1);
      this.tri(0, yBase, 0, x0, yBase, z0, x1, yBase, z1, 1);
    }
  }

  /** A flattened octahedron — one lobe of a broadleaf crown. */
  blob(cx: number, cy: number, cz: number, r: number, ry: number): void {
    const ex = [r, 0, -r, 0];
    const ez = [0, r, 0, -r];
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) & 3;
      this.tri(
        cx, cy + ry, cz,
        cx + ex[j], cy, cz + ez[j],
        cx + ex[k], cy, cz + ez[k],
        1,
      );
      this.tri(
        cx, cy - ry, cz,
        cx + ex[k], cy, cz + ez[k],
        cx + ex[j], cy, cz + ez[j],
        1,
      );
    }
  }

  finish(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('aH', new THREE.BufferAttribute(new Float32Array(this.hgt), 1));
    g.setAttribute('aFoliage', new THREE.BufferAttribute(new Float32Array(this.fol), 1));
    return g;
  }
}

/**
 * A conifer: three stacked pentagonal skirts on a stub of trunk, tapering to a
 * point at y = 1. Unit height; the instance matrix does the rest.
 */
function buildConifer(): THREE.BufferGeometry {
  const g = new GeomBuilder(1);
  g.trunk(0, 0.62, 0.045, 0.026, 4);
  const base = [0.18, 0.415, 0.65];
  const top = [0.66, 0.83, 1.0];
  const rad = [CONIFER_GEOM_RADIUS, 0.225, 0.145];
  for (let i = 0; i < 3; i++) g.cone(base[i], top[i], rad[i], 5, i * 0.7);
  return g.finish();
}

/** A broadleaf: a short trunk under four overlapping lobes of crown. */
function buildBroadleaf(): THREE.BufferGeometry {
  const g = new GeomBuilder(1);
  g.trunk(0, 0.5, 0.05, 0.034, 4);
  g.blob(0, 0.63, 0, BROADLEAF_GEOM_RADIUS, 0.3);
  g.blob(0.2, 0.5, -0.11, 0.25, 0.19);
  g.blob(-0.17, 0.72, 0.13, 0.24, 0.18);
  g.blob(0.05, 0.85, 0.03, 0.19, 0.15);
  return g.finish();
}

/**
 * A boulder: a cube with every corner pulled somewhere else. Twelve triangles
 * and a hard, readable shape — which is all a rock has to be.
 */
function buildRock(): THREE.BufferGeometry {
  const g = new GeomBuilder(0.85);
  const cx = new Float64Array(8);
  const cy = new Float64Array(8);
  const cz = new Float64Array(8);
  for (let i = 0; i < 8; i++) {
    const sx = i & 1 ? 1 : -1;
    const sy = i & 2 ? 1 : -1;
    const sz = i & 4 ? 1 : -1;
    // Deterministic corner jitter: the same boulder shape in every world.
    cx[i] = sx * (0.5 * (0.62 + 0.62 * hash2(i, 3, 7717)));
    cy[i] = sy > 0 ? 0.55 + 0.5 * hash2(i, 11, 7717) : -0.3;
    cz[i] = sz * (0.5 * (0.62 + 0.62 * hash2(i, 23, 7717)));
  }
  const faces = [
    [1, 3, 7, 5], // +X
    [0, 4, 6, 2], // -X
    [4, 5, 7, 6], // +Z
    [1, 0, 2, 3], // -Z
    [6, 7, 3, 2], // +Y
    [0, 1, 5, 4], // -Y
  ];
  for (const f of faces) {
    g.quad(
      cx[f[0]], cy[f[0]], cz[f[0]],
      cx[f[1]], cy[f[1]], cz[f[1]],
      cx[f[2]], cy[f[2]], cz[f[2]],
      cx[f[3]], cy[f[3]], cz[f[3]],
      1,
    );
  }
  return g.finish();
}

/** A grass clump: three crossed, tapered cards leaning off true. */
function buildGrass(): THREE.BufferGeometry {
  const g = new GeomBuilder(1);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI + 0.25;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const wb = 0.5;
    const wt = 0.11;
    // Each card flops a different way, so a clump has some body to it.
    const lx = Math.cos(a + 1.9) * 0.22;
    const lz = Math.sin(a + 1.9) * 0.22;
    g.quad(
      -dx * wb, 0, -dz * wb,
      dx * wb, 0, dz * wb,
      dx * wt + lx, 1, dz * wt + lz,
      -dx * wt + lx, 1, -dz * wt + lz,
      1,
    );
  }
  return g.finish();
}

/** The billboard: one quad, x in [-1,1], y in [0,1], turned to face the eye. */
function buildBillboard(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.BufferAttribute(
      new Float32Array([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0]),
      3,
    ),
  );
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

// ================================================================= SHADERS

interface PlantStyle {
  /** Linear bark colour. Foliage colour is per-instance, from the biome. */
  bark: [number, number, number];
  /** Gain on light coming through the leaf from behind. */
  trans: number;
  /** Metres of downwind lean per metre of height, at reference wind. */
  lean: number;
  /** Metres of sway per metre of height. */
  swayAmp: number;
  swayRate: number;
  /** How dark the plant is where it meets the ground. */
  aoBase: number;
  doubleSided: boolean;
}

/** Uniforms every scatter material shares, by reference. One wind, one world. */
interface WindUniforms {
  uWindDir: { value: THREE.Vector2 };
  uWindGain: { value: number };
}

/**
 * The wind block, shared verbatim by the geometry and billboard vertex
 * shaders. Weighting by height *squared* is what keeps trunks planted while
 * crowns move: at the base the weight is zero, so nothing ever slides out of
 * the ground.
 */
function windGlsl(s: PlantStyle): string {
  return /* glsl */ `
  float bend = ${glf(s.lean)} * uWindGain;
  float sway = ${glf(s.swayAmp)} * uWindGain
             * sin(uTime * ${glf(s.swayRate)} + phase + h * 2.2);
  float w = h * h * stiff;
  world.xz += uWindDir * ((bend + sway) * w * hgt);
  // A crosswind beat at a different rate, so a stand never moves as one object.
  world.xz += vec2(-uWindDir.y, uWindDir.x)
            * (${glf(s.swayAmp * 0.55)} * uWindGain
               * sin(uTime * ${glf(s.swayRate * 0.71)} + phase * 1.7) * w * hgt);
  // Leaning shortens the plant. Without this the crown grows taller as it
  // bends over, which reads as rubber rather than as wood.
  world.y -= bend * bend * 0.5 * w * hgt;
`;
}

function plantVertex(s: PlantStyle): string {
  return /* glsl */ `
${ATMOSPHERE_UNIFORMS_GLSL}

uniform vec2 uWindDir;
uniform float uWindGain;
uniform vec2 uFade;

attribute float aH;
attribute float aFoliage;
attribute vec4 iData;   // sway phase, dither seed, spare, wind stiffness
attribute vec3 iTint;

varying vec3  vWorld;
varying vec3  vNormal;
varying vec3  vTint;
varying float vFoliage;
varying float vH;
varying float vFade;
varying float vSeed;

void main() {
  // LOD is decided by the instance's ROOT, never per vertex: one corner of a
  // triangle dropping out while the others survive would smear it across the
  // screen. Every vertex of a plant agrees, so a plant leaves whole.
  vec3 root = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vFade = 1.0 - smoothstep(uFade.x, uFade.y, distance(root, uCameraPos));
  if (vFade <= 0.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);  // parked beyond the far plane
    return;
  }

  vec3 world = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;

  // Scale straight out of the instance matrix, so the lean below is in metres
  // and a full-grown tree bends further than the sapling beside it.
  // Floored: a released slot is an all-zero matrix, and dividing the normal by
  // its scale below would hand the rasterizer a NaN.
  vec3 sc = max(vec3(
    length(instanceMatrix[0].xyz),
    length(instanceMatrix[1].xyz),
    length(instanceMatrix[2].xyz)), vec3(1e-4));
  float hgt = sc.y;
  float h = aH;
  float phase = iData.x;
  float stiff = iData.w;
${windGlsl(s)}
  vWorld = world;
  // Non-uniform scale: the correct normal transform divides by the scale twice
  // (once to undo it, once for the inverse-transpose).
  vNormal = mat3(modelMatrix) * (mat3(instanceMatrix) * (normal / (sc * sc)));
  vTint = iTint;
  vFoliage = aFoliage;
  vH = h;
  vSeed = iData.y;

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;
}

function plantFragment(s: PlantStyle): string {
  const twoSided = s.doubleSided
    ? `  if (!gl_FrontFacing) N = -N;   // grass cards are visible from behind`
    : '';
  return /* glsl */ `
${ATMOSPHERE_PRELUDE}

varying vec3  vWorld;
varying vec3  vNormal;
varying vec3  vTint;
varying float vFoliage;
varying float vH;
varying float vFade;
varying float vSeed;

void main() {
  // A dithered dissolve, not an alpha fade: these are opaque, they write depth,
  // and they never need sorting. The hash is offset per instance so no two
  // neighbours thin out in the same pattern, and nothing ever pops.
  if (vFade < 0.996 && ahash12(gl_FragCoord.xy + vSeed) > vFade) discard;

  vec3 N = normalize(vNormal);
${twoSided}
  vec3 toFrag = vWorld - uCameraPos;
  float dist = length(toFrag);
  vec3 viewDir = toFrag / max(dist, 1e-4);

  vec3 albedo = mix(vec3(${glf(s.bark[0])}, ${glf(s.bark[1])}, ${glf(s.bark[2])}),
                    vTint, vFoliage);
  // Grain, so a canopy is not one flat plate of green.
  float g = anoise2(vWorld.xz * 0.85 + vWorld.y * 0.6);
  albedo *= 0.84 + 0.32 * g;

  // One number for two kinds of darkness: the shade a plant casts on its own
  // lower half, and the ground contact that stops it floating.
  float ao = mix(${glf(s.aoBase)}, 1.0, vH);

  vec3 col = shadeSurface(albedo, N, viewDir, ao);

  // Leaves are thin. Light that went in the far side comes out this one, and
  // that is the whole difference between a lit wood and a paper cut-out at
  // dawn — when the sun is behind the trees, they glow instead of going black.
  float back = max(dot(-N, uSunDir), 0.0);
  float toward = max(dot(viewDir, uSunDir), 0.0);
  col += vTint * uSunColor * uSunIntensity
       * (${glf(s.trans)} * vFoliage * back * toward * toward);

  // The shared atmosphere does the rest: at dawn and dusk everything past a
  // few hundred metres goes to near silhouette against a burning sky for free.
  col = aerialPerspective(col, vWorld, viewDir, dist);
  col += ditherValue(gl_FragCoord.xy);

  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
`;
}

const BILLBOARD_VERTEX = /* glsl */ `
${ATMOSPHERE_UNIFORMS_GLSL}

uniform vec2 uWindDir;
uniform float uWindGain;
uniform vec4 uFade;   // fade in lo/hi, fade out lo/hi

attribute vec4 iData;   // sway phase, dither seed, shape, wind stiffness
attribute vec3 iTint;

varying vec2  vQuad;
varying vec3  vWorld;
varying vec3  vNormal;
varying vec3  vTint;
varying float vFade;
varying float vSeed;
varying float vShape;

void main() {
  vec3 root = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float d = distance(root, uCameraPos);
  // In as the geometry trees leave, out at the edge of the grid that owns it.
  vFade = smoothstep(uFade.x, uFade.y, d) * (1.0 - smoothstep(uFade.z, uFade.w, d));
  if (vFade <= 0.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  float halfW = length(instanceMatrix[0].xyz);
  float hgt   = length(instanceMatrix[1].xyz);

  vec3 toCam = uCameraPos - root;
  vec3 look = normalize(toCam);
  vec3 r = cross(vec3(0.0, 1.0, 0.0), look);
  float rl = length(r);
  // Straight down the axis there is no horizontal right vector to find.
  vec3 right = rl > 1e-3 ? r / rl : vec3(1.0, 0.0, 0.0);
  // Mostly upright, tipped a little toward the eye: fully camera-facing lies
  // down when you overfly it, strictly upright vanishes edge-on.
  vec3 up = normalize(mix(vec3(0.0, 1.0, 0.0), cross(look, right), ${glf(BILLBOARD_TILT)}));

  vec3 world = root + right * (position.x * halfW) + up * (position.y * hgt);

  float h = position.y;
  float phase = iData.x;
  float stiff = iData.w;
${windGlsl(BILLBOARD_STYLE)}
  vQuad = position.xy;
  vWorld = world;
  // A sphere-impostor normal: rounded across the quad and biased at the eye, so
  // a distant canopy shades like a mass rather than like a signpost.
  vNormal = normalize(right * (position.x * 0.8)
                    + up * ((position.y - 0.55) * 0.9)
                    + look * 0.9);
  vTint = iTint;
  vSeed = iData.y;
  vShape = iData.z;

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const BILLBOARD_FRAGMENT = /* glsl */ `
${ATMOSPHERE_PRELUDE}

varying vec2  vQuad;
varying vec3  vWorld;
varying vec3  vNormal;
varying vec3  vTint;
varying float vFade;
varying float vSeed;
varying float vShape;

void main() {
  float x = vQuad.x;
  float y = vQuad.y;

  // Two silhouettes, because a spruce and an oak read differently at a
  // kilometre even when they are four vertices each.
  float mask;
  if (vShape < 0.5) {
    mask = (1.0 - y * 0.94) - abs(x);              // conifer spire
  } else {
    float dy = (y - 0.6) / 0.46;
    mask = 1.0 - (x * x + dy * dy);                // broadleaf crown
  }
  // Chewed edge, so the outline is never a clean cone or a clean ellipse.
  mask += (afbm2(vQuad * 3.1 + vSeed, 3) - 0.44) * 0.5;
  if (mask <= 0.0) discard;

  // Coverage folds the soft rim and the LOD fade into one stochastic test —
  // opaque, depth-writing, and free of every sorting problem alpha would bring.
  float cov = vFade * smoothstep(0.0, 0.22, mask);
  if (cov < 0.996 && ahash12(gl_FragCoord.xy + vSeed) > cov) discard;

  vec3 N = normalize(vNormal);
  vec3 toFrag = vWorld - uCameraPos;
  float dist = length(toFrag);
  vec3 viewDir = toFrag / max(dist, 1e-4);

  vec3 albedo = vTint * (0.82 + 0.34 * anoise2(vWorld.xz * 0.12 + vSeed));
  float ao = mix(${glf(BILLBOARD_STYLE.aoBase)}, 1.0, y);

  vec3 col = shadeSurface(albedo, N, viewDir, ao);

  float back = max(dot(-N, uSunDir), 0.0);
  float toward = max(dot(viewDir, uSunDir), 0.0);
  col += vTint * uSunColor * uSunIntensity
       * (${glf(BILLBOARD_STYLE.trans)} * back * toward * toward);

  col = aerialPerspective(col, vWorld, viewDir, dist);
  col += ditherValue(gl_FragCoord.xy);

  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
`;

// ================================================================== BATCH

/**
 * One InstancedMesh with a free list over its instances. Slots are handed out
 * as cells arrive and handed back as they leave; the arrays behind them are
 * allocated once and written in place forever after.
 */
class Batch {
  readonly mesh: THREE.InstancedMesh;
  readonly material: THREE.ShaderMaterial;

  private readonly matrices: Float32Array;
  private readonly data: Float32Array;
  private readonly tint: Float32Array;
  private readonly aData: THREE.InstancedBufferAttribute;
  private readonly aTint: THREE.InstancedBufferAttribute;
  private readonly freeList: Int32Array;
  private freeTop: number;
  /** Highest slot ever written. mesh.count follows it; freed slots draw nothing. */
  private high = 0;
  private dirty = false;

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.ShaderMaterial,
    capacity: number,
  ) {
    this.material = material;
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.count = 0;
    // The instances span kilometres while the mesh itself sits at the origin,
    // so a bounding sphere would be a lie. We cull per instance in the shader.
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.matrices = this.mesh.instanceMatrix.array as Float32Array;

    this.data = new Float32Array(capacity * 4);
    this.tint = new Float32Array(capacity * 3);
    this.aData = new THREE.InstancedBufferAttribute(this.data, 4);
    this.aTint = new THREE.InstancedBufferAttribute(this.tint, 3);
    this.aData.setUsage(THREE.DynamicDrawUsage);
    this.aTint.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('iData', this.aData);
    geometry.setAttribute('iTint', this.aTint);

    // Descending, so the first allocations come off the low indices and the
    // high-water mark stays tight around the live set.
    this.freeList = new Int32Array(capacity);
    for (let i = 0; i < capacity; i++) this.freeList[i] = capacity - 1 - i;
    this.freeTop = capacity;
  }

  /** -1 when the batch is full: the caller simply grows nothing there. */
  alloc(): number {
    return this.freeTop > 0 ? this.freeList[--this.freeTop] : -1;
  }

  release(slot: number): void {
    // An all-zero matrix collapses the instance to a point: no fragments, no
    // reallocation, and no need for an "alive" flag in the shader.
    const o = slot * 16;
    for (let i = 0; i < 16; i++) this.matrices[o + i] = 0;
    this.freeList[this.freeTop++] = slot;
    this.dirty = true;
  }

  /** Yaw + non-uniform scale + translation, written straight into the buffer. */
  write(
    slot: number,
    x: number, y: number, z: number,
    yaw: number,
    sx: number, sy: number, sz: number,
    phase: number, seed: number, shape: number, stiff: number,
    r: number, g: number, b: number,
  ): void {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const o = slot * 16;
    const m = this.matrices;
    m[o] = c * sx;      m[o + 1] = 0;   m[o + 2] = -s * sx;  m[o + 3] = 0;
    m[o + 4] = 0;       m[o + 5] = sy;  m[o + 6] = 0;        m[o + 7] = 0;
    m[o + 8] = s * sz;  m[o + 9] = 0;   m[o + 10] = c * sz;  m[o + 11] = 0;
    m[o + 12] = x;      m[o + 13] = y;  m[o + 14] = z;       m[o + 15] = 1;

    const d = slot * 4;
    this.data[d] = phase;
    this.data[d + 1] = seed;
    this.data[d + 2] = shape;
    this.data[d + 3] = stiff;

    const t = slot * 3;
    this.tint[t] = r;
    this.tint[t + 1] = g;
    this.tint[t + 2] = b;

    if (slot >= this.high) this.high = slot + 1;
    this.dirty = true;
  }

  /** Uploads only on frames where a cell actually moved. */
  flush(): void {
    if (!this.dirty) return;
    this.mesh.count = this.high;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.aData.needsUpdate = true;
    this.aTint.needsUpdate = true;
    this.dirty = false;
  }

  releaseAll(): void {
    const cap = this.freeList.length;
    this.matrices.fill(0);
    for (let i = 0; i < cap; i++) this.freeList[i] = cap - 1 - i;
    this.freeTop = cap;
    this.dirty = true;
  }

  setFade(x: number, y: number, z = 0, w = 0): void {
    const u = this.material.uniforms.uFade.value;
    if (u instanceof THREE.Vector4) u.set(x, y, z, w);
    else if (u instanceof THREE.Vector2) u.set(x, y);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}

// ================================================================== FIELD

/**
 * One streaming grid. The slot array is toroidal: a cell's slot index is its
 * coordinate modulo the grid width, so the window can slide forever without
 * anything being copied. When the camera moves, only the slots whose wrapped
 * coordinate no longer matches what they hold are rebuilt — which is exactly
 * the row that entered and the row that left.
 */
class Field {
  readonly cell: number;
  readonly r: number;
  readonly n: number;
  readonly total: number;
  readonly bakedX: Int32Array;
  readonly bakedZ: Int32Array;
  readonly baked: Uint8Array;
  readonly slot: Int32Array;
  readonly batch: Int8Array;
  /** The cell coordinate each column/row index must hold right now. */
  readonly colX: Int32Array;
  readonly colZ: Int32Array;

  scan = 0;
  /** Completed scan passes. One is enough to know the grid is coherent. */
  wraps = 0;
  ccx = 0;
  ccz = 0;
  mapped = false;

  constructor(cell: number, reach: number) {
    this.cell = cell;
    this.r = Math.max(1, Math.round(reach / cell));
    this.n = this.r * 2 + 1;
    this.total = this.n * this.n;
    this.bakedX = new Int32Array(this.total);
    this.bakedZ = new Int32Array(this.total);
    this.baked = new Uint8Array(this.total);
    this.slot = new Int32Array(this.total).fill(-1);
    this.batch = new Int8Array(this.total).fill(-1);
    this.colX = new Int32Array(this.n);
    this.colZ = new Int32Array(this.n);
  }

  remap(ccx: number, ccz: number): void {
    const n = this.n;
    const bx = ccx - this.r;
    const bz = ccz - this.r;
    for (let i = 0; i < n; i++) {
      this.colX[i] = bx + (((i - bx) % n) + n) % n;
      this.colZ[i] = bz + (((i - bz) % n) + n) % n;
    }
    this.ccx = ccx;
    this.ccz = ccz;
    this.mapped = true;
  }
}

// ================================================================ SCATTER

export class Scatter {
  private readonly batches: Batch[] = [];
  private readonly fields: Field[];

  private readonly uWindDir = { value: new THREE.Vector2(0, -1) };
  private readonly uWindGain = { value: 0 };

  private density = 1;
  private lodScale = 1;
  private windGain = 0;
  private primed = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly cfg: Config,
    private readonly terrain: TerrainProvider,
    private readonly biomes: BiomeProvider,
    atmo: AtmosphereUniforms,
    quality: QualitySettings,
  ) {
    this.fields = [
      new Field(DETAIL_CELL, DETAIL_REACH),
      new Field(NEAR_CELL, NEAR_REACH),
      new Field(FAR_CELL, FAR_REACH),
    ];

    // Capacity is fixed here, from the quality the run starts at. A later
    // switch to a richer tier raises the acceptance rate but never reallocates:
    // the extra cells that cannot find a slot simply stay bare.
    const d = clamp(quality.scatterDensity, 0.2, 1.5);
    const nearCells = this.fields[F_NEAR].total;
    const detailCells = this.fields[F_DETAIL].total;
    const farCells = this.fields[F_FAR].total;
    const treeCap = Math.ceil(nearCells * TREE_P * TREE_SHARE * d);
    const rockCap = Math.ceil(nearCells * ROCK_P * ROCK_SHARE * d);
    const grassCap = Math.ceil(detailCells * GRASS_P * GRASS_SHARE * d);
    const billCap = Math.ceil(farCells * FAR_TREE_P * BILLBOARD_SHARE * d);

    const wind: WindUniforms = { uWindDir: this.uWindDir, uWindGain: this.uWindGain };
    this.batches[B_CONIFER] = new Batch(
      buildConifer(), plantMaterial(atmo, wind, CONIFER_STYLE), treeCap);
    this.batches[B_BROADLEAF] = new Batch(
      buildBroadleaf(), plantMaterial(atmo, wind, BROADLEAF_STYLE), treeCap);
    this.batches[B_ROCK] = new Batch(
      buildRock(), plantMaterial(atmo, wind, ROCK_STYLE), rockCap);
    this.batches[B_GRASS] = new Batch(
      buildGrass(), plantMaterial(atmo, wind, GRASS_STYLE), grassCap);
    this.batches[B_BILLBOARD] = new Batch(
      buildBillboard(), billboardMaterial(atmo, wind), billCap);

    this.setQuality(quality);
    for (let i = 0; i < BATCH_COUNT; i++) scene.add(this.batches[i].mesh);
  }

  setQuality(q: QualitySettings): void {
    this.density = clamp(q.scatterDensity, 0.2, 1.5);
    // Thinner scatter also means shorter LOD bands — a low tier should not be
    // paying to fade something it barely draws. Never scales above 1: the fades
    // must finish inside the grids, which are sized in metres and fixed.
    this.lodScale = clamp(0.62 + 0.38 * this.density, 0.62, 1);
    const k = this.lodScale;
    this.batches[B_CONIFER].setFade(TREE_FADE[0] * k, TREE_FADE[1] * k);
    this.batches[B_BROADLEAF].setFade(TREE_FADE[0] * k, TREE_FADE[1] * k);
    this.batches[B_ROCK].setFade(ROCK_FADE[0] * k, ROCK_FADE[1] * k);
    this.batches[B_GRASS].setFade(GRASS_FADE[0] * k, GRASS_FADE[1] * k);
    this.batches[B_BILLBOARD].setFade(
      BILLBOARD_FADE[0] * k, BILLBOARD_FADE[1] * k,
      BILLBOARD_FADE[2] * k, BILLBOARD_FADE[3] * k,
    );
    // Density changed, so every acceptance roll changed with it.
    this.invalidateAll();
  }

  update(
    dt: number,
    cameraPos: THREE.Vector3,
    sky: SkyState,
    windDirX: number,
    windDirZ: number,
    windSpeed: number,
  ): void {
    const l = Math.hypot(windDirX, windDirZ);
    if (l > 1e-4) this.uWindDir.value.set(windDirX / l, windDirZ / l);

    // Measured against the day's own reference wind, so the lean reads the same
    // on a calm seed as on a rough one. Convective days are gusty at the
    // surface, so the afternoon stirs the trees harder than the dawn does.
    const gust = 0.82 + 0.36 * clamp01(sky.thermalActivity);
    const target = clamp((windSpeed / Math.max(this.cfg.windSpeed, 1)) * gust, 0, 1.8);
    // Damped: gusts build and ease, they never step.
    this.windGain = damp(this.windGain, target, 1.6, dt);
    this.uWindGain.value = this.windGain;

    this.stream(cameraPos);
    for (let i = 0; i < BATCH_COUNT; i++) this.batches[i].flush();
  }

  dispose(): void {
    for (let i = 0; i < BATCH_COUNT; i++) {
      this.scene.remove(this.batches[i].mesh);
      this.batches[i].dispose();
    }
  }

  // ------------------------------------------------------------ streaming

  private invalidateAll(): void {
    for (const f of this.fields) {
      f.baked.fill(0);
      f.slot.fill(-1);
      f.batch.fill(-1);
      f.scan = 0;
      f.wraps = 0;
      f.mapped = false;
    }
    for (let i = 0; i < BATCH_COUNT; i++) this.batches[i].releaseAll();
    this.primed = false;
  }

  private stream(cam: THREE.Vector3): void {
    let budget = this.primed ? FILL_BUDGET : FILL_BUDGET_BOOT;
    // Nearest grid first: the detail underfoot is what the eye checks.
    for (let id = 0; id < this.fields.length && budget > 0; id++) {
      budget -= this.streamField(id, this.fields[id], cam, budget);
    }
    if (!this.primed) {
      this.primed =
        this.fields[0].wraps > 0 && this.fields[1].wraps > 0 && this.fields[2].wraps > 0;
    }
  }

  private streamField(id: number, f: Field, cam: THREE.Vector3, budget: number): number {
    const ccx = Math.floor(cam.x / f.cell);
    const ccz = Math.floor(cam.z / f.cell);
    if (!f.mapped) {
      f.remap(ccx, ccz);
    } else if (ccx !== f.ccx || ccz !== f.ccz) {
      // A jump rather than a flight: drop the whole grid at once instead of
      // leaving a forest standing where the bird no longer is.
      if (
        Math.abs(ccx - f.ccx) > f.r + TELEPORT_CELLS ||
        Math.abs(ccz - f.ccz) > f.r + TELEPORT_CELLS
      ) {
        for (let i = 0; i < f.total; i++) this.clearCell(f, i);
        f.baked.fill(0);
        f.wraps = 0;
        this.primed = false;
      }
      f.remap(ccx, ccz);
    }

    const n = f.n;
    const steps = Math.min(f.total, SCAN_PER_FIELD);
    let used = 0;
    for (let s = 0; s < steps; s++) {
      const i = f.scan;
      if (i + 1 >= f.total) {
        f.scan = 0;
        f.wraps++;
      } else {
        f.scan = i + 1;
      }
      const cx = f.colX[i % n];
      const cz = f.colZ[(i / n) | 0];
      if (f.baked[i] === 1 && f.bakedX[i] === cx && f.bakedZ[i] === cz) continue;

      this.clearCell(f, i);
      f.bakedX[i] = cx;
      f.bakedZ[i] = cz;
      f.baked[i] = 1;
      if (id === F_DETAIL) this.fillDetail(f, i, cx, cz);
      else if (id === F_NEAR) this.fillNear(f, i, cx, cz);
      else this.fillFar(f, i, cx, cz);

      if (++used >= budget) break;
    }
    return used;
  }

  private clearCell(f: Field, i: number): void {
    const b = f.batch[i];
    if (b >= 0) {
      this.batches[b].release(f.slot[i]);
      f.batch[i] = -1;
      f.slot[i] = -1;
    }
  }

  /** Takes a slot in `batch` for cell `i`, or reports that the batch is full. */
  private take(f: Field, i: number, batch: number): number {
    const slot = this.batches[batch].alloc();
    if (slot < 0) return -1;
    f.batch[i] = batch;
    f.slot[i] = slot;
    return slot;
  }

  // ------------------------------------------------------------ placement

  /**
   * Grass. Never below the waterline, thickest in wet meadow, gone on rock and
   * snow and anything too steep to hold soil.
   */
  private fillDetail(f: Field, i: number, cx: number, cz: number): void {
    const seed = this.cfg.seed;
    const wx = (cx + 0.5 + (hash2(cx, cz, seed + 17) - 0.5) * JITTER) * f.cell;
    const wz = (cz + 0.5 + (hash2(cx, cz, seed + 41) - 0.5) * JITTER) * f.cell;
    this.terrain.sampleAt(wx, wz, _ts);
    if (_ts.height < this.terrain.waterLevel() + 0.4) return;
    if (_ts.slope > 0.86) return;

    this.biomes.sampleAt(wx, wz, _bs);
    const grassy = GRASSINESS[_bs.kind] * (0.45 + 0.75 * _bs.moisture);
    const p =
      GRASS_P * this.density * grassy * (1 - smoothstep(0.55, 0.85, _ts.slope));
    const roll = hash2(cx, cz, seed + 73);
    if (roll >= p) return;

    const slot = this.take(f, i, B_GRASS);
    if (slot < 0) return;

    const s1 = hash2(cx, cz, seed + 211);
    const s2 = hash2(cx, cz, seed + 271);
    const h = lerp(0.42, 1.05, s1) * (0.7 + 0.5 * grassy);
    // Dry straw with the green pushed in by moisture, then pulled toward the
    // ground it grows out of so a clump never floats off its own biome.
    const dry = 1 - clamp01(_bs.moisture * 1.15);
    _col.r = lerp(0.088, 0.168, dry);
    _col.g = lerp(0.128, 0.142, dry);
    _col.b = lerp(0.044, 0.062, dry);
    this.blendToGround(0.4, s2);
    this.batches[B_GRASS].write(
      slot,
      wx, _ts.height - 0.06, wz,
      hash2(cx, cz, seed + 331) * TAU,
      lerp(0.7, 1.35, s2) * h, h, lerp(0.7, 1.35, s1) * h,
      hash2(cx, cz, seed + 397) * TAU,
      s1 * 64,
      0,
      lerp(0.8, 1.25, s2),
      _col.r, _col.g, _col.b,
    );
  }

  /** Trees and boulders in full geometry, out to where they stop being legible. */
  private fillNear(f: Field, i: number, cx: number, cz: number): void {
    const cfg = this.cfg;
    const seed = cfg.seed;
    const wx = (cx + 0.5 + (hash2(cx, cz, seed + 17) - 0.5) * JITTER) * f.cell;
    const wz = (cz + 0.5 + (hash2(cx, cz, seed + 41) - 0.5) * JITTER) * f.cell;
    this.terrain.sampleAt(wx, wz, _ts);
    const water = this.terrain.waterLevel();
    if (_ts.height < water + 1.2) return;

    this.biomes.sampleAt(wx, wz, _bs);
    const roll = hash2(cx, cz, seed + 73);

    // Nothing above the treeline and nothing on a cliff. The band below the
    // line is krummholz: still trees, but stunted, which is what makes a
    // treeline look like a treeline instead of a mown edge.
    const alt = 1 - smoothstep(cfg.treeLine - 160, cfg.treeLine, _ts.height);
    const flat = 1 - smoothstep(0.52, 0.8, _ts.slope);
    const treeP = clamp(TREE_P * this.density * _bs.forest * alt * flat, 0, 0.85);

    if (roll < treeP) {
      this.plantTree(f, i, cx, cz, wx, wz, alt);
      return;
    }

    // Rocks take the far end of the same roll, so a cell is never both.
    const rockP =
      ROCK_P *
      this.density *
      ROCKINESS[_bs.kind] *
      (0.5 + 0.9 * smoothstep(0.2, 0.7, _ts.slope));
    if (roll > 1 - rockP) this.plantRock(f, i, cx, cz, wx, wz);
  }

  private plantTree(
    f: Field, i: number, cx: number, cz: number, wx: number, wz: number, alt: number,
  ): void {
    const seed = this.cfg.seed;
    // Conifer above and in the dry; broadleaf low and wet. Clamped so no stand
    // is ever purely one species — a single-species forest reads as wallpaper.
    const coniferP = clamp(
      0.3 + smoothstep(220, 900, _ts.height) * 0.5 - (_bs.moisture - 0.5) * 0.35,
      0.18,
      0.86,
    );
    const conifer = hash2(cx, cz, seed + 137) < coniferP;
    const batch = conifer ? B_CONIFER : B_BROADLEAF;
    const slot = this.take(f, i, batch);
    if (slot < 0) return;

    const s1 = hash2(cx, cz, seed + 211);
    const s2 = hash2(cx, cz, seed + 271);
    // Vigour: thin ground and the treeline both make small trees.
    const vigour = 0.6 + 0.4 * clamp01(_bs.forest) * (0.4 + 0.6 * alt);
    const h = (conifer ? lerp(10, 22, s1) : lerp(7.5, 16, s1)) * vigour;
    const crown = conifer
      ? lerp(CONIFER_CROWN[0], CONIFER_CROWN[1], s2) / CONIFER_GEOM_RADIUS
      : lerp(BROADLEAF_CROWN[0], BROADLEAF_CROWN[1], s2) / BROADLEAF_GEOM_RADIUS;

    this.treeColor(conifer, s2);
    // Sink the root: on a slope a trunk sitting exactly on the sampled height
    // leaves daylight under its uphill side.
    const y = _ts.height - 0.35 - _ts.slope * 2.2;
    this.batches[batch].write(
      slot,
      wx, y, wz,
      hash2(cx, cz, seed + 331) * TAU,
      h * crown, h, h * crown,
      hash2(cx, cz, seed + 397) * TAU,
      s1 * 64,
      0,
      // Small trees are stiffer relative to their height than big ones.
      lerp(1.2, 0.8, clamp01((h - 8) / 14)),
      _col.r, _col.g, _col.b,
    );
  }

  private plantRock(
    f: Field, i: number, cx: number, cz: number, wx: number, wz: number,
  ): void {
    const seed = this.cfg.seed;
    const slot = this.take(f, i, B_ROCK);
    if (slot < 0) return;
    const s1 = hash2(cx, cz, seed + 211);
    const s2 = hash2(cx, cz, seed + 271);
    const size = lerp(0.9, 3.4, s1 * s1);

    // Straight from the ground's own albedo, greyed off and darkened: a boulder
    // is the rock the hill is made of, so it must never look imported.
    const lum = _bs.r * 0.2126 + _bs.g * 0.7152 + _bs.b * 0.0722;
    const v = 0.78 + 0.4 * s2;
    _col.r = lerp(_bs.r, lum, 0.34) * v;
    _col.g = lerp(_bs.g, lum, 0.34) * v;
    _col.b = lerp(_bs.b, lum, 0.34) * v * 1.04;

    this.batches[B_ROCK].write(
      slot,
      wx, _ts.height, wz,
      hash2(cx, cz, seed + 331) * TAU,
      size * lerp(0.8, 1.3, s2), size * lerp(0.55, 0.95, s1), size * lerp(0.8, 1.3, s1),
      0,
      s2 * 64,
      0,
      1,
      _col.r, _col.g, _col.b,
    );
  }

  /** The far canopy: one billboard standing in for a clump of trees. */
  private fillFar(f: Field, i: number, cx: number, cz: number): void {
    const cfg = this.cfg;
    const seed = cfg.seed;
    const wx = (cx + 0.5 + (hash2(cx, cz, seed + 17) - 0.5) * JITTER) * f.cell;
    const wz = (cz + 0.5 + (hash2(cx, cz, seed + 41) - 0.5) * JITTER) * f.cell;
    this.terrain.sampleAt(wx, wz, _ts);
    if (_ts.height < this.terrain.waterLevel() + 1.2) return;

    this.biomes.sampleAt(wx, wz, _bs);
    const alt = 1 - smoothstep(cfg.treeLine - 160, cfg.treeLine, _ts.height);
    const flat = 1 - smoothstep(0.52, 0.8, _ts.slope);
    const p = clamp(FAR_TREE_P * this.density * _bs.forest * alt * flat, 0, 0.9);
    const roll = hash2(cx, cz, seed + 73);
    if (roll >= p) return;

    const slot = this.take(f, i, B_BILLBOARD);
    if (slot < 0) return;

    const s1 = hash2(cx, cz, seed + 211);
    const s2 = hash2(cx, cz, seed + 271);
    const coniferP = clamp(
      0.3 + smoothstep(220, 900, _ts.height) * 0.5 - (_bs.moisture - 0.5) * 0.35,
      0.18,
      0.86,
    );
    const conifer = hash2(cx, cz, seed + 137) < coniferP;
    const vigour = 0.6 + 0.4 * clamp01(_bs.forest) * (0.4 + 0.6 * alt);
    const h = (conifer ? lerp(10, 22, s1) : lerp(7.5, 16, s1)) * vigour * CLUMP_HEIGHT;
    const halfW = h * (conifer ? 0.24 : 0.36) * CLUMP_WIDTH;

    this.treeColor(conifer, s2);
    // A canopy seen at a kilometre is mostly its own shadow.
    _col.r *= 0.88;
    _col.g *= 0.88;
    _col.b *= 0.9;

    this.batches[B_BILLBOARD].write(
      slot,
      wx, _ts.height - 0.4, wz,
      0,
      halfW, h, halfW,
      hash2(cx, cz, seed + 397) * TAU,
      s1 * 64,
      conifer ? 0 : 1,
      lerp(1.1, 0.85, clamp01((h - 8) / 16)),
      _col.r, _col.g, _col.b,
    );
  }

  // --------------------------------------------------------------- colour
  //
  // Linear RGB, calibrated against the biome palette — which is NOT
  // pre-brightened, so foliage numbers look alarmingly dark written down.

  /** Canopy colour for the biome sample currently in `_bs`, into `_col`. */
  private treeColor(conifer: boolean, v: number): void {
    const dry = 1 - clamp01(_bs.moisture * 1.2);
    if (conifer) {
      // Deep blue-green, barely moving with moisture: spruce is spruce.
      _col.r = 0.031 + 0.014 * dry;
      _col.g = 0.062 + 0.006 * dry;
      _col.b = 0.041 - 0.008 * dry;
    } else {
      // Broadleaf swings hard to gold where the ground is dry, which is what
      // gives the afternoon country its warmth.
      _col.r = lerp(0.064, 0.142, dry);
      _col.g = lerp(0.101, 0.108, dry);
      _col.b = lerp(0.036, 0.041, dry);
    }
    this.blendToGround(0.2, v);
  }

  /** Pull `_col` partway toward the ground colour, then vary it per instance. */
  private blendToGround(amount: number, v: number): void {
    const gr = _bs.r * 0.55;
    const gg = _bs.g * 0.55;
    const gb = _bs.b * 0.55;
    const k = 0.8 + 0.42 * v;
    _col.r = lerp(_col.r, gr, amount) * k;
    _col.g = lerp(_col.g, gg, amount) * k;
    _col.b = lerp(_col.b, gb, amount) * k;
  }
}

// ================================================================ MATERIALS

function plantMaterial(
  atmo: AtmosphereUniforms,
  wind: WindUniforms,
  style: PlantStyle,
): THREE.ShaderMaterial {
  const uniforms = withAtmosphere(atmo, {
    uWindDir: wind.uWindDir,
    uWindGain: wind.uWindGain,
    uFade: { value: new THREE.Vector2(400, 500) },
  });
  return new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: plantVertex(style),
    fragmentShader: plantFragment(style),
    side: style.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    transparent: false,
    depthWrite: true,
    depthTest: true,
    fog: false,
    lights: false,
  });
}

function billboardMaterial(
  atmo: AtmosphereUniforms,
  wind: WindUniforms,
): THREE.ShaderMaterial {
  const uniforms = withAtmosphere(atmo, {
    uWindDir: wind.uWindDir,
    uWindGain: wind.uWindGain,
    uFade: { value: new THREE.Vector4(280, 400, 1100, 1300) },
  });
  return new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: BILLBOARD_VERTEX,
    fragmentShader: BILLBOARD_FRAGMENT,
    // The quad's winding follows the camera basis, so both faces have to draw.
    side: THREE.DoubleSide,
    transparent: false,
    depthWrite: true,
    depthTest: true,
    fog: false,
    lights: false,
  });
}

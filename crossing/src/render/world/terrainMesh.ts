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
import { clamp, damp, smoothstep, DEG } from '../../sim/math';
import {
  ATMOSPHERE_PRELUDE,
  withAtmosphere,
  type AtmosphereUniforms,
} from '../shaders/atmosphere';

/**
 * THE GROUND.
 *
 * A ring-LOD grid of chunks centred on the camera, streamed in over several
 * frames so that flying across a chunk boundary never costs a frame. Three
 * decisions carry most of the look:
 *
 *  - **Vertex data is sampled, not baked.** Height comes from the provider,
 *    the normal from the provider's own central difference (so two chunks at
 *    different LOD light identically along their shared edge), and the colour
 *    straight from the biome layer. The renderer never invents geography.
 *  - **Everything the eye reads as detail happens per-pixel**: two scales of
 *    noise on the albedo, snow that only settles on slopes shallow enough to
 *    hold it, a wet band at the waterline, and cloud shadows drifting downwind.
 *  - **Nothing is ever hidden before its replacement exists.** A chunk keeps
 *    drawing what it last built until its new build finishes, so re-LODing the
 *    whole grid after a boundary crossing never opens a hole under the bird.
 */

// ------------------------------------------------------------- streaming

/**
 * Cost of one terrain height query relative to one full vertex (height +
 * normal + biome), measured at ~1.0 µs against ~4.8 µs. The budget below is
 * denominated in vertices, so the height prepass has to be weighed against it.
 */
const HEIGHT_COST = 0.22;

/**
 * Per-frame build cap once the world is up: a vertex ceiling for fast machines
 * and a millisecond ceiling for slow ones, whichever bites first. 4 ms is
 * about a quarter of a 60 Hz frame — enough to refill a whole ring in a second
 * of flying, small enough that the refill is invisible.
 */
const BUILD_VERTS = 46000;
const BUILD_MS = 4;
/** While the boot screen is still up there is no frame to protect, so spend. */
const BOOT_VERTS = 260000;
const BOOT_MS = 26;

/** Ring 0 keeps the full resolution; every ring out halves it, down to this. */
const MIN_RESOLUTION = 16;

// ------------------------------------------------------------------ mesh

/**
 * Downward skirt depth as a multiple of the chunk's own vertex spacing. A
 * coarse chunk's surface can sit a long way below its fine neighbour's edge in
 * mountains; the skirt has to be deeper than that gap or the seam shows a
 * crack of sky. Clamped so flat country doesn't grow absurd walls.
 */
const SKIRT_STEP_FACTOR = 2;
const SKIRT_MIN = 24;
const SKIRT_MAX = 240;

/**
 * Curvature shading. The Laplacian of the height grid divided by the vertex
 * spacing is scale-invariant for fractal terrain, so a crease darkens by the
 * same amount whether it is read at 8 m or 68 m spacing and the LOD rings
 * agree. Creases go to ~0.65, convex ridges brighten slightly — which is what
 * reads as "there is a shape here" long before the sun is low enough to say so.
 */
const AO_GAIN = 2.2;
const AO_MIN = 0.55;
const AO_MAX = 1.12;

/** Cloud shadows fade with the sun: below the horizon there is nothing to cast. */
const SUN_FADE_LO = -0.04;
const SUN_FADE_HI = 0.1;
/** Seconds-ish of easing on coverage and shadow strength. Nothing snaps. */
const CLOUD_LAMBDA = 1.2;

// Module scratch. buildStep() runs tens of thousands of times per chunk and
// must never allocate; only one chunk is ever mid-build, so sharing is safe.
const _ts: TerrainSample = { height: 0, nx: 0, ny: 1, nz: 0, slope: 0 };
const _bs: BiomeSample = {
  kind: BiomeKind.Rock,
  heat: 0,
  forest: 0,
  moisture: 0,
  r: 0.5,
  g: 0.5,
  b: 0.5,
};

interface Chunk {
  /** Index into `all`, used to break coverage ties. */
  id: number;
  level: number;
  res: number;
  mesh: THREE.Mesh;
  geom: THREE.BufferGeometry;
  pos: Float32Array;
  nrm: Float32Array;
  col: Float32Array;
  ao: Float32Array;
  posAttr: THREE.BufferAttribute;
  nrmAttr: THREE.BufferAttribute;
  colAttr: THREE.BufferAttribute;
  aoAttr: THREE.BufferAttribute;
  /** Chunk coordinate this chunk is building toward. */
  gx: number;
  gz: number;
  /** Chunk coordinate its geometry currently represents. */
  shownX: number;
  shownZ: number;
  /** Has completed at least one build (so the geometry is drawable at all). */
  valid: boolean;
  /** Target differs from what is shown — needs (more) building. */
  dirty: boolean;
  /** 0 = height prepass, 1 = vertices. */
  phase: number;
  row: number;
  minY: number;
  maxY: number;
}

interface Level {
  res: number;
  chunks: Chunk[];
  /** Grid offsets, relative to the centre chunk, that this level owns. */
  slotDx: Int32Array;
  slotDz: Int32Array;
  taken: Uint8Array;
  free: Int32Array;
  index: THREE.BufferAttribute;
  border: Int32Array;
  vertCount: number;
}

export class TerrainRenderer {
  private readonly scene: THREE.Scene;
  private readonly cfg: Config;
  private readonly terrain: TerrainProvider;
  private readonly biomes: BiomeProvider;

  private readonly rings: number;
  private readonly span: number;
  private readonly levels: Level[] = [];
  private readonly all: Chunk[] = [];
  private readonly group = new THREE.Group();
  private readonly material: THREE.ShaderMaterial;

  /** offset (dx,dz) → which level owns it, and which slot within that level. */
  private readonly offsetLevel: Int32Array;
  private readonly offsetSlot: Int32Array;
  /** Per-offset coverage arbitration: best rank seen, and who owns it. */
  private readonly cover: Int32Array;
  private readonly coverOwner: Int32Array;

  /** Shared height prepass scratch, sized for the largest chunk. */
  private readonly heights: Float64Array;

  private cx = 0;
  private cz = 0;
  private centred = false;
  private active: Chunk | null = null;
  private builtSeed: number;

  private cloudTarget = 0;
  private shadowTarget = 0;

  private readonly uCloudCover = { value: 0 };
  private readonly uCloudShadow = { value: 0 };
  private readonly uCloudDrift = { value: new THREE.Vector2(6, -6) };
  private readonly uSnowLine = { value: 0 };
  private readonly uSnowBlend = { value: 1 };

  constructor(
    scene: THREE.Scene,
    cfg: Config,
    terrain: TerrainProvider,
    biomes: BiomeProvider,
    atmo: AtmosphereUniforms,
    quality: QualitySettings,
  ) {
    this.scene = scene;
    this.cfg = cfg;
    this.terrain = terrain;
    this.biomes = biomes;
    this.builtSeed = cfg.seed;

    this.rings = Math.max(0, Math.floor(quality.terrainRings));
    this.span = this.rings * 2 + 1;
    const cells = this.span * this.span;
    this.offsetLevel = new Int32Array(cells);
    this.offsetSlot = new Int32Array(cells);
    this.cover = new Int32Array(cells);
    this.coverOwner = new Int32Array(cells);

    const baseRes = Math.max(MIN_RESOLUTION, Math.floor(quality.chunkResolution));
    this.heights = new Float64Array((baseRes + 2) * (baseRes + 2));

    this.material = this.makeMaterial(atmo);
    this.group.name = 'terrain';
    // The group never moves; chunks carry their own world offset.
    this.group.matrixAutoUpdate = false;
    scene.add(this.group);

    // One pool per ring level, sized to exactly the number of chunks that ring
    // holds (1, then 8L). Because the count per ring is fixed, a chunk never
    // has to change resolution — it is only ever re-keyed to a new coordinate.
    for (let level = 0; level <= this.rings; level++) {
      const res = Math.max(MIN_RESOLUTION, baseRes >> level);
      const count = level === 0 ? 1 : 8 * level;
      const slotDx = new Int32Array(count);
      const slotDz = new Int32Array(count);
      let slot = 0;
      for (let dz = -level; dz <= level; dz++) {
        for (let dx = -level; dx <= level; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== level) continue;
          slotDx[slot] = dx;
          slotDz[slot] = dz;
          const oi = (dz + this.rings) * this.span + (dx + this.rings);
          this.offsetLevel[oi] = level;
          this.offsetSlot[oi] = slot;
          slot++;
        }
      }

      const lv: Level = {
        res,
        chunks: [],
        slotDx,
        slotDz,
        taken: new Uint8Array(count),
        free: new Int32Array(count),
        index: makeIndex(res),
        border: makeBorder(res),
        vertCount: res * res + 4 * (res - 1),
      };
      for (let i = 0; i < count; i++) {
        const c = this.makeChunk(lv, level, this.all.length);
        c.gx = slotDx[i];
        c.gz = slotDz[i];
        lv.chunks.push(c);
        this.all.push(c);
      }
      this.levels.push(lv);
    }
  }

  // ------------------------------------------------------------- public

  /**
   * True once ring 0 and ring 1 are complete: the ground the bird can actually
   * see on the first frame. Waiting for the whole grid would double the boot
   * time for terrain that is 5 km away behind fog.
   */
  get ready(): boolean {
    const last = Math.min(1, this.rings);
    for (let l = 0; l <= last; l++) {
      const chunks = this.levels[l].chunks;
      for (let i = 0; i < chunks.length; i++) {
        if (!chunks[i].valid || chunks[i].dirty) return false;
      }
    }
    return true;
  }

  /** 0..1 sky coverage, from the cloud layer. Eased, never stepped. */
  setCloudCoverage(c: number): void {
    this.cloudTarget = clamp(c, 0, 1);
  }

  /** Throw the whole grid away — after a seed change, or a chunk size change. */
  rebuild(): void {
    this.builtSeed = this.cfg.seed;
    this.active = null;
    this.centred = false;
    for (let i = 0; i < this.all.length; i++) {
      const c = this.all[i];
      c.dirty = true;
      c.phase = 0;
      c.row = 0;
    }
  }

  update(dt: number, cameraPos: THREE.Vector3, sky: SkyState): void {
    const cfg = this.cfg;
    if (cfg.seed !== this.builtSeed) this.rebuild();

    // --- shader state ----------------------------------------------------
    this.uSnowLine.value = cfg.snowLine;
    this.uSnowBlend.value = Math.max(1, cfg.snowBlend);

    // Shadows only exist while there is a sun to block, and only once there is
    // enough cloud to be worth drawing.
    this.shadowTarget =
      smoothstep(SUN_FADE_LO, SUN_FADE_HI, sky.sunElevation) *
      smoothstep(0.04, 0.28, this.cloudTarget);
    this.uCloudCover.value = damp(this.uCloudCover.value, this.cloudTarget, CLOUD_LAMBDA, dt);
    this.uCloudShadow.value = damp(this.uCloudShadow.value, this.shadowTarget, CLOUD_LAMBDA, dt);

    // Shadows travel with the cloud they fall from: downwind, at wind speed.
    // (windDirDeg is the bearing the air travels *toward*, 0 = toward -Z.)
    const wd = cfg.windDirDeg * DEG;
    this.uCloudDrift.value.set(Math.sin(wd) * cfg.windSpeed, -Math.cos(wd) * cfg.windSpeed);

    // --- streaming -------------------------------------------------------
    const size = cfg.chunkSize;
    const gx = Math.floor(cameraPos.x / size);
    const gz = Math.floor(cameraPos.z / size);
    if (!this.centred || gx !== this.cx || gz !== this.cz) this.recentre(gx, gz);

    const boot = !this.ready;
    const budget = boot ? BOOT_VERTS : BUILD_VERTS;
    const deadline = performance.now() + (boot ? BOOT_MS : BUILD_MS);
    let work = 0;
    while (work < budget) {
      if (this.active === null) this.active = this.pickNext(cameraPos, size);
      if (this.active === null) break;
      work += this.buildStep(this.active, budget - work, deadline);
      if (this.active.dirty) break; // still going: out of budget for this frame
      this.active = null;
      if (performance.now() >= deadline) break;
    }
  }

  dispose(): void {
    for (let i = 0; i < this.all.length; i++) {
      const c = this.all[i];
      this.group.remove(c.mesh);
      c.geom.dispose();
    }
    this.scene.remove(this.group);
    this.material.dispose();
    this.all.length = 0;
    this.levels.length = 0;
  }

  // ------------------------------------------------------------ streaming

  /**
   * Re-key the pools around a new centre chunk. Chunks whose target is still
   * wanted by their own level keep it (and keep whatever build progress they
   * had); the rest are handed the coordinates nobody claimed. Nothing is
   * hidden here — a re-keyed chunk goes on drawing its old ground until its
   * replacement is finished, which is what keeps the world whole while half
   * the grid changes LOD.
   */
  private recentre(gx: number, gz: number): void {
    this.cx = gx;
    this.cz = gz;
    this.centred = true;
    const R = this.rings;

    for (let l = 0; l < this.levels.length; l++) {
      const lv = this.levels[l];
      const count = lv.chunks.length;
      lv.taken.fill(0);
      let freeCount = 0;

      for (let i = 0; i < count; i++) {
        const c = lv.chunks[i];
        const dx = c.gx - gx;
        const dz = c.gz - gz;
        let kept = false;
        if (dx >= -R && dx <= R && dz >= -R && dz <= R) {
          const oi = (dz + R) * this.span + (dx + R);
          if (this.offsetLevel[oi] === l) {
            const slot = this.offsetSlot[oi];
            if (lv.taken[slot] === 0) {
              lv.taken[slot] = 1;
              kept = true;
            }
          }
        }
        if (!kept) lv.free[freeCount++] = i;
      }

      let f = 0;
      for (let slot = 0; slot < count && f < freeCount; slot++) {
        if (lv.taken[slot] !== 0) continue;
        const c = lv.chunks[lv.free[f++]];
        c.gx = gx + lv.slotDx[slot];
        c.gz = gz + lv.slotDz[slot];
        c.dirty = true;
        c.phase = 0;
        c.row = 0;
        if (this.active === c) this.active = null;
      }
    }

    this.refreshVisibility();
  }

  /** The dirty chunk whose target ground is nearest the camera. */
  private pickNext(cameraPos: THREE.Vector3, size: number): Chunk | null {
    let best: Chunk | null = null;
    let bestD = Infinity;
    const half = size * 0.5;
    for (let i = 0; i < this.all.length; i++) {
      const c = this.all[i];
      if (!c.dirty) continue;
      const dx = c.gx * size + half - cameraPos.x;
      const dz = c.gz * size + half - cameraPos.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  /**
   * A row of work at a time, resumable across frames. Phase 0 fills a height
   * grid one cell wider than the chunk on every side — that overlap is what
   * lets the curvature term be continuous across a chunk boundary instead of
   * drawing a faint grid over the whole continent. Phase 1 turns it into
   * vertices.
   */
  private buildStep(c: Chunk, budget: number, deadline: number): number {
    const res = c.res;
    const stride = res + 2;
    const H = this.heights;
    const size = this.cfg.chunkSize;
    const step = size / (res - 1);
    const ox = c.gx * size;
    const oz = c.gz * size;
    let work = 0;

    for (;;) {
      if (c.phase === 0) {
        if (c.row >= stride) {
          c.phase = 1;
          c.row = 0;
          c.minY = Infinity;
          c.maxY = -Infinity;
          continue;
        }
        const wz = oz + (c.row - 1) * step;
        const base = c.row * stride;
        for (let i = 0; i < stride; i++) {
          H[base + i] = this.terrain.heightAt(ox + (i - 1) * step, wz);
        }
        c.row++;
        work += stride * HEIGHT_COST;
      } else {
        if (c.row >= res) {
          this.finishChunk(c, step, ox, oz);
          return work;
        }
        const j = c.row;
        const wz = oz + j * step;
        const hb = (j + 1) * stride + 1;
        const pos = c.pos;
        const nrm = c.nrm;
        const col = c.col;
        const ao = c.ao;
        let o3 = j * res * 3;
        let o1 = j * res;
        let lo = c.minY;
        let hi = c.maxY;
        for (let i = 0; i < res; i++) {
          const hIdx = hb + i;
          const h = H[hIdx];
          // Discrete Laplacian: negative in a gully, positive on a spur.
          const lap =
            h - 0.25 * (H[hIdx - 1] + H[hIdx + 1] + H[hIdx - stride] + H[hIdx + stride]);
          const wx = ox + i * step;
          this.terrain.sampleAt(wx, wz, _ts);
          this.biomes.sampleAt(wx, wz, _bs);
          pos[o3] = i * step;
          pos[o3 + 1] = h;
          pos[o3 + 2] = j * step;
          nrm[o3] = _ts.nx;
          nrm[o3 + 1] = _ts.ny;
          nrm[o3 + 2] = _ts.nz;
          col[o3] = _bs.r;
          col[o3 + 1] = _bs.g;
          col[o3 + 2] = _bs.b;
          ao[o1] = clamp(1 + (lap / step) * AO_GAIN, AO_MIN, AO_MAX);
          if (h < lo) lo = h;
          if (h > hi) hi = h;
          o3 += 3;
          o1++;
        }
        c.minY = lo;
        c.maxY = hi;
        c.row++;
        work += res;
      }
      if (work >= budget || performance.now() >= deadline) return work;
    }
  }

  /** Skirt, bounds, upload, and the moment the chunk starts showing its new ground. */
  private finishChunk(c: Chunk, step: number, ox: number, oz: number): void {
    const res = c.res;
    const border = this.levels[c.level].border;
    const skirt = clamp(step * SKIRT_STEP_FACTOR, SKIRT_MIN, SKIRT_MAX);
    const pos = c.pos;
    const nrm = c.nrm;
    const col = c.col;
    const ao = c.ao;
    const base = res * res;

    // The skirt copies the border ring straight down. It carries the border's
    // normal and colour so the sliver you see through a seam reads as more
    // ground rather than as a dark wall.
    for (let k = 0; k < border.length; k++) {
      const g = border[k];
      const d3 = (base + k) * 3;
      const s3 = g * 3;
      pos[d3] = pos[s3];
      pos[d3 + 1] = pos[s3 + 1] - skirt;
      pos[d3 + 2] = pos[s3 + 2];
      nrm[d3] = nrm[s3];
      nrm[d3 + 1] = nrm[s3 + 1];
      nrm[d3 + 2] = nrm[s3 + 2];
      col[d3] = col[s3];
      col[d3 + 1] = col[s3 + 1];
      col[d3 + 2] = col[s3 + 2];
      ao[base + k] = ao[g];
    }

    c.posAttr.needsUpdate = true;
    c.nrmAttr.needsUpdate = true;
    c.colAttr.needsUpdate = true;
    c.aoAttr.needsUpdate = true;

    // Hand-built bounds: three would otherwise walk every vertex (and allocate)
    // on the first draw after every single rewrite.
    const size = this.cfg.chunkSize;
    const sphere = c.geom.boundingSphere;
    if (sphere) {
      const halfY = (c.maxY - c.minY + skirt) * 0.5;
      sphere.center.set(size * 0.5, (c.maxY + c.minY - skirt) * 0.5, size * 0.5);
      sphere.radius = Math.sqrt(size * size * 0.5 + halfY * halfY);
    }
    const box = c.geom.boundingBox;
    if (box) {
      box.min.set(0, c.minY - skirt, 0);
      box.max.set(size, c.maxY, size);
    }

    c.mesh.position.set(ox, 0, oz);
    c.mesh.updateMatrix();
    c.shownX = c.gx;
    c.shownZ = c.gz;
    c.valid = true;
    c.dirty = false;
    this.refreshVisibility();
  }

  /**
   * Exactly one chunk draws any given square of ground. While the grid is
   * re-LODing, a stale chunk and its finer replacement can both be holding the
   * same coordinate; the finer, finished one wins and the other goes dark
   * without ever leaving a gap in between.
   */
  private refreshVisibility(): void {
    const R = this.rings;
    this.cover.fill(0x7fffffff);
    this.coverOwner.fill(-1);

    for (let i = 0; i < this.all.length; i++) {
      const c = this.all[i];
      if (!c.valid) {
        c.mesh.visible = false;
        continue;
      }
      const dx = c.shownX - this.cx;
      const dz = c.shownZ - this.cz;
      if (dx < -R || dx > R || dz < -R || dz > R) {
        c.mesh.visible = false;
        continue;
      }
      const oi = (dz + R) * this.span + (dx + R);
      // Finer wins; at equal fineness the one that is not mid-rebuild wins.
      const rank = c.level * 2 + (c.dirty ? 1 : 0);
      if (rank < this.cover[oi]) {
        this.cover[oi] = rank;
        this.coverOwner[oi] = c.id;
      }
    }

    for (let i = 0; i < this.all.length; i++) {
      const c = this.all[i];
      if (!c.valid) continue;
      const dx = c.shownX - this.cx;
      const dz = c.shownZ - this.cz;
      if (dx < -R || dx > R || dz < -R || dz > R) continue;
      c.mesh.visible = this.coverOwner[(dz + R) * this.span + (dx + R)] === c.id;
    }
  }

  // ------------------------------------------------------------ resources

  private makeChunk(lv: Level, level: number, id: number): Chunk {
    const n = lv.vertCount;
    const pos = new Float32Array(n * 3);
    const nrm = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const ao = new Float32Array(n);

    const posAttr = new THREE.BufferAttribute(pos, 3);
    const nrmAttr = new THREE.BufferAttribute(nrm, 3);
    const colAttr = new THREE.BufferAttribute(col, 3);
    const aoAttr = new THREE.BufferAttribute(ao, 1);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    nrmAttr.setUsage(THREE.DynamicDrawUsage);
    colAttr.setUsage(THREE.DynamicDrawUsage);
    aoAttr.setUsage(THREE.DynamicDrawUsage);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', posAttr);
    geom.setAttribute('normal', nrmAttr);
    geom.setAttribute('aColor', colAttr);
    geom.setAttribute('aAo', aoAttr);
    // The index is topology, not data: every chunk at this ring shares one.
    geom.setIndex(lv.index);
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    geom.boundingBox = new THREE.Box3();

    const mesh = new THREE.Mesh(geom, this.material);
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    mesh.renderOrder = 0;
    this.group.add(mesh);

    return {
      id,
      level,
      res: lv.res,
      mesh,
      geom,
      pos,
      nrm,
      col,
      ao,
      posAttr,
      nrmAttr,
      colAttr,
      aoAttr,
      gx: 0,
      gz: 0,
      shownX: 0,
      shownZ: 0,
      valid: false,
      dirty: true,
      phase: 0,
      row: 0,
      minY: 0,
      maxY: 0,
    };
  }

  private makeMaterial(atmo: AtmosphereUniforms): THREE.ShaderMaterial {
    const uniforms = withAtmosphere(atmo, {
      uCloudCover: this.uCloudCover,
      uCloudShadow: this.uCloudShadow,
      uCloudDrift: this.uCloudDrift,
      uSnowLine: this.uSnowLine,
      uSnowBlend: this.uSnowBlend,
    });

    const vertexShader = /* glsl */ `
      attribute vec3 aColor;
      attribute float aAo;

      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vColor;
      varying float vAo;

      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        // NOT normalMatrix: three derives that from the modelView matrix, which
        // would hand the fragment a view-space normal. The atmosphere lights in
        // world space. Chunks only ever translate, so this is exact.
        vNormal = mat3(modelMatrix) * normal;
        vColor = aColor;
        vAo = aAo;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `;

    const fragmentShader = /* glsl */ `
      ${ATMOSPHERE_PRELUDE}

      uniform float uCloudCover;
      uniform float uCloudShadow;
      uniform vec2  uCloudDrift;
      uniform float uSnowLine;
      uniform float uSnowBlend;

      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vColor;
      varying float vAo;

      // Metres of the wet band above the waterline. Two and a half is a real
      // tide line: wide across a beach, a thin dark rim around a mountain tarn.
      const float WET_BAND = 2.6;

      void main() {
        vec3 N = normalize(vNormal);
        vec3 toCam = uCameraPos - vWorld;
        float dist = length(toCam);
        vec3 viewDir = -toCam / max(dist, 1e-4);   // camera -> fragment

        // ---------------------------------------------------------- albedo
        // Two scales, because one always reads as a pattern. The fine grain
        // fades out with distance or it aliases into a shimmering mess.
        float nearFade = 1.0 - smoothstep(150.0, 1100.0, dist);
        float grit = anoise2(vWorld.xz * 0.085);
        float mottle = afbm2(vWorld.xz * 0.0062, 3);
        float detail = (grit - 0.5) * 0.17 * nearFade + (mottle - 0.4375) * 0.34;
        vec3 albedo = vColor * (1.0 + detail);
        // A touch of hue wander with it, so it isn't pure brightness noise.
        albedo.g *= 1.0 + detail * 0.22;

        float ao = vAo;

        // ------------------------------------------------------------ snow
        // The single effect that makes a range read as a mountain range: snow
        // above the line, but only where the ground is shallow enough to hold
        // it, so every steep rib stays bare stone through the white.
        float snowJit = (afbm2(vWorld.xz * 0.0017, 3) - 0.4375) * 1.9;
        float snowH = smoothstep(
          uSnowLine, uSnowLine + uSnowBlend, vWorld.y + snowJit * uSnowBlend * 0.6);
        float holds = smoothstep(0.52, 0.80, N.y);
        float snow = snowH * holds;
        vec3 snowAlbedo = vec3(0.80, 0.855, 0.95) * (1.0 + 0.17 * (grit - 0.5) * nearFade);
        albedo = mix(albedo, snowAlbedo, snow);
        // Snow fills the creases it settles in, so it flattens the curvature term.
        ao = mix(ao, mix(1.0, ao, 0.45), snow);

        // ------------------------------------------------------- wet shore
        // Everything within a couple of metres of the water is dark and more
        // saturated. It is what draws a line around every lake and coast.
        float wet = (1.0 - smoothstep(0.0, WET_BAND, vWorld.y - uWaterLevel)) * (1.0 - snow);
        float lum = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
        vec3 wetC = max(mix(vec3(lum), albedo, 1.3), vec3(0.0)) * 0.46;
        albedo = mix(albedo, wetC, wet * 0.9);

        // --------------------------------------------------- cloud shadows
        // Scrolled downwind by the shared clock. Soft edges, never black —
        // ground under a cumulus still has the whole sky lighting it.
        vec2 cp = (vWorld.xz - uCloudDrift * uTime) * 0.00055;
        float cl = afbm2(cp, 3);
        float thr = mix(0.78, 0.26, uCloudCover);
        float cloud = smoothstep(thr, thr + 0.17, cl);
        float key = 1.0 - 0.75 * cloud * uCloudShadow;

        // ---------------------------------------------------------- shading
        vec3 lit = shadeSurface(albedo, N, viewDir, ao);
        // The same fill term shadeSurface uses, with the sun taken away: what
        // this fragment would look like with a cloud over it.
        float hemi = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 fill = mix(uGroundBounce, uAmbient, hemi) * uAmbientIntensity;
        vec3 shadowed = albedo * fill * ao;
        vec3 color = mix(shadowed, lit, key);

        color = aerialPerspective(color, vWorld, viewDir, dist);
        color += ditherValue(gl_FragCoord.xy);

        gl_FragColor = vec4(color, 1.0);
      }
    `;

    return new THREE.ShaderMaterial({
      uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
      vertexShader,
      fragmentShader,
      side: THREE.FrontSide,
      transparent: false,
      depthWrite: true,
      depthTest: true,
      fog: false,
      lights: false,
    });
  }
}

// ==================================================================== index
// Topology only, so it is built once per ring and shared by every chunk in it.

/**
 * Grid triangles wound so their geometric normal points up, then the skirt
 * wall wound so it faces outward. The border is walked as one closed loop
 * (+X, +Z, -X, -Z), which makes a single winding rule correct on all four
 * sides — verified per edge rather than guessed at.
 */
function makeIndex(res: number): THREE.BufferAttribute {
  const border = 4 * (res - 1);
  const verts = res * res + border;
  const count = (res - 1) * (res - 1) * 6 + border * 6;
  const arr = verts > 65535 ? new Uint32Array(count) : new Uint16Array(count);
  let k = 0;
  for (let j = 0; j < res - 1; j++) {
    for (let i = 0; i < res - 1; i++) {
      const a = j * res + i;
      const b = a + 1;
      const c = a + res;
      const d = c + 1;
      arr[k++] = a;
      arr[k++] = c;
      arr[k++] = b;
      arr[k++] = b;
      arr[k++] = c;
      arr[k++] = d;
    }
  }
  const loop = makeBorder(res);
  const base = res * res;
  for (let e = 0; e < border; e++) {
    const n = (e + 1) % border;
    const t0 = loop[e];
    const t1 = loop[n];
    const b0 = base + e;
    const b1 = base + n;
    arr[k++] = t0;
    arr[k++] = t1;
    arr[k++] = b0;
    arr[k++] = t1;
    arr[k++] = b1;
    arr[k++] = b0;
  }
  return new THREE.BufferAttribute(arr, 1);
}

/** The border ring as one closed loop of grid vertex indices. */
function makeBorder(res: number): Int32Array {
  const out = new Int32Array(4 * (res - 1));
  let k = 0;
  for (let i = 0; i < res - 1; i++) out[k++] = i; // south, +X
  for (let j = 0; j < res - 1; j++) out[k++] = j * res + (res - 1); // east, +Z
  for (let i = res - 1; i > 0; i--) out[k++] = (res - 1) * res + i; // north, -X
  for (let j = res - 1; j > 0; j--) out[k++] = j * res; // west, -Z
  return out;
}

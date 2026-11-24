import * as THREE from 'three';
import { BLOOM_DOWN, BLOOM_UP, COMPOSITE, COPY, FXAA, GRADE, SHADOW_BAKE } from './glsl/passes';
import { G, Uniforms } from './globals';
import { Pass } from './pass';
import { Frame } from './light';
import { makeNoiseTexture } from './textures';
import { Clouds } from './clouds';

export interface Quality {
  name: 'low' | 'medium' | 'high' | 'ultra';
  /** max device pixels on the long edge */
  maxPixels: number;
  msaa: number;
  cloudScale: number;
  cloudSteps: number;
  shadowSize: number;
  treeFar: number;
  treeDensity: number;
  grass: number;
  lodScale: number;
  heightN: number;
  mistSteps: number;
}

export const QUALITY: Record<Quality['name'], Quality> = {
  low: { name: 'low', maxPixels: 900_000, msaa: 0, cloudScale: 0.25, cloudSteps: 26, shadowSize: 1024, treeFar: 700, treeDensity: 0.45, grass: 0.25, lodScale: 0.7, heightN: 1024, mistSteps: 8 },
  medium: { name: 'medium', maxPixels: 1_500_000, msaa: 2, cloudScale: 0.33, cloudSteps: 36, shadowSize: 1536, treeFar: 1000, treeDensity: 0.7, grass: 0.5, lodScale: 0.85, heightN: 2048, mistSteps: 10 },
  high: { name: 'high', maxPixels: 2_600_000, msaa: 4, cloudScale: 0.4, cloudSteps: 48, shadowSize: 2048, treeFar: 1400, treeDensity: 1, grass: 1, lodScale: 1, heightN: 2048, mistSteps: 14 },
  ultra: { name: 'ultra', maxPixels: 5_000_000, msaa: 4, cloudScale: 0.5, cloudSteps: 72, shadowSize: 2048, treeFar: 1800, treeDensity: 1, grass: 1.4, lodScale: 1.2, heightN: 2048, mistSteps: 18 },
};

const RT_OPTS = {
  type: THREE.HalfFloatType,
  format: THREE.RGBAFormat,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  depthBuffer: false,
  generateMipmaps: false,
} as const;

export class Engine {
  readonly gl: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(58, 1, 1.0, 60000);
  readonly opaque = new THREE.Scene();
  readonly water = new THREE.Scene();
  readonly fx = new THREE.Scene();
  readonly shadowScene = new THREE.Scene();
  readonly clouds: Clouds;
  quality: Quality;
  /** dynamic resolution, 0.5..1 */
  renderScale = 1;
  painterly = 0;
  vignette = 0.32;
  bloom = 0.085;
  fade = 1;
  readonly fadeCol = new THREE.Color(0, 0, 0);

  private rtA!: THREE.WebGLRenderTarget;
  private rtB!: THREE.WebGLRenderTarget;
  private rtW!: THREE.WebGLRenderTarget;
  private rtL!: THREE.WebGLRenderTarget;
  private bloomDown: THREE.WebGLRenderTarget[] = [];
  private bloomUp: THREE.WebGLRenderTarget[] = [];
  private rtTerrainShadow: THREE.WebGLRenderTarget;
  private rtCsm!: THREE.WebGLRenderTarget;
  private readonly csmCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1200);
  private shadowTile = 0;
  private shadowDirty = true;

  private readonly pShadow: Pass;
  private readonly pComp: Pass;
  private readonly pCopy: Pass;
  private readonly pDown: Pass;
  private readonly pUp: Pass;
  private readonly pGrade: Pass;
  private readonly pFxaa: Pass;
  /** view uniforms shared by passes and water */
  readonly V: Uniforms = {
    uProj: { value: new THREE.Vector4() },
    uCamRot: { value: new THREE.Matrix3() },
    tColor: { value: null },
    tOpaque: { value: null },
    tScene: { value: null },
    tDepth: { value: null },
    tClouds: { value: null },
    uCloudRes: { value: new THREE.Vector2(1, 1) },
    uCloudsOn: { value: 1 },
    uVP: { value: new THREE.Matrix4() },
  };
  w = 1;
  h = 1;

  constructor(canvas: HTMLCanvasElement, quality: Quality) {
    this.quality = quality;
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    this.gl.autoClear = false;
    this.gl.toneMapping = THREE.NoToneMapping;
    this.gl.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.gl.info.autoReset = false;
    G.uNoise.value = makeNoiseTexture(512);

    this.rtTerrainShadow = new THREE.WebGLRenderTarget(1024, 1024, {
      ...RT_OPTS,
      format: THREE.RGFormat,
    });
    G.uShadowTex.value = this.rtTerrainShadow.texture;

    this.clouds = new Clouds(this);
    this.pShadow = new Pass(SHADOW_BAKE, { uMaxH: { value: 600 } });
    this.pComp = new Pass(COMPOSITE, this.V);
    this.pCopy = new Pass(COPY, { tColor: { value: null } });
    this.pDown = new Pass(BLOOM_DOWN, { tColor: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 0 } });
    this.pUp = new Pass(BLOOM_UP, { tColor: { value: null }, tBase: { value: null }, uTexel: { value: new THREE.Vector2() }, uMix: { value: 0.6 } });
    this.pGrade = new Pass(GRADE, {
      tColor: { value: null },
      tBloom: { value: null },
      uExp: { value: 1 },
      uSat: { value: 1 },
      uCon: { value: 1 },
      uBloom: { value: 0.08 },
      uVig: { value: 0.3 },
      uFade: { value: 0 },
      uPainterly: { value: 0 },
      uLo: { value: new THREE.Color(0.5, 0.5, 0.5) },
      uHi: { value: new THREE.Color(0.5, 0.5, 0.5) },
      uFadeCol: { value: this.fadeCol },
      uTexel: { value: new THREE.Vector2() },
    });
    this.pFxaa = new Pass(FXAA, { tColor: { value: null }, uTexel: { value: new THREE.Vector2() }, uSharp: { value: 0.15 } });
    this.makeCsm();
  }

  private makeCsm(): void {
    this.rtCsm?.dispose();
    const s = this.quality.shadowSize;
    this.rtCsm = new THREE.WebGLRenderTarget(s, s, { depthBuffer: true, format: THREE.RedFormat, type: THREE.UnsignedByteType, generateMipmaps: false });
    const dt = new THREE.DepthTexture(s, s, THREE.UnsignedIntType);
    dt.compareFunction = THREE.LessEqualCompare;
    dt.minFilter = THREE.LinearFilter;
    dt.magFilter = THREE.LinearFilter;
    this.rtCsm.depthTexture = dt;
    G.uCsm.value = dt;
    G.uCsmInfo.value.set(1 / s, 230, 1, 0);
  }

  setQuality(q: Quality): void {
    this.quality = q;
    this.makeCsm();
    this.resize(true);
  }

  resize(force = false): void {
    const c = this.gl.domElement;
    const cssW = c.clientWidth || window.innerWidth;
    const cssH = c.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let pw = cssW * dpr;
    let ph = cssH * dpr;
    const over = Math.sqrt((pw * ph) / this.quality.maxPixels);
    if (over > 1) {
      pw /= over;
      ph /= over;
    }
    pw = Math.max(64, Math.round(pw));
    ph = Math.max(64, Math.round(ph));
    const w = Math.max(64, Math.round(pw * this.renderScale));
    const h = Math.max(64, Math.round(ph * this.renderScale));
    this.camera.aspect = cssW / cssH;
    this.camera.updateProjectionMatrix();
    if (!force && w === this.w && h === this.h && c.width === pw && c.height === ph) return;
    this.gl.setPixelRatio(1);
    this.gl.setSize(pw, ph, false);
    this.w = w;
    this.h = h;
    for (const t of [this.rtA, this.rtB, this.rtW, this.rtL, ...this.bloomDown, ...this.bloomUp]) t?.dispose();
    this.rtA = new THREE.WebGLRenderTarget(w, h, { ...RT_OPTS, depthBuffer: true, samples: this.quality.msaa });
    const dt = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    dt.minFilter = dt.magFilter = THREE.NearestFilter;
    this.rtA.depthTexture = dt;
    this.rtB = new THREE.WebGLRenderTarget(w, h, RT_OPTS);
    this.rtW = new THREE.WebGLRenderTarget(w, h, { ...RT_OPTS, depthBuffer: true });
    this.rtL = new THREE.WebGLRenderTarget(w, h, { ...RT_OPTS, type: THREE.UnsignedByteType });
    this.bloomDown = [];
    this.bloomUp = [];
    let bw = w;
    let bh = h;
    for (let i = 0; i < 6; i++) {
      bw = Math.max(2, bw >> 1);
      bh = Math.max(2, bh >> 1);
      this.bloomDown.push(new THREE.WebGLRenderTarget(bw, bh, RT_OPTS));
      this.bloomUp.push(new THREE.WebGLRenderTarget(bw, bh, RT_OPTS));
    }
    G.uRes.value.set(w, h);
    this.clouds.resize(w, h);
  }

  /** Re-bake terrain shadows fully on the next frame (new land, big sun jump). */
  invalidateShadows(): void {
    this.shadowDirty = true;
  }

  private bakeTerrainShadow(maxH: number): void {
    if (!G.uHeightTex.value) return;
    const rt = this.rtTerrainShadow;
    this.pShadow.mat.uniforms.uMaxH.value = maxH;
    if (this.shadowDirty) {
      rt.scissorTest = false;
      this.pShadow.render(this.gl, rt);
      this.shadowDirty = false;
      return;
    }
    const n = 4;
    const s = rt.width / n;
    const t = this.shadowTile++ % (n * n);
    rt.scissorTest = true;
    rt.scissor.set((t % n) * s, Math.floor(t / n) * s, s, s);
    this.pShadow.render(this.gl, rt);
    rt.scissorTest = false;
  }

  private renderCsm(focus: THREE.Vector3): void {
    const R = G.uCsmInfo.value.y;
    const d = G.uKeyDir.value;
    const cam = this.csmCam;
    cam.left = -R;
    cam.right = R;
    cam.top = R;
    cam.bottom = -R;
    cam.near = 1;
    cam.far = 1400;
    cam.up.set(0, 1, 0);
    cam.position.copy(focus).addScaledVector(d, 700);
    cam.lookAt(focus);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    // snap to texels so shadows don't swim
    const m = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const o = new THREE.Vector4(0, 0, 0, 1).applyMatrix4(m);
    const s = this.quality.shadowSize / 2;
    const dx = (Math.round(o.x * s) - o.x * s) / s;
    const dy = (Math.round(o.y * s) - o.y * s) / s;
    cam.projectionMatrix.elements[12] += dx;
    cam.projectionMatrix.elements[13] += dy;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    G.uCsmMat.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.gl.setRenderTarget(this.rtCsm);
    this.gl.clear(true, true, false);
    this.gl.render(this.shadowScene, cam);
  }

  render(frame: Frame, focus: THREE.Vector3, maxH: number): void {
    const gl = this.gl;
    gl.info.reset();
    const cam = this.camera;
    cam.updateMatrixWorld();
    G.uCamPos.value.copy(cam.position);
    const ty = Math.tan((cam.fov * Math.PI) / 360);
    (this.V.uProj.value as THREE.Vector4).set(ty * cam.aspect, ty, cam.near, cam.far);
    (this.V.uCamRot.value as THREE.Matrix3).setFromMatrix4(cam.matrixWorld);
    (this.V.uVP.value as THREE.Matrix4).multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);

    this.bakeTerrainShadow(maxH);
    this.renderCsm(focus);

    // opaque world
    gl.setRenderTarget(this.rtA);
    gl.setClearColor(0x000000, 1);
    gl.clear(true, true, false);
    gl.render(this.opaque, cam);

    // clouds + mist
    this.V.tDepth.value = this.rtA.depthTexture;
    this.clouds.render(this.V);
    this.V.tClouds.value = this.clouds.texture;
    (this.V.uCloudRes.value as THREE.Vector2).set(this.clouds.w, this.clouds.h);

    // air + sky + clouds over the land
    this.V.tColor.value = this.rtA.texture;
    this.pComp.render(gl, this.rtB);

    // water reads the finished scene for reflection
    this.V.tOpaque.value = this.rtA.texture;
    this.V.tScene.value = this.rtB.texture;
    this.pCopy.mat.uniforms.tColor.value = this.rtB.texture;
    gl.setRenderTarget(this.rtW);
    gl.clear(true, true, false);
    this.pCopy.render(gl, this.rtW);
    gl.setRenderTarget(this.rtW);
    gl.render(this.water, cam);
    gl.render(this.fx, cam);

    // bloom
    let src = this.rtW;
    for (let i = 0; i < this.bloomDown.length; i++) {
      const u = this.pDown.mat.uniforms;
      u.tColor.value = src.texture;
      (u.uTexel.value as THREE.Vector2).set(1 / src.width, 1 / src.height);
      u.uFirst.value = i === 0 ? 1 : 0;
      this.pDown.render(gl, this.bloomDown[i]);
      src = this.bloomDown[i];
    }
    let up = this.bloomDown[this.bloomDown.length - 1];
    for (let i = this.bloomDown.length - 2; i >= 0; i--) {
      const u = this.pUp.mat.uniforms;
      u.tColor.value = up.texture;
      u.tBase.value = this.bloomDown[i].texture;
      (u.uTexel.value as THREE.Vector2).set(1 / up.width, 1 / up.height);
      u.uMix.value = 0.62;
      this.pUp.render(gl, this.bloomUp[i]);
      up = this.bloomUp[i];
    }

    // grade → fxaa → screen
    const gu = this.pGrade.mat.uniforms;
    gu.tColor.value = this.rtW.texture;
    gu.tBloom.value = this.bloomUp[0].texture;
    gu.uExp.value = frame.exp;
    gu.uSat.value = frame.sat;
    gu.uCon.value = frame.con;
    gu.uBloom.value = this.bloom;
    gu.uVig.value = this.vignette;
    gu.uFade.value = this.fade;
    gu.uPainterly.value = this.painterly;
    (gu.uLo.value as THREE.Color).copy(frame.lo).convertLinearToSRGB();
    (gu.uHi.value as THREE.Color).copy(frame.hi).convertLinearToSRGB();
    (gu.uTexel.value as THREE.Vector2).set(1 / this.w, 1 / this.h);
    this.pGrade.render(gl, this.rtL);
    const fu = this.pFxaa.mat.uniforms;
    fu.tColor.value = this.rtL.texture;
    (fu.uTexel.value as THREE.Vector2).set(1 / this.w, 1 / this.h);
    fu.uSharp.value = 0.12 + (1 - this.renderScale) * 0.3;
    this.pFxaa.render(gl, null);
  }
}

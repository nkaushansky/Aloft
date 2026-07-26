import * as THREE from 'three';
import type { Config } from '../sim/config';
import type {
  BiomeProvider,
  BirdState,
  FlockBird,
  QualitySettings,
  SkyState,
  TerrainProvider,
  WindField,
} from '../sim/types';
import { createAtmosphereUniforms, syncAtmosphere } from './shaders/atmosphere';
import type { AtmosphereUniforms } from './shaders/atmosphere';
import { TerrainRenderer } from './world/terrainMesh';
import { WaterPlane } from './world/water';
import { Scatter } from './world/scatter';
import { SkyDome } from './sky/skyDome';
import { CloudLayer } from './sky/clouds';
import { WindRibbons, AirColumns } from './air/windRibbons';
import { BirdActor } from './actors/birdMesh';
import { FlockActor } from './actors/flockMesh';
import { PostPipeline } from './post/pipeline';
import { ChaseCamera } from './camera/chase';
import { clamp01, smoothstep } from '../sim/math';
import { cruiseSpeed } from '../sim/config';

/**
 * The scene owner. Everything visible is built and driven from here, and the
 * only thing this class really does that is interesting is guarantee that
 * every subsystem shares one atmosphere: the AtmosphereUniforms object is
 * created once, handed to every material by reference, and updated exactly
 * once per frame. Nothing below is allowed to invent its own idea of where
 * the sun is.
 */
export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly chase: ChaseCamera;
  readonly atmo: AtmosphereUniforms;

  private readonly terrainR: TerrainRenderer;
  private readonly water: WaterPlane;
  private readonly scatter: Scatter;
  private readonly skyDome: SkyDome;
  private readonly clouds: CloudLayer;
  private readonly ribbons: WindRibbons;
  private readonly columns: AirColumns;
  private readonly birdActor: BirdActor;
  private readonly flockActor: FlockActor;
  private post: PostPipeline;

  private quality: QualitySettings;
  private time = 0;
  private readonly windDir = new THREE.Vector2();
  private windSpeed = 0;
  /** Smoothed 0..1 speed factor — post-processing hates a twitchy driver. */
  private speed01 = 0;
  private fade = 0;
  private vignette = 0.28;

  private readonly scratchV3 = new THREE.Vector3();
  private readonly sunScreen = new THREE.Vector2();

  constructor(
    private readonly container: HTMLElement,
    private readonly cfg: Config,
    private readonly terrain: TerrainProvider,
    biomes: BiomeProvider,
    private readonly wind: WindField,
    quality: QualitySettings,
  ) {
    this.quality = quality;

    this.gl = new THREE.WebGLRenderer({
      antialias: false, // FXAA in the post chain — cheaper, and MSAA can't see into HDR bloom
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatioCap));
    this.gl.setSize(container.clientWidth, container.clientHeight);
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    // Tonemapping happens in the post composite, not here — doing it twice
    // would crush the highlights the bloom is supposed to find.
    this.gl.toneMapping = THREE.NoToneMapping;
    this.gl.autoClear = true;
    container.appendChild(this.gl.domElement);

    this.atmo = createAtmosphereUniforms(terrain.waterLevel());
    this.chase = new ChaseCamera(cfg, terrain);

    this.skyDome = new SkyDome(this.scene, cfg, this.atmo, quality);
    this.terrainR = new TerrainRenderer(this.scene, cfg, terrain, biomes, this.atmo, quality);
    this.water = new WaterPlane(this.scene, cfg, terrain, this.atmo, quality);
    this.scatter = new Scatter(this.scene, cfg, terrain, biomes, this.atmo, quality);
    this.clouds = new CloudLayer(this.scene, cfg, wind, this.atmo, quality);
    this.ribbons = new WindRibbons(this.scene, cfg, wind, this.atmo, quality);
    this.columns = new AirColumns(this.scene, cfg, wind, this.atmo, quality);
    this.birdActor = new BirdActor(this.scene, cfg, this.atmo, quality);
    this.flockActor = new FlockActor(this.scene, cfg, this.atmo, quality);

    this.post = new PostPipeline(this.gl, this.scene, this.chase.camera, quality);
    this.resize();
    window.addEventListener('resize', this.onResize);
  }

  private readonly onResize = (): void => this.resize();

  resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    const pr = Math.min(window.devicePixelRatio, this.quality.pixelRatioCap);
    this.gl.setPixelRatio(pr);
    this.gl.setSize(w, h, false);
    this.chase.camera.aspect = w / h;
    this.chase.camera.updateProjectionMatrix();
    this.post.setSize(w, h, pr);
  }

  setQuality(q: QualitySettings): void {
    this.quality = q;
    this.ribbons.setQuality(q);
    this.columns.setQuality(q);
    this.clouds.setQuality(q);
    this.water.setQuality(q);
    this.scatter.setQuality(q);
    this.post.setQuality(q);
    this.resize();
  }

  /** Rebuild everything that depends on the seed. */
  rebuildWorld(): void {
    this.terrainR.rebuild();
  }

  get worldReady(): boolean {
    return this.terrainR.ready;
  }

  /** Fade the whole frame to black. 0 = clear, 1 = black. */
  setFade(f: number): void {
    this.fade = clamp01(f);
  }

  setVignette(v: number): void {
    this.vignette = v;
  }

  setBirdVisible(v: boolean): void {
    this.birdActor.setVisible(v);
  }

  render(dt: number, bird: BirdState, sky: SkyState, flock: readonly FlockBird[]): void {
    this.time += dt;
    const cam = this.chase.camera;

    // The camera moves first: everything else culls and streams against it,
    // so a stale camera means a frame of visible pop-in at the edges.
    this.chase.update(dt, bird, sky, cam.aspect);
    const camPos = cam.getWorldPosition(this.scratchV3);

    // ONE atmosphere update, before anything shades.
    syncAtmosphere(this.atmo, sky, camPos, this.time);

    // The prevailing wind, shared by everything that leans or drifts.
    const wdir = (this.cfg.windDirDeg * Math.PI) / 180;
    this.windDir.set(-Math.sin(wdir), -Math.cos(wdir));
    this.windSpeed = this.cfg.windSpeed;

    this.skyDome.update(dt, camPos, sky);
    this.terrainR.update(dt, camPos, sky);
    this.water.update(dt, camPos, sky, this.windDir.x, this.windDir.y);
    this.scatter.update(dt, camPos, sky, this.windDir.x, this.windDir.y, this.windSpeed);
    this.clouds.update(dt, bird, sky, camPos);
    this.ribbons.update(dt, bird, sky, camPos);
    this.columns.update(dt, bird, sky, camPos);
    this.birdActor.update(dt, bird, sky, camPos);
    this.flockActor.update(dt, flock, sky, camPos);

    // --- drive the post chain -------------------------------------------
    const cruise = cruiseSpeed(this.cfg, bird.wing);
    const target = clamp01((bird.airspeed - cruise) / Math.max(this.cfg.maxAirspeed - cruise, 1));
    // Deliberately laggy: speed effects that track airspeed exactly read as
    // a bug, while ones that swell a beat late read as momentum.
    this.speed01 += (target - this.speed01) * Math.min(1, dt * 2.4);

    this.projectSun(sky, cam);
    const sunVisible =
      smoothstep(-0.02, 0.08, sky.sunDir.y) *
      (this.sunScreen.x > -0.35 && this.sunScreen.x < 1.35 && this.sunScreen.y > -0.35 && this.sunScreen.y < 1.35
        ? 1
        : 0);

    this.post.setState({
      exposure: sky.exposure,
      speed01: this.speed01,
      turbulence: bird.turbulence,
      sunScreenPos: this.sunScreen,
      sunVisible,
      vignette: this.vignette,
      fade: this.fade,
      dayT: sky.t,
    });
    this.post.render(dt);
  }

  /** Where the sun lands in normalized screen space, for the god-ray pass. */
  private projectSun(sky: SkyState, cam: THREE.PerspectiveCamera): void {
    const far = this.cfg.viewDistance * 0.9;
    this.scratchV3
      .set(sky.sunDir.x, sky.sunDir.y, sky.sunDir.z)
      .multiplyScalar(far)
      .add(cam.position);
    this.scratchV3.project(cam);
    this.sunScreen.set(this.scratchV3.x * 0.5 + 0.5, this.scratchV3.y * 0.5 + 0.5);
  }

  /** Cloud coverage from the cloud layer, for terrain shadowing. */
  get cloudCoverage(): number {
    return this.clouds.coverage;
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.skyDome.dispose();
    this.terrainR.dispose();
    this.water.dispose();
    this.scatter.dispose();
    this.clouds.dispose();
    this.ribbons.dispose();
    this.columns.dispose();
    this.birdActor.dispose();
    this.flockActor.dispose();
    this.post.dispose();
    this.gl.dispose();
    this.gl.domElement.remove();
    void this.terrain;
    void this.wind;
  }
}

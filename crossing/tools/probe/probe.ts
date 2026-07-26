// Temporary: instantiate each landed render module against a real GL context
// so shader compile/link failures surface before the whole game is wired up.
import * as THREE from 'three';
import { config } from '../../src/sim/config';
import { ProceduralTerrain } from '../../src/sim/terrain';
import { ProceduralBiomes } from '../../src/sim/biome';
import { AtmosphereField } from '../../src/sim/wind';
import { SkyModel } from '../../src/sim/sky';
import { createAtmosphereUniforms, syncAtmosphere } from '../../src/render/shaders/atmosphere';
import { qualityFor } from '../../src/game/quality';
import { SkyDome } from '../../src/render/sky/skyDome';
import { TerrainRenderer } from '../../src/render/world/terrainMesh';
import { CloudLayer } from '../../src/render/sky/clouds';
import { WindRibbons, AirColumns } from '../../src/render/air/windRibbons';
import { ChaseCamera } from '../../src/render/camera/chase';
import { createBirdState } from '../../src/sim/state';
import { PostPipeline } from '../../src/render/post/pipeline';

const log: string[] = [];
const results: Record<string, string> = {};
function step(name: string, fn: () => void) {
  try { fn(); results[name] = 'ok'; }
  catch (e) { results[name] = String((e as Error).message ?? e); log.push(name + ': ' + results[name]); }
}

const container = document.getElementById('app')!;
const EXPO = Number(new URLSearchParams(location.search).get('e') ?? '1');
const tier = (new URLSearchParams(location.search).get('q') ?? 'high') as 'low'|'medium'|'high'|'ultra';
const q = qualityFor(tier);
const terrain = new ProceduralTerrain(config);
const biomes = new ProceduralBiomes(config, terrain);
const wind = new AtmosphereField(config, terrain, biomes);
const sky = new SkyModel(config);
sky.setTime(0.62);
wind.setFocus(0, 0);
wind.update(0.016, sky.state);

const gl = new THREE.WebGLRenderer({ antialias: false });
gl.setSize(900, 500);
gl.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(gl.domElement);
const scene = new THREE.Scene();
const atmo = createAtmosphereUniforms(terrain.waterLevel());

let skyDome: SkyDome, terrainR: TerrainRenderer, clouds: CloudLayer,
    ribbons: WindRibbons, columns: AirColumns, chase: ChaseCamera, post: PostPipeline;

step('ChaseCamera', () => { chase = new ChaseCamera(config, terrain); });
step('SkyDome', () => { skyDome = new SkyDome(scene, config, atmo, q); });
step('TerrainRenderer', () => { terrainR = new TerrainRenderer(scene, config, terrain, biomes, atmo, q); });
step('CloudLayer', () => { clouds = new CloudLayer(scene, config, wind, atmo, q); });
step('WindRibbons', () => { ribbons = new WindRibbons(scene, config, wind, atmo, q); });
step('AirColumns', () => { columns = new AirColumns(scene, config, wind, atmo, q); });

const bird = createBirdState(config, 0, 1800, 0);
const freeCam = new THREE.PerspectiveCamera(62, 900/500, 0.5, config.viewDistance);
const camPos = new THREE.Vector3();

step('PostPipeline', () => { post = new PostPipeline(gl, scene, freeCam, q); post.setSize(900, 500, 1); });

const sunScreen = new THREE.Vector2(0.5, 0.5);
step('frames', () => {
  for (let i = 0; i < 45; i++) {
    const dt = 1 / 60;
    sky.update(dt);
    wind.update(dt, sky.state);
    chase.update(dt, bird, sky.state, 900 / 500);
    chase.camera.getWorldPosition(camPos);
    // Look down and forward from a fixed high vantage so the LAND is in frame,
    // not just the sky — the chase cam frames the horizon by design.
    freeCam.position.set(0, terrain.heightAt(0,0) + 1400, 900);
    freeCam.lookAt(0, terrain.heightAt(0,0) + 300, -2200);
    freeCam.updateMatrixWorld();
    freeCam.getWorldPosition(camPos);
    syncAtmosphere(atmo, sky.state, camPos, i * dt);
    skyDome.update(dt, camPos, sky.state);
    terrainR.update(dt, camPos, sky.state);
    clouds.update(dt, bird, sky.state, camPos);
    ribbons.update(dt, bird, sky.state, camPos);
    columns.update(dt, bird, sky.state, camPos);
    // Drive the real post chain so what we look at is what the game outputs:
    // ACES, the grade, bloom and the vignette all live in here.
    const sd = sky.state.sunDir;
    const sp = new THREE.Vector3(sd.x, sd.y, sd.z).multiplyScalar(config.viewDistance * 0.9).add(freeCam.position);
    sp.project(freeCam);
    sunScreen.set(sp.x * 0.5 + 0.5, sp.y * 0.5 + 0.5);
    post.setState({
      exposure: sky.state.exposure * EXPO, speed01: 0.25, turbulence: 0.1,
      sunScreenPos: sunScreen, sunVisible: (sunScreen.x > -0.2 && sunScreen.x < 1.2 && sunScreen.y > -0.2 && sunScreen.y < 1.2 && sky.state.sunDir.y > 0) ? 1 : 0,
      vignette: 0.28, fade: 0, dayT: sky.state.t,
    });
    post.render(dt);
  }
});

// Surface anything WebGL complained about.
const diag = gl.getContext().getError();
// Read the SCENE alone (no post) and then the POST result, so we can tell
// which stage is washing the frame out instead of guessing.
gl.setRenderTarget(null);
gl.render(scene, freeCam);
const px = new Uint8Array(4);
function probePixel(fx: number, fy: number) {
  const ctx = gl.getContext();
  ctx.readPixels(Math.round(fx * 900), Math.round(fy * 500), 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
  return [px[0], px[1], px[2]];
}
const rawSamples = {
  zenith: probePixel(0.5, 0.95),
  skyMid: probePixel(0.5, 0.72),
  farGround: probePixel(0.5, 0.45),
  nearGround: probePixel(0.5, 0.12),
};
post.setState({ exposure: sky.state.exposure * EXPO, speed01: 0, turbulence: 0,
  sunScreenPos: sunScreen, sunVisible: 0, vignette: 0.28, fade: 0, dayT: sky.state.t });
post.render(1/60);
const samples = {
  zenith: probePixel(0.5, 0.95),
  skyMid: probePixel(0.5, 0.72),
  farGround: probePixel(0.5, 0.45),
  nearGround: probePixel(0.5, 0.12),
};
(window as any).__probe = { results, log, glError: diag, ready: terrainR ? terrainR.ready : false, expo: EXPO, tier, raw: rawSamples, samples };
console.log('PROBE', JSON.stringify(results));

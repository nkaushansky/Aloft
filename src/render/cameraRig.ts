import * as THREE from 'three';
import type { BirdState } from '../sim/state';
import type { TerrainProvider } from '../sim/terrain';
import { config } from '../sim/config';

type Mode = 'chase' | 'orbit' | 'fixed';

const V = THREE.Vector3;
const wrap = (a: number) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

/**
 * One camera, several moods, and it always drifts between them. In chase it
 * eases the bird's heading rather than its position, so the bird sits still
 * in frame and the world does the moving.
 */
export class CameraRig {
  mode: Mode = 'orbit';
  private yaw = 0;
  private pitch = 0;
  private roll = 0;
  private fov = 56;
  private dist = 9.6;
  private lookX = 0;
  private lookY = 0;
  private readonly pos = new V();
  private readonly look = new V();
  private readonly from = new V();
  private readonly fromQ = new THREE.Quaternion();
  private blend = 1;
  private blendT = 1;
  private t = 0;
  sway = true;
  orbit = { angle: 0, speed: 0.05, radius: 8, height: 1.8, lookUp: 1.2, fov: 42, shift: 0 };
  readonly free = { yaw: 0, pitch: 0.1, dist: 9, fov: 45, up: 0 };

  /** Begin easing from wherever the camera is now. */
  ease(cam: THREE.PerspectiveCamera, seconds: number): void {
    this.from.copy(cam.position);
    this.fromQ.copy(cam.quaternion);
    this.blend = 0;
    this.blendT = seconds;
  }

  snap(s: BirdState): void {
    this.yaw = s.yaw;
    this.pitch = s.pitch * 0.6;
    this.roll = 0;
    this.blend = 1;
    this.lookX = this.lookY = 0;
  }

  update(cam: THREE.PerspectiveCamera, s: BirdState, dt: number, terrain: TerrainProvider, lookIn: { x: number; y: number }, standing: number): void {
    this.t += dt;
    const p = s.position;
    let fov = this.fov;
    if (this.mode === 'chase') {
      const k = 1 - Math.exp(-config.camFollow * 0.62 * dt);
      const kp = 1 - Math.exp(-config.camFollow * 0.5 * dt);
      this.yaw += wrap(s.yaw - this.yaw) * k;
      this.pitch += (Math.max(-0.85, Math.min(0.6, s.pitch * 0.72 + s.climbRate * 0.006)) - this.pitch) * kp;
      this.roll += (-s.roll * config.camRoll - this.roll) * kp;
      // looking around springs gently home
      this.lookX += lookIn.x * 1.9 * dt;
      this.lookY += lookIn.y * 1.2 * dt;
      this.lookX = Math.max(-2.8, Math.min(2.8, this.lookX));
      this.lookY = Math.max(-0.7, Math.min(0.9, this.lookY));
      if (Math.abs(lookIn.x) + Math.abs(lookIn.y) < 0.02) {
        this.lookX *= Math.exp(-dt * 0.9);
        this.lookY *= Math.exp(-dt * 0.9);
      }
      const speed = Math.max(0, (s.airspeed - 18) / 30);
      const want = config.camDistance + speed * 2.4 + s.beat * 0.5;
      this.dist += (want - this.dist) * (1 - Math.exp(-dt * 1.4));
      const yaw = this.yaw - this.lookX;
      const pit = this.pitch - this.lookY * 0.7 - 0.07;
      const cp = Math.cos(pit);
      const fx = -Math.sin(yaw) * cp;
      const fy = Math.sin(pit);
      const fz = -Math.cos(yaw) * cp;
      const sw = this.sway ? 1 : 0;
      const bx = Math.sin(this.t * 0.31) * 0.16 * sw;
      const by = Math.sin(this.t * 0.43 + 1) * 0.12 * sw;
      const standUp = standing * 0.7;
      this.pos.set(p.x - fx * this.dist + Math.cos(yaw) * bx, p.y - fy * this.dist + config.camHeight + by + standUp * 0.2, p.z - fz * this.dist - Math.sin(yaw) * bx);
      const la = config.camLookAhead;
      this.look.set(p.x + fx * la, p.y + fy * la + 1.0 + standUp, p.z + fz * la);
      fov = config.camFov + config.camFovSpeed * Math.min(1, speed);
      this.keepAbove(this.pos, terrain, 1.5);
    } else if (this.mode === 'orbit') {
      const o = this.orbit;
      o.angle += o.speed * dt;
      const x = p.x + Math.sin(o.angle) * o.radius;
      const z = p.z + Math.cos(o.angle) * o.radius;
      const h = o.height + (this.sway ? Math.sin(this.t * 0.27) * 0.12 : 0);
      this.pos.set(x, p.y + h, z);
      // shift moves the subject off-centre for type
      const sx = Math.cos(o.angle) * o.shift;
      const sz = -Math.sin(o.angle) * o.shift;
      this.look.set(p.x + sx, p.y + o.lookUp, p.z + sz);
      this.roll *= Math.exp(-dt * 2);
      this.yaw = s.yaw;
      this.pitch = 0;
      fov = o.fov;
      this.keepAbove(this.pos, terrain, 0.55);
    } else {
      const f = this.free;
      const cp = Math.cos(f.pitch);
      this.pos.set(p.x + Math.sin(f.yaw) * cp * f.dist, p.y + Math.sin(f.pitch) * f.dist + f.up, p.z + Math.cos(f.yaw) * cp * f.dist);
      this.look.set(p.x, p.y + 0.3 + f.up * 0.3, p.z);
      fov = f.fov;
      this.keepAbove(this.pos, terrain, 0.4);
    }
    // tall screens need a taller lens to keep the sky wide
    if (cam.aspect < 1.15 && this.mode !== 'fixed') {
      const minH = this.mode === 'chase' ? 0.46 : 0.34;
      fov = Math.max(fov, Math.min(82, (2 * Math.atan(minH / cam.aspect) * 180) / Math.PI));
    }
    this.fov += (fov - this.fov) * (this.mode === 'fixed' ? 1 : 1 - Math.exp(-dt * 1.6));
    cam.position.copy(this.pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.look);
    if (this.mode === 'chase') cam.rotateZ(this.roll);
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / this.blendT);
      const b = this.blend * this.blend * this.blend * (this.blend * (6 * this.blend - 15) + 10);
      cam.position.lerpVectors(this.from, this.pos, b);
      this.keepAbove(cam.position, terrain, 0.5);
      const q = cam.quaternion.clone();
      cam.quaternion.copy(this.fromQ).slerp(q, b);
    }
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }

  private keepAbove(v: THREE.Vector3, terrain: TerrainProvider, m: number): void {
    const g = Math.max(0, terrain.heightAt(v.x, v.z)) + m;
    if (v.y < g) v.y = g;
  }
}

import * as THREE from 'three';
import type { AircraftState } from '../sim/state';
import { forwardOf } from '../sim/state';
import { config } from '../sim/config';

/**
 * Smoothed follow camera. Sits behind and above the craft, looks a little
 * ahead of it, and lags with an exponential smoothing so speed reads as
 * separation and turns sweep instead of snapping.
 */
export class ChaseCamera {
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private initialized = false;

  update(camera: THREE.PerspectiveCamera, state: AircraftState, dt: number): void {
    const fwd = forwardOf(state);
    const p = state.position;

    const targetPos = new THREE.Vector3(
      p.x - fwd.x * config.camDistance,
      p.y - fwd.y * config.camDistance + config.camHeight,
      p.z - fwd.z * config.camDistance,
    );
    // Don't let the camera dip into the ground plane.
    targetPos.y = Math.max(targetPos.y, 1.5);

    const targetLook = new THREE.Vector3(
      p.x + fwd.x * config.camLookAhead,
      p.y + fwd.y * config.camLookAhead,
      p.z + fwd.z * config.camLookAhead,
    );

    if (!this.initialized) {
      this.pos.copy(targetPos);
      this.look.copy(targetLook);
      this.initialized = true;
    }

    // camLerp is expressed per-60Hz-frame; convert to framerate-independent.
    const k = 1 - Math.pow(1 - config.camLerp, dt * 60);
    this.pos.lerp(targetPos, k);
    this.look.lerp(targetLook, k);

    camera.position.copy(this.pos);
    camera.lookAt(this.look);
  }

  /** Snap to the target on reset so the relaunch doesn't whip the camera. */
  snap(): void {
    this.initialized = false;
  }
}

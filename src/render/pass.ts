import * as THREE from 'three';
import { FSQ_VERT } from './glsl/common';
import { G, Uniforms } from './globals';

/** Fullscreen-triangle pass helper. */
export class Pass {
  static readonly cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private static geo: THREE.BufferGeometry | null = null;
  readonly mat: THREE.ShaderMaterial;
  readonly scene = new THREE.Scene();

  constructor(frag: string, uniforms: Uniforms, opts: Partial<THREE.ShaderMaterialParameters> = {}) {
    if (!Pass.geo) {
      Pass.geo = new THREE.BufferGeometry();
      Pass.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    }
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FSQ_VERT,
      fragmentShader: frag,
      uniforms: { ...G, ...uniforms },
      depthTest: false,
      depthWrite: false,
      ...opts,
    });
    const m = new THREE.Mesh(Pass.geo, this.mat);
    m.frustumCulled = false;
    this.scene.add(m);
  }

  render(gl: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    gl.setRenderTarget(target);
    gl.render(this.scene, Pass.cam);
  }
}


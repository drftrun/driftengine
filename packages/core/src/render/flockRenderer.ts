import type { FrameView } from './frameView.ts';
import type { Vec3 } from '../math/color.ts';
import { compileProgram, uniformLocations } from './shader.ts';
import { FLOCK_FRAG, FLOCK_VERT } from './shaders/flock.ts';
import { buildFlockGeometry } from './flockGeometry.ts';

/**
 * Ambient sky life. Entirely GPU-side: the geometry is uploaded once and every
 * bird's path is computed in the vertex shader from its index and the clock.
 *
 * Deliberately not a simulation. Flocking behaviour would be CPU work every
 * frame, forever, for something nobody looks at directly — and the thing it
 * actually buys, a world that carries on without the player, comes from motion
 * and silhouette rather than from correct boids.
 */
export interface FlockParams {
  center: Vec3;
  radius: number;
  height: number;
  count: number;
  /** Metres per second along the orbit. */
  speed: number;
  /**
   * Half the wingspan, in metres: a bird measures `2 * scale` from tip to tip.
   *
   * It said "wingspan, roughly", and it is out by a factor of two, which is not roughly.
   * The corner table below puts the tips at plus and minus one before this multiplies
   * them, so a caller asking for a 1.5 m bird is handed a 3 m one.
   */
  scale: number;
}

export class FlockRenderer {
  private readonly program: WebGLProgram;
  private readonly uniforms: Record<string, WebGLUniformLocation>;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffers: WebGLBuffer[] = [];
  private readonly vertexCount: number;

  constructor(gl: WebGL2RenderingContext, count: number) {
    this.program = compileProgram(gl, FLOCK_VERT, FLOCK_FRAG, 'flock');
    this.uniforms = uniformLocations(gl, this.program, 'flockRenderer');

    /* Built in `flockGeometry.ts`, which is also where the count is validated. */
    const geometry = buildFlockGeometry(count);
    const { corners, wings, indices } = geometry;
    this.vertexCount = geometry.vertexCount;

    const vao = gl.createVertexArray();
    if (vao === null) throw new Error('FlockRenderer: createVertexArray failed');
    this.vao = vao;
    gl.bindVertexArray(vao);

    const attach = (data: Float32Array, location: number, size: number): void => {
      const buffer = gl.createBuffer();
      if (buffer === null) throw new Error('FlockRenderer: createBuffer failed');
      this.buffers.push(buffer);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    };
    attach(corners, 0, 2);
    attach(wings, 1, 1);
    attach(indices, 2, 1);
    gl.bindVertexArray(null);
  }

  draw(
    gl: WebGL2RenderingContext,
    camera: FrameView,
    timeSeconds: number,
    params: FlockParams,
    tint: Vec3,
    windX = 0,
    windZ = 0,
  ): void {
    const u = this.uniforms;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(u['uViewProj'] ?? null, false, camera.viewProjection);
    /*
     * No `uCameraPos` here, and the shader no longer declares one. It fed the banking that
     * turned a wing plane toward the viewer, and that was reverted with the rest of the flock
     * work when the shape being reported turned out to be the lighthouse beam rather than a
     * bird. What was left behind was a declaration nothing read and an upload every frame to a
     * location that had stopped existing. See AGENTS.md, 2026-08-10.
     */
    gl.uniform3fv(u['uCenter'] ?? null, params.center);
    gl.uniform1f(u['uRadius'] ?? null, params.radius);
    gl.uniform1f(u['uHeight'] ?? null, params.height);
    gl.uniform1f(u['uSpeed'] ?? null, params.speed);
    gl.uniform1f(u['uCount'] ?? null, params.count);
    gl.uniform1f(u['uScale'] ?? null, params.scale);
    gl.uniform1f(u['uTime'] ?? null, timeSeconds);
    gl.uniform3fv(u['uTint'] ?? null, tint);
    gl.uniform2f(u['uWind'] ?? null, windX, windZ);

    // Birds are flat and seen from both sides as they bank.
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
    gl.bindVertexArray(null);
    gl.enable(gl.CULL_FACE);
  }

  dispose(gl: WebGL2RenderingContext): void {
    for (const buffer of this.buffers) gl.deleteBuffer(buffer);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}

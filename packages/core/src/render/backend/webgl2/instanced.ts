import { INSTANCE_FLOATS, INSTANCE_STRIDE, packInstances } from '../../instances.ts';
import type { MeshInstances } from '../../instances.ts';
import type { Mesh } from '../../mesh.ts';

/**
 * One mesh's per-instance buffer, bound to that mesh's own vertex array.
 *
 * The twin of the WebGPU batch and deliberately the same shape, because which floats go where is
 * a decision shared through `instances.ts` and only the binding is per-backend.
 *
 * The staging array is allocated here and rewritten in place, so a frame re-uploading a moving
 * batch allocates nothing.
 */
export class InstancedBatch {
  readonly mesh: Mesh;
  readonly capacity: number;
  private readonly buffer: WebGLBuffer;
  private readonly staging: Float32Array;

  constructor(gl: WebGL2RenderingContext, mesh: Mesh, capacity: number) {
    const buffer = gl.createBuffer();
    if (buffer === null) throw new Error('InstancedBatch: createBuffer failed');
    this.mesh = mesh;
    this.capacity = capacity;
    this.buffer = buffer;
    this.staging = new Float32Array(capacity * INSTANCE_FLOATS);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, capacity * INSTANCE_STRIDE, gl.DYNAMIC_DRAW);
    /* `DYNAMIC_DRAW` because a batch of vehicles is rewritten every frame — advisory, but a
       driver told the truth can place the buffer where a rewrite is cheap. */
    mesh.attachInstances(gl, buffer, INSTANCE_STRIDE);
  }

  /** Pack and push the live prefix, in one call. */
  upload(gl: WebGL2RenderingContext, data: MeshInstances): void {
    const count = Math.min(data.count, this.capacity);
    if (count === 0) return;
    packInstances(data, this.staging);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.staging, 0, count * INSTANCE_FLOATS);
  }

  dispose(gl: WebGL2RenderingContext): void {
    gl.deleteBuffer(this.buffer);
  }
}

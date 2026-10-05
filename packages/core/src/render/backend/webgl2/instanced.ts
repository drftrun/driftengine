import { cullInstances, instancesBox } from '../../instanceCull.ts';
import {
  INSTANCE_FLOATS,
  INSTANCE_STRIDE,
  createMeshInstances,
  packInstances,
} from '../../instances.ts';
import type { MeshInstances } from '../../instances.ts';
import type { Mesh } from '../../mesh.ts';
import type { FrustumPlanes } from '../../../math/frustum.ts';

/**
 * One batch of a mesh: its per-instance buffer and a vertex array of its own.
 *
 * The twin of the WebGPU batch and deliberately the same shape, because which floats go where is
 * a decision shared through `instances.ts` and only the binding is per-backend. The vertex array is
 * the batch's rather than the mesh's (`Mesh.createInstanceArray`), which is what lets one mesh carry
 * a batch per region.
 *
 * **A culling batch holds a second buffer and array**, for the instances `cullInstances` keeps each
 * camera draw. The full set stays in the first, because a shadow pass, a mirror and a probe each
 * see a different part of the batch than the camera does, and they draw from it.
 *
 * Staging arrays are allocated here and rewritten in place, so a frame re-uploading or re-culling a
 * batch allocates nothing.
 */
export class InstancedBatch {
  readonly mesh: Mesh;
  readonly capacity: number;
  /** Whether the camera draw culls this batch. See `InstancedOptions.cull`. */
  readonly cull: boolean;
  /** The world box around every live instance, fitted at upload. See `instancesBox`. */
  readonly box = new Float32Array([1, 1, 1, -1, -1, -1]);
  private readonly buffer: WebGLBuffer;
  private readonly vao: WebGLVertexArrayObject;
  private readonly staging: Float32Array;
  /** The survivors of a lightmapped batch's cull, made the first time one is culled. */
  private keptRegioned: MeshInstances | null = null;
  private readonly kept: {
    readonly buffer: WebGLBuffer;
    readonly vao: WebGLVertexArrayObject;
    readonly instances: MeshInstances;
  } | null;

  constructor(gl: WebGL2RenderingContext, mesh: Mesh, capacity: number, cull = false) {
    this.mesh = mesh;
    this.capacity = capacity;
    this.cull = cull;
    this.staging = new Float32Array(capacity * INSTANCE_FLOATS);
    this.buffer = allocate(gl, capacity);
    this.vao = mesh.createInstanceArray(gl, this.buffer, INSTANCE_STRIDE);
    if (cull) {
      const buffer = allocate(gl, capacity);
      this.kept = {
        buffer,
        vao: mesh.createInstanceArray(gl, buffer, INSTANCE_STRIDE),
        instances: createMeshInstances(capacity),
      };
    } else {
      this.kept = null;
    }
  }

  upload(gl: WebGL2RenderingContext, data: MeshInstances): void {
    if (this.cull) instancesBox(data, this.mesh.bounds, this.box);
    const count = Math.min(data.count, this.capacity);
    if (count === 0) return;
    packInstances(data, this.staging);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.staging, 0, count * INSTANCE_FLOATS);
  }

  /** Draw the first `count` uploaded instances: every draw but a culling camera draw. */
  draw(gl: WebGL2RenderingContext, count: number): void {
    this.mesh.drawInstancesThrough(gl, this.vao, count);
  }

  /**
   * Cull `data` against `frustum`, upload what survives into the second buffer and draw it. Returns
   * how many were drawn — 0 draws nothing. Only for a batch made with `cull`.
   */
  drawCulled(gl: WebGL2RenderingContext, data: MeshInstances, frustum: FrustumPlanes): number {
    const kept = this.kept;
    if (kept === null) return 0;
    /* A lightmapped batch's survivors keep their regions, in a copy that carries them. */
    const into =
      data.lightmapRegions === undefined
        ? kept.instances
        : (this.keptRegioned ??= {
            ...createMeshInstances(this.capacity),
            lightmapRegions: new Float32Array(this.capacity * 4),
          });
    const count = cullInstances(data, this.mesh.bounds, frustum, into);
    if (count === 0) return 0;
    packInstances(into, this.staging);
    gl.bindBuffer(gl.ARRAY_BUFFER, kept.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.staging, 0, count * INSTANCE_FLOATS);
    this.mesh.drawInstancesThrough(gl, kept.vao, count);
    return count;
  }

  dispose(gl: WebGL2RenderingContext): void {
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.buffer);
    if (this.kept !== null) {
      gl.deleteVertexArray(this.kept.vao);
      gl.deleteBuffer(this.kept.buffer);
    }
  }
}

/**
 * An instance buffer sized to capacity. `DYNAMIC_DRAW` because a batch of vehicles is rewritten
 * every frame — advisory, but a driver told the truth can place the buffer where a rewrite is cheap.
 */
function allocate(gl: WebGL2RenderingContext, capacity: number): WebGLBuffer {
  const buffer = gl.createBuffer();
  if (buffer === null) throw new Error('InstancedBatch: createBuffer failed');
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, Math.max(1, capacity) * INSTANCE_STRIDE, gl.DYNAMIC_DRAW);
  return buffer;
}

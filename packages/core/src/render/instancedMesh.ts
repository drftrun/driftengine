import type { MeshData } from './mesh.ts';

/**
 * One base mesh drawn many times in a single call.
 *
 * A field of grass is tens of thousands of copies of the same few triangles.
 * Submitted individually that is tens of thousands of draw calls, which is the
 * one thing a browser renderer cannot absorb; as instances it is one call and
 * the GPU does the rest. This is what makes "dress the world" affordable at all.
 *
 * Per-instance attributes advance once per instance rather than once per vertex
 * (`vertexAttribDivisor`), so the base mesh is uploaded once and never again.
 */
export interface InstanceData {
  /** 3 floats each: world position. */
  readonly positions: Float32Array;
  /** 2 floats each: uniform scale, then yaw in radians. */
  readonly scaleAndYaw: Float32Array;
  /** 3 floats each: multiplied into the base mesh's colour. */
  readonly tints: Float32Array;
  /**
   * 3 floats each: how far this instance bends, how much the gust moves it,
   * and a phase offset.
   *
   * Per instance rather than global so a field does not sway in lockstep —
   * uniform motion is the single clearest sign that foliage is a texture with
   * an animation on it rather than many separate plants.
   */
  readonly windResponse: Float32Array;
  readonly capacity: number;
  /** How many instances are live; the rest of the buffer is ignored. */
  count: number;
}

export function createInstanceData(capacity: number): InstanceData {
  return {
    positions: new Float32Array(capacity * 3),
    scaleAndYaw: new Float32Array(capacity * 2),
    tints: new Float32Array(capacity * 3),
    windResponse: new Float32Array(capacity * 3),
    capacity,
    count: 0,
  };
}

export function writeInstance(
  data: InstanceData,
  index: number,
  x: number,
  y: number,
  z: number,
  scale: number,
  yaw: number,
  tintR: number,
  tintG: number,
  tintB: number,
  bend: number,
  flutter: number,
  phase: number,
): void {
  if (index < 0 || index >= data.capacity) {
    throw new Error(`Instance ${index} is outside capacity ${data.capacity}`);
  }
  const p = index * 3;
  data.positions[p] = x;
  data.positions[p + 1] = y;
  data.positions[p + 2] = z;

  const s = index * 2;
  data.scaleAndYaw[s] = scale;
  data.scaleAndYaw[s + 1] = yaw;

  data.tints[p] = tintR;
  data.tints[p + 1] = tintG;
  data.tints[p + 2] = tintB;

  data.windResponse[p] = bend;
  data.windResponse[p + 1] = flutter;
  data.windResponse[p + 2] = phase;
}

export class InstancedMesh {
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffers: WebGLBuffer[] = [];
  private readonly indexCount: number;
  private readonly positionBuffer: WebGLBuffer;
  private readonly scaleBuffer: WebGLBuffer;
  private readonly tintBuffer: WebGLBuffer;
  private readonly windBuffer: WebGLBuffer;

  constructor(gl: WebGL2RenderingContext, base: MeshData, capacity: number) {
    /*
     * **Refused rather than dropped.** The per-vertex channel sits at location 13, which this path
     * spends on `aInstanceModel2` — eleven base attributes plus five per-instance is exactly the
     * sixteen WebGL2 guarantees, so there is nothing left to put it in. Drawing the mesh anyway
     * would read the absent-attribute constant and produce a plausible picture: leaves that never
     * move, a cave face at full sun, a pane at full opacity, with nothing anywhere saying why.
     * That is the silent no-op `AGENTS.md` forbids, so it throws at construction instead.
     *
     * **The escape hatch is written down and untaken**: the instance tint could ride in the `w`
     * lanes of the four model columns, which an affine matrix leaves unused, freeing location 15
     * — at the cost of narrowing instance transforms to affine and making a projective one
     * silently wrong. Not paid for yet, because the obvious instanced case for sway is a field of
     * vegetation and `ScatterBatch` already draws that with wind of its own. A consumer filing
     * instanced geometry that needs a lane is what reverses it.
     */
    if (base.channel !== undefined) {
      throw new Error(
        'InstancedMesh: this mesh carries a per-vertex channel, which needs attribute location ' +
          '13, and an instanced draw already spends 11 through 15 on its transform and tint. ' +
          'Draw it as an ordinary mesh, or drop the channel — the sway, sky and alpha lanes ' +
          'cannot reach an instanced pipeline.',
      );
    }
    const vao = gl.createVertexArray();
    if (vao === null) throw new Error('InstancedMesh: createVertexArray failed');
    this.vao = vao;
    gl.bindVertexArray(vao);

    const make = (): WebGLBuffer => {
      const buffer = gl.createBuffer();
      if (buffer === null) throw new Error('InstancedMesh: createBuffer failed');
      this.buffers.push(buffer);
      return buffer;
    };

    // Base mesh: divisor 0, so these advance per vertex as usual.
    const attach = (data: Float32Array, location: number, size: number): void => {
      gl.bindBuffer(gl.ARRAY_BUFFER, make());
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    };
    attach(base.positions, 0, 3);
    attach(base.normals, 1, 3);
    attach(base.colors, 2, 3);

    const indexBuffer = make();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, base.indices, gl.STATIC_DRAW);
    this.indexCount = base.indices.length;

    // Per-instance: divisor 1, so each advances once per copy rather than once
    // per vertex. Sized to capacity now and rewritten later, because resizing a
    // buffer mid-frame is a stall.
    const instanced = (location: number, size: number): WebGLBuffer => {
      const buffer = make();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, capacity * size * 4, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(location, 1);
      return buffer;
    };
    this.positionBuffer = instanced(3, 3);
    this.scaleBuffer = instanced(4, 2);
    this.tintBuffer = instanced(5, 3);
    this.windBuffer = instanced(6, 3);

    gl.bindVertexArray(null);
  }

  /** Upload placement. Called at load; scatter does not move once placed. */
  upload(gl: WebGL2RenderingContext, data: InstanceData): void {
    const put = (buffer: WebGLBuffer, values: Float32Array, perInstance: number): void => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, values.subarray(0, data.count * perInstance));
    };
    put(this.positionBuffer, data.positions, 3);
    put(this.scaleBuffer, data.scaleAndYaw, 2);
    put(this.tintBuffer, data.tints, 3);
    put(this.windBuffer, data.windResponse, 3);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  draw(gl: WebGL2RenderingContext, count: number): void {
    if (count <= 0) return;
    gl.bindVertexArray(this.vao);
    gl.drawElementsInstanced(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0, count);
    gl.bindVertexArray(null);
  }

  dispose(gl: WebGL2RenderingContext): void {
    for (const buffer of this.buffers) gl.deleteBuffer(buffer);
    gl.deleteVertexArray(this.vao);
  }
}

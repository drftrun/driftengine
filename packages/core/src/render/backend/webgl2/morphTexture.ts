import { morphTextureRows, morphTextureWidth } from '../../skinPalette.ts';

/**
 * A mesh's morph deltas as an `RGB32F` texture, on WebGL2.
 *
 * **Owned by the mesh rather than set per draw**, which is the difference between this and the
 * joint palette beside it. A palette changes every frame and belongs to a *pose*; deltas are
 * geometry and never change, so they are uploaded once with the vertex buffers and bound by the
 * draw that uses them. Only the weights are per-draw state.
 *
 * `RGB32F` rather than `RGBA32F`: a delta is three floats and the fourth would be a quarter of the
 * texture holding nothing. Both are colour-renderable-optional in WebGL2 core and neither is
 * filtered here, so the narrower one costs nothing and saves a third.
 */
export class MorphTexture {
  private texture: WebGLTexture | null = null;
  readonly width: number;
  readonly rows: number;
  readonly targetCount: number;

  constructor(gl: WebGL2RenderingContext, deltas: Float32Array, vertices: number, targets: number) {
    this.targetCount = targets;
    this.width = morphTextureWidth(vertices, targets);
    this.rows = morphTextureRows(vertices, targets);

    const created = gl.createTexture();
    if (created === null) throw new Error('morph targets: failed to create the delta texture');
    this.texture = created;
    gl.bindTexture(gl.TEXTURE_2D, created);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGB32F, this.width, this.rows);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    /*
     * The last row is usually short, and `texSubImage2D` reads a full row's worth whatever it is
     * told — so uploading the whole rectangle from a source that stops early walks off the end.
     * Padded to the rectangle once, here, rather than uploaded row by row: this runs at mesh
     * construction and the padding is at most one row of zeroes. The splat streaming path found
     * the row-by-row version of this the hard way, on one backend only.
     */
    const padded = new Float32Array(this.width * this.rows * 3);
    padded.set(deltas.subarray(0, Math.min(deltas.length, padded.length)));
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.width, this.rows, gl.RGB, gl.FLOAT, padded);
  }

  bind(gl: WebGL2RenderingContext, unit: number): void {
    if (this.texture === null) return;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
  }

  dispose(gl: WebGL2RenderingContext): void {
    if (this.texture !== null) gl.deleteTexture(this.texture);
    this.texture = null;
  }
}

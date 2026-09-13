/** The WebGL2 half of the splat pass: two integer textures, one program, no vertex state at all. */

import {
  SPLAT_STRIDE,
  checkSplatCapacity,
  splatRowSource,
  splatRows,
  splatTexels,
} from './splatLayout.ts';
import { SPLAT_FRAG, SPLAT_VERT } from './shaders/splat.ts';
import type { SplatData } from './splatData.ts';

/** Texture units this pass borrows. High, so they cannot collide with the lit pass's sixteen. */
const DATA_UNIT = 12;
const ORDER_UNIT = 13;

export interface Webgl2Splats {
  readonly program: WebGLProgram;
  readonly vao: WebGLVertexArrayObject;
  readonly data: WebGLTexture;
  readonly order: WebGLTexture;
  readonly uniforms: Readonly<Record<string, WebGLUniformLocation | null>>;
  readonly rows: number;
  /** Two, or three for a capture with view-dependent colour. See `splatTexels`. */
  readonly texels: number;
}

function compile(
  gl: WebGL2RenderingContext,
  kind: number,
  source: string,
  label: string,
): WebGLShader {
  const shader = gl.createShader(kind);
  if (shader === null) throw new Error(`${label}: createShader failed`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  /*
   * Checked at init and never in the frame, which is the reliability rule: fail fast and loud at
   * construction with a message somebody can act on, and never throw once the loop is running.
   */
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '(no log)';
    gl.deleteShader(shader);
    throw new Error(`${label}: ${log}`);
  }
  return shader;
}

/**
 * Build the program, the two textures and the empty vertex array.
 *
 * **The vertex array holds nothing and still has to exist.** The geometry is `gl_VertexID`
 * arithmetic, so there is no buffer to describe — but a draw with the default vertex array bound
 * is invalid in a core WebGL2 context, which `demo/contributedPass.ts` already records.
 */
export function createWebgl2Splats(
  gl: WebGL2RenderingContext,
  splats: SplatData,
  label: string,
): Webgl2Splats {
  checkSplatCapacity(
    splats.count,
    gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    splats.wordsPerSplat,
  );
  const texels = splatTexels(splats.wordsPerSplat);

  const program = gl.createProgram();
  if (program === null) throw new Error(`${label}: createProgram failed`);
  const vert = compile(gl, gl.VERTEX_SHADER, SPLAT_VERT, `${label} vertex`);
  const frag = compile(gl, gl.FRAGMENT_SHADER, SPLAT_FRAG, `${label} fragment`);
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? '(no log)';
    throw new Error(`${label}: link failed — ${log}`);
  }
  /* Attached shaders are reference-counted by the program; deleting the objects frees the source
     without touching the linked binary. */
  gl.deleteShader(vert);
  gl.deleteShader(frag);

  const names = [
    'uSplatData',
    'uSplatOrder',
    'uSplatCount',
    'uSplatStride',
    'uView',
    'uProjection',
    'uViewport',
    'uModel',
    'uOutputTransform',
    'uOutputExposure',
    'uSplatTexels',
    'uSplatShDegree',
    'uSplatCameraLocal',
  ];
  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  for (const name of names) uniforms[name] = gl.getUniformLocation(program, name);

  const rows = splatRows(splats.count);

  const data = gl.createTexture();
  if (data === null) throw new Error(`${label}: createTexture failed`);
  gl.bindTexture(gl.TEXTURE_2D, data);
  /*
   * `RGBA32UI` with nearest filtering and no mips: the contents are bit patterns rather than
   * colours, so there is nothing meaningful to interpolate between two splats' packed floats. An
   * integer format cannot be filtered at all in core WebGL2, which makes this required rather
   * than merely correct.
   */
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32UI, SPLAT_STRIDE * texels, rows);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  /*
   * Padded to the full rectangle, because `texSubImage2D` of a partial last row is a second call
   * with different arithmetic and the padding is at most one row of 1024 splats — 32 KB.
   */
  const padded = new Uint32Array(SPLAT_STRIDE * texels * rows * 4);
  padded.set(splats.packed.subarray(0, Math.min(splats.packed.length, padded.length)));
  gl.texSubImage2D(
    gl.TEXTURE_2D,
    0,
    0,
    0,
    SPLAT_STRIDE * texels,
    rows,
    gl.RGBA_INTEGER,
    gl.UNSIGNED_INT,
    padded,
  );

  const order = gl.createTexture();
  if (order === null) throw new Error(`${label}: createTexture failed`);
  gl.bindTexture(gl.TEXTURE_2D, order);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32UI, SPLAT_STRIDE, rows);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);

  const vao = gl.createVertexArray();
  if (vao === null) throw new Error(`${label}: createVertexArray failed`);

  return { program, vao, data, order, uniforms, rows, texels };
}

/**
 * Upload a new draw order. Four bytes a splat and nothing else moves.
 *
 * **`texSubImage2D` into storage allocated once**, never a reallocation: this runs whenever the
 * view has turned enough to want a re-sort, and allocating a texture per sort is the per-frame
 * allocation the house rules are about.
 */
export function uploadWebgl2Order(
  gl: WebGL2RenderingContext,
  splats: Webgl2Splats,
  order: Uint32Array,
  padded: Uint32Array,
): void {
  padded.set(order.subarray(0, Math.min(order.length, padded.length)));
  gl.bindTexture(gl.TEXTURE_2D, splats.order);
  gl.texSubImage2D(
    gl.TEXTURE_2D,
    0,
    0,
    0,
    SPLAT_STRIDE,
    splats.rows,
    gl.RED_INTEGER,
    gl.UNSIGNED_INT,
    padded,
  );
}

/**
 * Upload a run of splats that has just arrived, and nothing else.
 *
 * **Whole rows at a time**, because `texSubImage2D` takes a rectangle and a partial row is a
 * second call with different arithmetic for no gain: a row is 1,024 splats, so rounding a block
 * out to row boundaries re-sends at most 32 KB and the row a block ends in is re-sent once when
 * the next block completes it. A capture streams in a handful of blocks, so that is a few
 * kilobytes over a load rather than a per-frame cost.
 */
export function uploadWebgl2SplatRange(
  gl: WebGL2RenderingContext,
  splats: Webgl2Splats,
  packed: Uint32Array,
  from: number,
  count: number,
): void {
  if (count <= 0) return;
  const firstRow = Math.floor(from / SPLAT_STRIDE);
  const lastRow = Math.floor((from + count - 1) / SPLAT_STRIDE);
  const rows = lastRow - firstRow + 1;
  gl.bindTexture(gl.TEXTURE_2D, splats.data);
  gl.texSubImage2D(
    gl.TEXTURE_2D,
    0,
    0,
    firstRow,
    SPLAT_STRIDE * splats.texels,
    rows,
    gl.RGBA_INTEGER,
    gl.UNSIGNED_INT,
    splatRowSource(packed, firstRow, rows, splats.texels * 4),
  );
  gl.bindTexture(gl.TEXTURE_2D, null);
}

/**
 * Draw, and put back every piece of state this borrowed.
 *
 * **The contract in `PassDefinition.draw`**: the renderer's own verbs assume what they left, and a
 * leaked blend function is the class of bug that shows up three scenes away. Depth *test* on and
 * depth *write* off is the composition claim — a wall in front of a capture occludes it, and a
 * Gaussian has no surface to occlude anything with, so a cloud that wrote depth would cull its
 * own tail.
 */
export function drawWebgl2Splats(
  gl: WebGL2RenderingContext,
  splats: Webgl2Splats,
  count: number,
): void {
  if (count <= 0) return;
  gl.useProgram(splats.program);
  gl.bindVertexArray(splats.vao);

  gl.activeTexture(gl.TEXTURE0 + DATA_UNIT);
  gl.bindTexture(gl.TEXTURE_2D, splats.data);
  gl.activeTexture(gl.TEXTURE0 + ORDER_UNIT);
  gl.bindTexture(gl.TEXTURE_2D, splats.order);
  gl.uniform1i(splats.uniforms['uSplatData'] ?? null, DATA_UNIT);
  gl.uniform1i(splats.uniforms['uSplatOrder'] ?? null, ORDER_UNIT);

  const blendWas = gl.getParameter(gl.BLEND) as boolean;
  const depthMaskWas = gl.getParameter(gl.DEPTH_WRITEMASK) as boolean;
  gl.enable(gl.BLEND);
  /* Premultiplied `over`, per the plan's decision 1: the fragment stage folds alpha in, so this
     composes correctly onto a target that already holds opaque geometry. */
  gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.depthMask(false);

  gl.drawArrays(gl.TRIANGLES, 0, count * 6);

  gl.depthMask(depthMaskWas);
  if (!blendWas) gl.disable(gl.BLEND);
  gl.bindVertexArray(null);
  gl.activeTexture(gl.TEXTURE0);
}

export function disposeWebgl2Splats(gl: WebGL2RenderingContext, splats: Webgl2Splats): void {
  gl.deleteProgram(splats.program);
  gl.deleteVertexArray(splats.vao);
  gl.deleteTexture(splats.data);
  gl.deleteTexture(splats.order);
}

/** The WebGL2 half of the sprite pass: one program, one instance buffer, one texture slot table. */

import { SPRITE_FRAG, SPRITE_VERT } from './shaders/sprite.ts';
import { SPRITE_FLOATS } from './spriteBatch.ts';
import type { SpriteBatch } from './spriteBatch.ts';
import type { SpriteTextureOptions } from './spriteTexture.ts';

/**
 * The unit this pass borrows for the length of one draw.
 *
 * Fourteen is above every unit `lightBudget.ts` assigns — `COOKIE_ATLAS_TEXTURE_UNIT` is the
 * highest at thirteen — and below the sixteen WebGL2 guarantees. The pass releases it before it
 * returns, because a texture left bound to a unit a later pass attaches is a feedback loop rather
 * than a wrong colour.
 */
const SPRITE_UNIT = 14;

/** Bytes per instance. Fourteen floats; see `SPRITE_FLOATS`. */
const STRIDE = SPRITE_FLOATS * 4;

export interface Webgl2Sprites {
  readonly program: WebGLProgram;
  readonly vao: WebGLVertexArrayObject;
  readonly instances: WebGLBuffer;
  readonly uniforms: Readonly<Record<string, WebGLUniformLocation | null>>;
  /** One per slot, `null` until the caller sets it. A run naming an empty slot draws nothing. */
  readonly textures: (WebGLTexture | null)[];
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
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    const log = gl.getShaderInfoLog(shader) ?? '';
    gl.deleteShader(shader);
    throw new Error(`${label}: ${log}`);
  }
  return shader;
}

const UNIFORM_NAMES = [
  'uToNdc0',
  'uToNdc1',
  'uClipCorrection',
  'uSpriteTexture',
  'uOutputTransform',
  'uOutputExposure',
] as const;

export function createWebgl2Sprites(
  gl: WebGL2RenderingContext,
  capacity: number,
  slots: number,
  label: string,
): Webgl2Sprites {
  const program = gl.createProgram();
  if (program === null) throw new Error(`${label}: createProgram failed`);
  const vert = compile(gl, gl.VERTEX_SHADER, SPRITE_VERT, `${label} vertex`);
  const frag = compile(gl, gl.FRAGMENT_SHADER, SPRITE_FRAG, `${label} fragment`);
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    const log = gl.getProgramInfoLog(program) ?? '';
    gl.deleteProgram(program);
    throw new Error(`${label}: ${log}`);
  }

  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  for (const name of UNIFORM_NAMES) uniforms[name] = gl.getUniformLocation(program, name);

  const vao = gl.createVertexArray();
  const instances = gl.createBuffer();
  if (vao === null || instances === null) throw new Error(`${label}: buffer allocation failed`);
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, instances);
  gl.bufferData(gl.ARRAY_BUFFER, capacity * STRIDE, gl.DYNAMIC_DRAW);
  /*
   * Four attributes, every one of them per instance: the quad's own corners come from
   * `gl_VertexID` and cost no buffer at all. Offsets are re-pointed per run, which is how a run
   * starts partway into the buffer without `baseInstance` — WebGL2 has no such call.
   */
  bindAttributes(gl, 0);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  return { program, vao, instances, uniforms, textures: new Array<null>(slots).fill(null) };
}

/** Point the four instance attributes at instance `first`. The buffer must be bound. */
function bindAttributes(gl: WebGL2RenderingContext, first: number): void {
  const base = first * STRIDE;
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, STRIDE, base);
  gl.vertexAttribDivisor(0, 1);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE, base + 16);
  gl.vertexAttribDivisor(1, 1);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, STRIDE, base + 32);
  gl.vertexAttribDivisor(2, 1);
  gl.enableVertexAttribArray(3);
  gl.vertexAttribPointer(3, 2, gl.FLOAT, false, STRIDE, base + 48);
  gl.vertexAttribDivisor(3, 1);
}

/** Replace a texture slot. The previous texture in that slot is deleted. */
export function setWebgl2SpriteTexture(
  gl: WebGL2RenderingContext,
  sprites: Webgl2Sprites,
  slot: number,
  source: TexImageSource,
  options: SpriteTextureOptions,
): void {
  const previous = sprites.textures[slot];
  if (previous !== null && previous !== undefined) gl.deleteTexture(previous);
  const texture = gl.createTexture();
  if (texture === null) throw new Error('ui2d: createTexture failed');
  gl.activeTexture(gl.TEXTURE0 + SPRITE_UNIT);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  const internal = options.colorSpace === 'linear' ? gl.RGBA : gl.SRGB8_ALPHA8;
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, gl.RGBA, gl.UNSIGNED_BYTE, source);
  const filter = options.filter === 'linear' ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  /*
   * Clamped on both axes, and it is a correctness rule rather than a default. A sheet frame's
   * edge texel is adjacent to the *next* frame's, so a repeating wrap bleeds one sprite into
   * another at exactly the seam a caller cannot see in the atlas.
   */
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.activeTexture(gl.TEXTURE0);
  sprites.textures[slot] = texture;
}

/**
 * Fill a slot with one opaque white texel, from an array rather than an image.
 *
 * **White is the identity of the multiply this shader does**, so a quad on this slot draws exactly
 * its tint — which is what a solid background is. Built from four bytes rather than from a canvas
 * because the pass has no DOM to reach for and should not need one: `texImage2D`'s pixel overload
 * takes the texel directly, and `queue.writeTexture` is its WebGPU twin.
 */
export function setWebgl2WhiteTexture(
  gl: WebGL2RenderingContext,
  sprites: Webgl2Sprites,
  slot: number,
): void {
  const texture = gl.createTexture();
  if (texture === null) throw new Error('ui2d: createTexture failed');
  gl.activeTexture(gl.TEXTURE0 + SPRITE_UNIT);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([255, 255, 255, 255]),
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.activeTexture(gl.TEXTURE0);
  sprites.textures[slot] = texture;
}

export function uploadWebgl2Instances(
  gl: WebGL2RenderingContext,
  sprites: Webgl2Sprites,
  batch: SpriteBatch,
): void {
  if (batch.count === 0) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, sprites.instances);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, batch.instances, 0, batch.count * SPRITE_FLOATS);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
}

export function drawWebgl2Sprites(
  gl: WebGL2RenderingContext,
  sprites: Webgl2Sprites,
  batch: SpriteBatch,
  toNdc: Float32Array,
  clipCorrection: Float32Array,
  outputTransform: number,
  outputExposure: number,
): void {
  if (batch.count === 0) return;
  gl.useProgram(sprites.program);
  gl.bindVertexArray(sprites.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, sprites.instances);

  const u = sprites.uniforms;
  gl.uniform4f(
    u['uToNdc0'] ?? null,
    toNdc[0] as number,
    toNdc[1] as number,
    toNdc[2] as number,
    toNdc[3] as number,
  );
  gl.uniform4f(u['uToNdc1'] ?? null, toNdc[4] as number, toNdc[5] as number, 0, 0);
  gl.uniformMatrix4fv(u['uClipCorrection'] ?? null, false, clipCorrection);
  gl.uniform1i(u['uOutputTransform'] ?? null, outputTransform);
  gl.uniform1f(u['uOutputExposure'] ?? null, outputExposure);
  gl.uniform1i(u['uSpriteTexture'] ?? null, SPRITE_UNIT);

  const blendWas = gl.getParameter(gl.BLEND) as boolean;
  const depthTestWas = gl.getParameter(gl.DEPTH_TEST) as boolean;
  const depthMaskWas = gl.getParameter(gl.DEPTH_WRITEMASK) as boolean;
  const cullWas = gl.getParameter(gl.CULL_FACE) as boolean;
  /*
   * **Culling off, and the WebGPU pipeline says `cullMode: 'none'` for the same reason**: a sprite
   * is mirrored by giving it a negative width, which reverses its winding, so a cull mode drops
   * every flipped sprite — which is what a character facing left is.
   *
   * This line is here because the frame that was missing it drew *nothing at all* on WebGL2 while
   * WebGPU was pixel-perfect, and nothing reported an error. A contributed pass inherits whatever
   * cull state the last scene draw left on, and the screen-space quad's winding is not the scene's;
   * WebGPU has no such inheritance, because a pipeline states its own. Every backend difference
   * this seam has is of that shape: one API carries state between draws and the other does not.
   */
  gl.disable(gl.CULL_FACE);
  gl.enable(gl.BLEND);
  /* Premultiplied `over`: the fragment stage folds alpha in, so this composes onto opaque pixels. */
  gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.disable(gl.DEPTH_TEST);
  gl.depthMask(false);
  gl.activeTexture(gl.TEXTURE0 + SPRITE_UNIT);

  for (let run = 0; run < batch.runCount; run += 1) {
    const at = run * 3;
    const texture = sprites.textures[batch.runs[at] as number];
    if (texture === null || texture === undefined) continue;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    bindAttributes(gl, batch.runs[at + 1] as number);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, batch.runs[at + 2] as number);
  }

  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.activeTexture(gl.TEXTURE0);
  gl.depthMask(depthMaskWas);
  if (cullWas) gl.enable(gl.CULL_FACE);
  if (depthTestWas) gl.enable(gl.DEPTH_TEST);
  if (!blendWas) gl.disable(gl.BLEND);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.bindVertexArray(null);
}

export function disposeWebgl2Sprites(gl: WebGL2RenderingContext, sprites: Webgl2Sprites): void {
  gl.deleteProgram(sprites.program);
  gl.deleteVertexArray(sprites.vao);
  gl.deleteBuffer(sprites.instances);
  for (const texture of sprites.textures) if (texture !== null) gl.deleteTexture(texture);
}

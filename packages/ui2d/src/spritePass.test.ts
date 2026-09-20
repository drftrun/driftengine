import { describe, expect, it } from 'vitest';

import { createAffine2D, screenToNdc } from './camera2d.ts';
import { drawSprite } from './spriteBatch.ts';
import { createSpritePass } from './spritePass.ts';
import type { SpriteImage } from './spriteTexture.ts';

/**
 * A WebGL2 context that records what it was told, and answers what it was asked.
 *
 * Enough of the surface for this pass and nothing more. What it is for is the half of the pass a
 * pixel check cannot see: whether the state it changed is the state it put back, and whether one
 * run really becomes one draw. A frame that looks right and leaves depth testing off has broken
 * every draw after it, and no screenshot of the 2D layer shows that.
 */
interface Call {
  readonly name: string;
  readonly args: readonly unknown[];
}

function recordingGl(): { gl: WebGL2RenderingContext; calls: Call[] } {
  const calls: Call[] = [];
  const state: Record<number, unknown> = {};
  const record =
    (name: string) =>
    (...args: unknown[]): unknown => {
      calls.push({ name, args });
      return undefined;
    };
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    DYNAMIC_DRAW: 6,
    FLOAT: 7,
    TRIANGLES: 8,
    TEXTURE_2D: 9,
    TEXTURE0: 1000,
    RGBA: 10,
    SRGB8_ALPHA8: 11,
    UNSIGNED_BYTE: 12,
    TEXTURE_MIN_FILTER: 13,
    TEXTURE_MAG_FILTER: 14,
    TEXTURE_WRAP_S: 15,
    TEXTURE_WRAP_T: 16,
    CLAMP_TO_EDGE: 17,
    NEAREST: 18,
    LINEAR: 19,
    /* The two minification filters that read a chain. Distinct values, so a test can tell which
       one was set rather than only that something was. */
    NEAREST_MIPMAP_LINEAR: 26,
    LINEAR_MIPMAP_LINEAR: 27,
    BLEND: 20,
    DEPTH_TEST: 21,
    DEPTH_WRITEMASK: 22,
    CULL_FACE: 25,
    ONE: 23,
    ONE_MINUS_SRC_ALPHA: 24,
    createShader: () => ({}),
    shaderSource: record('shaderSource'),
    compileShader: record('compileShader'),
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    createProgram: () => ({}),
    attachShader: record('attachShader'),
    linkProgram: record('linkProgram'),
    deleteShader: record('deleteShader'),
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    getUniformLocation: (_p: unknown, name: string) => ({ name }),
    createVertexArray: () => ({}),
    createBuffer: () => ({}),
    createTexture: () => ({ id: calls.length }),
    generateMipmap: record('generateMipmap'),
    bindVertexArray: record('bindVertexArray'),
    bindBuffer: record('bindBuffer'),
    bufferData: record('bufferData'),
    bufferSubData: record('bufferSubData'),
    enableVertexAttribArray: record('enableVertexAttribArray'),
    vertexAttribPointer: record('vertexAttribPointer'),
    vertexAttribDivisor: record('vertexAttribDivisor'),
    useProgram: record('useProgram'),
    uniform4f: record('uniform4f'),
    uniform1i: record('uniform1i'),
    uniform1f: record('uniform1f'),
    uniformMatrix4fv: record('uniformMatrix4fv'),
    getParameter: (which: number) => state[which],
    enable: (which: number) => {
      calls.push({ name: 'enable', args: [which] });
      state[which] = true;
    },
    disable: (which: number) => {
      calls.push({ name: 'disable', args: [which] });
      state[which] = false;
    },
    blendFuncSeparate: record('blendFuncSeparate'),
    depthMask: (on: boolean) => {
      calls.push({ name: 'depthMask', args: [on] });
      state[22] = on;
    },
    activeTexture: record('activeTexture'),
    bindTexture: record('bindTexture'),
    texImage2D: record('texImage2D'),
    texParameteri: record('texParameteri'),
    drawArraysInstanced: record('drawArraysInstanced'),
    deleteProgram: record('deleteProgram'),
    deleteVertexArray: record('deleteVertexArray'),
    deleteBuffer: record('deleteBuffer'),
    deleteTexture: record('deleteTexture'),
  } as unknown as WebGL2RenderingContext;
  return { gl, calls };
}

const IMAGE = { width: 4, height: 4 } as unknown as SpriteImage;

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function registered(): {
  pass: ReturnType<typeof createSpritePass>;
  gl: WebGL2RenderingContext;
  calls: Call[];
} {
  const pass = createSpritePass({ capacity: 16, slots: 4, label: 'test' });
  const { gl, calls } = recordingGl();
  pass.init?.({ backend: 'webgl2', gl, clipCorrection: IDENTITY, depthCorrection: IDENTITY });
  return { pass, gl, calls };
}

function named(calls: readonly Call[], name: string): Call[] {
  return calls.filter((call) => call.name === name);
}

describe('the sprite pass on WebGL2', () => {
  it("draws once per run, with that run's length", () => {
    const { pass, gl, calls } = registered();
    pass.setTexture(0, IMAGE);
    pass.setTexture(1, IMAGE);
    drawSprite(pass.batch, 0, { x: 0, y: 0, w: 1, h: 1 }, null, null);
    drawSprite(pass.batch, 0, { x: 1, y: 0, w: 1, h: 1 }, null, null);
    drawSprite(pass.batch, 1, { x: 2, y: 0, w: 1, h: 1 }, null, null);
    calls.length = 0;
    pass.draw({ backend: 'webgl2', gl, outputTransform: 0, outputExposure: 1 });
    const draws = named(calls, 'drawArraysInstanced');
    expect(draws.map((call) => call.args[3])).toEqual([2, 1]);
  });

  it('skips a run whose slot has no texture, and still draws the others', () => {
    const { pass, gl, calls } = registered();
    pass.setTexture(1, IMAGE);
    drawSprite(pass.batch, 0, { x: 0, y: 0, w: 1, h: 1 }, null, null);
    drawSprite(pass.batch, 1, { x: 1, y: 0, w: 1, h: 1 }, null, null);
    calls.length = 0;
    pass.draw({ backend: 'webgl2', gl, outputTransform: 0, outputExposure: 1 });
    expect(named(calls, 'drawArraysInstanced')).toHaveLength(1);
  });

  it('draws nothing at all when the batch is empty', () => {
    const { pass, gl, calls } = registered();
    pass.setTexture(0, IMAGE);
    calls.length = 0;
    pass.draw({ backend: 'webgl2', gl, outputTransform: 0, outputExposure: 1 });
    expect(calls).toEqual([]);
  });

  /*
   * The state contract from `PassDefinition.draw`, asserted rather than trusted. Every one of these
   * is invisible in the pass's own output and breaks the draw *after* it.
   */
  it('puts back the depth test, the depth mask and the blend it found', () => {
    const { pass, gl, calls } = registered();
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    pass.setTexture(0, IMAGE);
    drawSprite(pass.batch, 0, { x: 0, y: 0, w: 1, h: 1 }, null, null);
    calls.length = 0;
    pass.draw({ backend: 'webgl2', gl, outputTransform: 0, outputExposure: 1 });
    expect(gl.getParameter(gl.DEPTH_TEST)).toBe(true);
    expect(gl.getParameter(gl.DEPTH_WRITEMASK)).toBe(true);
    expect(gl.getParameter(gl.BLEND)).toBe(false);
    // And it did turn them off while it drew, or the assertion above proves nothing.
    expect(named(calls, 'disable').map((call) => call.args[0])).toContain(gl.DEPTH_TEST);
  });

  /*
   * **This one is here because its absence drew nothing at all.** A contributed pass inherits the
   * cull state the last scene draw left on, and a screen-space quad's winding is not the scene's —
   * so on WebGL2 every sprite was culled while WebGPU, whose pipeline states its own cull mode, was
   * pixel-perfect. No error anywhere, on either side.
   */
  it('draws with culling off, and puts back the culling it found', () => {
    const { pass, gl, calls } = registered();
    gl.enable(gl.CULL_FACE);
    pass.setTexture(0, IMAGE);
    drawSprite(pass.batch, 0, { x: 0, y: 0, w: 1, h: 1 }, null, null);
    calls.length = 0;
    pass.draw({ backend: 'webgl2', gl, outputTransform: 0, outputExposure: 1 });
    const order = calls.filter(
      (call) =>
        (call.name === 'disable' ||
          call.name === 'enable' ||
          call.name === 'drawArraysInstanced') &&
        (call.args[0] === gl.CULL_FACE || call.name === 'drawArraysInstanced'),
    );
    expect(order.map((call) => call.name)).toEqual(['disable', 'drawArraysInstanced', 'enable']);
    expect(gl.getParameter(gl.CULL_FACE)).toBe(true);
  });

  it('leaves culling off when it found it off', () => {
    const { pass, gl } = registered();
    gl.disable(gl.CULL_FACE);
    pass.setTexture(0, IMAGE);
    drawSprite(pass.batch, 0, { x: 0, y: 0, w: 1, h: 1 }, null, null);
    pass.draw({ backend: 'webgl2', gl, outputTransform: 0, outputExposure: 1 });
    expect(gl.getParameter(gl.CULL_FACE)).toBe(false);
  });

  it('leaves blend enabled when it found it enabled', () => {
    const { pass, gl } = registered();
    gl.enable(gl.BLEND);
    pass.setTexture(0, IMAGE);
    drawSprite(pass.batch, 0, { x: 0, y: 0, w: 1, h: 1 }, null, null);
    pass.draw({ backend: 'webgl2', gl, outputTransform: 0, outputExposure: 1 });
    expect(gl.getParameter(gl.BLEND)).toBe(true);
  });

  it('releases the texture unit it borrowed', () => {
    const { pass, gl, calls } = registered();
    pass.setTexture(0, IMAGE);
    drawSprite(pass.batch, 0, { x: 0, y: 0, w: 1, h: 1 }, null, null);
    calls.length = 0;
    pass.draw({ backend: 'webgl2', gl, outputTransform: 0, outputExposure: 1 });
    const binds = named(calls, 'bindTexture');
    expect(binds[binds.length - 1]?.args[1]).toBeNull();
    const units = named(calls, 'activeTexture');
    expect(units[units.length - 1]?.args[0]).toBe(gl.TEXTURE0);
  });

  it("unbinds its vertex array, which the renderer's own verbs assume", () => {
    const { pass, gl, calls } = registered();
    pass.setTexture(0, IMAGE);
    drawSprite(pass.batch, 0, { x: 0, y: 0, w: 1, h: 1 }, null, null);
    calls.length = 0;
    pass.draw({ backend: 'webgl2', gl, outputTransform: 0, outputExposure: 1 });
    const arrays = named(calls, 'bindVertexArray');
    expect(arrays[arrays.length - 1]?.args[0]).toBeNull();
  });

  it('points its attributes at the run rather than at the start of the buffer', () => {
    const { pass, gl, calls } = registered();
    pass.setTexture(0, IMAGE);
    pass.setTexture(1, IMAGE);
    drawSprite(pass.batch, 0, { x: 0, y: 0, w: 1, h: 1 }, null, null);
    drawSprite(pass.batch, 1, { x: 1, y: 0, w: 1, h: 1 }, null, null);
    calls.length = 0;
    pass.draw({ backend: 'webgl2', gl, outputTransform: 0, outputExposure: 1 });
    // The second run starts at instance 1, so its first attribute is one stride in.
    const zeroth = named(calls, 'vertexAttribPointer').filter((call) => call.args[0] === 0);
    expect(zeroth.map((call) => call.args[5])).toEqual([0, 14 * 4]);
  });

  it("hands the frame's own grade to the shader", () => {
    const { pass, gl, calls } = registered();
    pass.setTexture(0, IMAGE);
    drawSprite(pass.batch, 0, { x: 0, y: 0, w: 1, h: 1 }, null, null);
    calls.length = 0;
    pass.draw({ backend: 'webgl2', gl, outputTransform: 2, outputExposure: 1.5 });
    const ints = named(calls, 'uniform1i').map((call) => [
      (call.args[0] as { name: string }).name,
      call.args[1],
    ]);
    expect(ints).toContainEqual(['uOutputTransform', 2]);
    const floats = named(calls, 'uniform1f').map((call) => [
      (call.args[0] as { name: string }).name,
      call.args[1],
    ]);
    expect(floats).toContainEqual(['uOutputExposure', 1.5]);
  });

  it('uploads the affine it was given, as two vec4s', () => {
    const { pass, gl, calls } = registered();
    pass.setTransform(screenToNdc(800, 200, createAffine2D()));
    pass.setTexture(0, IMAGE);
    drawSprite(pass.batch, 0, { x: 0, y: 0, w: 1, h: 1 }, null, null);
    calls.length = 0;
    pass.draw({ backend: 'webgl2', gl, outputTransform: 0, outputExposure: 1 });
    const vectors = new Map(
      named(calls, 'uniform4f').map((call) => [
        (call.args[0] as { name: string }).name,
        call.args.slice(1),
      ]),
    );
    const first = vectors.get('uToNdc0') as number[];
    // Through a Float32Array on the way, so compared as floats rather than for identity.
    expect(first[0]).toBeCloseTo(2 / 800, 9);
    expect(first[1]).toBe(0);
    expect(first[2]).toBe(0);
    expect(first[3] as number).toBeCloseTo(-2 / 200, 9);
    expect(vectors.get('uToNdc1')).toEqual([-1, 1, 0, 0]);
  });
});

describe('texture slots', () => {
  it('holds a texture set before the pass has a device, and applies it at init', () => {
    const pass = createSpritePass({ capacity: 4, slots: 2 });
    pass.setTexture(0, IMAGE);
    const { gl, calls } = recordingGl();
    pass.init?.({ backend: 'webgl2', gl, clipCorrection: IDENTITY, depthCorrection: IDENTITY });
    /* Two uploads: the pass's own white texel, and the one that was waiting. */
    const uploads = named(calls, 'texImage2D');
    expect(uploads).toHaveLength(2);
    expect(uploads.some((call) => call.args.includes(IMAGE))).toBe(true);
  });

  it('fills a white slot of its own, which the caller cannot reach', () => {
    const pass = createSpritePass({ capacity: 4, slots: 2 });
    expect(pass.white).toBe(2);
    expect(() => pass.setTexture(pass.white, IMAGE)).toThrow(/slot 2/);
  });

  it('draws a quad on the white slot, so a solid rectangle needs no sheet', () => {
    const { pass, gl, calls } = registered();
    drawSprite(pass.batch, pass.white, { x: 0, y: 0, w: 10, h: 10 }, null, [1, 0, 0, 1]);
    calls.length = 0;
    pass.draw({ backend: 'webgl2', gl, outputTransform: 0, outputExposure: 1 });
    expect(named(calls, 'drawArraysInstanced')).toHaveLength(1);
  });

  it('refuses a slot it does not have, at the call rather than in the frame', () => {
    const { pass } = registered();
    expect(() => pass.setTexture(4, IMAGE)).toThrow(/slot 4/);
  });

  it('replaces a slot rather than leaking the texture that was in it', () => {
    const { pass, calls } = registered();
    pass.setTexture(0, IMAGE);
    calls.length = 0;
    pass.setTexture(0, IMAGE);
    expect(named(calls, 'deleteTexture')).toHaveLength(1);
  });
});

/**
 * The mip chain, which a glyph atlas needs and pixel art must not get.
 *
 * **What this is about.** A consumer bakes one page per weight at 96 px and draws body copy at 11,
 * which is a 7x minification. `linear` reads four texels of a footprint covering dozens, so a `t`
 * crossbar two texels tall lands on about a quarter of a pixel and survives or not depending on
 * where the sample falls — reported by a player as `Step-In Uppercut` reading `Slep-In Uppercul`.
 * The sampler state below is the whole of the fix on this backend, and none of it is visible in a
 * screenshot of a frame that happened to sample well.
 */
describe('a mipmapped sprite sheet on WebGL2', () => {
  /*
   * The **last** setting of each, not the first: the pass fills a slot with its white texel at
   * init and that sets both filters too, so reading the first call reads the white texture's
   * state and passes whatever the sheet under test was given.
   */
  const minFilter = (calls: readonly Call[]): unknown =>
    named(calls, 'texParameteri')
      .filter((call) => call.args[1] === 13)
      .at(-1)?.args[2];
  const magFilter = (calls: readonly Call[]): unknown =>
    named(calls, 'texParameteri')
      .filter((call) => call.args[1] === 14)
      .at(-1)?.args[2];

  it('builds no chain unless one is asked for, which is what pixel art needs', () => {
    const { pass, calls } = registered();
    pass.setTexture(0, IMAGE, { filter: 'linear' });
    expect(named(calls, 'generateMipmap')).toHaveLength(0);
    expect(minFilter(calls), 'plain LINEAR, the same as before this option existed').toBe(19);
  });

  it('builds none for a caller that passes no options at all', () => {
    /*
     * The path through `DEFAULT_SPRITE_TEXTURE_OPTIONS`, which is the only one that reads it: the
     * pass falls back to that constant when a caller hands over nothing. Without this the constant
     * could be flipped to `true` and every other test here would still pass.
     */
    const { pass, calls } = registered();
    pass.setTexture(0, IMAGE);
    expect(named(calls, 'generateMipmap')).toHaveLength(0);
  });

  it('builds one when it is', () => {
    const { pass, calls } = registered();
    pass.setTexture(0, IMAGE, { filter: 'linear', mipmap: true });
    expect(named(calls, 'generateMipmap')).toHaveLength(1);
  });

  it('samples it trilinearly, which is what stops a stroke vanishing between levels', () => {
    const { pass, calls } = registered();
    pass.setTexture(0, IMAGE, { filter: 'linear', mipmap: true });
    expect(minFilter(calls)).toBe(27); // LINEAR_MIPMAP_LINEAR
  });

  it('blends between levels even for a nearest sheet, because that is minification', () => {
    /*
     * `filter` is a decision about magnification — whether the texels of one level are blended.
     * Asking for `nearest` says the pixels are the subject; it does not say a stroke should
     * disappear on the way down. `SurfaceTexture` splits the two the same way.
     */
    const { pass, calls } = registered();
    pass.setTexture(0, IMAGE, { filter: 'nearest', mipmap: true });
    expect(minFilter(calls)).toBe(26); // NEAREST_MIPMAP_LINEAR
    expect(magFilter(calls), 'magnification is still nearest, as asked').toBe(18);
  });

  it('leaves magnification alone when the chain is on', () => {
    const { pass, calls } = registered();
    pass.setTexture(0, IMAGE, { filter: 'linear', mipmap: true });
    expect(magFilter(calls)).toBe(19); // LINEAR
  });

  it('builds the chain after the upload, which is the only order that works', () => {
    /* The chain is generated from level 0; a driver handed the call before the image builds it
       from whatever was there, which is nothing. */
    const { pass, calls } = registered();
    pass.setTexture(0, IMAGE, { filter: 'linear', mipmap: true });
    const upload = calls.findIndex((call) => call.name === 'texImage2D');
    const generate = calls.findIndex((call) => call.name === 'generateMipmap');
    expect(upload).toBeGreaterThanOrEqual(0);
    expect(generate).toBeGreaterThan(upload);
  });
});

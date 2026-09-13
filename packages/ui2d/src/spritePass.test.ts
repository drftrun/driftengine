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
  pass.init?.({ backend: 'webgl2', gl, clipCorrection: IDENTITY });
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
    pass.init?.({ backend: 'webgl2', gl, clipCorrection: IDENTITY });
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

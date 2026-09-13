import { describe, expect, it } from 'vitest';

import { SceneTarget } from './sceneTarget.ts';

/**
 * A WebGL2 context that answers everything and records what it was asked.
 *
 * A `Proxy` rather than a hand-written stub, because `SceneTarget` touches several dozen
 * entry points to build one framebuffer and what is under test here is a single call among
 * them. Anything not named below comes back as a recorded no-op returning a fresh object, so
 * the constructor runs to completion and the test asserts the one thing it is about.
 */
function recordingGl() {
  const calls: { name: string; args: unknown[] }[] = [];
  const constants: Record<string, number> = {
    MAX_SAMPLES: 0x8d57,
    COLOR_ATTACHMENT0: 0x8ce0,
    DEPTH_ATTACHMENT: 0x8d00,
    READ_FRAMEBUFFER: 0x8ca8,
    DRAW_FRAMEBUFFER: 0x8ca9,
    FRAMEBUFFER: 0x8d40,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    NO_ERROR: 0,
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_BUFFER_BIT: 0x100,
    NEAREST: 0x2600,
    RENDERBUFFER: 0x8d41,
    DEPTH_COMPONENT24: 0x81a6,
    RGBA8: 0x8058,
    TEXTURE_2D: 0x0de1,
    LINK_STATUS: 0x8b82,
    COMPILE_STATUS: 0x8b81,
    ACTIVE_UNIFORMS: 0x8b86,
    /* Named so the resolve's own state changes can be compared rather than merely passed along. */
    CULL_FACE: 0x0b44,
    DEPTH_TEST: 0x0b71,
    BLEND: 0x0be2,
  };
  const answers: Record<string, (...a: unknown[]) => unknown> = {
    /* Four samples available, so the multisampled pair is actually allocated. */
    getParameter: () => 4,
    /* No float colour and no timer: neither is what this file is about. */
    getExtension: () => null,
    checkFramebufferStatus: () => constants.FRAMEBUFFER_COMPLETE,
    getError: () => constants.NO_ERROR,
    getShaderParameter: () => true,
    /* Linked yes, but no active uniforms: zero ends the reflection loop immediately, and the
       uniforms are not what this file is about. */
    getProgramParameter: (_program: unknown, pname: unknown) =>
      pname === constants.ACTIVE_UNIFORMS ? 0 : true,
    getActiveUniform: () => ({ name: '', size: 1, type: 0 }),
    getUniformLocation: () => ({}),
  };

  const gl = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop in constants) return constants[prop];
        if (prop in answers) {
          return (...args: unknown[]) => {
            calls.push({ name: prop, args });
            return answers[prop]?.(...args);
          };
        }
        return (...args: unknown[]) => {
          calls.push({ name: prop, args });
          return {};
        };
      },
    },
  ) as unknown as WebGL2RenderingContext;

  return { gl, calls, constants };
}

/**
 * What a tile-based GPU is charged for when a multisampled buffer is resolved and then kept.
 *
 * `blitFramebuffer` is WebGL2's resolve, and it is only half the statement: the multisampled
 * renderbuffers still hold contents the driver believes are wanted, so a tiler writes them out
 * to memory at the end of the pass. `invalidateFramebuffer` is the other half, and is the exact
 * counterpart of WebGPU's `storeOp: 'discard'`.
 *
 * Nothing samples them — a multisampled renderbuffer cannot be sampled at all, which is the
 * whole reason the blit exists — so the saving is unconditional and the picture cannot move.
 */
describe('resolving the multisampled scene target', () => {
  it('invalidates the multisampled buffers once it has blitted them down', () => {
    const { gl, calls, constants } = recordingGl();
    const target = new SceneTarget(gl, 4);
    target.begin(640, 480);
    calls.length = 0;

    target.resolve(0, 0);

    const invalidations = calls.filter((c) => c.name === 'invalidateFramebuffer');
    expect(
      invalidations.length,
      'a resolved multisample buffer that is kept is bandwidth nothing reads',
    ).toBeGreaterThan(0);

    const attachments = invalidations.flatMap((c) => (c.args[1] as number[]) ?? []);
    expect(attachments).toContain(constants.COLOR_ATTACHMENT0);
    expect(attachments).toContain(constants.DEPTH_ATTACHMENT);
  });

  it('invalidates before it unbinds, or the call lands on the wrong framebuffer', () => {
    const { gl, calls, constants } = recordingGl();
    const target = new SceneTarget(gl, 4);
    target.begin(640, 480);
    calls.length = 0;

    target.resolve(0, 0);

    const names = calls.map((c) => c.name);
    const invalidateAt = names.indexOf('invalidateFramebuffer');
    const unbindAt = calls.findIndex(
      (c) =>
        c.name === 'bindFramebuffer' &&
        c.args[0] === constants.READ_FRAMEBUFFER &&
        c.args[1] === null,
    );
    expect(invalidateAt, 'nothing was invalidated').toBeGreaterThanOrEqual(0);
    expect(unbindAt, 'the read framebuffer is never unbound').toBeGreaterThanOrEqual(0);
    expect(
      invalidateAt,
      'invalidateFramebuffer acts on whatever is bound, so unbinding first discards nothing',
    ).toBeLessThan(unbindAt);
  });

  it('leaves a single-sampled target alone, having nothing to resolve or discard', () => {
    const { gl, calls } = recordingGl();
    const target = new SceneTarget(gl, 1);
    target.begin(640, 480);
    calls.length = 0;

    target.resolve(0, 0);

    expect(calls.filter((c) => c.name === 'blitFramebuffer').length).toBe(0);
    expect(
      calls.filter((c) => c.name === 'invalidateFramebuffer').length,
      'the texture the post chain samples is the one drawn into; discarding it is the frame',
    ).toBe(0);
  });
});

/**
 * The frame veil: a flat colour composited into the same triangle this pass already draws.
 *
 * `Renderer.setFrameVeil` documents the ordering ruling; what belongs here is narrower — that
 * the colour and alpha a caller hands `resolve` actually reach a uniform, as plain floats
 * rather than as a texture or a second draw, since a veil that needed either would not be the
 * zero-cost composite it was asked for.
 */
describe('the frame veil', () => {
  it('uploads zero alpha, not a skipped uniform, when a caller asks for no veil at all', () => {
    const { gl, calls } = recordingGl();
    const target = new SceneTarget(gl, 1);
    target.begin(640, 480);
    calls.length = 0;

    target.resolve(0, 0);

    const alphaCall = calls.find((c) => c.name === 'uniform1f' && c.args[1] === 0);
    expect(
      alphaCall,
      'a veil-less frame must still zero the uniform the shader reads',
    ).toBeDefined();
    /* One triangle, exactly as every other resolve: the veil is a uniform, never a second draw. */
    expect(calls.filter((c) => c.name === 'drawArrays').length).toBe(1);
  });

  it('forwards the exact colour and alpha asked for, as a plain uniform rather than a texture', () => {
    const { gl, calls } = recordingGl();
    const target = new SceneTarget(gl, 1);
    target.begin(640, 480);
    calls.length = 0;

    target.resolve(
      0,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [0.11, 0.22, 0.33],
      0.37,
    );

    const colorCall = calls.find(
      (c) => c.name === 'uniform3fv' && (c.args[1] as number[])[0] === 0.11,
    );
    const alphaCall = calls.find((c) => c.name === 'uniform1f' && c.args[1] === 0.37);
    expect(colorCall?.args[1]).toEqual([0.11, 0.22, 0.33]);
    expect(alphaCall, 'the veil alpha never reached a uniform').toBeDefined();
    /* Still one triangle: the veil composites into the pass that already runs. */
    expect(calls.filter((c) => c.name === 'drawArrays').length).toBe(1);
  });
});

describe('depth of field', () => {
  /**
   * Depth of field's three numbers reach the shader, and its strength is the whole of the off path.
   *
   * **The strength is uploaded whether or not the frame asked**, unlike the distance and the range,
   * because it is what the shader branches on: a uniform left at a previous frame's value is an
   * effect that will not turn off. The other two are only meaningful when it is non-zero.
   */
  it('forwards the focus plane and turns the effect off by its strength alone', () => {
    const { gl, calls } = recordingGl();
    const target = new SceneTarget(gl, 1);
    target.begin(640, 480);
    calls.length = 0;

    target.resolve(0, 0, undefined, undefined, undefined, undefined, {
      distance: 12.5,
      range: 2.5,
      strength: 0.03,
      depthToView: new Float32Array([0, -1, -1.6, 1.7]),
    });

    const floats = calls.filter((c) => c.name === 'uniform1f').map((c) => c.args[1]);
    expect(floats, 'the focus distance').toContain(12.5);
    expect(floats, 'the range that goes with it').toContain(2.5);
    expect(floats, 'and the strength').toContain(0.03);
    expect(
      calls.some((c) => c.name === 'uniform4fv'),
      'the four elements that turn a depth into a distance',
    ).toBe(true);

    calls.length = 0;
    target.resolve(0, 0);
    expect(
      calls.filter((c) => c.name === 'uniform1f').map((c) => c.args[1]),
      'a frame that did not ask still says so, or the effect never turns off',
    ).toContain(0);
    expect(
      calls.some((c) => c.name === 'uniform4fv'),
      'and nothing else about it is uploaded',
    ).toBe(false);
  });
});

/**
 * What the resolve leaves behind, which is the whole frame's state and not its own.
 *
 * **A pass that turns something off owns turning it back on.** The resolve draws one triangle
 * over the canvas and switches off depth, blend and culling to do it — a screen-space triangle
 * has no facing and would be culled outright. None of that was put back, and `resolve` runs at
 * `endFrame`, so from the *second* frame onwards the entire world was drawn with `CULL_FACE`
 * disabled: double-sided, on the backend the engine is most often looked at.
 *
 * It is invisible in a world whose geometry is wound correctly, which is every scene in this
 * repository, and total in one whose geometry is not. The voxel sandbox was wound backwards and
 * looked perfect here while WebGPU — which culls as documented, in pipeline state a pass cannot
 * leak — drew no ground at all. So the defect presented as a WebGPU bug and was a WebGL2 one:
 * this backend was not enforcing the rule the other one was.
 */
describe('the state the resolve borrows', () => {
  it('re-enables face culling, which the world after it is drawn with', () => {
    const { gl, calls, constants } = recordingGl();
    const target = new SceneTarget(gl, 4);
    target.begin(640, 480);
    calls.length = 0;
    target.resolve(0, 0);

    const culling = calls.filter(
      (call) =>
        (call.name === 'enable' || call.name === 'disable') && call.args[0] === constants.CULL_FACE,
    );
    expect(
      culling.length > 0,
      'the resolve is expected to touch CULL_FACE at all; if it stopped, this test is stale',
    ).toBe(true);
    expect(culling.at(-1)?.name, 'the resolve left CULL_FACE disabled for the next frame').toBe(
      'enable',
    );
  });
});

/**
 * The colour snapshot a refracting surface reads.
 *
 * **The property under test is that it is a copy**, which is what makes it answerable at all:
 * sampling a texture attached to the bound framebuffer is undefined in WebGL2, and
 * `colorAttachment` returns null under multisampling because the frame is in a renderbuffer until
 * `resolve`. A blit answers both, and from a multisampled source it resolves.
 */
describe('the colour snapshot', () => {
  it('copies rather than handing back the attachment', () => {
    const { gl, calls } = recordingGl();
    const target = new SceneTarget(gl, 1);
    target.begin(640, 480);
    calls.length = 0;

    const snapshot = target.snapshotColor();

    expect(snapshot).not.toBeNull();
    expect(calls.filter((c) => c.name === 'blitFramebuffer').length).toBe(1);
  });

  /*
   * One copy serves every refracting draw in a frame, so glass does not refract other glass and a
   * scene with fifty panes pays one blit. The escape exists for the reason `snapshotDepth`'s does:
   * a caller at the end of the frame wants the world as it stands, not as it stood when something
   * asked earlier.
   */
  it('is taken once a frame unless a caller asks afresh', () => {
    const { gl, calls } = recordingGl();
    const target = new SceneTarget(gl, 1);
    target.begin(640, 480);
    calls.length = 0;

    target.snapshotColor();
    target.snapshotColor();
    expect(calls.filter((c) => c.name === 'blitFramebuffer').length).toBe(1);

    target.snapshotColor(true);
    expect(calls.filter((c) => c.name === 'blitFramebuffer').length).toBe(2);
  });

  /* A new frame is a new scene; last frame's snapshot would show a pane the world before it moved. */
  it('is retaken after the frame turns over', () => {
    const { gl, calls } = recordingGl();
    const target = new SceneTarget(gl, 1);
    target.begin(640, 480);
    target.snapshotColor();
    calls.length = 0;

    target.begin(640, 480);
    target.snapshotColor();

    expect(calls.filter((c) => c.name === 'blitFramebuffer').length).toBe(1);
  });

  /*
   * Colour only. This file records a combined colour-and-depth blit losing the colour because the
   * driver disliked the depth, and the depth-only path losing the depth for a missing colour
   * target, so the two copies stay one buffer bit each.
   */
  it('blits the colour bit alone', () => {
    const { gl, calls } = recordingGl();
    const target = new SceneTarget(gl, 1);
    target.begin(640, 480);
    calls.length = 0;

    target.snapshotColor();

    const blit = calls.find((c) => c.name === 'blitFramebuffer');
    expect(blit?.args[8]).toBe(0x4000);
  });
});

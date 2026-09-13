import { describe, expect, it } from 'vitest';
import { mat4 } from 'gl-matrix';
import { Camera } from '@driftengine/core';
import { enterXr } from './session.ts';
import { eyeViews, aimCameraAtEye } from './views.ts';
import { buttonPressed, buttonValue, controllerFor, readControllers } from './input.ts';
import { HandSkeleton, JOINT_INDEX, jointPosition, readHand } from './hands.ts';
import { probeXrSupport } from './support.ts';
import { syntheticGlLayer, syntheticXr } from './testing/synthetic.ts';
import type { XrFrame, XrInputSource } from './types.ts';

/**
 * Everything from the first frame onward, which is everything the machine this was written on
 * cannot reach.
 *
 * No headset here: `immersive-vr` reports false and `makeXRCompatible` throws, so a real session
 * delivers no frame at all. `scripts/xr-check.mjs` asserts what a real browser *does* reach; this
 * file is the other half, and its runtime is a stand-in for a browser API rather than for an engine
 * capability. It cannot prove a compositor accepts what comes back, and nothing here says it can.
 */

/** A WebGL2 context that answers the one question a session asks of it. */
function fakeGl(): { makeXRCompatible(): Promise<void> } {
  return { makeXRCompatible: async () => {} };
}

async function run(system = syntheticXr()) {
  const globalCtor = globalThis as { XRWebGLLayer?: unknown };
  const before = globalCtor.XRWebGLLayer;
  globalCtor.XRWebGLLayer = class {
    constructor() {
      return syntheticGlLayer() as unknown as object;
    }
  };
  const result = await enterXr({ system, sources: { gl: fakeGl() } });
  globalCtor.XRWebGLLayer = before;
  return result;
}

describe('entering and leaving a session', () => {
  it('takes a session, a layer and a reference space, and hands back a frame source', async () => {
    const result = await run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.run.referenceSpaceType).toBe('local-floor');
    expect(result.run.backend).toBe('webgl2');
    expect(result.run.layer.baseLayer).not.toBeNull();
    expect(typeof result.run.frameSource.requestAnimationFrame).toBe('function');
  });

  /**
   * **`local-floor` first, and this is the assertion that keeps it that way.** `local` puts the
   * origin where the headset started, which stands a player's feet wherever their head was.
   */
  it('prefers a floor space and falls back in order', async () => {
    const noFloor = await run(syntheticXr({ spaces: ['local', 'viewer'] }));
    expect(noFloor.ok && noFloor.run.referenceSpaceType).toBe('local');

    const viewerOnly = await run(syntheticXr({ spaces: ['viewer'] }));
    expect(viewerOnly.ok && viewerOnly.run.referenceSpaceType).toBe('viewer');
  });

  it('refuses with a sentence when the device is not there, and never throws', async () => {
    const result = await run(syntheticXr({ modes: ['inline'] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('immersive-vr');
    expect(result.reason).toContain('no device');
  });

  it('refuses with a sentence when no reference space is offered', async () => {
    const result = await run(syntheticXr({ spaces: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('reference space');
  });

  it('reports the end of a session however it ends', async () => {
    const system = syntheticXr();
    const result = await run(system);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    let ended = 0;
    result.run.onEnd(() => {
      ended++;
    });
    system.endLatest();
    expect(ended).toBe(1);
  });

  it('ends once even when asked twice', async () => {
    const system = syntheticXr();
    const result = await run(system);
    if (!result.ok) return;
    await result.run.end();
    await result.run.end();
    expect(system.sessions[0]?.endedCount).toBe(1);
  });
});

describe('the frame source a session hands over', () => {
  it('delivers the frame the runtime produced', async () => {
    const system = syntheticXr();
    const result = await run(system);
    if (!result.ok) return;

    let delivered: unknown = null;
    result.run.frameSource.requestAnimationFrame((_time, frame) => {
      delivered = frame;
    });
    expect(delivered).toBeNull();

    system.advance();
    expect(delivered).not.toBeNull();
    expect((delivered as XrFrame).getViewerPose).toBeTypeOf('function');
  });
});

describe('stereo, which is two views and not one drawn twice', () => {
  it('turns a pose into one eye view per view, with viewports that differ', async () => {
    const system = syntheticXr();
    const result = await run(system);
    if (!result.ok) return;

    let frame: XrFrame | null = null;
    result.run.frameSource.requestAnimationFrame((_t, f) => {
      frame = f as XrFrame;
    });
    system.advance();
    expect(frame).not.toBeNull();

    const pose = (frame as unknown as XrFrame).getViewerPose(result.run.referenceSpace);
    const views = eyeViews(pose!, result.run.layer.baseLayer);

    expect(views).toHaveLength(2);
    expect(views[0]?.eye).toBe('left');
    expect(views[1]?.eye).toBe('right');
    expect(views[0]?.viewport?.x).toBe(0);
    expect(views[1]?.viewport?.x).toBe(512);
  });

  /**
   * **The assertion a stereo path that drew one picture twice would fail.** The two eyes have
   * different off-axis projections and stand 64 mm apart, so a renderer that reused one eye's
   * matrices for both would pass every other test in this file and this one alone.
   */
  it('gives the two eyes different projections and different positions', async () => {
    const system = syntheticXr();
    const result = await run(system);
    if (!result.ok) return;

    let frame: XrFrame | null = null;
    result.run.frameSource.requestAnimationFrame((_t, f) => {
      frame = f as XrFrame;
    });
    system.advance();
    const pose = (frame as unknown as XrFrame).getViewerPose(result.run.referenceSpace);
    const views = eyeViews(pose!, result.run.layer.baseLayer);

    expect([...(views[0]?.projection ?? [])]).not.toEqual([...(views[1]?.projection ?? [])]);

    const left = new Camera();
    const right = new Camera();
    aimCameraAtEye(left, views[0]!);
    aimCameraAtEye(right, views[1]!);

    /* 64 mm apart, which is the interpupillary distance the runtime was built with. */
    expect(right.position[0] - left.position[0]).toBeCloseTo(0.064, 4);
    expect(left.position[1]).toBeCloseTo(1.6, 4);
  });

  /** Both eyes' matrices have to survive the other being adopted, or the second overwrites the first. */
  it('keeps each eye’s matrices valid while the other is in use', async () => {
    const system = syntheticXr();
    const result = await run(system);
    if (!result.ok) return;

    let frame: XrFrame | null = null;
    result.run.frameSource.requestAnimationFrame((_t, f) => {
      frame = f as XrFrame;
    });
    system.advance();
    const pose = (frame as unknown as XrFrame).getViewerPose(result.run.referenceSpace);
    const views = eyeViews(pose!, result.run.layer.baseLayer);

    const leftView = mat4.clone(views[0]!.view);
    aimCameraAtEye(new Camera(), views[1]!);
    expect([...views[0]!.view]).toEqual([...leftView]);
  });

  /** An inline session carries one view, and nothing here may assume two. */
  it('handles a single view without pretending there are two', async () => {
    const system = syntheticXr({ views: 'mono' });
    const result = await run(system);
    if (!result.ok) return;

    let frame: XrFrame | null = null;
    result.run.frameSource.requestAnimationFrame((_t, f) => {
      frame = f as XrFrame;
    });
    system.advance();
    const pose = (frame as unknown as XrFrame).getViewerPose(result.run.referenceSpace);
    expect(eyeViews(pose!, result.run.layer.baseLayer)).toHaveLength(1);
  });
});

describe('controllers', () => {
  async function withFrame() {
    const system = syntheticXr();
    const result = await run(system);
    if (!result.ok) throw new Error(result.reason);
    let frame: XrFrame | null = null;
    result.run.frameSource.requestAnimationFrame((_t, f) => {
      frame = f as XrFrame;
    });
    system.advance();
    return { system, run: result.run, frame: frame as unknown as XrFrame };
  }

  it('reads a source per hand, with a grip and a ray', async () => {
    const { run: session, frame } = await withFrame();
    const states = readControllers(session.session, frame, session.referenceSpace);

    expect(states).toHaveLength(2);
    const left = controllerFor(states, 'left');
    expect(left?.tracked).toBe(true);
    expect(left?.gripMatrix).not.toBeNull();
    expect(left?.rayMatrix).not.toBeNull();
    expect(left?.gripMatrix?.[12]).toBeCloseTo(-0.25, 4);
  });

  it('reads buttons by the profile’s names rather than by index at the call site', async () => {
    const { system, run: session, frame } = await withFrame();
    system.sessions[0]?.setButton('right', 0, 0.75);

    const states = readControllers(session.session, frame, session.referenceSpace);
    const right = controllerFor(states, 'right')!;
    expect(buttonValue(right, 'trigger')).toBeCloseTo(0.75, 5);
    expect(buttonPressed(right, 'trigger')).toBe(true);
    expect(buttonPressed(right, 'squeeze')).toBe(false);
  });

  /** A device with fewer buttons reads zero rather than throwing or reporting a neighbour's. */
  it('answers zero for a button the device does not have', async () => {
    const { run: session, frame } = await withFrame();
    const states = readControllers(session.session, frame, session.referenceSpace);
    expect(buttonValue(states[0]!, 'thumbstick')).toBe(0);
  });
});

describe('hands', () => {
  async function handFrame() {
    const system = syntheticXr();
    const result = await run(system);
    if (!result.ok) throw new Error(result.reason);
    let frame: XrFrame | null = null;
    result.run.frameSource.requestAnimationFrame((_t, f) => {
      frame = f as XrFrame;
    });
    system.advance();
    const source = [...result.run.session.inputSources].find(
      (s) => s.hand !== undefined,
    ) as XrInputSource;
    return { system, run: result.run, frame: frame as unknown as XrFrame, source };
  }

  it('reads twenty-five joints into flat storage', async () => {
    const { run: session, frame, source } = await handFrame();
    const skeleton = new HandSkeleton();

    expect(readHand(source, frame, session.referenceSpace, skeleton)).toBe(true);
    expect(skeleton.trackedCount).toBe(25);
    expect(skeleton.visible).toBe(true);
    expect(skeleton.matrices).toHaveLength(25 * 16);

    const at = new Float32Array(3);
    expect(jointPosition(skeleton, 'wrist', at)).toBe(true);
    expect(at[1]).toBeCloseTo(1.1, 4);
    expect(jointPosition(skeleton, 'index-finger-tip', at)).toBe(true);
    expect(at[1]).toBeCloseTo(1.1 + JOINT_INDEX['index-finger-tip']! * 0.005, 4);
  });

  /**
   * **The decision this file exists to pin.** A hand tracker loses joints constantly as fingers
   * occlude each other, and zeroing one collapses that finger onto the wrist for a frame and snaps
   * it back on the next. So the last pose stays and only the flag moves.
   */
  it('keeps the last pose of a joint that stopped being tracked', async () => {
    const { system, run: session, frame, source } = await handFrame();
    const skeleton = new HandSkeleton();
    readHand(source, frame, session.referenceSpace, skeleton);

    const before = new Float32Array(3);
    jointPosition(skeleton, 'index-finger-tip', before);

    system.sessions[0]?.setJointTracked('left', 'index-finger-tip', false);
    let next: XrFrame | null = null;
    session.frameSource.requestAnimationFrame((_t, f) => {
      next = f as XrFrame;
    });
    system.advance();
    readHand(source, next as unknown as XrFrame, session.referenceSpace, skeleton);

    const after = new Float32Array(3);
    const tracked = jointPosition(skeleton, 'index-finger-tip', after);

    expect(tracked).toBe(false);
    expect([...after]).toEqual([...before]);
    expect(skeleton.trackedCount).toBe(24);
    expect(skeleton.visible).toBe(true);
  });

  /** A hand that leaves is different from a hand holding stale poses, and `clear` is the difference. */
  it('forgets everything when told the hand is gone', async () => {
    const { run: session, frame, source } = await handFrame();
    const skeleton = new HandSkeleton();
    readHand(source, frame, session.referenceSpace, skeleton);
    skeleton.clear();

    expect(skeleton.trackedCount).toBe(0);
    expect(skeleton.visible).toBe(false);
    expect([...skeleton.matrices].every((n) => n === 0)).toBe(true);
  });

  it('reports nothing for a controller with no hand, without failing', async () => {
    const { run: session, frame } = await handFrame();
    const plain = [...session.session.inputSources].find((s) => s.hand === undefined)!;
    const skeleton = new HandSkeleton();
    expect(readHand(plain, frame, session.referenceSpace, skeleton)).toBe(false);
    expect(skeleton.visible).toBe(false);
  });
});

describe('support, asked by doing', () => {
  it('says which modes a system offers', async () => {
    const system = syntheticXr({ modes: ['inline'] });
    const support = await probeXrSupport({ makeXRCompatible: async () => {} }, system);

    expect(support.present).toBe(true);
    expect(support.inline).toBe(true);
    expect(support.immersiveVr).toBe(false);
    expect(support.compatible).toBe(true);
    expect(support.reason).toContain('inline');
  });

  /**
   * **The case this whole file was shaped by.** A context that refuses to become XR compatible is
   * exactly what this machine does, and it is the step no `isSessionSupported` reports on.
   */
  it('names a context that refused to become XR compatible', async () => {
    const system = syntheticXr();
    const support = await probeXrSupport(
      {
        makeXRCompatible: async () => {
          const error = new Error('no device');
          error.name = 'InvalidStateError';
          throw error;
        },
      },
      system,
    );

    expect(support.compatible).toBe(false);
    expect(support.reason).toContain('InvalidStateError');
    expect(support.reason).toContain('no XR device');
  });

  it('answers with nothing when the browser has no WebXR', async () => {
    const support = await probeXrSupport(null, null);

    expect(support.present).toBe(false);
    expect(support.reason).toContain('navigator.xr is not defined');
  });
});

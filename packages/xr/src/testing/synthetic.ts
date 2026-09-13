/**
 * A WebXR runtime that answers, so everything past the first frame can be exercised.
 *
 * **This stands in for a browser API and not for an engine capability**, which is the distinction
 * R1 drew when it withdrew the mock capability providers: a mock with no first implementation to
 * check it against is only ever agreeing with itself. The first implementation of WebXR is a
 * browser's, and `DeterministicProvider` already lives on the same footing, standing in for a thing
 * that is genuinely elsewhere.
 *
 * **It exists because no frame can be produced on the machine this was written on.** Measured
 * 2026-09-05, Chrome 151, no headset: an inline session starts and `makeXRCompatible` throws, so
 * there is no base layer and therefore no `XRFrame` at all. Every path from the first frame onward
 * would otherwise be code nobody had run.
 *
 * **What it cannot do is prove a real runtime accepts what the engine hands back.** It produces the
 * shapes the specification describes; whether a compositor is happy with them is a question only
 * hardware answers, and that is tracked as unmeasured rather than this file
 * pretending otherwise.
 *
 * The numbers are deliberately asymmetric and deliberately not round. An eye projection is off-axis
 * and the two eyes differ; a synthetic runtime handing back two identical symmetric matrices would
 * let a stereo path that drew the same picture twice pass as correct.
 */

import { mat4 } from 'gl-matrix';
import type {
  XrFrame,
  XrGamepad,
  XrHand,
  XrInputSource,
  XrJointPose,
  XrRigidTransform,
  XrSession,
  XrSystem,
  XrView,
  XrViewerPose,
  XrViewport,
  XrWebGlLayer,
} from '../types.ts';
import { HAND_JOINTS } from '../hands.ts';

function transform(matrix: mat4): XrRigidTransform {
  return {
    matrix: matrix as unknown as Float32Array,
    inverse: { matrix: mat4.invert(mat4.create(), matrix) as unknown as Float32Array },
  };
}

/** Two eyes, 64 mm apart, with off-axis frusta that differ from each other. */
function stereoViews(headHeight: number): XrView[] {
  const half = 0.032;
  const make = (eye: 'left' | 'right', offset: number, left: number, right: number): XrView => {
    const world = mat4.create();
    mat4.translate(world, world, [offset, headHeight, 0]);
    return {
      eye,
      projectionMatrix: mat4.frustum(
        mat4.create(),
        left,
        right,
        -0.08,
        0.08,
        0.1,
        1000,
      ) as unknown as Float32Array,
      /* The eye's pose in the reference space, which is what `XRView.transform` is. An earlier
         draft inverted this twice by accident, which typechecked as `mat4 | null` and said so. */
      transform: transform(world),
    };
  };
  /* Each eye's frustum is off-centre towards its own side, which is what a headset's optics do. */
  return [make('left', -half, -0.11, 0.09), make('right', half, -0.09, 0.11)];
}

export interface SyntheticOptions {
  /** Modes the system reports and will grant. Everything else is refused. */
  readonly modes?: readonly string[];
  /** Reference spaces the session will grant, in the order it is asked. */
  readonly spaces?: readonly string[];
  readonly headHeight?: number;
  /** One entry per controller. `hand` gives it twenty-five joints as well. */
  readonly controllers?: readonly { handedness: 'left' | 'right'; hand?: boolean }[];
  /** Views a frame carries. Two by default, which is what a headset gives. */
  readonly views?: 'stereo' | 'mono';
}

export interface SyntheticSystem extends XrSystem {
  /** Deliver one frame to whoever asked. Nothing happens on its own. */
  advance(timeMs?: number): void;
  /** Sessions this system has granted, in order. */
  readonly sessions: SyntheticSession[];
  /** End the newest session the way a runtime does when a headset is removed. */
  endLatest(): void;
}

export interface SyntheticSession extends XrSession {
  readonly renderState: { baseLayer?: XrWebGlLayer; layers?: readonly unknown[] };
  readonly endedCount: number;
  /** Set a button's analogue value on a controller, which also sets `pressed` past a half. */
  setButton(handedness: 'left' | 'right', index: number, value: number): void;
  /** Stop reporting a joint, the way an occluded finger stops being tracked. */
  setJointTracked(handedness: 'left' | 'right', joint: string, tracked: boolean): void;
}

/**
 * Build a runtime.
 *
 * Nothing is on a timer: `advance` is the only thing that produces a frame, so a test asserting
 * about frame N is asserting about a frame it caused rather than one it waited for.
 */
export function syntheticXr(options: SyntheticOptions = {}): SyntheticSystem {
  const modes = options.modes ?? ['immersive-vr', 'inline'];
  const spaces = options.spaces ?? ['local-floor', 'local', 'viewer'];
  const headHeight = options.headHeight ?? 1.6;
  const wanted = options.controllers ?? [
    { handedness: 'left', hand: true },
    { handedness: 'right' },
  ];
  const sessions: SyntheticSession[] = [];

  const system: SyntheticSystem = {
    sessions,
    async isSessionSupported(mode: string): Promise<boolean> {
      return modes.includes(mode);
    },
    async requestSession(mode: string): Promise<XrSession> {
      if (!modes.includes(mode)) {
        const error = new Error(`no ${mode} device`);
        error.name = 'NotSupportedError';
        throw error;
      }
      const session = buildSession(mode);
      sessions.push(session);
      return session;
    },
    advance(timeMs = 16): void {
      for (const session of sessions)
        (session as unknown as { fire(t: number): void }).fire(timeMs);
    },
    endLatest(): void {
      const session = sessions.at(-1);
      void session?.end();
    },
  };

  function buildSession(mode: string): SyntheticSession {
    let pending: ((timeMs: number, frame: XrFrame) => void) | null = null;
    let handle = 0;
    let ended = 0;
    let clock = 0;
    const listeners = new Map<string, (() => void)[]>();
    const renderState: { baseLayer?: XrWebGlLayer; layers?: readonly unknown[] } = {};

    const buttons = new Map<string, number[]>();
    const untracked = new Set<string>();
    for (const controller of wanted) buttons.set(controller.handedness, [0, 0, 0, 0]);

    const inputSources: XrInputSource[] = wanted.map((controller) => {
      const gripSpace = { kind: 'grip', handedness: controller.handedness };
      const targetRaySpace = { kind: 'ray', handedness: controller.handedness };
      const gamepad: XrGamepad = {
        get buttons() {
          const values = buttons.get(controller.handedness) ?? [];
          return values.map((value) => ({ pressed: value > 0.5, touched: value > 0, value }));
        },
        axes: [0, 0, 0.25, -0.5],
      };
      const hand: XrHand | undefined = controller.hand
        ? {
            size: HAND_JOINTS.length,
            get: (joint: string) => ({ kind: 'joint', joint, handedness: controller.handedness }),
            keys: () => HAND_JOINTS[Symbol.iterator]() as unknown as IterableIterator<string>,
          }
        : undefined;
      return {
        handedness: controller.handedness,
        targetRayMode: 'tracked-pointer',
        targetRaySpace,
        gripSpace,
        gamepad,
        hand,
      };
    });

    const viewport = (index: number): XrViewport => ({
      x: index * 512,
      y: 0,
      width: 512,
      height: 512,
    });

    const frameFor = (session: SyntheticSession): XrFrame => ({
      session,
      getViewerPose(): XrViewerPose | null {
        const views =
          options.views === 'mono'
            ? [stereoViews(headHeight)[0] as XrView]
            : stereoViews(headHeight);
        const head = mat4.create();
        mat4.translate(head, head, [0, headHeight, 0]);
        return { views, transform: transform(head) };
      },
      getPose(space: unknown) {
        const described = space as { kind?: string; handedness?: string } | null;
        if (described?.handedness === undefined) return null;
        const world = mat4.create();
        mat4.translate(world, world, [described.handedness === 'left' ? -0.25 : 0.25, 1.1, -0.35]);
        return { transform: transform(world) };
      },
      getJointPose(joint: unknown): XrJointPose | null {
        const described = joint as { joint?: string; handedness?: string } | null;
        if (described?.joint === undefined) return null;
        if (untracked.has(`${described.handedness}:${described.joint}`)) return null;
        const index = HAND_JOINTS.indexOf(described.joint as (typeof HAND_JOINTS)[number]);
        const world = mat4.create();
        mat4.translate(world, world, [
          described.handedness === 'left' ? -0.25 : 0.25,
          1.1 + index * 0.005,
          -0.35,
        ]);
        return { transform: transform(world), radius: 0.008 };
      },
    });

    const session: SyntheticSession = {
      renderState,
      get endedCount() {
        return ended;
      },
      get inputSources() {
        return inputSources;
      },
      async requestReferenceSpace(type: string): Promise<unknown> {
        if (!spaces.includes(type)) {
          const error = new Error(`no ${type}`);
          error.name = 'NotSupportedError';
          throw error;
        }
        return { kind: 'space', type };
      },
      updateRenderState(state) {
        if (state.baseLayer !== undefined) renderState.baseLayer = state.baseLayer;
        if (state.layers !== undefined) renderState.layers = state.layers;
      },
      requestAnimationFrame(callback) {
        pending = callback;
        return ++handle;
      },
      cancelAnimationFrame() {
        pending = null;
      },
      async end(): Promise<void> {
        ended++;
        for (const listener of listeners.get('end') ?? []) listener();
      },
      addEventListener(type, listener) {
        const list = listeners.get(type) ?? [];
        list.push(listener);
        listeners.set(type, list);
      },
      setButton(handedness, index, value) {
        const values = buttons.get(handedness);
        if (values !== undefined) values[index] = value;
      },
      setJointTracked(handedness, joint, tracked) {
        const key = `${handedness}:${joint}`;
        if (tracked) untracked.delete(key);
        else untracked.add(key);
      },
    };

    (session as unknown as { fire(t: number): void }).fire = (timeMs: number): void => {
      const callback = pending;
      pending = null;
      clock += timeMs;
      callback?.(clock, frameFor(session));
    };

    void mode;
    return session;
  }

  return system;
}

/** A layer a synthetic session accepts, so the render-state path can be exercised too. */
export function syntheticGlLayer(): XrWebGlLayer {
  return {
    framebuffer: { kind: 'framebuffer' },
    framebufferWidth: 1024,
    framebufferHeight: 512,
    getViewport(view: XrView): XrViewport {
      return { x: view.eye === 'right' ? 512 : 0, y: 0, width: 512, height: 512 };
    },
  };
}

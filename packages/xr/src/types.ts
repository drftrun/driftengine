/**
 * The parts of WebXR this package touches, declared here.
 *
 * **Declared and not imported, because `tsconfig.json` sets `"types": []`.** The engine's config
 * says why: `@types/node` is installed for the tools, and TypeScript pulls in every `@types`
 * package it can find unless a config says otherwise, so a stray `Buffer` would compile here and
 * fail in somebody's game. `@types/webxr` would be the same trade in the other direction, and its
 * own note already sanctions the alternative: *`src/` and `demo/` reach the DOM through the `lib`
 * above and declare anything else they need themselves.*
 *
 * So these are the shapes this package reads, written out. They are deliberately **narrower than
 * the specification**: what is here is what the code below touches, and a field nobody reads is a
 * field nobody has to keep in step with a moving standard.
 */

/** A pose's transform. Only the matrix is read; the decomposed parts are the runtime's convenience. */
export interface XrRigidTransform {
  readonly matrix: Float32Array;
  readonly inverse?: { readonly matrix: Float32Array };
}

/** One eye, or the single view an inline session offers. */
export interface XrView {
  readonly eye: 'left' | 'right' | 'none';
  readonly projectionMatrix: Float32Array;
  readonly transform: XrRigidTransform;
}

export interface XrViewerPose {
  readonly views: readonly XrView[];
  readonly transform: XrRigidTransform;
}

/** Where in the layer's texture one eye draws. */
export interface XrViewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface XrWebGlLayer {
  readonly framebuffer: unknown;
  readonly framebufferWidth: number;
  readonly framebufferHeight: number;
  getViewport(view: XrView): XrViewport | undefined;
}

/** A joint of a hand, keyed by the twenty-five names the specification fixes. */
export interface XrJointPose {
  readonly transform: XrRigidTransform;
  readonly radius: number | null;
}

export interface XrHand {
  readonly size: number;
  get(joint: string): unknown;
  keys(): IterableIterator<string>;
}

export interface XrGamepadButton {
  readonly pressed: boolean;
  readonly touched: boolean;
  readonly value: number;
}

export interface XrGamepad {
  readonly buttons: readonly XrGamepadButton[];
  readonly axes: readonly number[];
}

export interface XrInputSource {
  readonly handedness: 'left' | 'right' | 'none';
  readonly targetRayMode: string;
  readonly targetRaySpace: unknown;
  readonly gripSpace?: unknown;
  readonly gamepad?: XrGamepad;
  readonly hand?: XrHand;
}

export interface XrFrame {
  readonly session: XrSession;
  getViewerPose(space: unknown): XrViewerPose | null | undefined;
  getPose?(
    space: unknown,
    base: unknown,
  ): { readonly transform: XrRigidTransform } | null | undefined;
  getJointPose?(joint: unknown, base: unknown): XrJointPose | null | undefined;
}

export interface XrRenderState {
  baseLayer?: XrWebGlLayer;
  layers?: readonly unknown[];
  depthNear?: number;
  depthFar?: number;
}

export interface XrSession {
  readonly inputSources: Iterable<XrInputSource>;
  requestReferenceSpace(type: string): Promise<unknown>;
  updateRenderState(state: XrRenderState): void;
  requestAnimationFrame(callback: (timeMs: number, frame: XrFrame) => void): number;
  cancelAnimationFrame(handle: number): void;
  end(): Promise<void>;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

export interface XrSystem {
  isSessionSupported(mode: string): Promise<boolean>;
  requestSession(
    mode: string,
    options?: { optionalFeatures?: readonly string[] },
  ): Promise<XrSession>;
}

/** The session modes this package will ask for. */
export type XrMode = 'immersive-vr' | 'immersive-ar' | 'inline';

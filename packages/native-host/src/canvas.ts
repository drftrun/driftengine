/**
 * A canvas with no page around it: a drawing buffer, a CSS box, and a WebGPU context.
 *
 * **What the engine asks of a canvas, and no more.** Its WebGPU backend takes a canvas, asks it
 * for a `webgpu` context, configures that against its device, sets the drawing buffer's size, and
 * each frame draws into `getCurrentTexture()`. The renderer's public measurements read the canvas's
 * CSS box. That is the whole surface, so that is what this implements — and anything a scene reaches
 * for beyond it is a gap the host names when it meets one, rather than a document this pretends to
 * be.
 *
 * **The frame lands in a texture the host owns.** A browser presents the canvas itself at the end of
 * a task; a host has to, so the texture carries two usages the engine never asks for — sampled, to be
 * drawn into the window, and copyable, to be read back by the pixel gate.
 */

import { CanvasStyle } from './canvasStyle.ts';
import { type Handlers, HostNode } from './domTree.ts';
import { INPUT_TYPES, type PageDocument } from './page.ts';
import { PointerCapture } from './pointerCapture.ts';

/* Texture usage flags, named here rather than read off a global a host may not have installed. */
const COPY_SRC = 0x01;
const TEXTURE_BINDING = 0x04;
const RENDER_ATTACHMENT = 0x10;

/* The attributes `HostNode.handles` defines below, declared for the checker. */
export interface NativeCanvas extends Handlers<(typeof INPUT_TYPES)[number]> {}

export class NativeCanvas extends HostNode {
  /** The drawing buffer, in device pixels, which the engine sets. */
  width: number;
  height: number;
  /** Device pixels per CSS pixel. */
  readonly pixelRatio: number;
  /** Whether there is a window to present to: false while it is minimised to nothing. */
  visible = true;

  private cssWidth: number;
  private cssHeight: number;
  private context: NativeCanvasContext | null = null;
  /** Set by the page that holds this canvas (`page.ts`); a canvas outside one has no pointer to lock. */
  lockPointer: (() => Promise<void>) | null = null;
  /** Set by the page too, which is what holds the focus and the fullscreen. */
  focuser: ((focus: boolean) => void) | null = null;
  fullscreener: (() => Promise<void>) | null = null;
  capture: PointerCapture | null = null;
  /** Set by what drives the window's mouse, which is where a cursor is shown (`canvasStyle.ts`). */
  cursorer: ((css: string) => void) | null = null;
  readonly style = new CanvasStyle((css) => this.cursorer?.(css));
  /**
   * A canvas is focusable only once it is given a `tabIndex`, as a browser's is: until then it
   * reports −1 and `focus()` does nothing.
   */
  private focusIndex: number | null = null;

  static {
    HostNode.handles(NativeCanvas.prototype, INPUT_TYPES);
  }

  constructor(width: number, height: number, pixelRatio = 1) {
    super();
    this.pixelRatio = pixelRatio;
    this.width = width;
    this.height = height;
    this.cssWidth = width / pixelRatio;
    this.cssHeight = height / pixelRatio;
  }

  /** The CSS box, which is what `cssWidth` and `aspect` are asked of. */
  get clientWidth(): number {
    return this.cssWidth;
  }

  get clientHeight(): number {
    return this.cssHeight;
  }

  getBoundingClientRect(): DOMRect {
    const width = this.cssWidth;
    const height = this.cssHeight;
    const rect = { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height };
    return { ...rect, toJSON: () => rect } as DOMRect;
  }

  /**
   * `webgpu`, and nothing else — which is what a browser's canvas answers once it has given one.
   * The engine never asks for another here: the backend is chosen before a context is taken.
   */
  getContext(kind: string): GPUCanvasContext | null {
    if (kind !== 'webgpu') return null;
    if (this.context === null) this.context = new NativeCanvasContext(this);
    return this.context as unknown as GPUCanvasContext;
  }

  get tabIndex(): number {
    return this.focusIndex ?? -1;
  }

  set tabIndex(index: number) {
    this.focusIndex = Math.trunc(index);
  }

  /** Focus, through the page; nothing, as in a browser, for a canvas that is not focusable. */
  focus(_options?: FocusOptions): void {
    if (this.focusIndex !== null) this.focuser?.(true);
  }

  blur(): void {
    this.focuser?.(false);
  }

  /** Capture, through the page, which is what knows the pointers (`pointerCapture.ts`). */
  setPointerCapture(pointerId: number): void {
    this.pointers().set(this, pointerId);
  }

  releasePointerCapture(pointerId: number): void {
    this.pointers().release(this, pointerId);
  }

  hasPointerCapture(pointerId: number): boolean {
    return this.capture?.has(this, pointerId) ?? false;
  }

  /** The document this canvas is in, once a page holds it. */
  get ownerDocument(): PageDocument {
    if (this.parentNode === null) {
      throw new Error('[driftengine] a canvas no page holds is in no document');
    }
    return this.parentNode as PageDocument;
  }

  /** Fullscreen, through the page, which is what holds the window. */
  requestFullscreen(_options?: FullscreenOptions): Promise<void> {
    if (this.fullscreener === null) {
      return Promise.reject(new TypeError('[driftengine] a canvas with no window cannot fill it'));
    }
    return this.fullscreener();
  }

  /** A canvas no page holds knows no pointers, so every id is unknown to it. */
  private pointers(): PointerCapture {
    return this.capture ?? new PointerCapture();
  }

  /** What a browser's canvas answers, through the page, which is what holds the lock. */
  requestPointerLock(_options?: unknown): Promise<void> {
    if (this.lockPointer === null) {
      return Promise.reject(
        new Error('[driftengine] a canvas with no window has no pointer to lock'),
      );
    }
    return this.lockPointer();
  }

  /**
   * The window's size, in device pixels, as the host is told it.
   *
   * **A window minimised to nothing keeps the last size it had.** It reports zero by zero, and a
   * texture of no size is a validation error that invalidates every command buffer that touches
   * it; the engine sizes its targets from this canvas, so this canvas never goes to zero. `visible`
   * says there is nowhere to present to, and the host skips presenting until there is.
   */
  resizeTo(width: number, height: number): void {
    if (width <= 0 || height <= 0) {
      this.visible = false;
      return;
    }
    this.visible = true;
    this.width = width;
    this.height = height;
    this.cssWidth = width / this.pixelRatio;
    this.cssHeight = height / this.pixelRatio;
  }
}

export class NativeCanvasContext {
  readonly canvas: NativeCanvas;
  private configuration: GPUCanvasConfiguration | null = null;
  private texture: GPUTexture | null = null;

  constructor(canvas: NativeCanvas) {
    this.canvas = canvas;
  }

  configure(configuration: GPUCanvasConfiguration): void {
    this.dropTexture();
    const asked = configuration.usage ?? RENDER_ATTACHMENT;
    this.configuration = { ...configuration, usage: asked | TEXTURE_BINDING | COPY_SRC };
  }

  unconfigure(): void {
    this.dropTexture();
    this.configuration = null;
  }

  getConfiguration(): GPUCanvasConfiguration | null {
    return this.configuration;
  }

  /**
   * This frame's texture: the same one until the drawing buffer changes size, and a new one when it
   * does, as a browser's is.
   */
  getCurrentTexture(): GPUTexture {
    const configuration = this.configuration;
    if (configuration === null) {
      throw new Error('[driftengine] this canvas is not configured, so it has no frame to give');
    }
    const { width, height } = this.canvas;
    const current = this.texture;
    if (current !== null && current.width === width && current.height === height) return current;
    this.dropTexture();
    this.texture = configuration.device.createTexture({
      label: 'native canvas',
      size: { width, height },
      format: configuration.format,
      usage: configuration.usage ?? RENDER_ATTACHMENT,
    });
    return this.texture;
  }

  private dropTexture(): void {
    this.texture?.destroy();
    this.texture = null;
  }
}

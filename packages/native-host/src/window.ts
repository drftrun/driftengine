/**
 * A window, the canvas the engine draws into, and the frame put on the screen.
 *
 * **SDL makes the window and Dawn draws into it**, through `@kmamal/sdl` and `@kmamal/gpu`: the
 * composition chosen for this host on 2026-09-18, because Dawn is the WebGPU implementation inside
 * Chrome and the host's gate is that the engine's frames match the browser's. SDL is also what the
 * later tasks read input, audio and the clipboard from.
 *
 * **The window renderer is made from the engine's device, when the engine configures the canvas.**
 * The engine asks `navigator.gpu` for its own adapter and device, as it does in a browser, so the
 * host does not have one until the engine hands it over — which it does, in `configure`.
 *
 * **Teardown waits for the device.** Destroying the device, the instance or the window with work
 * still in flight trips an assertion inside Dawn and takes the process with it (measured
 * 2026-09-18); after `onSubmittedWorkDone` every order is clean.
 */

import gpuModule from '@kmamal/gpu';
import sdl from '@kmamal/sdl';

import { nativeBridge } from './bridge.ts';
import type { BridgeDisplay, BridgeWindow, NativeBridge } from './bridge.ts';
import { NativeCanvas } from './canvas.ts';
import { desktopFiles } from './dialogs.ts';
import { createNativeTextHost } from './textHost.ts';
import type { NativeTextHost, TextWindow } from './textHost.ts';
import { connectDomEvents } from './domEvents.ts';
import { sdlWindowFlags, type WindowMode } from './windowMode.ts';
import { windowTitle } from './windowTitle.ts';
import type { EventWindow } from './domEvents.ts';
import { nativeGpu } from './gpu.ts';
import type { HostPage } from './page.ts';
import { Presenter } from './present.ts';

type Instance = ReturnType<typeof gpuModule.create>;
type WindowRenderer = ReturnType<typeof gpuModule.renderGPUDeviceToWindow>;
type SdlWindow = ReturnType<typeof sdl.video.createWindow>;
/* `@kmamal/gpu` declares its own branded device type; the engine's is the DOM's, and they are one object. */
type DawnDevice = Parameters<typeof gpuModule.renderGPUDeviceToWindow>[0]['device'];

export interface HostWindowOptions {
  readonly title: string;
  readonly width: number;
  readonly height: number;
  /** A window that is never shown, for checks that should not flash on a desktop. */
  readonly hidden?: boolean;
  /** As a packaged game's manifest says; windowed and resizable when it says nothing. */
  readonly mode?: WindowMode;
  readonly resizable?: boolean;
}

export class HostWindow {
  readonly canvas: NativeCanvas;
  readonly gpu: GPU;
  private readonly window: SdlWindow;
  private readonly instance: Instance;
  private device: GPUDevice | null = null;
  private renderer: WindowRenderer | null = null;
  private presenter: Presenter | null = null;
  private closed = false;

  constructor(options: HostWindowOptions) {
    this.window = sdl.video.createWindow({
      title: windowTitle(options.title, sdl.info.drivers.video.current),
      width: options.width,
      height: options.height,
      ...sdlWindowFlags(options.mode, options.resizable),
      visible: options.hidden !== true,
      webgpu: true,
    });
    this.canvas = new NativeCanvas(this.window.pixelWidth, this.window.pixelHeight);
    this.instance = gpuModule.create([]);
    this.gpu = nativeGpu(this.instance as unknown as Parameters<typeof nativeGpu>[0]);
    this.window.on('resize', ({ pixelWidth, pixelHeight }) => {
      this.canvas.resizeTo(pixelWidth, pixelHeight);
      this.renderer?.resize();
    });
    this.window.on('close', () => {
      this.closed = true;
    });
    /*
     * **A window nobody focused receives no keys, and SDL says so nowhere.**
     *
     * `@kmamal/sdl` routes a mouse event by which window is *hovered* and a key event by which one
     * is *focused*, and it learns the second only from a `focus` event it may deliver before
     * anything is listening — a window created and given focus by the desktop in the same breath
     * leaves `Globals.windows.focused` null. The window then draws, answers the mouse, and is deaf:
     * a maintainer reported exactly that on 2026-09-20, with clicks landing and the keyboard doing
     * nothing.
     *
     * Asking for focus outright sets it, which is what an application does when it opens a window
     * anyway. **Only a visible one**: a hidden window is for checks that must not take a desktop's
     * focus away from whoever is using it.
     */
    if (options.hidden !== true) this.window.focus();
  }

  /**
   * Put this window's canvas in `page`, and its keys, mouse, focus and size into `page`'s events.
   * Hands back what disconnects them.
   */
  connectPage(page: HostPage): () => void {
    page.attach(this.canvas);
    return connectDomEvents(this.window as unknown as EventWindow, sdl.mouse, page, this.canvas);
  }

  /**
   * The shell's bridge over this window, with its store at `storePath` (see `bridge.ts`). `quit` is
   * how the host hears that the game, or the person closing the window, has ended the session.
   */
  createBridge(storePath: string, quit: () => void): NativeBridge {
    return nativeBridge({
      window: this.window as unknown as BridgeWindow,
      displays: () => sdl.video.displays as unknown as readonly BridgeDisplay[],
      storePath,
      quit,
      files: desktopFiles() ?? undefined,
    });
  }

  /** The editor's text services over this window's typing and the desktop's clipboard. */
  createTextHost(): NativeTextHost {
    return createNativeTextHost(this.window as unknown as TextWindow, sdl.clipboard);
  }

  /** Whether the person closed it. */
  /** A new title, made showable as the first one was (`windowTitle.ts`). */
  setTitle(title: string): void {
    this.window.setTitle(windowTitle(title, sdl.info.drivers.video.current));
  }

  /**
   * Send `event` as SDL sends one, through the window's own emitter, for input a capture replays:
   * it then takes the path a person's does, and counts as a gesture where theirs would.
   */
  replay(type: string, event: object): void {
    (this.window as unknown as { emit(type: string, event: object): void }).emit(type, event);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Put the engine's last frame on the screen. Nothing happens before the engine has configured
   * the canvas, or while the window is minimised to nothing.
   */
  present(): void {
    if (this.closed || !this.canvas.visible) return;
    const context = this.canvas.getContext('webgpu') as GPUCanvasContext;
    const configuration = context.getConfiguration();
    if (configuration === null) return;
    if (this.device !== configuration.device) this.adopt(configuration.device);
    const renderer = this.renderer;
    const presenter = this.presenter;
    if (renderer === null || presenter === null) return;
    presenter.present(context.getCurrentTexture(), renderer.getCurrentTextureView());
    renderer.swap();
  }

  /** Wait for the device, then let everything go in an order Dawn accepts. */
  async close(): Promise<void> {
    await this.device?.queue.onSubmittedWorkDone();
    this.closed = true;
    /*
     * **A window the person already closed is destroyed, and destroying it again throws.**
     *
     * SDL destroys a window when its close button is pressed, so a host that then shuts down in
     * good order — which is the ordinary path, and the only one after a person closes a window —
     * met `Error: window is destroyed` out of `sdl.video.window.destroy` and ended on a stack
     * trace instead of a clean exit. Reported from a maintainer's own machine, 2026-09-20.
     *
     * **What it gives up:** a destroy that fails for some other reason is swallowed too. The
     * instance below is released either way, which is the part that holds the process open.
     */
    try {
      this.window.destroy();
    } catch {
      /* Already gone, which is what closing a window does. */
    }
    gpuModule.destroy(this.instance);
  }

  private adopt(device: GPUDevice): void {
    this.device = device;
    this.renderer = gpuModule.renderGPUDeviceToWindow({
      device: device as unknown as DawnDevice,
      window: this.window,
    });
    this.presenter = new Presenter(device, this.renderer.getCurrentTexture().format);
  }
}

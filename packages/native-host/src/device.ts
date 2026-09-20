/**
 * The device, made to say what it rejected, when its binding will not.
 *
 * **The engine hears one thing from its device**: `uncapturederror`, which its surface turns into a
 * line naming what the GPU refused — the only warning a WebGPU frame gets that it drew nothing.
 * `@kmamal/gpu` 0.2.0 refuses that listener ("no overload matched for addEventListener") and will not
 * take an `onuncapturederror` either (measured 2026-09-18). Error scopes work, so the host opens one
 * around each frame and hands whatever it caught to the listeners the engine registered: the same
 * message, at the end of the frame that caused it, which is when a browser raises it too.
 *
 * **Detected, not assumed.** A device whose binding takes the listener is left exactly as it is, so a
 * later binding that delivers its own events costs nothing here.
 *
 * What it gives up: an error from work outside a frame — a pipeline built at mount — is only caught
 * if the host has a scope open at the time. Dawn still prints every validation error to the
 * terminal itself, so none is silent.
 */

import { AlphaCopier } from './alphaCopy.ts';
import type { AlphaStep } from './alphaCopy.ts';
import { isHostBitmap } from './images.ts';

export interface FrameErrors {
  /** Before the frame: catch what it does. */
  open(): void;
  /** After it: hand anything caught to the engine's listeners. */
  close(): void;
}

const adapted = new WeakMap<GPUDevice, FrameErrors>();

/** The frame's error scopes for a device this host adapted, or `null` for one it left alone. */
export function errorsOf(device: GPUDevice): FrameErrors | null {
  return adapted.get(device) ?? null;
}

/** Skia's premultiply, the integer rounding Chrome's image decoders use. */
export function premultiplied(straight: Uint8Array): Uint8Array {
  const out = new Uint8Array(straight.length);
  for (let at = 0; at < straight.length; at += 4) {
    const alpha = straight[at + 3] as number;
    out[at + 3] = alpha;
    for (let channel = 0; channel < 3; channel += 1) {
      out[at + channel] = (((straight[at + channel] as number) * alpha + 128) * 257) >> 16;
    }
  }
  return out;
}

/**
 * The step a copy takes between the alpha an image is held in and the alpha its texture wants, or
 * null where the two agree and a browser copies the bytes as they are.
 */
export function alphaStepFor(held: boolean, wanted: boolean): AlphaStep | null {
  if (held === wanted) return null;
  return held ? 'unpremultiply' : 'premultiply';
}

/**
 * The queue, taking an image the host decoded where a browser would take one it decoded.
 *
 * **The engine puts a decoded image on the device with `copyExternalImageToTexture`**, and a browser
 * copies from its own image there. A host's image is a `HostBitmap` from `images.ts`, four bytes a
 * pixel that Dawn's binding cannot read as an image, so it is copied the way Chrome copies one:
 *
 * - **held as the texture wants it**, the bytes go in with `writeTexture`. Straight or
 *   premultiplied, into a plain or an sRGB texture, Chrome writes exactly these (measured);
 * - **held one way and wanted the other**, `alphaCopy.ts` runs the step on the device.
 *
 * A browser holds a decoded image premultiplied unless told `premultiplyAlpha: 'none'`, with Skia's
 * integer rounding, so that is how the bytes are held here. A browser flips rows only when asked,
 * and so does this. Any other source goes to the binding.
 */
function adaptQueue(device: GPUDevice): void {
  const queue = device.queue as GPUQueue | undefined;
  if (queue === undefined) return;
  const original = queue.copyExternalImageToTexture.bind(queue);
  const copier = new AlphaCopier(device);
  queue.copyExternalImageToTexture = (source, destination, copySize) => {
    /* A size may be any iterable of numbers or a dictionary; one shape, for both uses below. */
    const size: GPUExtent3D =
      Symbol.iterator in Object(copySize)
        ? Array.from(copySize as Iterable<number>)
        : (copySize as GPUExtent3DDict);
    const image: unknown = source.source;
    if (!isHostBitmap(image)) {
      original(source, destination, size);
      return;
    }
    const from = source.origin as GPUOrigin2DDict | undefined;
    if ((from?.x ?? 0) !== 0 || (from?.y ?? 0) !== 0) {
      throw new Error(
        '[driftengine] the native host copies a whole image, from its top-left corner',
      );
    }
    const row = image.width * 4;
    const straight = new Uint8Array(
      image.data.buffer,
      image.data.byteOffset,
      image.data.byteLength,
    );
    let bytes = image.premultiplied ? premultiplied(straight) : straight;
    if (source.flipY === true) {
      const flipped = new Uint8Array(bytes.length);
      for (let y = 0; y < image.height; y += 1) {
        flipped.set(bytes.subarray(y * row, (y + 1) * row), (image.height - 1 - y) * row);
      }
      bytes = flipped;
    }
    const width = Array.isArray(size) ? (size[0] as number) : (size as GPUExtent3DDict).width;
    const height = Array.isArray(size) ? (size[1] ?? 1) : ((size as GPUExtent3DDict).height ?? 1);
    const step = alphaStepFor(image.premultiplied, destination.premultipliedAlpha === true);
    if (step !== null) {
      copier.copy(bytes, image.width, image.height, step, destination, width, height);
      return;
    }
    queue.writeTexture(
      {
        texture: destination.texture,
        mipLevel: destination.mipLevel ?? 0,
        origin: destination.origin ?? { x: 0, y: 0, z: 0 },
      },
      bytes,
      { offset: 0, bytesPerRow: row, rowsPerImage: image.height },
      { width, height, depthOrArrayLayers: 1 },
    );
  };
}

export function adaptDevice(device: GPUDevice): GPUDevice {
  adaptQueue(device);
  const original = device.addEventListener.bind(device);
  try {
    original('uncapturederror', () => undefined);
    return device;
  } catch {
    /* The binding refused it: this device needs the adapter. */
  }

  const listeners = new Set<EventListenerOrEventListenerObject>();
  const deliver = (error: GPUError): void => {
    const event = { type: 'uncapturederror', error } as unknown as GPUUncapturedErrorEvent;
    for (const listener of listeners) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  };
  const scoped = device as unknown as {
    addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  };
  scoped.addEventListener = (type, listener) => {
    if (type === 'uncapturederror') listeners.add(listener);
  };
  scoped.removeEventListener = (type, listener) => {
    if (type === 'uncapturederror') listeners.delete(listener);
  };
  adapted.set(device, {
    open: () => device.pushErrorScope('validation'),
    close: () => {
      void device.popErrorScope().then((error) => {
        if (error !== null) deliver(error);
      });
    },
  });
  return device;
}

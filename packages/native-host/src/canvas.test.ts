import { describe, expect, test } from 'vitest';

import { NativeCanvas } from './canvas.ts';
import { errorsOf } from './device.ts';
import { PREFERRED_FORMAT, nativeGpu } from './gpu.ts';

/**
 * **What this file is for: the two things the engine asks a page for, answered by a host.**
 *
 * The engine's WebGPU backend reaches outside itself twice: `navigator.gpu`, and a canvas whose
 * `getContext('webgpu')` hands back a context it configures and draws into. A native host has
 * neither, so it supplies both — and the engine is not told, which is the whole design. These
 * pin the host's half against a device that records what it was asked, so the shape is settled
 * before a real one is involved.
 */

const TEXTURE_BINDING = 0x04;
const COPY_SRC = 0x01;
const RENDER_ATTACHMENT = 0x10;

interface Made {
  size: { width: number; height: number };
  format: GPUTextureFormat;
  usage: number;
  destroyed: boolean;
}

function recordingDevice() {
  const made: Made[] = [];
  const device = {
    createTexture(descriptor: GPUTextureDescriptor) {
      const size = descriptor.size as { width: number; height: number };
      const texture: Made = {
        size: { width: size.width, height: size.height },
        format: descriptor.format,
        usage: descriptor.usage,
        destroyed: false,
      };
      made.push(texture);
      /* A texture answers its own size, as a real one does, which is how a canvas knows it. */
      return {
        width: size.width,
        height: size.height,
        format: descriptor.format,
        destroy: () => void (texture.destroyed = true),
      };
    },
  } as unknown as GPUDevice;
  return { device, made };
}

describe('the gpu a host hands the engine', () => {
  test('ASKS DAWN FOR ADAPTERS AND ANSWERS THE PREFERRED FORMAT AS CHROME DOES HERE', async () => {
    /*
     * **Chrome answers `rgba8unorm` on this machine and Dawn's own instance answers
     * `bgra8unorm`.** The engine builds every pipeline that writes the frame against this answer,
     * and the host controls the texture the frame lands in, so it answers what the browser does
     * and the two hosts build the same pipelines.
     */
    const asked: unknown[] = [];
    /* A binding whose device refuses the engine's listener, as `@kmamal/gpu` 0.2.0's does. */
    const refusing = {
      addEventListener() {
        throw new TypeError('no overload matched for addEventListener:');
      },
    } as unknown as GPUDevice;
    const adapter = {
      name: 'the adapter',
      requestDevice: () => Promise.resolve(refusing),
    } as unknown as GPUAdapter;
    const gpu = nativeGpu({
      requestAdapter: (options?: GPURequestAdapterOptions) => {
        asked.push(options);
        return Promise.resolve(adapter);
      },
      getPreferredCanvasFormat: () => 'bgra8unorm',
    });
    expect(gpu.getPreferredCanvasFormat()).toBe('rgba8unorm');
    expect(PREFERRED_FORMAT).toBe('rgba8unorm');
    const handed = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    expect(asked).toEqual([{ powerPreference: 'high-performance' }]);
    /* Dawn's adapter, read through; and its devices come out able to take the engine's listener. */
    expect((handed as unknown as { name: string }).name).toBe('the adapter');
    const device = await handed?.requestDevice();
    expect(device).toBe(refusing);
    expect(errorsOf(refusing)).not.toBeNull();
  });
});

describe('a canvas with no page around it', () => {
  test('GIVES A WEBGPU CONTEXT AND NOTHING ELSE, as a canvas that has given one does', () => {
    const canvas = new NativeCanvas(320, 180);
    expect(canvas.getContext('webgpu')).not.toBeNull();
    expect(canvas.getContext('webgpu')).toBe(canvas.getContext('webgpu'));
    expect(canvas.getContext('webgl2')).toBeNull();
    expect(canvas.getContext('2d')).toBeNull();
  });

  test('HANDS OUT THE FRAME AT THE DRAWING BUFFER’S SIZE, in the format configured', () => {
    const { device, made } = recordingDevice();
    const canvas = new NativeCanvas(320, 180);
    const context = canvas.getContext('webgpu') as GPUCanvasContext;
    context.configure({ device, format: 'rgba8unorm', alphaMode: 'opaque' });
    const texture = context.getCurrentTexture();
    expect(made).toHaveLength(1);
    expect(made[0]?.size).toEqual({ width: 320, height: 180 });
    expect(made[0]?.format).toBe('rgba8unorm');
    /* The same texture for the rest of the frame, as the browser's is. */
    expect(context.getCurrentTexture()).toBe(texture);
  });

  test('ADDS WHAT THE HOST NEEDS TO THE USAGE THE ENGINE ASKED FOR: reading back and presenting', () => {
    /*
     * The engine configures a render target and nothing else. The host has two more jobs for the
     * same texture — sampling it into the window's swap chain, and copying it out for the pixel
     * gate — and a usage flag is the one thing it cannot add afterwards.
     */
    const { device, made } = recordingDevice();
    const context = new NativeCanvas(8, 8).getContext('webgpu') as GPUCanvasContext;
    context.configure({ device, format: 'rgba8unorm', usage: RENDER_ATTACHMENT });
    context.getCurrentTexture();
    const usage = made[0]?.usage ?? 0;
    expect(usage & RENDER_ATTACHMENT).toBe(RENDER_ATTACHMENT);
    expect(usage & TEXTURE_BINDING).toBe(TEXTURE_BINDING);
    expect(usage & COPY_SRC).toBe(COPY_SRC);
    /* Unasked, the usage is the browser's default: a render attachment. */
    const other = recordingDevice();
    const plain = new NativeCanvas(8, 8).getContext('webgpu') as GPUCanvasContext;
    plain.configure({ device: other.device, format: 'rgba8unorm' });
    plain.getCurrentTexture();
    expect((other.made[0]?.usage ?? 0) & RENDER_ATTACHMENT).toBe(RENDER_ATTACHMENT);
  });

  test('A RESIZE MAKES THE NEXT FRAME AT THE NEW SIZE, and lets the old one go', () => {
    const { device, made } = recordingDevice();
    const canvas = new NativeCanvas(320, 180);
    const context = canvas.getContext('webgpu') as GPUCanvasContext;
    context.configure({ device, format: 'rgba8unorm' });
    context.getCurrentTexture();
    canvas.width = 640;
    canvas.height = 360;
    context.getCurrentTexture();
    expect(made.map((texture) => texture.size)).toEqual([
      { width: 320, height: 180 },
      { width: 640, height: 360 },
    ]);
    expect(made[0]?.destroyed).toBe(true);
    expect(made[1]?.destroyed).toBe(false);
  });

  test('A WINDOW MINIMISED TO NOTHING KEEPS THE LAST FRAME’S SIZE rather than asking for none', () => {
    /*
     * **A minimised window reports zero by zero**, and a texture of no size is a validation error
     * that invalidates every command buffer touching it. The engine sizes its targets from the
     * canvas, so the canvas never goes to zero: it keeps the last size it had, and the host skips
     * presenting while there is nowhere to present to.
     */
    const { device, made } = recordingDevice();
    const canvas = new NativeCanvas(320, 180);
    const context = canvas.getContext('webgpu') as GPUCanvasContext;
    context.configure({ device, format: 'rgba8unorm' });
    canvas.resizeTo(0, 0);
    expect(canvas.width).toBe(320);
    expect(canvas.height).toBe(180);
    expect(canvas.visible).toBe(false);
    context.getCurrentTexture();
    expect(made[0]?.size).toEqual({ width: 320, height: 180 });
    canvas.resizeTo(400, 300);
    expect(canvas.visible).toBe(true);
    expect([canvas.width, canvas.height]).toEqual([400, 300]);
  });

  test('ITS CSS BOX IS ITS DRAWING BUFFER OVER THE PIXEL RATIO, which the renderer measures', () => {
    const canvas = new NativeCanvas(640, 360, 2);
    expect([canvas.clientWidth, canvas.clientHeight]).toEqual([320, 180]);
    const box = canvas.getBoundingClientRect();
    expect([box.left, box.top, box.width, box.height]).toEqual([0, 0, 320, 180]);
  });

  test('UNCONFIGURED, IT HAS NO FRAME TO GIVE, which is the browser’s answer too', () => {
    const context = new NativeCanvas(8, 8).getContext('webgpu') as GPUCanvasContext;
    expect(() => context.getCurrentTexture()).toThrow(/not configured/);
  });
});

describe('the globals a host installs', () => {
  test('`NAVIGATOR.GPU` GOES ONTO NODE’S OWN NAVIGATOR, which keeps what it already answered', async () => {
    const { installGpu } = await import('./globals.ts');
    const scope = globalThis as unknown as {
      navigator: { gpu?: unknown; hardwareConcurrency?: number };
    };
    const cores = scope.navigator.hardwareConcurrency;
    const gpu = { marker: 'host' } as unknown as GPU;
    installGpu(gpu);
    try {
      expect(scope.navigator.gpu).toBe(gpu);
      expect(scope.navigator.hardwareConcurrency).toBe(cores);
    } finally {
      delete scope.navigator.gpu;
    }
  });

  test('`LOCATION` CARRIES THE QUERY A SCENE READS ITS OPTIONS FROM, however it was written', async () => {
    const { installLocation } = await import('./globals.ts');
    const scope = globalThis as unknown as { location?: { search: string } };
    try {
      installLocation('at=29.7&occlusion=0');
      expect(scope.location?.search).toBe('?at=29.7&occlusion=0');
      installLocation('?radius=8');
      expect(new URLSearchParams(scope.location?.search).get('radius')).toBe('8');
      installLocation('');
      expect(scope.location?.search).toBe('');
    } finally {
      delete scope.location;
    }
  });
});

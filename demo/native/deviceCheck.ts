/**
 * The host's window and device, checked on this machine's GPU: `npm run check -w @driftengine/native-host`.
 *
 * **Not a test, because it needs a device and a display**, the reason every GPU check in this
 * repository is run by hand. It opens a hidden window, takes a device the way the engine does, and
 * checks what wave 5A Task 2 promised:
 *
 * - one capability probe serves both hosts;
 * - a feature the device lacks is reported absent rather than thrown;
 * - the engine's own surface configures, resizes, and hands back a frame that can be read;
 * - a lost device reaches the engine through the engine's own path, `createGpuSurface`, and not
 *   through anything this host adds;
 * - what the device rejects during a frame reaches the engine's own message, although this Dawn
 *   binding delivers no error events (see `device.ts`).
 *
 * It reaches two engine functions by path, `probeCapabilities` and `createGpuSurface`. They are not
 * in the barrel, and what is being checked is those functions against this host's device.
 */

import { probeCapabilities } from '../../packages/core/src/render/deviceFeatures.ts';
import { createGpuSurface } from '../../packages/core/src/render/backend/webgpu/device.ts';

import { errorsOf } from '../../packages/native-host/src/device.ts';
import { hostCreateImageBitmap } from '../../packages/native-host/src/images.ts';
import { installGpu } from '../../packages/native-host/src/globals.ts';
import { HostWindow } from '../../packages/native-host/src/window.ts';

let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

const host = new HostWindow({
  title: 'driftengine native check',
  width: 320,
  height: 180,
  hidden: true,
});
installGpu(host.gpu);

const adapter = await host.gpu.requestAdapter({ powerPreference: 'high-performance' });
check('an adapter', adapter !== null, adapter === null ? 'none' : 'offered');
if (adapter === null) process.exit(1);

/* One probe, both hosts: the shape `probeCapabilities` reads off a device, from this one. */
const device = await adapter.requestDevice({
  requiredFeatures: [...adapter.features].filter(
    (name): name is GPUFeatureName => name === 'timestamp-query' || name === 'shader-f16',
  ),
});
const capabilities = probeCapabilities(
  { features: device.features, limits: device.limits as unknown as Record<string, number> },
  'webgpu',
);
check(
  'the capability probe reads this device',
  capabilities.maxStorageBufferBytes > 0 && capabilities.maxComputeInvocationsPerWorkgroup > 0,
  JSON.stringify(capabilities),
);

/* A feature the adapter does not offer is absent, and asking for it anyway is a refusal. */
const absent: GPUFeatureName = 'texture-compression-astc';
let refused = 'granted';
if (!adapter.features.has(absent)) {
  try {
    const extra = await adapter.requestDevice({ requiredFeatures: [absent] });
    extra.destroy();
  } catch (error) {
    refused = `refused: ${(error as Error).message.split('\n')[0]}`;
  }
}
check(
  'a feature the device lacks is absent, not thrown',
  !adapter.features.has(absent) && !capabilities.compressedAstc && refused.startsWith('refused'),
  `${absent} ${refused}`,
);

/* The engine's own surface, configured on the host's canvas, at two sizes. */
const canvas = host.canvas as unknown as HTMLCanvasElement;
const surface = createGpuSurface(canvas, device);
surface.configure(320, 180);
const first = surface.context.getCurrentTexture();
host.canvas.resizeTo(400, 300);
surface.configure(400, 300);
const second = surface.context.getCurrentTexture();
check(
  'the surface configures and resizes',
  first.width === 320 &&
    second.width === 400 &&
    second.height === 300 &&
    surface.format === 'rgba8unorm',
  `${first.width}x${first.height} then ${second.width}x${second.height}, ${surface.format}`,
);

/* A frame the engine draws is one the host can read back, and put in the window. */
const encoder = device.createCommandEncoder();
encoder
  .beginRenderPass({
    colorAttachments: [
      {
        view: second.createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0.2, g: 0.4, b: 0.8, a: 1 },
      },
    ],
  })
  .end();
const rowBytes = 256 * Math.ceil((second.width * 4) / 256);
const readback = device.createBuffer({ size: rowBytes * second.height, usage: 0x01 | 0x08 });
encoder.copyTextureToBuffer(
  { texture: second },
  { buffer: readback, bytesPerRow: rowBytes },
  { width: second.width, height: second.height },
);
device.queue.submit([encoder.finish()]);
host.present();
await readback.mapAsync(0x01);
const pixel = Array.from(new Uint8Array(readback.getMappedRange(), 0, 4));
readback.unmap();
check(
  'a frame drawn into the canvas reads back as drawn',
  pixel[0] === 51 && pixel[1] === 102 && pixel[2] === 204 && pixel[3] === 255,
  pixel.join(','),
);

/* A rejection during a frame, delivered to the listener the engine's surface registered. */
const said: string[] = [];
const error = console.error;
console.error = (...parts: unknown[]) => {
  said.push(parts.map(String).join(' '));
};
const frame = errorsOf(device);
frame?.open();
device.createTexture({
  label: 'deliberately empty',
  size: [0, 0],
  format: 'rgba8unorm',
  usage: 0x10,
});
frame?.close();
await device.queue.onSubmittedWorkDone();
await new Promise((resolve) => setTimeout(resolve, 50));
console.error = error;
const heard = said.find((line) => line.includes('the GPU rejected something'));
check(
  'a rejection during a frame reaches the engine’s own message',
  frame !== null && heard !== undefined && heard.includes('deliberately empty'),
  heard === undefined ? 'nothing said' : (heard.split('\n')[1] ?? heard),
);

/*
 * An image copied through alpha as Chrome copies it, which is on the device (see `alphaCopy.ts`).
 * The pairs are ones where a correctly rounded division would say otherwise, and the expected bytes
 * are Chrome's on this machine, measured 2026-09-19: dividing 1, 5 and 57 by alphas 6, 6 and 128
 * gives 42, 212 and 113, where rounding gives 43, 213 and 114 — and into an sRGB texture the last
 * is 114, because the write's own encode lands on a decoded value. Multiplying 206 by 13 gives 10,
 * where Skia's integer rounding gives 11, and 11 again into sRGB.
 */
async function copiedRed(
  pixels: number[],
  premultiplyAlpha: PremultiplyAlpha,
  format: GPUTextureFormat,
  premultipliedAlpha: boolean,
): Promise<number[]> {
  const width = pixels.length / 4;
  const bitmap = await hostCreateImageBitmap(
    { data: new Uint8ClampedArray(pixels), width, height: 1 } as ImageData,
    { premultiplyAlpha },
  );
  const texture = device.createTexture({ size: [width, 1], format, usage: 0x1 | 0x2 | 0x10 });
  device.queue.copyExternalImageToTexture(
    { source: bitmap as unknown as ImageBitmap },
    { texture, premultipliedAlpha },
    [width, 1],
  );
  const buffer = device.createBuffer({ size: 256, usage: 0x01 | 0x08 });
  const reading = device.createCommandEncoder();
  reading.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [width, 1]);
  device.queue.submit([reading.finish()]);
  await buffer.mapAsync(0x01);
  const bytes = new Uint8Array(buffer.getMappedRange().slice(0, width * 4));
  buffer.unmap();
  return Array.from({ length: width }, (_, at) => bytes[at * 4] as number);
}
const divided = [43, 0, 0, 6, 228, 0, 0, 6, 114, 0, 0, 128];
const plainDivided = await copiedRed(divided, 'default', 'rgba8unorm', false);
const srgbDivided = await copiedRed(divided, 'default', 'rgba8unorm-srgb', false);
const plainMultiplied = await copiedRed([206, 0, 0, 13], 'none', 'rgba8unorm', true);
const srgbMultiplied = await copiedRed([206, 0, 0, 13], 'none', 'rgba8unorm-srgb', true);
check(
  'an image copied through alpha gets Chrome’s bytes',
  plainDivided.join() === '42,212,113' &&
    srgbDivided.join() === '42,212,114' &&
    plainMultiplied.join() === '10' &&
    srgbMultiplied.join() === '11',
  `divided ${plainDivided.join()} and ${srgbDivided.join()} in sRGB, multiplied ${plainMultiplied.join()} and ${srgbMultiplied.join()}`,
);

/* Loss, through the engine's path. The host adds no listener of its own. */
let told = false;
surface.onLost(() => {
  told = true;
});
device.destroy();
await device.lost;
check(
  'a lost device reaches the engine through createGpuSurface',
  told && surface.lost,
  `listener ${told ? 'told' : 'not told'}, surface.lost ${String(surface.lost)}`,
);

await host.close();
console.log(failed === 0 ? '\nall checks pass' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);

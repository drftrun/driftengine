/**
 * Running a WGSL compute shader and reading its buffers back.
 *
 * **This is what lets a compute shader have a test.** The repository's discipline for anything
 * written twice — the splat shader, the decode interpreter, the heightfield triangulation — is one
 * authored expression, two consumers, and a test that they have not drifted. Every compute pass in
 * the GPU-driven pipeline is arithmetic written once in TypeScript as the reference and once in
 * WGSL for the device, and until now there was no way to compare them: the TypeScript half had
 * tests and the WGSL half had a generator.
 *
 * **A page rather than a headless device, because WebGPU needs a secure context.** `navigator.gpu`
 * is not exposed on `about:blank` — `browser.mjs`'s own header records that, and records that the
 * first reading of the absence was that the card had no adapter. `http://localhost` is a secure
 * context, so this serves one blank page from a loopback server of its own. No dev server, no
 * build step, nothing to start first.
 *
 * **One browser for many shaders.** Launching Chrome costs a second or two and a parity check runs
 * hundreds of cases, so `openGpuCompute` hands back a handle that keeps the device and the page.
 *
 * Not a `*.test.mjs`: it needs a GPU, and `npm run test:scripts` runs on machines that have none.
 * The checks that use it are run by hand, the way `probe-check.mjs` and `ibl-check.mjs` are.
 */
import { createServer } from 'node:http';

import { launch } from './browser.mjs';
import { connect } from './cdp.mjs';

const PAGE = `<!doctype html><meta charset="utf-8"><title>gpu compute</title><body></body>`;

/** A loopback server serving one blank page, which is all a secure context needs. */
async function servePage() {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(PAGE);
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: `http://localhost:${port}/`,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  };
}

/**
 * The script the page runs, as a string, because it executes in the browser rather than here.
 *
 * Buffers cross as plain number arrays. That costs a copy per call and buys not having to agree
 * about a binary encoding across the CDP boundary — at the sizes a parity check uses, hundreds of
 * spheres rather than millions, the copy is not the cost that matters.
 */
function dispatchScript(request) {
  return `(async () => {
    if (!('gpu' in navigator)) return { error: 'no navigator.gpu' };
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter === null) return { error: 'no adapter' };
    const request = ${JSON.stringify(request)};
    /* Asked for by name and refused by name: a check that quietly ran without its feature did not run. */
    const missing = request.features.filter((feature) => !adapter.features.has(feature));
    if (missing.length > 0) return { error: 'the adapter lacks ' + missing.join(', ') };
    const device = await adapter.requestDevice({ requiredFeatures: request.features });

    const errors = [];
    device.addEventListener('uncapturederror', (event) => errors.push(String(event.error.message)));

    const module = device.createShaderModule({ code: request.wgsl });
    const info = await module.getCompilationInfo();
    const fatal = info.messages.filter((message) => message.type === 'error');
    if (fatal.length > 0) {
      return { error: fatal.map((m) => \`\${m.lineNum}:\${m.linePos} \${m.message}\`).join('\\n') };
    }

    const entries = [];
    const bindings = [];
    const readbacks = [];
    for (let at = 0; at < request.buffers.length; at += 1) {
      const spec = request.buffers[at];
      if (spec.kind === 'texture2dArray') {
        const texture = device.createTexture({
          size: [spec.size, spec.size, spec.layers],
          format: 'rgba8unorm',
          mipLevelCount: spec.levels.length,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        for (let level = 0; level < spec.levels.length; level += 1) {
          const edge = Math.max(1, spec.size >> level);
          device.queue.writeTexture(
            { texture, mipLevel: level },
            new Uint8Array(spec.levels[level]),
            { bytesPerRow: edge * 4, rowsPerImage: edge },
            [edge, edge, spec.layers],
          );
        }
        entries.push({ binding: at, resource: texture.createView({ dimension: '2d-array' }) });
        bindings.push({
          binding: at,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float', viewDimension: '2d-array' },
        });
        continue;
      }
      if (spec.kind === 'texture2d') {
        const texture = device.createTexture({
          size: [spec.width, spec.height, 1],
          format: spec.format,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        const channels = spec.format === 'r32float' ? 1 : 4;
        device.queue.writeTexture(
          { texture },
          new Float32Array(spec.values),
          { bytesPerRow: spec.width * channels * 4, rowsPerImage: spec.height },
          [spec.width, spec.height, 1],
        );
        entries.push({ binding: at, resource: texture.createView() });
        bindings.push({
          binding: at,
          visibility: GPUShaderStage.COMPUTE,
          /* A 32-bit float format is not filterable, so a shader reading one loads its texels. */
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        });
        continue;
      }
      if (spec.kind === 'sampler') {
        const sampler = device.createSampler({
          magFilter: 'linear',
          minFilter: 'linear',
          mipmapFilter: 'linear',
          addressModeU: spec.address,
          addressModeV: spec.address,
        });
        entries.push({ binding: at, resource: sampler });
        bindings.push({ binding: at, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } });
        continue;
      }
      const Ctor =
        spec.type === 'u32' ? Uint32Array
        : spec.type === 'i32' ? Int32Array
        : spec.type === 'f16' ? Uint16Array
        : Float32Array;
      /*
       * An f16 buffer is written as the half-precision bits the caller hands over, and padded to
       * four bytes, which is the least a storage binding may be sized in.
       */
      const count = spec.values.length > 0 ? spec.values.length : spec.length;
      const values = new Ctor(spec.type === 'f16' ? Math.ceil(count / 2) * 2 : count);
      if (spec.values.length > 0) values.set(spec.values);
      /* A uniform binding is sized in whole sixteen-byte rows, and is never read back. */
      const uniform = spec.kind === 'uniform';
      const buffer = device.createBuffer({
        size: uniform
          ? Math.max(16, Math.ceil(values.byteLength / 16) * 16)
          : Math.max(4, values.byteLength),
        usage: uniform
          ? GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
          : GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
      device.queue.writeBuffer(buffer, 0, values);
      entries.push({ binding: at, resource: { buffer } });
      bindings.push({
        binding: at,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: uniform ? 'uniform' : spec.readOnly ? 'read-only-storage' : 'storage' },
      });
      if (spec.read && !uniform) readbacks.push({ at, buffer, size: values.byteLength, type: spec.type });
    }

    const layout = device.createBindGroupLayout({ entries: bindings });
    const pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module, entryPoint: request.entryPoint },
    });
    const group = device.createBindGroup({ layout, entries });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(request.workgroups[0], request.workgroups[1], request.workgroups[2]);
    pass.end();

    const staging = readbacks.map((entry) => {
      const copy = device.createBuffer({
        size: entry.size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      encoder.copyBufferToBuffer(entry.buffer, 0, copy, 0, entry.size);
      return copy;
    });
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();

    const out = {};
    for (let at = 0; at < readbacks.length; at += 1) {
      await staging[at].mapAsync(GPUMapMode.READ);
      const entry = readbacks[at];
      const Ctor = entry.type === 'u32' ? Uint32Array : entry.type === 'i32' ? Int32Array : Float32Array;
      out[entry.at] = Array.from(new Ctor(staging[at].getMappedRange().slice(0)));
      staging[at].unmap();
    }
    return errors.length > 0 ? { error: errors.join('\\n'), buffers: out } : { buffers: out };
  })()`;
}

/**
 * Open a browser with a WebGPU device on it.
 *
 * `run` takes the shader, the buffers it binds at group 0 in order, and the workgroup counts, and
 * hands back whichever buffers were asked to be read. Buffers are declared rather than inferred:
 * a harness that guessed which binding was an output would guess wrong on the first shader that
 * writes into what it reads.
 */
export async function openGpuCompute(options = {}) {
  const page = await servePage();
  const browser = await launch(options.launch ?? {});
  const client = await connect(await browser.port);
  const tab = await client.page(page.url, 320, 240);

  return {
    /**
     * `features` are the device features the shader needs, `'shader-f16'` for a half-precision one;
     * an adapter without one of them is an error rather than a device created without it.
     *
     * Each entry of `buffers` is bound at the binding its index names, as one of four kinds:
     *
     * - `'storage'`, the default — `type`, `values` or `length`, `read`, `readOnly`. An `'f16'`
     *   buffer takes half-precision bits as its values, and is never read back.
     * - `'uniform'` — `{ kind: 'uniform', type: 'u32' | 'f32', values }`, bound as a uniform
     *   buffer padded to whole sixteen-byte rows, and never read back.
     * - `'texture2dArray'` — `{ kind: 'texture2dArray', size, layers, levels }`: an `rgba8unorm`
     *   array of `size`-square layers with `levels.length` mip levels, where `levels[k]` is every
     *   layer's RGBA bytes at level `k`, layer after layer.
     * - `'texture2d'` — `{ kind: 'texture2d', width, height, format, values }`: one mip level of
     *   `'r32float'` or `'rgba32float'`, written from `values` as float32, row after row. **Bound
     *   as `unfilterable-float`**, because no 32-bit float format is filterable without an optional
     *   feature — a shader reading one uses `textureLoad` and does any interpolation itself, which
     *   is what makes a comparison against a reference exact rather than a tolerance on whatever
     *   the device's sampler rounds to.
     * - `'sampler'` — `{ kind: 'sampler', address: 'clamp-to-edge' | 'repeat' }`, linear in
     *   magnification, minification and between levels.
     *
     * @param {{ wgsl: string, entryPoint?: string, workgroups?: number[], features?: string[],
     *           buffers: { kind?: 'storage'|'uniform'|'texture2dArray'|'texture2d'|'sampler',
     *                      type?: 'f32'|'f16'|'u32'|'i32', values?: number[], length?: number,
     *                      read?: boolean, readOnly?: boolean, size?: number, layers?: number,
     *                      levels?: ArrayLike<number>[], address?: string,
     *                      width?: number, height?: number,
     *                      format?: 'r32float'|'rgba32float' }[] }} request
     */
    async run(request) {
      const prepared = {
        wgsl: request.wgsl,
        entryPoint: request.entryPoint ?? 'main',
        features: request.features ?? [],
        workgroups: [
          request.workgroups?.[0] ?? 1,
          request.workgroups?.[1] ?? 1,
          request.workgroups?.[2] ?? 1,
        ],
        buffers: request.buffers.map((buffer) => ({
          kind: buffer.kind ?? 'storage',
          type: buffer.type ?? 'f32',
          values: buffer.values === undefined ? [] : Array.from(buffer.values),
          length: buffer.length ?? 0,
          read: buffer.read === true,
          readOnly: buffer.readOnly === true,
          size: buffer.size ?? 0,
          layers: buffer.layers ?? 0,
          width: buffer.width ?? 0,
          height: buffer.height ?? 0,
          format: buffer.format ?? 'rgba32float',
          levels:
            buffer.levels === undefined ? [] : buffer.levels.map((level) => Array.from(level)),
          address: buffer.address ?? 'clamp-to-edge',
        })),
      };
      const result = await tab.eval(dispatchScript(prepared));
      const parsed = typeof result === 'string' ? JSON.parse(result) : result;
      if (parsed.error !== undefined && parsed.buffers === undefined) {
        throw new Error(`gpu compute: ${parsed.error}`);
      }
      if (parsed.error !== undefined) throw new Error(`gpu compute: ${parsed.error}`);
      return parsed.buffers;
    },

    /**
     * What the page's adapter says it is — vendor, architecture, whether it is a fallback — so a
     * figure a check prints names the device that produced it, and a software adapter is seen.
     */
    async adapter() {
      const result = await tab.eval(`(async () => {
        const adapter = await navigator.gpu?.requestAdapter();
        if (!adapter) return { error: 'no adapter' };
        const info = adapter.info ?? {};
        return {
          vendor: info.vendor ?? '',
          architecture: info.architecture ?? '',
          description: info.description ?? '',
          fallback: adapter.isFallbackAdapter === true || info.isFallbackAdapter === true,
          features: [...adapter.features],
        };
      })()`);
      const parsed = typeof result === 'string' ? JSON.parse(result) : result;
      if (parsed.error !== undefined) throw new Error(`gpu compute: ${parsed.error}`);
      return parsed;
    },

    async close() {
      try {
        await tab.close();
      } catch {
        /* the page may already be gone; the browser close below is what matters */
      }
      await client.close?.();
      await browser.close();
      await page.close();
    },
  };
}

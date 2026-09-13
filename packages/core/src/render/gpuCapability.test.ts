import { expect, test } from 'vitest';

import {
  adapterRendererName,
  describeGpu,
  isWeakGpuFamily,
  webgl2RendererName,
} from './gpuCapability.ts';

test('the Adreno that lost its context is known-weak', () => {
  // NFD6QQ, verbatim from the report.
  expect(isWeakGpuFamily('ANGLE (Qualcomm, Adreno (TM) 619, OpenGL ES 3.2)')).toBe(true);
});

test('the Adreno from JBL3XG is known-weak', () => {
  // 112 ms a frame on the default high preset, ~9 fps.
  expect(isWeakGpuFamily('ANGLE (Qualcomm, Adreno (TM) 710, OpenGL ES 3.2)')).toBe(true);
});

test('Intel integrated graphics are known-weak', () => {
  // Chri's machine: unplayable fullscreen, perfect in a small window.
  expect(isWeakGpuFamily('ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.6)')).toBe(true);
  expect(isWeakGpuFamily('ANGLE (Intel, Intel(R) HD Graphics 520, OpenGL 4.6)')).toBe(true);
});

test('a desktop discrete part is not weak', () => {
  expect(
    isWeakGpuFamily(
      'ANGLE (AMD, AMD Radeon RX 9070 XT (radeonsi gfx1201 LLVM 20.1.2), OpenGL ES 3.2)',
    ),
  ).toBe(false);
  // R77XPL and DZTF9F, both of which held 60 fps once the shader was fixed.
  expect(isWeakGpuFamily('ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0)')).toBe(false);
  expect(isWeakGpuFamily('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0)')).toBe(false);
});

test('an unknown string is not weak, because the guess must fail open', () => {
  /*
   * A device database is wrong about every GPU nobody has tested, so the default is the
   * good profile and the governor is what corrects it. Guessing weak on the unknown would
   * ship a soft picture to every device released after this line was written.
   */
  expect(isWeakGpuFamily('')).toBe(false);
  expect(isWeakGpuFamily('Some Vendor Something 9000')).toBe(false);
});

test('matching is case-insensitive, because vendors are not consistent', () => {
  expect(isWeakGpuFamily('angle (qualcomm, adreno (tm) 619, opengl es 3.2)')).toBe(true);
  expect(isWeakGpuFamily('ADRENO 619')).toBe(true);
});

test('an Adreno flagship is not swept up by the mid-range families', () => {
  /*
   * JBL3XG's 710 is the one 7xx data point and it is mid-range; the 8xx parts hold the
   * budget comfortably. If a second 7xx report lands, move that whole family rather than
   * special-casing a number.
   */
  expect(isWeakGpuFamily('ANGLE (Qualcomm, Adreno (TM) 830, OpenGL ES 3.2)')).toBe(false);
  expect(isWeakGpuFamily('ANGLE (Qualcomm, Adreno (TM) 750, OpenGL ES 3.2)')).toBe(false);
});

test('the mobile families with no report yet are still listed', () => {
  /*
   * No report from either, and listed anyway: the cost of being wrong here is a picture
   * one step softer than it had to be, and the cost of omitting them is another NFD6QQ.
   */
  expect(isWeakGpuFamily('Mali-G52 MC2')).toBe(true);
  expect(isWeakGpuFamily('PowerVR Rogue GE8320')).toBe(true);
});

test('a Mali flagship is not swept up either', () => {
  expect(isWeakGpuFamily('Mali-G715-Immortalis MC11')).toBe(false);
});

/*
 * WebGPU reports an architecture bucket rather than a part number — measured on this machine,
 * `vendor: "amd", architecture: "rdna-4"` and nothing more. So the table has to answer on both
 * shapes, and the bucket costs precision where a family spans strong and weak parts.
 */
test('a bucketed architecture is recognised where the whole family is weak', () => {
  expect(isWeakGpuFamily('qualcomm adreno-6xx')).toBe(true);
  expect(isWeakGpuFamily('qualcomm adreno-5xx')).toBe(true);
  expect(isWeakGpuFamily('arm mali-g5x')).toBe(true);
});

test('adreno-7xx is left alone, because the bucket holds both a 710 and a 740', () => {
  /*
   * The 710 was measured at 112 ms a frame and belongs here; the 740 is a current flagship and
   * does not. WebGPU cannot tell them apart, and softening every flagship to catch one mid-range
   * part is the wrong trade — the governor corrects a wrong guess from measurement instead.
   */
  expect(isWeakGpuFamily('qualcomm adreno-7xx')).toBe(false);
});

test('the WebGL2 spelling still answers, so the two backends agree', () => {
  expect(isWeakGpuFamily('ANGLE (Qualcomm, Adreno (TM) 619, OpenGL ES 3.2)')).toBe(true);
  expect(isWeakGpuFamily('amd rdna-4')).toBe(false);
  expect(isWeakGpuFamily('WebGPU')).toBe(false);
});

/**
 * A fake adapter, and the join that turns one into a string the table can match.
 *
 * These are here rather than in `select.test.ts` because the join moved: two callers build it now
 * — the backend selection and `describeGpu` — and a second spelling of it is the 2026-08-13 rule's
 * first clause, one decision with two implementations.
 */
test('an adapter is named from every field the browser offered', () => {
  expect(adapterRendererName({ vendor: 'amd', architecture: 'rdna-4' } as GPUAdapterInfo)).toBe(
    'amd rdna-4',
  );
  /* Measured on this machine: an RX 9070 XT reports a vendor and an architecture bucket, nothing
     else. A phone that reports only a vendor is still something the table can read. */
  expect(adapterRendererName({ vendor: 'qualcomm' } as GPUAdapterInfo)).toBe('qualcomm');
});

test('an adapter that names nothing still gets a label rather than an empty string', () => {
  /* `WebGPU` is the fallback and `isWeakGpuFamily` must read it as not weak — otherwise every
     browser that withholds adapter fields would clamp every part it runs on. */
  expect(adapterRendererName(undefined)).toBe('WebGPU');
  expect(adapterRendererName({} as GPUAdapterInfo)).toBe('WebGPU');
  expect(isWeakGpuFamily(adapterRendererName(undefined))).toBe(false);
});

test('a WebGL2 context with no debug extension names nothing, which is not weak', () => {
  const gl = { getExtension: () => null } as unknown as WebGL2RenderingContext;
  expect(webgl2RendererName(gl)).toBe('');
  expect(isWeakGpuFamily('')).toBe(false);
});

test('a WebGL2 context with the extension gives the unmasked string', () => {
  const gl = {
    getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 0x9246 }),
    getParameter: () => 'ANGLE (Qualcomm, Adreno (TM) 619, OpenGL ES 3.2)',
  } as unknown as WebGL2RenderingContext;
  expect(isWeakGpuFamily(webgl2RendererName(gl))).toBe(true);
});

/** A canvas that hands back one fake context, and records whether it was released. */
function fakeCanvas(name: string | null): { canvas: HTMLCanvasElement; lost: () => boolean } {
  let lost = false;
  const gl = {
    getExtension: (extension: string) =>
      extension === 'WEBGL_lose_context'
        ? {
            loseContext: () => {
              lost = true;
            },
          }
        : name === null
          ? null
          : { UNMASKED_RENDERER_WEBGL: 0x9246 },
    getParameter: () => name,
  };
  return {
    canvas: { getContext: () => gl } as unknown as HTMLCanvasElement,
    lost: () => lost,
  };
}

const adapterGiving = (info: Partial<GPUAdapterInfo>): GPU =>
  ({ requestAdapter: async () => ({ info }) }) as unknown as GPU;

test('describeGpu prefers the WebGL2 string, which is the one with a model number in it', async () => {
  /*
   * **Measured on this machine and it is why the order is what it is.** Asking WebGPU first gave
   * `amd rdna-4` where WebGL2 gives the full ANGLE string; the same part, and only one spelling
   * carries a model. On a phone the difference decides a verdict rather than a label — see below.
   */
  const { canvas, lost } = fakeCanvas('ANGLE (Qualcomm, Adreno (TM) 619, OpenGL ES 3.2)');
  const gpu = await describeGpu({
    gpu: adapterGiving({ vendor: 'qualcomm', architecture: 'adreno-6xx' }),
    createCanvas: () => canvas,
  });
  expect(gpu.source).toBe('webgl2');
  expect(gpu.rendererName).toContain('Adreno (TM) 619');
  /* The detached context is handed back: a boot that leaks one on every consumer is a cost this
     function has no business adding. */
  expect(lost()).toBe(true);
});

test('and that order is what lets a 710 be recognised at all', async () => {
  /*
   * The whole argument for the ordering, as one case. `GPUAdapterInfo` reports an architecture
   * bucket, so a 710 and a 740 are both `adreno-7xx` and the table refuses to clamp either. The
   * unmasked WebGL2 string names the 710, which the table does clamp — and this is therefore
   * **more accurate than the WebGPU renderer's own `rendererName` would be on the same device**.
   */
  const { canvas } = fakeCanvas('ANGLE (Qualcomm, Adreno (TM) 710, OpenGL ES 3.2)');
  const bucketed = adapterRendererName({
    vendor: 'qualcomm',
    architecture: 'adreno-7xx',
  } as GPUAdapterInfo);
  expect(isWeakGpuFamily(bucketed)).toBe(false);
  const gpu = await describeGpu({
    gpu: adapterGiving({ vendor: 'qualcomm', architecture: 'adreno-7xx' }),
    createCanvas: () => canvas,
  });
  expect(gpu.weak).toBe(true);
});

test('describeGpu asks WebGPU only when WebGL2 will not name the part', async () => {
  const { canvas } = fakeCanvas(null);
  const gpu = await describeGpu({
    gpu: adapterGiving({ vendor: 'qualcomm', architecture: 'adreno-6xx' }),
    createCanvas: () => canvas,
  });
  expect(gpu).toEqual({ rendererName: 'qualcomm adreno-6xx', weak: true, source: 'webgpu' });
});

test('describeGpu answers weak:false for a part the table does not know', async () => {
  /* The rule the whole table is built on: unknown is not weak, because guessing weak ships a soft
     picture to every device released after these lines were written. */
  const { canvas } = fakeCanvas(null);
  const gpu = await describeGpu({
    gpu: adapterGiving({ vendor: 'amd', architecture: 'rdna-4' }),
    createCanvas: () => canvas,
  });
  expect(gpu.weak).toBe(false);
});

test('describeGpu answers unknown when neither API will name the part', async () => {
  const { canvas } = fakeCanvas(null);
  const gpu = await describeGpu({
    gpu: { requestAdapter: async () => null } as unknown as GPU,
    createCanvas: () => canvas,
  });
  expect(gpu.source).toBe('none');
});

test('describeGpu survives an adapter request that throws', async () => {
  const { canvas } = fakeCanvas(null);
  const gpu = await describeGpu({
    gpu: {
      requestAdapter: async () => {
        throw new Error('no');
      },
    } as unknown as GPU,
    createCanvas: () => canvas,
  });
  expect(gpu.source).toBe('none');
});

test('describeGpu never asks for an adapter when a caller declines WebGPU', async () => {
  const { canvas } = fakeCanvas(null);
  let asked = false;
  const gpu = await describeGpu({
    preferWebGpu: false,
    gpu: {
      requestAdapter: async () => {
        asked = true;
        return null;
      },
    } as unknown as GPU,
    createCanvas: () => canvas,
  });
  expect(asked).toBe(false);
  expect(gpu.source).toBe('none');
});

test('describeGpu answers "none" on a machine that will name neither', async () => {
  /* Which `isWeakGpuFamily` reads as not weak, so a caller gets the good profile and the
     resolution governor corrects it from measurement. That is the design, not a gap. */
  const gpu = await describeGpu({ gpu: null, createCanvas: () => null });
  expect(gpu).toEqual({ rendererName: '', weak: false, source: 'none' });
  expect(isWeakGpuFamily(gpu.rendererName)).toBe(false);
});

test('describeGpu answers "none" when the context exists and names nothing', async () => {
  const { canvas } = fakeCanvas(null);
  const gpu = await describeGpu({ gpu: null, createCanvas: () => canvas });
  expect(gpu.source).toBe('none');
});

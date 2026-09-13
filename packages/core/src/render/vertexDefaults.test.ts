import { describe, expect, it, vi } from 'vitest';

import { ABSENT_ATTRIBUTE } from './vertexDefaults.ts';
import { createGpuMesh, VERTEX_LAYOUT } from './backend/webgpu/buffers.ts';

/** A device that records what was written where, so a buffer's contents can be read back. */
function recordingDevice() {
  const writes: { label: string; data: ArrayBufferView }[] = [];
  const device = {
    createBuffer: vi.fn((d: GPUBufferDescriptor) => ({ label: d.label, destroy: vi.fn() })),
    queue: {
      writeBuffer: vi.fn((buffer: { label: string }, _offset: number, data: ArrayBufferView) => {
        writes.push({ label: buffer.label, data });
      }),
    },
    /* Read by `createGpuMesh`, which refuses a mesh past this rather than handing the driver an
       invalid buffer. The default a browser guarantees. */
    limits: { maxBufferSize: 268_435_456 } as unknown as GPUSupportedLimits,
  };
  return { device: device as unknown as GPUDevice, writes };
}

const TRIANGLE = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
  colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
  emissive: new Float32Array([1, 1, 1]),
  indices: new Uint32Array([0, 1, 2]),
};

describe('what an absent vertex attribute reads as', () => {
  /**
   * **The two backends have to agree, and they did not.**
   *
   * WebGL2 disables the attribute and hands the driver a constant; WebGPU has no disabled
   * attribute and reads a one-element buffer at a stride of zero. Both are "the value for a
   * mesh that did not supply this" — one decision, expressed twice, which is precisely the
   * shape `AGENTS.md` says to put in one module.
   *
   * It was not a tidiness problem. `flat.ts` reads `vEmissiveColor.r < 0.0 ? albedo :
   * vEmissiveColor`, so **−1 means "glow in my own colour" and 0 means "glow black"** — and
   * this backend was filling zeroes. Every emissive surface whose mesh omitted the attribute
   * simply stopped emitting, which is a picture rather than an error: `night-street`'s far
   * windows went out and its near ones stayed lit only because they were already clipped.
   */
  it('gives an absent emissiveColor the sentinel the shader tests for, not zero', () => {
    const { device, writes } = recordingDevice();

    createGpuMesh(device, TRIANGLE as never);

    const constants = writes.find((w) => w.label === 'mesh.constants');
    const floats = new Float32Array(constants?.data.buffer as ArrayBuffer);
    const slot = VERTEX_LAYOUT.findIndex((a) => a.name === 'emissiveColor');
    /* Sixteen bytes a slot, so four floats. */
    expect([...floats.slice(slot * 4, slot * 4 + 3)]).toEqual([-1, -1, -1]);
  });

  /* An unstated roughness is the engine's long-standing lobe, not a mirror. */
  it('gives an absent roughness the engine default, not zero', () => {
    const { device, writes } = recordingDevice();

    createGpuMesh(device, TRIANGLE as never);

    const constants = writes.find((w) => w.label === 'mesh.constants');
    const floats = new Float32Array(constants?.data.buffer as ArrayBuffer);
    const slot = VERTEX_LAYOUT.findIndex((a) => a.name === 'roughness');
    expect(floats[slot * 4]).toBeCloseTo(ABSENT_ATTRIBUTE.roughness[0] as number);
    expect(floats[slot * 4]).toBeGreaterThan(0);
  });

  /* Every optional attribute has a stated default; a missing entry is the bug this prevents. */
  it('states a default for every optional attribute', () => {
    for (const attribute of VERTEX_LAYOUT) {
      if (!attribute.optional) continue;
      const stated = ABSENT_ATTRIBUTE[attribute.name as keyof typeof ABSENT_ATTRIBUTE];
      expect(stated, `${attribute.name} has no absent value`).toBeDefined();
      expect(stated?.length).toBe(attribute.components);
    }
  });
});

/**
 * What locations 11 and 12 read when a skinned pipeline draws a mesh with no rig.
 *
 * WebGPU has no disabled attribute, so every location a variant declares must be backed by
 * something — and the skinned variant declares both. A mesh without joints normally takes the
 * unskinned pipeline and never meets these, but the constants buffer is *sized* from this table,
 * so a missing entry would size it short rather than fail.
 */
describe('the skinning attributes', () => {
  it('has an entry of the right width for each', () => {
    expect(ABSENT_ATTRIBUTE['joints']).toEqual([0, 0, 0, 0]);
    expect(ABSENT_ATTRIBUTE['weights']).toEqual([1, 0, 0, 0]);
  });

  /*
   * **The weight default is not zero, and that is the whole of it.** Four zero weights build a
   * zero matrix, and a zero matrix collapses every vertex it touches onto the origin — so a
   * skinned draw of an unrigged mesh would not shade oddly, it would vanish. One and three zeroes
   * is the identity influence: bound entirely to joint 0, which for a mesh with no rig is exactly
   * where it already was. Same reasoning `emissiveColor` records above: an absent attribute's
   * value is a statement, and zero is a real value for most of them.
   */
  it('rests a weight set at the identity influence rather than at zero', () => {
    const weights = ABSENT_ATTRIBUTE['weights'] as readonly number[];
    expect(weights[0]).toBe(1);
    expect(weights.reduce((sum, w) => sum + w, 0)).toBe(1);
  });
});

/*
 * **Two of these four are ones, and that is the entry doing the work.** Zero for `skyDirect` would
 * take the directional light off every mesh in the engine that has never heard of this attribute,
 * and zero for `alpha` would make all of them invisible. This is what stops a new per-vertex
 * channel from being a visible change, so it is pinned rather than reviewed.
 */
it('reads a mesh with no channel as planted, fully sunlit, opaque and one thickness deep', () => {
  expect(ABSENT_ATTRIBUTE['channel']).toEqual([0, 1, 1, 1]);
});

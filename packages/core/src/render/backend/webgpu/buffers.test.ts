import { describe, expect, it, vi } from 'vitest';

import type { MeshData } from '../../mesh.ts';
import { UPLOAD_BYTES_PER_STEP } from '../../uploadStep.ts';
import { vertexPackingOf } from '../../vertexPacking.ts';
import {
  VERTEX_LAYOUT,
  createGpuMesh,
  createGpuMeshIncremental,
  vertexBufferLayouts,
} from './buffers.ts';
import { markPacking } from './vertexFormats.ts';

/**
 * A device that remembers what was written to it.
 *
 * The bytes matter here and not only the calls: an upload that lands over several frames writes
 * the same buffer in ranges, and the defect it can have — a slice written before it was filled,
 * or a slice never written at all — is invisible to an assertion that counts `writeBuffer`
 * calls. So this applies each write into a `Uint8Array` per buffer, and a test can compare the
 * device's memory against what the one-shot path put there.
 */
function fakeDevice(maxBufferSize = 268_435_456) {
  const created: { label: string; size: number; usage: number }[] = [];
  const memory = new Map<object, Uint8Array>();
  return {
    created,
    memory,
    device: {
      createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
        created.push({
          label: descriptor.label ?? '',
          size: descriptor.size,
          usage: descriptor.usage,
        });
        const buffer = { destroy: vi.fn(), label: descriptor.label };
        memory.set(buffer, new Uint8Array(descriptor.size));
        return buffer;
      }),
      queue: {
        writeBuffer: vi.fn(
          (
            buffer: object,
            offset: number,
            data: ArrayBufferView,
            dataOffset = 0,
            size?: number,
          ) => {
            const bytes = memory.get(buffer);
            if (bytes === undefined) return;
            const width = (data as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
            const length = size ?? data.byteLength / width - dataOffset;
            bytes.set(
              new Uint8Array(data.buffer, data.byteOffset + dataOffset * width, length * width),
              offset,
            );
          },
        ),
        /* A copy recorded on an encoder lands at submit, in queue order with the writes. */
        submit: vi.fn((commands: { copies: [object, number, object, number, number][] }[]) => {
          for (const command of commands) {
            for (const [from, fromAt, to, toAt, size] of command.copies) {
              const source = memory.get(from);
              const target = memory.get(to);
              if (source === undefined || target === undefined) continue;
              target.set(source.subarray(fromAt, fromAt + size), toAt);
            }
          }
        }),
      },
      createCommandEncoder: vi.fn(() => {
        const copies: [object, number, object, number, number][] = [];
        return {
          copyBufferToBuffer: (
            from: object,
            fromAt: number,
            to: object,
            toAt: number,
            size: number,
          ) => copies.push([from, fromAt, to, toAt, size]),
          finish: () => ({ copies }),
        };
      }),
      /*
       * A fake device carries the limits a real one does, because the code under test reads
       * them: a mesh past `maxBufferSize` is refused with a sentence rather than left to the
       * driver, and a fake with no limits at all made that read throw. The default a browser
       * guarantees, so the refusal is exercised at the size a real device would refuse.
       */
      limits: { maxBufferSize } as unknown as GPUSupportedLimits,
    } as unknown as GPUDevice,
  };
}

/** The smallest mesh the validator will accept: one triangle, required arrays only. */
function triangle(): MeshData {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
    emissive: new Float32Array([0, 0, 0]),
    indices: new Uint32Array([0, 1, 2]),
  };
}

describe('a gpu mesh', () => {
  /*
   * **Two vertex buffers, never ten.** `maxVertexBuffers` is eight, and one buffer per
   * attribute overruns it the moment the tenth attribute exists:
   *
   *     Vertex buffer count (10) exceeds the maximum number of vertex buffers (8)
   *
   * So the supplied attributes interleave into one buffer and the absent ones read zeroes
   * out of a second with a stride of zero. It is also the better layout: a vertex's data is
   * contiguous rather than scattered across ten allocations.
   */
  it('uses two vertex buffers however many attributes there are', () => {
    const { device } = fakeDevice();
    const mesh = createGpuMesh(device, triangle());

    expect(mesh.vertexBuffers.length).toBe(2);
    expect(mesh.indexCount).toBe(3);
  });

  it('interleaves the supplied attributes into one buffer', () => {
    const { device, created } = fakeDevice();

    createGpuMesh(device, triangle());

    /* Three floats of position and a normal in four sixteen-bit lanes, twenty bytes a vertex; its
       colour and emissive are one value for every vertex, so constants. See `vertexPacking.ts`. */
    expect(created.find((b) => b.label === 'mesh.vertices')?.size).toBe(20 * 3);
  });

  /*
   * **WebGPU has no disabled attribute reading a constant**, which is how WebGL2 lets a mesh
   * omit `specular` and `uvs` and upload nothing for them. `arrayStride: 0` is the
   * equivalent: every vertex reads the same element, so the constants buffer is a fixed 176
   * bytes whatever the mesh's size. A zero-filled per-vertex array would instead cost six
   * more floats a vertex on geometry that asked for none of them.
   */
  it('backs absent attributes with a constant buffer that does not scale with the mesh', () => {
    const { device, created } = fakeDevice();

    createGpuMesh(device, triangle());

    const constants = created.find((b) => b.label === 'mesh.constants');
    /* One 16-byte slot per attribute in `VERTEX_LAYOUT`: 16 x 16 = 256, up from 14 x 16 = 224
       when the second four influences took locations 14 and 15, and from 13 x 16 = 208 when the
       per-vertex channel took 13. Hand-derived, not read back from the run. It is the attribute
       count this scales with and never the vertex count, which is the claim in the name of this
       test. */
    expect(constants?.size).toBe(256);
  });

  it('grows the interleaved buffer when an optional attribute is really supplied', () => {
    const { device, created } = fakeDevice();

    createGpuMesh(device, { ...triangle(), uvs: new Float32Array([0, 0, 1, 0, 0, 1]) });

    /* Two more floats a vertex for the uv, which stays a float even inside [0, 1]. */
    expect(created.find((b) => b.label === 'mesh.vertices')?.size).toBe(28 * 3);
  });

  it('lays out one interleaved buffer and one constants buffer', () => {
    const layouts = vertexBufferLayouts({ specular: false, uvs: true });

    expect(layouts.length).toBe(2);
    expect(layouts[0]?.arrayStride).toBeGreaterThan(0);
    /* Stride zero is what makes every vertex read the same constant. */
    expect(layouts[1]?.arrayStride).toBe(0);
    const located = [...(layouts[0]?.attributes ?? [])].map((a) => a.shaderLocation);
    expect(located).toContain(5);
    expect(located).not.toContain(4);
  });

  /*
   * The interleave, byte for byte, against a vertex written out by hand. Every other test here
   * compares one path of the upload against the other, and both walk the same loop, so a mistake in
   * the loop is a mistake they agree on.
   *
   * **Each field at the width it travels at** (`vertexPacking.ts`): a normal and a tangent in
   * sixteen-bit signed lanes, 1 as 32767; coordinates past [0, 1] as floats; an emissive that
   * differs between vertices as a float; and a colour every vertex shares not in the rows at all
   * but in the constants, at its own slot.
   */
  it('A VERTEX IS ITS ATTRIBUTES IN LAYOUT ORDER, each at the width the shader reads', () => {
    const { device, memory } = fakeDevice();
    const data: MeshData = {
      ...triangle(),
      positions: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
      colors: new Float32Array([1, 0.5, 0.25, 1, 0.5, 0.25, 1, 0.5, 0.25]),
      emissive: new Float32Array([0.5, 0.25, 0.125]),
      uvs: new Float32Array([10, 11, 12, 13, 14, 15]),
      tangents: new Float32Array([1, 0, 0, -1, 0, 1, 0, 1, 0, 0, 1, -1]),
    };
    const mesh = createGpuMesh(device, data);
    const bytes = memory.get(mesh.vertexBuffers[0] as object) as Uint8Array;
    /* position 12, normal 8, emissive 4, uv 8, tangent 8: forty bytes a vertex. */
    expect(bytes.byteLength).toBe(40 * 3);
    const vertex = (at: number) => {
      const view = new DataView(bytes.buffer, at * 40, 40);
      const f = (byte: number) => view.getFloat32(byte, true);
      const h = (byte: number) => view.getInt16(byte, true);
      return [
        [f(0), f(4), f(8)],
        [h(12), h(14), h(16), h(18)],
        f(20),
        [f(24), f(28)],
        [h(32), h(34), h(36), h(38)],
      ];
    };
    expect(vertex(1)).toEqual([[4, 5, 6], [0, 0, 32767, 0], 0.25, [12, 13], [0, 32767, 0, 32767]]);
    expect(vertex(2)).toEqual([
      [7, 8, 9],
      [0, 0, 32767, 0],
      0.125,
      [14, 15],
      [0, 0, 32767, -32767],
    ]);
    /* The colour, in its slot of the constants: the third of sixteen bytes each. */
    const constants = memory.get(mesh.vertexBuffers[1] as object) as Uint8Array;
    expect([...new Float32Array(constants.buffer, 2 * 16, 3)]).toEqual([1, 0.5, 0.25]);
  });

  /*
   * **The layout reads every field where the rows put it, at the format they were written in.** A
   * pipeline describes a mesh from `present` alone, so the packing travels there too: one field
   * read as sixteen bits where it was written as thirty-two moves every field after it.
   */
  it('DESCRIBES A PACKED MESH AS IT WAS WRITTEN, each field at its format and offset', () => {
    const data: MeshData = {
      ...triangle(),
      colors: new Float32Array([1, 0.5, 0.25, 0, 0, 0, 1, 1, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
      tangents: new Float32Array([1, 0, 0, -1, 0, 1, 0, 1, 0, 0, 1, -1]),
    };
    const present: Record<string, boolean> = { uvs: true, tangents: true };
    markPacking(present, vertexPackingOf(data, false));
    const layouts = vertexBufferLayouts(present);
    const fields = [...(layouts[0]?.attributes ?? [])].map((a) => [
      a.shaderLocation,
      a.offset,
      a.format,
    ]);
    /* Emissive is one value for every vertex here, so it reads from the constants. */
    expect(fields).toEqual([
      [0, 0, 'float32x3'],
      [1, 12, 'snorm16x4'],
      [2, 20, 'unorm16x4'],
      [5, 28, 'float32x2'],
      [10, 36, 'snorm16x4'],
    ]);
    expect(layouts[0]?.arrayStride).toBe(44);
    expect(layouts[1]?.attributes.map((a) => a.shaderLocation)).toContain(3);
    const { device, created } = fakeDevice();
    createGpuMesh(device, data);
    expect(created.find((b) => b.label === 'mesh.vertices')?.size).toBe(44 * 3);
  });

  /*
   * A texture-array layer rides as the third texture coordinate, so a layered mesh's UV field is
   * three floats wide and every field after it moves along by one — the case where a layout that
   * disagreed with the upload would read every later attribute from the wrong offset.
   */
  it('A LAYERED MESH CARRIES (u, v, layer) IN ONE FIELD, and the layout and the rows agree on it', () => {
    const { device, memory } = fakeDevice();
    const data: MeshData = {
      ...triangle(),
      positions: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
      emissive: new Float32Array([0.5, 0.25, 0.125]),
      uvs: new Float32Array([10, 11, 12, 13, 14, 15]),
      layers: new Float32Array([0, 6, 9]),
      tangents: new Float32Array([1, 0, 0, -1, 0, 1, 0, 1, 0, 0, 1, -1]),
    };
    const mesh = createGpuMesh(device, data);
    const bytes = memory.get(mesh.vertexBuffers[0] as object) as Uint8Array;
    /* Position 12, normal 8, emissive 4, (u, v, layer) as three floats 12, tangent 8: 44 bytes. The
       colour is one for every vertex and a constant; see `vertexPacking.ts`. */
    const second = new DataView(bytes.buffer, 44, 44);
    expect([20, 24, 28, 32].map((at) => second.getFloat32(at, true))).toEqual([0.25, 12, 13, 6]);
    /* The second vertex's tangent is (0, 1, 0, 1): its y, two bytes into the field at 36. */
    expect(second.getInt16(38, true), 'and the tangent after it, moved along').toBe(32767);

    const layered = vertexBufferLayouts({ uvs: true, tangents: true, layers: true });
    const plain = vertexBufferLayouts({ uvs: true, tangents: true });
    const uv = (layouts: GPUVertexBufferLayout[]) =>
      [...(layouts[0]?.attributes ?? [])].find((a) => a.shaderLocation === 5);
    expect(uv(layered)?.format).toBe('float32x3');
    expect(uv(plain)?.format, 'a mesh without layers keeps two floats').toBe('float32x2');
    expect(layered[0]?.arrayStride).toBe(17 * 4);
    expect(Number(plain[0]?.arrayStride) + 4).toBe(layered[0]?.arrayStride);
    const tangent = (layouts: GPUVertexBufferLayout[]) =>
      [...(layouts[0]?.attributes ?? [])].find((a) => a.shaderLocation === 10)?.offset;
    expect(tangent(layered), 'the tangent after the widened field moves by four bytes').toBe(
      13 * 4,
    );
  });

  /*
   * **The other backend refused a short attribute and this one drew zeroes for its tail.** WebGL2's
   * mesh has run `validateMeshData` since the validator existed; this path never called it, so a
   * uv array one vertex short was an error on one backend and a stretched texture on the other.
   */
  it('REFUSES A SHORT ATTRIBUTE, as the other backend does', () => {
    const { device } = fakeDevice();
    const short = { ...triangle(), uvs: new Float32Array([0, 0, 1, 0]) };
    expect(() => createGpuMesh(device, short)).toThrow(/uvs has 4 floats for 3 vertices/);
    expect(() => createGpuMeshIncremental(device, short)).toThrow(/uvs has 4 floats/);
  });

  it('uploads a real buffer when the optional attribute is supplied', () => {
    const { device } = fakeDevice();
    const data = { ...triangle(), uvs: new Float32Array([0, 0, 1, 0, 0, 1]) };

    const mesh = createGpuMesh(device, data);

    expect(mesh.indexCount).toBe(3);
    expect(device.queue.writeBuffer).toHaveBeenCalled();
  });

  /*
   * The motion pass skins through a shader of its own, so it has to find the joints and weights in
   * the interleaved vertex without the generated pipelines' `present` map. Positions are twelve
   * bytes and the normal eight, sixteen-bit lanes; this triangle's colour and emissive are one
   * value each and sit in the constants. So the joint indices follow at twenty, four floats wide,
   * and the weights at thirty-six, in four sixteen-bit lanes, which the motion pass has to read.
   */
  it('SAYS WHERE A SKINNED MESH KEEPS ITS JOINTS AND WEIGHTS, and a rigid one says nothing', () => {
    const { device } = fakeDevice();
    const rigged = createGpuMesh(device, {
      ...triangle(),
      joints: new Float32Array(12),
      weights: new Float32Array(12),
    });
    /* No second set on this rig, so its offsets say so with -1. */
    expect(rigged.skinOffsets).toEqual({
      joints: 20,
      weights: 36,
      joints2: -1,
      weights2: -1,
      weightsFormat: 'unorm16x4',
      weights2Format: 'float32x4',
    });
    expect(createGpuMesh(device, triangle()).skinOffsets).toBeNull();
  });

  /*
   * A reconstruction needs where a rewritten mesh's vertices were last frame. The rewrite is staged:
   * the new positions are written into a buffer of the mesh's own, and two copies are recorded into
   * the encoder the renderer hands over — the live positions aside first, then the staged ones in —
   * which goes out at the head of the frame's next submit. So nothing is submitted by the rewrite,
   * the live positions are untouched until then, and after it the previous buffer holds the old
   * positions and the mesh the new ones.
   */
  it('A DYNAMIC MESH STAGES A REWRITE: ITS OLD POSITIONS ASIDE AND THE NEW ONES IN, AT THE SUBMIT', () => {
    const { device, memory } = fakeDevice();
    const mesh = createGpuMesh(device, triangle(), true);
    expect(mesh.motion).toEqual({ previous: null, staging: null, changed: -1 });
    expect(createGpuMesh(device, triangle()).motion).toBeNull();

    const previous = device.createBuffer({ size: 36, usage: 0 });
    const staging = device.createBuffer({ size: 36, usage: 0 });
    const encoder = device.createCommandEncoder();
    mesh.update?.(device, new Float32Array([10, 0, 0, 11, 0, 0, 10, 1, 0]), undefined, {
      encoder,
      staging,
      previous,
    });
    const floats = (buffer: object): Float32Array =>
      new Float32Array((memory.get(buffer) as Uint8Array).buffer);
    const live = mesh.vertexBuffers[0] as object;
    /* The first vertex's x, then the second's: three floats a vertex in a buffer of positions. */
    expect(device.queue.submit, 'the rewrite submits nothing of its own').not.toHaveBeenCalled();
    expect([floats(live)[0], floats(live)[3]], 'and the live positions wait for it').toEqual([
      0, 1,
    ]);

    device.queue.submit([encoder.finish()]);
    expect([floats(previous)[0], floats(previous)[3]]).toEqual([0, 1]);
    expect([floats(live)[0], floats(live)[3]]).toEqual([10, 11]);
  });

  it('destroys every buffer it made', () => {
    const { device } = fakeDevice();
    const mesh = createGpuMesh(device, triangle());
    const buffers = (device.createBuffer as ReturnType<typeof vi.fn>).mock.results.map(
      (r) => r.value as { destroy: ReturnType<typeof vi.fn> },
    );

    mesh.dispose();

    for (const buffer of buffers) expect(buffer.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('the vertex layout', () => {
  /*
   * The locations are the ones the GLSL declared and the generator carried into WGSL, so
   * they are not free to be renumbered here: a mismatch binds normals to the colour slot and
   * produces a picture that looks lit but is wrong, which is the worst kind of wrong.
   *
   * All thirteen, not the six a simple mesh fills. WebGPU validates the vertex state against the
   * whole shader module and refuses the pipeline with "attribute slot 9 is not present in
   * the VertexState", which is how the four late-added attributes were found missing.
   *
   * Fourteen is also the budget: WebGL2 guarantees sixteen vertex attributes and promises nothing
   * above, so two are left. A fifteenth is a decision rather than an addition.
   */
  it('matches the attribute locations the shaders were compiled with', () => {
    expect(VERTEX_LAYOUT.map((entry) => entry.shaderLocation)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
  });

  it('describes each attribute with the width the shader reads', () => {
    expect(VERTEX_LAYOUT.map((entry) => entry.format)).toEqual([
      'float32x3',
      'float32x3',
      'float32x3',
      'float32',
      'float32',
      'float32x2',
      'float32x3',
      'float32',
      'float32',
      'float32',
      /* The tangent frame, then the two skinning attributes: four wide each. */
      'float32x4',
      'float32x4',
      'float32x4',
      /* The four-lane per-vertex channel. */
      'float32x4',
      /* The second four influences, joints then weights. */
      'float32x4',
      'float32x4',
    ]);
  });

  /*
   * **Fourteen attributes against WebGL2's guaranteed sixteen, and this is the one that closed a
   * door.** An instanced pipeline takes 11 through 15, so a mesh carrying the channel cannot be
   * drawn instanced at all — `flatVert` throws on the pair rather than dropping the attribute.
   * This asserts the arithmetic that forces the refusal, so a fifteenth attribute has to argue
   * with a number instead of with a comment.
   */
  it('spends the channel at 13, which is what makes it exclusive with instancing', () => {
    const channel = VERTEX_LAYOUT.find((a) => a.name === 'channel');
    expect(channel).toMatchObject({ shaderLocation: 13, format: 'float32x4', optional: true });
  });

  /*
   * **Sixteen locations, every one WebGL2 guarantees, and the last two are the second four
   * influences.** A skinned draw can spend them because an instanced one, which takes 11 to 15,
   * cannot skin; there is no seventeenth to add after these.
   */
  it('SPENDS THE LAST TWO LOCATIONS ON THE SECOND FOUR INFLUENCES, and has none left', () => {
    expect(VERTEX_LAYOUT.find((a) => a.name === 'joints2')).toMatchObject({ shaderLocation: 14 });
    expect(VERTEX_LAYOUT.find((a) => a.name === 'weights2')).toMatchObject({ shaderLocation: 15 });
    expect(Math.max(...VERTEX_LAYOUT.map((a) => a.shaderLocation)) + 1).toBe(16);
  });
});

/*
 * The refusal, in words, before the driver gets a chance to say it a hundred times.
 *
 * An oversized buffer is not created — an invalid one comes back, and every encoder that binds
 * it is invalidated with it, so what a consumer sees is a wall of "invalid due to a previous
 * error" and a missing model rather than the one number that explains it.
 */
it('refuses a mesh whose vertices exceed the device buffer limit, naming both sizes', () => {
  /* The device's ceiling rather than the mesh is what is made small here: the branch is the
     same one a 298 MB model met on a 256 MiB default, and reproducing it at those sizes would
     allocate two thirds of a gigabyte to assert one comparison. */
  const { device } = fakeDevice(32);
  expect(() => createGpuMesh(device, triangle())).toThrow(/vertex buffer and this GPU allows/);
});

/*
 * The layout mirrors `mesh.ts` exactly, locations included, because both backends draw from
 * shaders generated out of the same GLSL. A renumbering on one side would draw a picture rather
 * than fail, which is why this is asserted rather than reviewed.
 */
describe('the skinning attributes', () => {
  it('sits at 11 and 12, behind the tangent', () => {
    const joints = VERTEX_LAYOUT.find((a) => a.name === 'joints');
    const weights = VERTEX_LAYOUT.find((a) => a.name === 'weights');
    expect(joints).toMatchObject({ shaderLocation: 11, format: 'float32x4', optional: true });
    expect(weights).toMatchObject({ shaderLocation: 12, format: 'float32x4', optional: true });
  });

  /*
   * Thirteen attributes against WebGL2's guaranteed sixteen. The guarantee is what has to be
   * survivable — a desktop reports more and nobody notices — so this is the same arithmetic
   * `textureUnitBudget.test.ts` does for samplers, one stage over.
   */
  it('leaves the vertex attribute budget inside what WebGL2 guarantees', () => {
    const highest = Math.max(...VERTEX_LAYOUT.map((a) => a.shaderLocation));
    expect(highest + 1).toBeLessThanOrEqual(16);
  });
});

describe('a mesh whose geometry moves', () => {
  /*
   * **Its positions and normals live in buffers of their own, so a rewrite sends them and nothing
   * else.** Every other attribute is interleaved into one buffer, and a rewrite of positions used to
   * patch a CPU copy of that buffer and upload it whole: a dynamic cloth mesh re-sent every colour,
   * coordinate, tangent and joint of every vertex each frame for the twenty-four bytes a vertex that
   * moved — reported at 2.8 MB a frame for one character's garments. Now the caller's arrays go up
   * as they are, and no copy of the vertex data is kept to patch.
   */
  it('has no update unless it declared itself deforming', () => {
    const { device } = fakeDevice();
    expect(createGpuMesh(device, triangle()).update).toBeNull();
    expect(createGpuMesh(device, triangle(), true).update).not.toBeNull();
  });

  it('A REWRITE OF ITS POSITIONS WRITES THEM, AND ONLY THEM, TO A BUFFER OF THEIR OWN', () => {
    const { device, memory } = fakeDevice();
    const mesh = createGpuMesh(device, triangle(), true);
    const writes = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const before = writes.mock.calls.length;
    const positions = new Float32Array([2, 7, 4, 1, 7, 0, 0, 8, 0]);

    mesh.update?.(device, positions);

    expect(writes.mock.calls.length - before, 'one write, of the positions').toBe(1);
    expect(writes.mock.calls[writes.mock.calls.length - 1]?.[0]).toBe(mesh.vertexBuffers[0]);
    const now = new Float32Array(
      (memory.get(mesh.vertexBuffers[0] as object) as Uint8Array).buffer,
    );
    expect(Array.from(now)).toEqual(Array.from(positions));
  });

  it('writes normals to a buffer of their own when the caller has them', () => {
    const { device, memory } = fakeDevice();
    const mesh = createGpuMesh(device, triangle(), true);
    const writes = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const before = writes.mock.calls.length;
    const normals = new Float32Array([0, 1, 0, 0.6, 0.8, 0, 0, 0, 1]);

    mesh.update?.(device, new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals);

    expect(writes.mock.calls.length - before, 'positions and normals, two writes').toBe(2);
    const now = new Float32Array(
      (memory.get(mesh.vertexBuffers[1] as object) as Uint8Array).buffer,
    );
    expect(Array.from(now)).toEqual(Array.from(normals));
  });

  /*
   * The pipeline reads what the mesh binds: positions at location 0 and normals at 1 in buffers of
   * their own, ahead of the interleaved rest — colour and emissive for this triangle, sixteen bytes
   * — and the constants; an instanced draw's buffer after all four. A static mesh keeps today's two.
   */
  it('lays its two streams out ahead of the rest, and the pipeline layout agrees', () => {
    const { device } = fakeDevice();
    const mesh = createGpuMesh(device, triangle(), true);
    const layouts = vertexBufferLayouts({ dynamic: true });
    expect(layouts).toHaveLength(mesh.vertexBuffers.length);
    expect(layouts[0]).toEqual({
      arrayStride: 12,
      attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
    });
    expect(layouts[1]).toEqual({
      arrayStride: 12,
      attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }],
    });
    expect(layouts[2]?.arrayStride).toBe(16);
    expect(layouts[2]?.attributes.map((a) => a.shaderLocation)).toEqual([2, 3]);
    expect(mesh.vertexStride, 'the stride of buffer 0, which the motion pass steps by').toBe(12);
    expect(vertexBufferLayouts({ dynamic: true }, true)).toHaveLength(5);
    expect(vertexBufferLayouts({})).toHaveLength(
      createGpuMesh(device, triangle()).vertexBuffers.length,
    );
  });

  it('moves the bounds with the geometry', () => {
    const { device } = fakeDevice();
    const mesh = createGpuMesh(device, triangle(), true);
    expect(mesh.bounds.max[1]).toBeCloseTo(1, 6);

    mesh.update?.(device, new Float32Array([0, 20, 0, 1, 20, 0, 0, 21, 0]));
    expect(mesh.bounds.min[1]).toBeCloseTo(20, 6);
    expect(mesh.bounds.max[1]).toBeCloseTo(21, 6);
  });

  it('refuses a rewrite of the wrong size, naming both', () => {
    const { device } = fakeDevice();
    const mesh = createGpuMesh(device, triangle(), true);
    expect(() => mesh.update?.(device, new Float32Array(6))).toThrow(
      /3 vertices and the update has 2/,
    );
  });
});

/** A mesh big enough that its upload cannot fit one step. `count` must be a multiple of three. */
function slab(count: number): MeshData {
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const emissive = new Float32Array(count);
  const indices = new Uint32Array(count);
  for (let vertex = 0; vertex < count; vertex++) {
    positions[vertex * 3] = vertex * 0.5;
    positions[vertex * 3 + 1] = (vertex % 7) - 3;
    positions[vertex * 3 + 2] = -vertex * 0.25;
    normals[vertex * 3 + 2] = 1;
    colors[vertex * 3] = (vertex % 11) / 11;
    colors[vertex * 3 + 1] = (vertex % 5) / 5;
    colors[vertex * 3 + 2] = (vertex % 3) / 3;
    emissive[vertex] = (vertex % 2) * 0.5;
    indices[vertex] = vertex;
  }
  return { positions, normals, colors, emissive, indices };
}

/** Drive an upload to the end, counting the calls it took. */
function drive(upload: Iterator<void, void>): number {
  let calls = 0;
  for (;;) {
    calls += 1;
    if (upload.next().done === true) return calls;
    if (calls > 10_000) throw new Error('an upload that never finishes');
  }
}

describe('a gpu mesh uploaded a step at a time', () => {
  /*
   * **The counting assertion, and it needs no clock and no device.**
   *
   * A consumer measured `createMesh` as the whole of every frame over 50 ms while driving into a
   * town: the geometry of one 500 m square landed in whichever frame its build happened to
   * finish, outside every budget the game had. One material group of that square was 248,928 of
   * its 367,542 triangles, so spreading the square across its two dozen groups would still have
   * left that group as one indivisible stop. This is what makes the group itself divisible.
   *
   * The number is derived from the same constant the implementation uses, not written out, so
   * the assertion is that the work is *spread* rather than that it is spread by any one amount.
   */
  it('takes one step per chunk of geometry, and there are several', () => {
    const { device } = fakeDevice();
    const data = slab(21_000);

    const { mesh, upload } = createGpuMeshIncremental(device, data);

    /* Position 12, a normal and a colour in sixteen-bit lanes 8 each, emissive 4: 32 bytes. */
    const vertexBytes = 21_000 * 32;
    const expected =
      Math.ceil(vertexBytes / UPLOAD_BYTES_PER_STEP) +
      Math.ceil(data.indices.byteLength / UPLOAD_BYTES_PER_STEP);

    expect(expected).toBeGreaterThan(1);
    expect(drive(upload)).toBe(expected);
    expect(mesh.indexCount).toBe(21_000);
  });

  /*
   * **The bytes, not the calls.** An upload spread over frames can write a slice before it was
   * interleaved, or skip one, and both leave the call count right and the geometry wrong. So the
   * two paths are compared where it counts: in the device's memory.
   */
  it('leaves the device holding exactly what a one-shot upload would', () => {
    const data = slab(21_000);

    const once = fakeDevice();
    const whole = createGpuMesh(once.device, data);

    const spread = fakeDevice();
    const { mesh, upload } = createGpuMeshIncremental(spread.device, data);
    drive(upload);

    const bytesOf = (fake: ReturnType<typeof fakeDevice>, buffer: object): Uint8Array => {
      const found = fake.memory.get(buffer);
      if (found === undefined) throw new Error('a buffer this device never made');
      return found;
    };
    /* Scanned rather than handed to `toEqual`, which takes two and a half seconds over 840 kB of
       `Uint8Array` building a diff nobody reads unless it fails. So the diff is built only then. */
    const same = (a: Uint8Array, b: Uint8Array): void => {
      expect(a.length).toBe(b.length);
      let differ = false;
      for (let at = 0; !differ && at < a.length; at++) differ = a[at] !== b[at];
      if (differ) expect(a).toEqual(b);
    };

    same(
      bytesOf(spread, mesh.vertexBuffers[0] as object),
      bytesOf(once, whole.vertexBuffers[0] as object),
    );
    same(
      bytesOf(spread, mesh.vertexBuffers[1] as object),
      bytesOf(once, whole.vertexBuffers[1] as object),
    );
    same(bytesOf(spread, mesh.indexBuffer as object), bytesOf(once, whole.indexBuffer as object));
  });

  /*
   * **Nothing may be drawn before it is whole.** The alternative — draw what has landed — is a
   * mesh with a growing number of triangles, which is worse than a square that is briefly not
   * there. `submitMesh` reads this, so a consumer that forgets to drive the iterator gets a mesh
   * that never appears rather than a fan of triangles through the origin.
   */
  it('is not complete until its last step has run', () => {
    const { device } = fakeDevice();
    const { mesh, upload } = createGpuMeshIncremental(device, slab(21_000));

    expect(mesh.complete).toBe(false);
    upload.next();
    expect(mesh.complete).toBe(false);

    drive(upload);
    expect(mesh.complete).toBe(true);
  });

  /*
   * A mesh small enough to fit one chunk takes one step per buffer, which is two: the vertices
   * and the indices are written separately and a step never spans both. Merging them for the
   * small case would be arithmetic in exchange for nothing — the pump stops when the clock says
   * so, and a stop that costs nothing costs nothing.
   */
  it('finishes a small mesh in one step per buffer', () => {
    const { device } = fakeDevice();
    const { mesh, upload } = createGpuMeshIncremental(device, triangle());

    expect(drive(upload)).toBe(2);
    expect(mesh.complete).toBe(true);
  });

  /*
   * The handle is usable the moment it is made, and bounds are the reason: a streamer places and
   * culls a region from them before a byte of it has landed. So the position pass is paid at
   * creation rather than spread, and it is the one pass creation does pay for.
   */
  it('knows how big it is before any of it has been uploaded', () => {
    const { device } = fakeDevice();
    const { mesh } = createGpuMeshIncremental(device, slab(21_000));

    expect(mesh.bounds.min[0]).toBe(0);
    expect(mesh.bounds.max[0]).toBe(20_999 * 0.5);
  });
});

/**
 * **The instanced layout, which had no test at all until it shipped a duplicate location.**
 *
 * `vertexBufferLayouts` was exercised only in its default form, so the arm that reclaims 11 through
 * 15 for the per-instance buffer was never called by anything. When the per-vertex channel took
 * location 13 the base layout kept declaring it there and the instance buffer declared it too —
 * every instanced pipeline, colour pass and shadow pass alike, rejected by the device with
 * *"attribute shader location (13) is used more than once"*. The failure surfaces as an invalid
 * command buffer two calls later, which names neither the attribute nor the pipeline.
 *
 * These assert the property rather than the incident: **no layout a pipeline is built from may
 * name one location twice**, whatever the mesh supplies and whichever arm it takes.
 */
describe('vertexBufferLayouts, instanced', () => {
  /** Every optional attribute absent — the shape an instanced mesh is allowed to have. */
  const NONE: Record<string, boolean> = Object.fromEntries(
    VERTEX_LAYOUT.filter((a) => a.optional).map((a) => [String(a.name), false]),
  );

  function locationsOf(present: Record<string, boolean>, instanced: boolean): number[] {
    return vertexBufferLayouts(present, instanced).flatMap((layout) =>
      [...layout.attributes].map((attribute) => attribute.shaderLocation),
    );
  }

  it('names no location twice, for any mesh and either arm', () => {
    /* Every optional attribute on its own, plus all-absent and all-present: the combinations that
       move an attribute between the interleaved buffer and the constants one, which is the axis
       the duplicate hid behind. */
    const shapes: Record<string, boolean>[] = [
      { ...NONE },
      Object.fromEntries(Object.keys(NONE).map((name) => [name, true])),
      ...Object.keys(NONE).map((name) => ({ ...NONE, [name]: true })),
    ];
    for (const present of shapes) {
      for (const instanced of [false, true]) {
        /* A supplied attribute at an instance location is refused, not laid out — asserted on its
           own below. Skip those pairs here so this test is about duplicates alone. */
        const claimed = VERTEX_LAYOUT.filter((a) => a.shaderLocation >= 11).map((a) =>
          String(a.name),
        );
        if (instanced && claimed.some((name) => present[name] === true)) continue;
        const locations = locationsOf(present, instanced);
        const seen = new Set(locations);
        expect(seen.size, `instanced=${instanced} ${JSON.stringify(present)}`).toBe(
          locations.length,
        );
      }
    }
  });

  /**
   * And the instance buffer gets exactly the five it is owed, with the base layout standing clear.
   *
   * Sixteen locations, 0 through 15, each once: eleven base attributes and five per-instance, which
   * is the arithmetic every comment in `buffers.ts` quotes and nothing asserted.
   */
  it('gives the per-instance buffer 11 through 15 and the base layout everything below', () => {
    const locations = locationsOf(NONE, true).sort((a, b) => a - b);
    expect(locations).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

    const layouts = vertexBufferLayouts(NONE, true);
    const instanceBuffer = layouts[layouts.length - 1];
    expect(instanceBuffer?.stepMode).toBe('instance');
    expect([...(instanceBuffer?.attributes ?? [])].map((a) => a.shaderLocation)).toEqual([
      11, 12, 13, 14, 15,
    ]);
  });

  /**
   * **A supplied attribute at an instance location is an error and never a silent drop.**
   *
   * Dropping one the mesh interleaves would shift the stride under every attribute after it and
   * draw scrambled geometry — the artefact `createInstanced` refuses a skinned mesh to avoid. The
   * refusal is here as well as there because this is the level that cannot be reached around.
   */
  it('refuses a mesh that supplies an attribute the instance buffer claims', () => {
    for (const name of ['joints', 'weights', 'channel']) {
      expect(() => vertexBufferLayouts({ ...NONE, [name]: true }, true), name).toThrow(
        /instanced pipeline claims attribute location/,
      );
      /* And is perfectly happy with the same mesh drawn without instancing. */
      expect(() => vertexBufferLayouts({ ...NONE, [name]: true }, false), name).not.toThrow();
    }
  });

  /** A channelled mesh says so, which is what lets `createInstanced` refuse it before this does. */
  it('records a per-vertex channel on the mesh, as the other backend does', () => {
    const { device } = fakeDevice();
    const plain = createGpuMesh(device, triangle());
    expect(plain.hasChannel).toBe(false);

    const channelled = createGpuMesh(device, {
      ...triangle(),
      channel: new Float32Array([0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0]),
    });
    expect(channelled.hasChannel).toBe(true);
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { MeshData } from '../../mesh.ts';
import { UPLOAD_BYTES_PER_STEP } from '../../uploadStep.ts';
import {
  VERTEX_LAYOUT,
  createGpuMesh,
  createGpuMeshIncremental,
  vertexBufferLayouts,
} from './buffers.ts';

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
      },
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

    /* position(3) + normal(3) + colour(3) + emissive(1) = 10 floats a vertex, three vertices. */
    expect(created.find((b) => b.label === 'mesh.vertices')?.size).toBe(10 * 4 * 3);
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
    /* One 16-byte slot per attribute in `VERTEX_LAYOUT`: 14 x 16 = 224, up from 13 x 16 = 208
       when the per-vertex channel took location 13. Hand-derived, not read back from the run.
       It is the attribute count this scales with and never the vertex count, which is the
       claim in the name of this test. */
    expect(constants?.size).toBe(224);
  });

  it('grows the interleaved buffer when an optional attribute is really supplied', () => {
    const { device, created } = fakeDevice();

    createGpuMesh(device, { ...triangle(), uvs: new Float32Array([0, 0, 1, 0, 0, 1]) });

    /* Two more floats a vertex for the uv. */
    expect(created.find((b) => b.label === 'mesh.vertices')?.size).toBe(12 * 4 * 3);
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

  it('uploads a real buffer when the optional attribute is supplied', () => {
    const { device } = fakeDevice();
    const data = { ...triangle(), uvs: new Float32Array([0, 0, 1, 0, 0, 1]) };

    const mesh = createGpuMesh(device, data);

    expect(mesh.indexCount).toBe(3);
    expect(device.queue.writeBuffer).toHaveBeenCalled();
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
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
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
    expect(Math.max(...VERTEX_LAYOUT.map((a) => a.shaderLocation)) + 1).toBe(14);
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
  const { device } = fakeDevice(64);
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
   * **The interleaving is what makes this backend's update different.** WebGL2 keeps a buffer per
   * attribute, so rewriting positions is one `bufferSubData` over a contiguous array. Here every
   * attribute shares one buffer, so a position is three floats every `stride` — writing them
   * individually would be one `writeBuffer` per vertex. So a dynamic mesh keeps the interleaved
   * array it was built from, patches the fields that move, and uploads the lot in one call.
   *
   * That CPU-side copy is the whole reason the flag exists rather than every mesh paying it.
   */
  it('has no update unless it declared itself deforming', () => {
    const { device } = fakeDevice();
    expect(createGpuMesh(device, triangle()).update).toBeNull();
    expect(createGpuMesh(device, triangle(), true).update).not.toBeNull();
  });

  it('patches the positions in place and uploads the whole vertex buffer once', () => {
    const { device } = fakeDevice();
    const mesh = createGpuMesh(device, triangle(), true);
    const writes = device.queue.writeBuffer as ReturnType<typeof vi.fn>;
    const before = writes.mock.calls.length;

    mesh.update?.(device, new Float32Array([0, 7, 0, 1, 7, 0, 0, 8, 0]));

    expect(writes.mock.calls.length - before, 'one upload, not one per vertex').toBe(1);
    const uploaded = writes.mock.calls[writes.mock.calls.length - 1]?.[2] as Float32Array;
    /* Required attributes only, so the stride is position(3) + normal(3) + colour(3) +
       emissive(1) = 10 floats, and position sits at the front of each vertex. */
    expect(uploaded[1], "the first vertex's y").toBeCloseTo(7, 6);
    expect(uploaded[11], "the second vertex's y").toBeCloseTo(7, 6);
    expect(uploaded[21], "the third vertex's y").toBeCloseTo(8, 6);
    /* And the colour beside it is untouched: what a surface *is* did not change because it bent. */
    expect(uploaded[6]).toBeCloseTo(1, 6);
  });

  it('moves the bounds with the geometry', () => {
    const { device } = fakeDevice();
    const mesh = createGpuMesh(device, triangle(), true);
    expect(mesh.bounds.max[1]).toBeCloseTo(1, 6);

    mesh.update?.(device, new Float32Array([0, 20, 0, 1, 20, 0, 0, 21, 0]));
    expect(mesh.bounds.min[1]).toBeCloseTo(20, 6);
    expect(mesh.bounds.max[1]).toBeCloseTo(21, 6);
  });

  it('writes normals beside the positions when the caller has them', () => {
    const { device } = fakeDevice();
    const mesh = createGpuMesh(device, triangle(), true);
    const writes = device.queue.writeBuffer as ReturnType<typeof vi.fn>;

    mesh.update?.(
      device,
      new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    );
    const uploaded = writes.mock.calls[writes.mock.calls.length - 1]?.[2] as Float32Array;
    /* Normals follow positions in the layout, so the first vertex's normal is floats 3..5. */
    expect(uploaded[3]).toBeCloseTo(0, 6);
    expect(uploaded[4]).toBeCloseTo(1, 6);
    expect(uploaded[5]).toBeCloseTo(0, 6);
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

    /* position+normal+colour = 9 floats a vertex, emissive 1: 10, and four bytes each. */
    const vertexBytes = 21_000 * 10 * 4;
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

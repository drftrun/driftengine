import { describe, expect, test } from 'vitest';

import { createGpuMesh, createGpuMeshIncremental } from './backend/webgpu/buffers.ts';
import { Mesh, createMeshIncremental } from './mesh.ts';
import { recordingGl } from './rendererHarness.ts';

import type { MeshData } from './mesh.ts';

/**
 * **What this file is for: a mesh keeps its GPU buffers and nothing it was built from.**
 *
 * The voxel sandbox's forward path held 2,058 MB of ArrayBuffers at radius 32 where the second
 * pipeline held 368 for the same world, and the reason was in the engine: every live WebGPU mesh
 * kept its whole `MeshData`, and its interleaved copy with it. Nothing names a copy like that. The
 * mesh's `complete` getter was made in the same scope as the upload generator and a `filter` that
 * both read `data`, and V8 gives every closure in a scope one shared context — so the getter, a
 * boolean, held every array the mesh was made from for as long as the mesh lived.
 *
 * **A collector, forced.** `--expose_gc` set at run time and `gc` taken from a fresh context, so a
 * retention is something a test can see rather than infer. A weak reference to each source array
 * says whether it survived; `process.memoryUsage().arrayBuffers` counts the interleaved copy, which
 * nothing outside the upload can name.
 */

/*
 * **Node's, named through a variable**, because this package is typed for the browser: `node:` has
 * no types here, and `celestialClock.test.ts` declares the one piece of `process` it reads the same
 * way. Vitest runs in Node, so the modules are there to import.
 */
declare const process: { memoryUsage(): { arrayBuffers: number } };
const NODE = 'node:';
const v8 = (await import(/* @vite-ignore */ `${NODE}v8`)) as {
  setFlagsFromString(flags: string): void;
};
const vm = (await import(/* @vite-ignore */ `${NODE}vm`)) as {
  runInNewContext(code: string): unknown;
};
v8.setFlagsFromString('--expose_gc');
const collect = vm.runInNewContext('gc') as () => void;

async function settle(): Promise<void> {
  /* A task between rounds: a weak reference read in one job keeps its target to the job's end. */
  for (let round = 0; round < 4; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    collect();
  }
}

/** What the process holds in ArrayBuffers once everything collectable has been collected. */
async function heldBytes(): Promise<number> {
  await settle();
  return process.memoryUsage().arrayBuffers;
}

const VERTICES = 100_000;
const MESHES = 8;
/* Position, normal and colour at three floats, emissive at one: the rows the upload interleaves. */
const ROW_BYTES = (3 + 3 + 3 + 1) * 4;
const MB = 1024 * 1024;

function source(): MeshData {
  return {
    positions: new Float32Array(VERTICES * 3),
    normals: new Float32Array(VERTICES * 3),
    colors: new Float32Array(VERTICES * 3),
    emissive: new Float32Array(VERTICES),
    indices: new Uint32Array(VERTICES),
  };
}

/** Every array a mesh is made from, weakly. */
function watch(data: MeshData, into: WeakRef<object>[]): void {
  for (const value of Object.values(data)) {
    if (ArrayBuffer.isView(value)) into.push(new WeakRef(value));
  }
}

/**
 * `count` meshes made by `make`, watching every array each was made from.
 *
 * **Synchronous, and that is the point of it.** Built inside the async test, the last iteration's
 * `data` stayed in the suspended frame across the `await` that collects, and one mesh's five arrays
 * read as retained by a mesh that held none of them. This frame is gone before anything is read.
 */
function build<T>(count: number, make: (data: MeshData) => T, refs: WeakRef<object>[]): T[] {
  const made: T[] = [];
  for (let i = 0; i < count; i += 1) {
    const data = source();
    watch(data, refs);
    made.push(make(data));
  }
  return made;
}

const alive = (refs: readonly WeakRef<object>[]): number =>
  refs.filter((ref) => ref.deref() !== undefined).length;

/** A device that keeps nothing it is handed, so whatever survives is the mesh's doing. */
const DEVICE = {
  limits: { maxBufferSize: 2 ** 32 },
  createBuffer: () => ({ destroy: () => undefined }),
  queue: { writeBuffer: () => undefined },
} as unknown as GPUDevice;

describe('a WebGPU mesh', () => {
  test('KEEPS NOTHING IT WAS BUILT FROM, while it lives', async () => {
    const refs: WeakRef<object>[] = [];
    const before = await heldBytes();
    const meshes = build(MESHES, (data) => createGpuMesh(DEVICE, data), refs);
    const after = await heldBytes();
    expect(alive(refs), 'source arrays held by live meshes').toBe(0);
    /* Nor the interleaved rows, which are the upload's scratch and not the mesh's. */
    expect(after - before).toBeLessThan(MB);
    expect(meshes.length).toBe(MESHES);
  });

  test('A DYNAMIC ONE KEEPS ITS INTERLEAVED ROWS AND NOTHING ELSE, because `update` rewrites them', async () => {
    const refs: WeakRef<object>[] = [];
    const before = await heldBytes();
    const meshes = build(MESHES, (data) => createGpuMesh(DEVICE, data, true), refs);
    const after = await heldBytes();
    expect(alive(refs), 'source arrays held by live meshes').toBe(0);
    const rows = MESHES * VERTICES * ROW_BYTES;
    expect(after - before).toBeGreaterThan(rows - MB);
    expect(after - before).toBeLessThan(rows + MB);
    expect(meshes.every((mesh) => mesh.update !== null)).toBe(true);
  });

  test('AN UPLOAD KEPT AFTER IT FINISHES KEEPS NOTHING EITHER', async () => {
    /* A streamer holds the handle it was given; the iterator in it must not hold the source. */
    const refs: WeakRef<object>[] = [];
    const before = await heldBytes();
    const handles = build(
      MESHES,
      (data) => {
        const handle = createGpuMeshIncremental(DEVICE, data);
        while (handle.upload.next().done !== true);
        return handle;
      },
      refs,
    );
    const after = await heldBytes();
    expect(alive(refs), 'source arrays held by finished uploads').toBe(0);
    expect(after - before).toBeLessThan(MB);
    expect(handles.every((handle) => handle.mesh.complete)).toBe(true);
  });

  test('AN UNFINISHED UPLOAD KEEPS ITS SOURCE, which it still has to write — the control', async () => {
    /*
     * **What says the three above can see a retention at all.** An upload that has not finished
     * needs every array it was given, so a weak reference to them must survive a collection; if
     * this came back empty, a zero above would mean nothing.
     */
    const refs: WeakRef<object>[] = [];
    const handles = build(
      2,
      (data) => {
        const handle = createGpuMeshIncremental(DEVICE, data);
        handle.upload.next();
        return handle;
      },
      refs,
    );
    await settle();
    expect(alive(refs)).toBe(refs.length);
    expect(handles.some((handle) => handle.mesh.complete)).toBe(false);
  });
});

describe('a WebGL2 mesh', () => {
  test('KEEPS NOTHING IT WAS BUILT FROM, while it lives', async () => {
    const { gl, calls } = recordingGl();
    const refs: WeakRef<object>[] = [];
    const before = await heldBytes();
    const meshes = build(MESHES, (data) => new Mesh(gl, data), refs);
    /* The harness records every call with its arguments, and `bufferData` is handed the arrays. */
    calls.length = 0;
    const after = await heldBytes();
    expect(alive(refs), 'source arrays held by live meshes').toBe(0);
    expect(after - before).toBeLessThan(MB);
    expect(meshes.length).toBe(MESHES);
  });

  test('AN UPLOAD KEPT AFTER IT FINISHES KEEPS NOTHING EITHER', async () => {
    const { gl, calls } = recordingGl();
    const refs: WeakRef<object>[] = [];
    const before = await heldBytes();
    const handles = build(
      MESHES,
      (data) => {
        const handle = createMeshIncremental(gl, data);
        while (handle.upload.next().done !== true);
        return handle;
      },
      refs,
    );
    calls.length = 0;
    const after = await heldBytes();
    expect(alive(refs), 'source arrays held by finished uploads').toBe(0);
    expect(after - before).toBeLessThan(MB);
    expect(handles.every((handle) => handle.mesh.complete)).toBe(true);
  });
});

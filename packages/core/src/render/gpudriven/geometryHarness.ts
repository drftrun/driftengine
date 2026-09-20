/**
 * A sink that keeps what a streaming scene writes, for tests that read its geometry back.
 *
 * **Not a `.test.ts` file**, for the reason `rendererHarness.ts` gives: Vitest registers a test
 * when the file declaring it is imported, so a helper living beside tests would re-run them in
 * every file that imported it.
 *
 * **The scene keeps no copy of its vertices and indices** — they go to the device of the pass
 * that draws them, through a `GeometrySink` — so a test that wants to read them attaches one of
 * these where the pass would have attached itself, and reads the mirror.
 */
import { GPU_DRIVEN_VERTEX_FLOATS } from './sceneUpload.ts';

import type { GeometrySink, StreamCapacity } from './streamScene.ts';

export interface MirrorWrite {
  readonly kind: 'vertices' | 'indices';
  readonly first: number;
  readonly count: number;
  /** The array the scene handed over, kept so a test can ask whether it was the same one. */
  readonly source: Float32Array | Uint32Array;
}

export interface MirrorSink extends GeometrySink {
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly writes: MirrorWrite[];
}

/** A mirror as large as the capacity: what the pass's two buffers would hold. */
export function mirrorSink(capacity: StreamCapacity): MirrorSink {
  const vertices = new Float32Array(capacity.vertices * GPU_DRIVEN_VERTEX_FLOATS);
  const indices = new Uint32Array(capacity.indices);
  const writes: MirrorWrite[] = [];
  return {
    vertices,
    indices,
    writes,
    writeVertices(first, rows, count) {
      vertices.set(
        rows.subarray(0, count * GPU_DRIVEN_VERTEX_FLOATS),
        first * GPU_DRIVEN_VERTEX_FLOATS,
      );
      writes.push({ kind: 'vertices', first, count, source: rows });
    },
    writeIndices(first, values, count) {
      indices.set(values.subarray(0, count), first);
      writes.push({ kind: 'indices', first, count, source: values });
    },
  };
}

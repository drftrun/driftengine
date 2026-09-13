/** The shipped sort capability: a worker built from a Blob, falling back to the main thread aloud. */

import { sortOnMainThread } from './splatSorter.ts';
import { SPLAT_SIZE_BUCKETS, SPLAT_SORT_BUCKETS } from './splatSort.ts';
import type { SplatSortFn, SplatSortRequest, SplatSortResult } from './splatSort.ts';

/**
 * The sort, as source, for a worker that has no module graph to import from.
 *
 * **Stringified rather than a second file, and that is the no-build-step contract.** This engine
 * ships TypeScript source and consumers bundle it; `new Worker(new URL('./x.ts', import.meta.url))`
 * asks every consumer's bundler to know about a worker entry point, which is a build step by
 * another name. A `Blob` needs nothing of anybody.
 *
 * **What it costs is a copy of the sort that no test can reach**, so the two could drift — which is
 * exactly what the 2026-08-17 rule is about. It does not drift here because it is not written
 * twice: `sortSplatsByDepth.toString()` is interpolated below, so the worker runs the same
 * function the main thread does, and a change to that function changes both. What would make it
 * wrong is that function closing over a module-scope binding, since a stringified closure loses
 * its scope — which is why it takes its scratch as a parameter and its bucket counts as part of it.
 *
 * **The capture is cached in the worker and re-sent only when it changes.** Positions are twelve
 * bytes a splat and extents four, so posting them with every sort would structured-clone sixteen
 * megabytes for a million-splat capture — several times a second while a viewer turns, on the
 * device this whole arrangement exists for. The sender omits them when the capture is the one the
 * worker already holds, and `null` is what says so.
 */
function workerSource(sortSource: string): string {
  return `
const SPLAT_SORT_BUCKETS = ${SPLAT_SORT_BUCKETS};
const SPLAT_SIZE_BUCKETS = ${SPLAT_SIZE_BUCKETS};
const sortSplatsByDepth = ${sortSource};
let scratch = null;
let positions = null;
let extents = null;
self.onmessage = (event) => {
  const request = event.data;
  if (request.positions !== null) positions = request.positions;
  if (request.extents !== null) extents = request.extents;
  const count = request.count;
  if (scratch === null || scratch.keys.length < count) {
    const bits = new ArrayBuffer(4);
    scratch = {
      keys: new Uint16Array(Math.max(1, count)),
      counts: new Uint32Array(SPLAT_SORT_BUCKETS),
      sizes: new Uint16Array(Math.max(1, count)),
      sizeCounts: new Uint32Array(SPLAT_SIZE_BUCKETS),
      bits: new Float32Array(bits),
      bitsAsUint: new Uint32Array(bits),
    };
  }
  request.positions = positions;
  request.extents = extents;
  const kept = sortSplatsByDepth(request, scratch);
  /* Transferred back, so the pair ping-pongs rather than allocating a result a frame. */
  self.postMessage({ order: request.out, count: kept }, [request.out.buffer]);
};
`;
}

/**
 * Build the default sort capability.
 *
 * **Falls back to the main thread aloud, once.** A strict CSP without `worker-src blob:` refuses
 * the construction, and so does any runtime with no `Worker` at all. A capture that stutters is
 * better than one that does not draw — and a *silent* fallback is what `capabilityClamp` exists to
 * prevent, because the symptom is then a frame rate nobody can attribute.
 *
 * The sort's source is passed in rather than imported here so this module has no opinion about
 * where the function lives; `createDefaultSplatSort` supplies it.
 */
export function createSplatSortWorker(sortSource: string): SplatSortFn {
  let worker: Worker | null = null;
  let warned = false;

  const fallback = (reason: string): SplatSortFn => {
    if (!warned) {
      warned = true;
      console.warn(
        `splats: sorting on the main thread — ${reason}. A capture will stutter while the view ` +
          'turns. Supply your own `sort` capability to put it somewhere else.',
      );
    }
    return sortOnMainThread;
  };

  try {
    if (
      typeof Worker === 'undefined' ||
      typeof Blob === 'undefined' ||
      typeof URL === 'undefined'
    ) {
      return fallback('this runtime has no Worker');
    }
    const url = URL.createObjectURL(
      new Blob([workerSource(sortSource)], { type: 'text/javascript' }),
    );
    worker = new Worker(url);
    /* The blob is referenced by the live worker; the URL is only the handle. */
    URL.revokeObjectURL(url);
  } catch (error) {
    return fallback(String((error as Error).message ?? error));
  }

  const live = worker;
  /* Identity, not a copy: `SplatData` owns these arrays for its lifetime, so the same reference
     arriving twice is exactly the statement that the worker's copy is still current. */
  let sentPositions: Float32Array | null = null;
  let sentExtents: Float32Array | null = null;

  return (request: SplatSortRequest): Promise<SplatSortResult> =>
    new Promise<SplatSortResult>((resolve, reject) => {
      const onMessage = (event: MessageEvent): void => {
        live.removeEventListener('message', onMessage);
        live.removeEventListener('error', onError);
        resolve(event.data as SplatSortResult);
      };
      const onError = (event: ErrorEvent): void => {
        live.removeEventListener('message', onMessage);
        live.removeEventListener('error', onError);
        /* The worker never learned this capture, so the next attempt must send it again. */
        sentPositions = null;
        sentExtents = null;
        reject(new Error(`splats: the sort worker failed — ${event.message}`));
      };
      live.addEventListener('message', onMessage);
      live.addEventListener('error', onError);

      const positions = request.positions === sentPositions ? null : request.positions;
      const extents = request.extents === sentExtents ? null : request.extents;
      sentPositions = request.positions;
      sentExtents = request.extents;
      /*
       * `out` is transferred and the capture is copied at most once. Copying rather than
       * transferring the capture is the price of not owning it: the positions belong to the
       * `SplatData` and the main thread reads them for a fallback sort.
       */
      live.postMessage(
        {
          positions,
          extents,
          count: request.count,
          dirX: request.dirX,
          dirY: request.dirY,
          dirZ: request.dirZ,
          originX: request.originX,
          originY: request.originY,
          originZ: request.originZ,
          budget: request.budget,
          out: request.out,
        },
        [request.out.buffer],
      );
    });
}

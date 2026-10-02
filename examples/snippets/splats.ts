/**
 * Splat captures read from the files capture tools write, streamed out of a `.drft` block by
 * block, and held to a budget on a weaker GPU.
 *
 * A snippet, typechecked with the examples and quoted by the manual's splats chapter.
 */
import type { RendererApi } from '@driftengine/core';
import { DrftStream } from '@driftengine/drft';
import type { DrftSplatBlock } from '@driftengine/drft';
import {
  SplatCapture,
  SplatSorter,
  browserWebpDecoder,
  createSplatPass,
  defaultSplatBudget,
  readSplat,
  readSplatPly,
  readSplatSog,
  unbundleSog,
} from '@driftengine/splats';
import type { SplatData, SplatPass } from '@driftengine/splats';

// #region files
/** A capture from a file: a `.ply` from training, a `.splat`, or a `.sog` bundle of WebP images. */
export async function readCapture(url: string): Promise<SplatData> {
  const bytes = await (await fetch(url)).arrayBuffer();
  if (url.endsWith('.ply')) return readSplatPly(bytes);
  if (url.endsWith('.splat')) return readSplat(bytes);
  return readSplatSog(await unbundleSog(bytes), browserWebpDecoder());
}
// #endregion

// #region budget
/** At most as many splats as this GPU family is known to hold, the largest on screen kept. */
export function budgetedSorter(renderer: RendererApi, splats: SplatData): SplatSorter {
  return new SplatSorter({ splats, budget: defaultSplatBudget(renderer.rendererName) });
}
// #endregion

// #region stream
/**
 * A capture that fills as its blocks arrive. The first block names the final count, so the
 * capture and its pass are sized once, and every block after is a sub-upload.
 */
export function streamCapture(
  renderer: RendererApi,
  onReady: (pass: SplatPass, sorter: SplatSorter) => void,
): DrftStream {
  let capture: SplatCapture | null = null;
  let pass: SplatPass | null = null;
  return new DrftStream({
    onSplats: (block: DrftSplatBlock) => {
      if (capture === null) {
        const filling = new SplatCapture({
          total: block.totalCount,
          boundsMin: block.boundsMin,
          boundsMax: block.boundsMax,
          sphericalHarmonics: block.sphericalHarmonics,
          wordsPerSplat: block.wordsPerSplat,
        });
        capture = filling;
        pass = createSplatPass(filling.data, 'streamed');
        renderer.registerPass(pass);
        /* The sorter orders what has arrived, and nothing of the zeroed tail still to come. */
        onReady(pass, new SplatSorter({ splats: filling.data, ready: () => filling.ready }));
      }
      const landed = capture.append(block.records, block.count);
      pass?.uploadSplats(landed.from, landed.count);
    },
  });
}
// #endregion

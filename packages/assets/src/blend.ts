/**
 * Reading a `.blend` directly: Blender's own file, with no Blender installed.
 *
 * The route is container → catalogue → scene → glTF document → the glTF reader, each step in its
 * own module, and this one only chains them and decides what a refusal looks like. See
 * `blendGltf.ts` for why the document in the middle is glTF.
 *
 * **A refusal is an error with its reasons attached**, `BlendNeedsBlender`, because the caller
 * that can act on it — the baker, with Blender on the machine — needs the list rather than a
 * sentence to parse: it hands the file to Blender and says why. A browser has no Blender, and shows
 * the message.
 */

import { DrftError } from '@driftengine/drft';
import { BlendData } from './blendData.ts';
import { blendToGltf } from './blendGltf.ts';
import type { BlendGltf } from './blendGltf.ts';
import { unpackBlend } from './blendPacked.ts';
import type { BlendDecompress } from './blendPacked.ts';

/** Thrown when a `.blend` holds something only Blender can evaluate, with each thing named. */
export class BlendNeedsBlender extends DrftError {
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    const shown = reasons
      .slice(0, 6)
      .map((reason) => `  ${reason}`)
      .join('\n');
    const more = reasons.length > 6 ? `\n  …and ${reasons.length - 6} more` : '';
    super(
      `blend: this file needs Blender to evaluate it, and the direct reader draws nothing rather than ` +
        `the wrong shape:\n${shown}${more}\nBake it with \`npm run bake\` on a machine with Blender ` +
        'installed, which hands it to Blender, or apply these in Blender and save again.',
    );
    this.name = 'BlendNeedsBlender';
    this.reasons = reasons;
  }
}

/** Open a `.blend`'s bytes, decompressing them first where the file was saved compressed. */
export async function openBlend(
  bytes: Uint8Array,
  decompress?: BlendDecompress,
): Promise<BlendData> {
  return new BlendData(await unpackBlend(bytes, decompress));
}

/** A `.blend` as a glTF document, refusing it whole when any part of it needs evaluating. */
export async function readBlend(
  bytes: Uint8Array,
  decompress?: BlendDecompress,
): Promise<BlendGltf> {
  const result = blendToGltf(await openBlend(bytes, decompress));
  if (result.refusals.length > 0) throw new BlendNeedsBlender(result.refusals);
  return result;
}

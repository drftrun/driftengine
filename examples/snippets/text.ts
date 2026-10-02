/**
 * Text in the world, from a signed-distance-field font the game supplies.
 *
 * A snippet, typechecked with the examples and quoted by the manual's text and overlays chapter.
 */
import { DEFAULT_SDF_TEXT_STYLE, parseSdfFont } from '@driftengine/core';
import type { RendererApi, SdfTextHandle, Vec3 } from '@driftengine/core';

// #region sdf
/** Load a font's metrics and atlas, which the engine never fetches itself, and lay a sign out. */
export async function shopSign(renderer: RendererApi, base: string): Promise<SdfTextHandle> {
  const font = parseSdfFont(await (await fetch(`${base}/metrics.json`)).json());
  const image = await createImageBitmap(await (await fetch(`${base}/atlas.png`)).blob());
  const atlas = renderer.createSurfaceTexture(image);
  const sign = renderer.createSdfText();
  renderer.setSdfText(sign, font, atlas, 'OPEN LATE', {
    ...DEFAULT_SDF_TEXT_STYLE,
    size: 0.4,
    anchorX: 'center',
  });
  return sign;
}

const NEON: Vec3 = [1, 0.4, 0.7];

/** Drawn inside the mesh pass, at a model matrix, like any mesh. */
export function drawSign(renderer: RendererApi, sign: SdfTextHandle, model: Float32Array): void {
  renderer.drawSdfText(sign, model, NEON, 1);
}
// #endregion

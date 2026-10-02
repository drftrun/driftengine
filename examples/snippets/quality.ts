/**
 * Render quality: a profile chosen when the renderer is built, and the few dials that move per frame.
 *
 * A snippet, typechecked with the examples and quoted by the manual's quality chapter.
 */
import { createRenderer } from '@driftengine/core';
import type { RenderQualityOptions, RendererApi } from '@driftengine/core';

// #region profiles
/** A desktop profile: a filmic tone curve, real brightness through the composite, and post effects. */
export const DESKTOP: RenderQualityOptions = {
  maxDevicePixelRatio: 2,
  outputTransform: 'aces',
  outputExposure: 1.4,
  screenEffects: true,
  hdrScene: true,
  sceneSamples: 4,
  bloom: 0.5,
  bloomThreshold: 1,
  ambientOcclusion: 0.6,
  directionalShadows: true,
  directionalShadowMapSize: 2048,
  pointShadows: true,
};

/** A phone profile: fewer pixels, a smaller shadow map, and no full-frame post pass. */
export const PHONE: RenderQualityOptions = {
  maxDevicePixelRatio: 1.25,
  maxDrawingBufferPixels: 1280 * 720,
  outputTransform: 'aces',
  outputExposure: 1.4,
  screenEffects: false,
  directionalShadows: true,
  directionalShadowMapSize: 1024,
  pointShadows: false,
};

export async function build(canvas: HTMLCanvasElement, phone: boolean) {
  return createRenderer(canvas, phone ? PHONE : DESKTOP);
}
// #endregion

// #region dials
/** The dials that may move every frame. Everything else is fixed when the renderer is built. */
export function cinematicMoment(renderer: RendererApi, intensity: number): void {
  renderer.setBloom(0.5 + intensity * 0.5);
  renderer.setOutputExposure(1.4 + intensity * 0.6);
  renderer.setCameraMotionBlur(intensity);
  renderer.setVignette(intensity * 0.4);
}
// #endregion

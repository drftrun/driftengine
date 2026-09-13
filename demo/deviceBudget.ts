/**
 * What a demo should cost on this device, as quality dials rather than as features taken away.
 *
 * **The mistake this replaces.** Every scene mounted at `full` on every device, and `full` is
 * the engine's defaults plus `sceneSamples: 4` — four times the colour and depth bandwidth of a
 * frame that was already the constraint on a handset. Reported from a Galaxy S23 Ultra at 15 to
 * 20 fps across the demos page. The obvious answer was the `lean` budget, and it is the wrong
 * one *here*: `lean` switches off directional shadows, water reflections and `screenEffects`
 * outright, and with the composite gone so are bloom, occlusion, motion blur and the speed rush.
 *
 * A settings screen can afford that, because a player who disagrees can put it back. **This page
 * has no settings screen.** So a reader on a phone would be shown a version of the engine with
 * several of its passes missing, on the one page whose whole job is to say what the engine does,
 * with no way back that anybody would find. That is a worse failure than a soft picture.
 *
 * So nothing is switched off. Every pass a desktop reader sees, a phone reader sees: the
 * reflection still reflects, the shafts still march, the composite still grades. What changes is
 * how many pixels and how many taps each of them costs, which is the axis the frame is actually
 * bound on — it is bandwidth, not features, and the two are separable.
 *
 * `lean` keeps its meaning as the diagnostic it was written to be, reachable at `?budget=lean`.
 */
import type { RenderQualityOptions } from '../packages/core/src/index';

/** What the first mount needs to know about the device, and nothing more. */
export interface DemoDeviceHints {
  /** A touchscreen rather than a mouse: `(pointer: coarse)`. */
  readonly coarsePointer: boolean;
  readonly devicePixelRatio: number;
}

/**
 * A coarse pointer at a density of two or more is a phone or a tablet.
 *
 * A fact about the panel and the input, which is what the expensive settings are denominated
 * in, and answerable on every browser. Deliberately not the engine's GPU-name table: that table
 * is exactly what missed this device, because it excludes the flagship Adreno and Mali families
 * on the reasoning that flagships hold the budget — and a flagship phone pairs desktop-class
 * shading with a tenth of the memory bandwidth. WebGPU weakens it further, reporting an
 * architecture bucket rather than a part number.
 *
 * A touchscreen laptop reports a coarse pointer at density 1 and is not one: it has a desktop
 * GPU behind it and none of the problems this exists for.
 */
export function isHandheld(hints: DemoDeviceHints): boolean {
  return hints.coarsePointer && hints.devicePixelRatio >= 2;
}

/**
 * The trims a handheld gets on top of whatever budget it mounted at. Empty everywhere else.
 *
 * Every one of these is a dial rather than a switch, and each is the cheap end of something the
 * scene still does:
 *
 * - **Density and area.** The frame is roughly 90% fragment-bound, so this is the lever with the
 *   most picture per byte. 1.5 on a 450ppi panel is still finer than a desktop monitor at 1.
 * - **One sample rather than four.** The only genuine quality loss here, and the panel largely
 *   pays it back: multisampling buys edge smoothing, and at this density an edge is already a
 *   third of the width it would be on a desktop. WebGPU permits 1 or 4 and nothing between, so
 *   there is no middle to take. It is four times the colour *and* depth bandwidth of the frame.
 * - **Half-scale reflections.** Still a real planar reflection of the real scene. The water
 *   shader takes up to nine taps across it, which removes most of what the other half was
 *   carrying.
 * - **Smaller, softer shadow maps.** Still shadows, from the same lights, at a resolution and a
 *   filter width suited to a screen this size.
 */
export function demoQualityFor(hints: DemoDeviceHints): RenderQualityOptions {
  if (!isHandheld(hints)) return {};
  return {
    maxDevicePixelRatio: 1.5,
    maxDrawingBufferPixels: 1_600_000,
    sceneSamples: 1,
    waterReflectionScale: 0.5,
    directionalShadowMapSize: 1024,
    directionalShadowDepthLayers: 1,
    pointShadowFaceSize: 256,
    shadowFilterTaps: 4,
    waterResolution: 64,
    plumeNoiseOctaves: 2,
  };
}

/**
 * What this browser says about itself, or a desktop's answers where it cannot be asked.
 *
 * Defensive because a host may call it during module evaluation, and a server-rendered or test
 * environment has no `matchMedia` — throwing there would cost a page for a question whose wrong
 * answer costs one reload.
 */
export function readDemoDeviceHints(): DemoDeviceHints {
  try {
    return {
      coarsePointer: globalThis.matchMedia?.('(pointer: coarse)').matches ?? false,
      devicePixelRatio: globalThis.devicePixelRatio ?? 1,
    };
  } catch {
    return { coarsePointer: false, devicePixelRatio: 1 };
  }
}

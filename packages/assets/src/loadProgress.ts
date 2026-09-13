import type { MeshHandle } from '@driftengine/core';

/**
 * The vocabulary of a load in flight: which phase it is in, how far it has got, and what a
 * finished part is.
 *
 * Separate from the loader because these three are what a consumer's progress bar is written
 * against, and reading them should not mean paging through a thousand-line class.
 */

/**
 * Where a load has got to, in the order a file delivers it.
 *
 * These are the chunk kinds rather than invented steps, which is the argument docs/FORMAT.md
 * §4.6 makes for the whole design: the format's own layout is the sequence a viewer sees.
 */
export type DrftLoadPhase =
  | 'idle'
  | 'connecting'
  | 'manifest'
  /** A coarse whole model has landed: the asset is on screen, at the resolution it arrived at. */
  | 'outline'
  | 'materials'
  | 'geometry'
  | 'textures'
  | 'ready'
  | 'absent'
  | 'failed';

/**
 * How far a load has got, and every field here now answers about the *picture* rather than about
 * the work.
 *
 * **This was not true until it was reported.** `imagesDone` counted an image when its bytes
 * arrived, and the decode that follows is deliberately not awaited so a slow one never holds up
 * the stream. So there was a window in which `fraction` was 1, every part was uploaded and
 * `imagesDone` equalled `imagesTotal`, while the surfaces wearing those images still drew
 * untextured. Measured by a consumer across a scenario switch: **one and three quarter seconds.**
 *
 * It cost more than a harness photographing the wrong frame, which is how it was found. The same
 * consumer drives a loading bar off these counters, so the bar reached 100% and the model then
 * visibly changed underneath somebody who had been told it was finished. Their argument for the
 * trade is the one that decided it: a bar that sits still for a moment is honest about being
 * busy, and a bar that finishes early and then lets the thing it loaded change is not, and nobody
 * can tell the second one is happening.
 *
 * So an image counts when it is **on the GPU**. `fraction` reaches 1 when the picture is right,
 * and the cost is that it pauses near the end while the last decodes finish. On a weighted bar
 * that pause is not at 99%: parts and images carry separate shares, so it climbs to roughly two
 * thirds on the uploads and waits there, and a bar that stops at two thirds reads as working
 * where one that stops at 99% reads as stuck.
 *
 * `phase === 'ready'` remains the signal to *act* on, and is what anything judging the finished
 * picture should gate on.
 */
export interface DrftLoadProgress {
  readonly phase: DrftLoadPhase;
  /** 0 to 1, weighted by what the manifest says the file is actually made of. */
  readonly fraction: number;
  readonly partsDone: number;
  readonly partsTotal: number;
  /**
   * Images that are **on the GPU**, not images whose bytes have arrived.
   *
   * A decode that fails counts too, because the alternative to counting it is a bar that can
   * never finish as the price of one image that was never going to draw.
   */
  readonly imagesDone: number;
  readonly imagesTotal: number;
  readonly totalBytes: number;
  /** Present only when the phase is `failed` or `absent`. */
  readonly message: string;
}

/** One drawable piece of a loaded model. */
export interface DrftPart {
  readonly mesh: MeshHandle;
  /** Which of the asset's images this surface wears, or -1 for none. */
  readonly albedo: number;
  /** Which image carries its occlusion, roughness and metallic, or -1 for none. */
  readonly orm: number;
  /**
   * Which image carries its surface-space normals, or -1 for none.
   *
   * **Carried by the container since `MATL` reached stride 72 and dropped here until 2026-08-23**,
   * which is the whole of why a bought model looked smoother than the one its maker shipped: the
   * baker wrote the index, the reader read it, the renderer has taken a normal map through
   * `SurfaceMaterial.normal` since normal maps landed, and this was the one step that did not pass
   * it on. Panel seams, stitching, tread and every other detail an exporter bakes into a normal
   * map rather than into geometry was arriving and going nowhere.
   */
  readonly normal: number;
  /**
   * Which image carries its emission, or -1 for none.
   *
   * **The fourth and last index `MATL` carries, passed on from 2026-08-24.** It was written by the
   * baker, read by the reader and dropped here for the same stretch the normal map was — but for a
   * stated reason rather than by oversight: no renderer took an emissive map until now, so there
   * was nowhere to pass it. `SurfaceMaterial.emissive` is that somewhere.
   */
  readonly emissive: number;
  /**
   * glTF's three factors, in the shape `SurfaceMaterial` takes them.
   *
   * Carried on the part rather than looked up from the material, because a caller building a
   * `setMaterial` call has the part and not the index that produced it.
   */
  readonly roughnessScale: number;
  readonly metallicScale: number;
  readonly occlusionStrength: number;
  readonly opacity: number;
  readonly reflectivity: number;
  /**
   * Alpha below which this surface's fragments are discarded, 0 for one that discards nothing.
   *
   * The pair to `opacity` and not a weaker version of it: a cutout decides which texels of the
   * surface exist, an opacity decides how much light passes through the ones that do. It is what
   * `SurfaceMaterial.cutout` takes, and until `MATL` grew the field there was no way for a source
   * format to say it — a masked grille arrived as a solid rectangle, and a vehicle format's alpha
   * *test* was being spent on the opacity, which drew nine surfaces of a hundred and two as
   * nothing at all.
   */
  readonly cutout: number;
  /**
   * 0 to 1 as this part arrives, for a caller that would rather it faded in than appeared.
   *
   * Advanced by `update`, so it follows the frame's own clock and holds when the frame holds.
   * A caller that wants parts to pop in can ignore it; one that wants a build fades on it.
   */
  reveal: number;
}

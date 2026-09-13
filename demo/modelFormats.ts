import { MODEL_FORMATS } from '@driftengine/assets';
import type { UpAxis } from '@driftengine/assets';
/**
 * What the page and the worker have to agree on, and nothing else.
 *
 * **It is a separate module because importing the worker's own module from the page is a
 * mistake that does not look like one.** A worker module ends in the code that installs its
 * message handler, and a page that imports it for one constant runs that line too: `self` on a
 * main thread is `window`, so the guard `'onmessage' in self` is true there, and the handler
 * gets attached to the page. Every unrelated `message` event then reaches it. Vite's own dev
 * client posts them, so the scene issued a fetch per hot-update message, each for a URL built
 * from an object that had none. 1,684 requests to `/undefined`, all pending, before anybody
 * looked at the network panel.
 *
 * The second reason is size: importing the worker also drags every reader into the page's
 * bundle, which is the opposite of what moving the parse off the main thread was for.
 */

/**
 * Every extension the showroom will look for, best first.
 *
 * `.drft` leads because it is the one that needs no work: it streams, it is zero-copy, and the
 * staged reveal is the file's own layout rather than anything the scene arranges. The source
 * formats follow in the order `MODEL_FORMATS` prefers them.
 */
export const MODEL_EXTENSIONS: readonly string[] = [
  '.drft',
  ...MODEL_FORMATS.map((entry) => entry.ext),
];

/** What the page asks for: one model, by absolute URL. */
export interface ModelRequest {
  /**
   * Absolute, and that is a correctness requirement rather than a convention.
   *
   * A relative URL inside a worker resolves against the *worker's* location, not the document's,
   * so `car.obj` becomes a request for one sitting beside this module. A dev server answers that
   * with the page under a 200 and the reader is handed HTML.
   */
  readonly url: string;
  /** Which way is up in the asset, when the file is not to be believed. Optional. */
  readonly up?: UpAxis;
  /**
   * Material names whose meshes are left out, matched exactly.
   *
   * **A bought model is a scene, not an object.** An artist exports the file they were working
   * in, so it routinely carries a backdrop plane and the studio lights they lit it with, and
   * those are geometry like everything else. Dropping them is the caller's decision because
   * only the caller knows it wanted a car rather than the photograph of one.
   *
   * Exact rather than a substring, deliberately. The obvious loose match for a light also
   * catches every `Highlight` on the car, and one asset here has a real part called
   * `MirrorsLightSouces` sitting on the wing mirror. Names are stated and printed, so a drop is
   * something somebody chose and can check, never something inferred from a shape.
   */
  readonly exclude?: readonly string[];
  /**
   * Cells along the longest axis for a coarse outline. Absent takes the default, `false` refuses.
   *
   * A coarse level puts a whole object on screen while the parts are still arriving. It used to
   * be absent unless asked for, because how good that object looks is a property of the model
   * rather than of the code, and the hull of the time decimated into lumps and ridges: a viewer
   * saw white cliffs where a car should be, which is worse than an empty turntable, since an
   * empty turntable is obviously a load in progress and a bad preview looks like a broken import.
   *
   * The occupancy hull emits the boundary of a solid rather than joining clusters that sit on
   * different surfaces, so a coarse version is now a coarse version of the shape. It costs about
   * four hundred milliseconds on the 187-mesh car, on a thread nothing else is waiting on.
   *
   * `false` refuses one. The number is still worth typing for an asset whose detail is finer
   * than the default grid, and the only way to know the right one is to try it and look.
   */
  readonly outline?: number | false;
}

/**
 * How far the conversion has got, sent while it runs.
 *
 * **The container's own phases cannot cover this, and should not try.** `DrftLoadProgress`
 * reports what a `.drft` is doing as it arrives, and none of that has started yet: a source
 * format has to be fetched whole, parsed, welded and written before there is a container at all.
 * Without this the bar sat at its first phase for the entire download and parse, then filled
 * instantly, because by the time the loader saw anything the bytes were already in memory. The
 * work was not being reported, so the one part with nothing to say was the longest part.
 *
 * `received` and `total` are bytes and only mean anything while downloading; `total` is 0 where
 * the server sent no length, which a consumer has to show as an unknown rather than as zero.
 */
export interface ModelProgress {
  readonly stage: 'downloading' | 'reading' | 'building' | 'packing';
  readonly received: number;
  readonly total: number;
}

/** What comes back: a container, progress on the way to one, or the reason there is not one. */
export type ModelReply =
  | { readonly ok: true; readonly drft: ArrayBuffer }
  | { readonly ok: false; readonly message: string }
  | { readonly progress: ModelProgress };

/** Whether a message from the worker is progress rather than an outcome. */
export function isProgress(reply: ModelReply): reply is { readonly progress: ModelProgress } {
  return 'progress' in reply;
}

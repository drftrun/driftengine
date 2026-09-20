/**
 * A clip's frames, and which of them a capture keeps.
 *
 * **The engine never opens a file.** A host hands it a `FrameSource` — a video element in a
 * browser, a decoder on a native host, a folder of stills in a test — and the engine reads it one
 * frame at a time, in order, into a buffer of its own. A minute of 1080p is eight gigabytes of
 * pixels, so a clip is walked rather than held, and what a capture keeps is chosen as it goes past.
 *
 * **A frame may arrive later than it is asked for**, since every browser decoder is asynchronous, so
 * `frameAt` may answer a promise and the two readers here are `async`. A host with its frames
 * already in hand answers without one and pays nothing: an awaited value that is not a promise
 * costs a microtask, and this is a clip's pace rather than a frame's.
 *
 * **Frames are chosen by motion, not by number.** What reconstruction needs is baseline: two views
 * far enough apart to triangulate, and no more of them than the budget allows. So the frames kept
 * are spaced by equal motion — a slow pan gives up most of its frames, a fast one keeps them — and
 * a clip that never moves is one frame, which is what it holds. `every` is the other way to choose,
 * for a caller that knows its clip: every Nth frame, under the same budget.
 *
 * **Motion is the mean absolute difference between one frame and the last**, over the colours and
 * not the alpha, which is a measure of how much the picture changed rather than of how far anything
 * travelled. **What it gives up** is telling a pan from a light being switched on; what would make
 * it wrong is a clip whose brightness swings without the camera moving, and the answer then is the
 * feature matching of Task 9 rather than a cleverer average.
 */

export interface FrameSize {
  readonly width: number;
  readonly height: number;
}

export interface FrameSource {
  frameCount(): number;
  /**
   * Writes frame `index` as RGBA into `out` and answers the frame's size. A buffer too small for
   * the frame is left untouched, so a caller may ask with an empty one to learn the size first.
   */
  frameAt(index: number, out: Uint8Array): FrameSize | Promise<FrameSize>;
}

export interface FrameChoice {
  /** At most this many frames. */
  readonly budget: number;
  /** Every Nth frame instead of by motion. */
  readonly every?: number;
}

const NOTHING = new Uint8Array(0);

/** Every frame in order, each read over the last into one buffer the visitor must not keep. */
export async function eachFrame(
  source: FrameSource,
  visit: (index: number, pixels: Uint8Array, width: number, height: number) => void,
): Promise<void> {
  const count = source.frameCount();
  if (count <= 0) return;
  const { width, height } = await source.frameAt(0, NOTHING);
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < count; index += 1) {
    const size = await source.frameAt(index, pixels);
    visit(index, pixels, size.width, size.height);
  }
}

/** The frames a capture keeps, in order, the first among them. */
export async function selectFrames(source: FrameSource, choice: FrameChoice): Promise<number[]> {
  const count = source.frameCount();
  const budget = Math.max(1, Math.floor(choice.budget));
  if (count <= 0) return [];
  if (choice.every !== undefined) {
    const kept: number[] = [];
    for (let index = 0; index < count && kept.length < budget; index += choice.every) {
      kept.push(index);
    }
    return kept;
  }
  if (count <= budget) return Array.from({ length: count }, (_, index) => index);

  /* One pass for the motion between each frame and the last, keeping a copy of that last frame. */
  const travelled = new Float64Array(count);
  let last: Uint8Array | null = null;
  await eachFrame(source, (index, pixels) => {
    if (last !== null) {
      let sum = 0;
      for (let at = 0; at < pixels.length; at += 4) {
        sum +=
          Math.abs((pixels[at] as number) - (last[at] as number)) +
          Math.abs((pixels[at + 1] as number) - (last[at + 1] as number)) +
          Math.abs((pixels[at + 2] as number) - (last[at + 2] as number));
      }
      travelled[index] = (travelled[index - 1] as number) + sum / ((pixels.length / 4) * 3);
    } else {
      last = new Uint8Array(pixels.length);
    }
    last.set(pixels);
  });

  const total = travelled[count - 1] as number;
  if (total === 0) return [0];
  /* Spaced so the whole clip's motion divides into the budget's frames, the last one included. */
  const step = total / (budget - 1);
  const kept = [0];
  let since = 0;
  for (let index = 1; index < count && kept.length < budget; index += 1) {
    if ((travelled[index] as number) - since >= step * (1 - 1e-9)) {
      kept.push(index);
      since = travelled[index] as number;
    }
  }
  return kept;
}

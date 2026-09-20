/**
 * DriftFG's reference: a frame generated between two rendered ones, from their motion and depth.
 *
 * **One scatter, of the later frame.** Its motion points each pixel to where its surface was in the
 * earlier frame, so a surface visible in the later frame stands at time `t` a fraction `1 − t` of
 * that motion back from where it is now (`projectForward`), the nearest surface winning a pixel two
 * land on. That one scatter places every surface the later frame shows, and carries both frames'
 * colours for it: the later frame's at the pixel it came from, and the earlier frame's at the pixel
 * its motion points to — when the earlier frame shows the same surface there, which its depth says.
 * The colour is taken from whichever frame is nearer in time (`resolveGenerated`).
 *
 * **A pixel nothing lands on is a hole, filled and marked** (`fillHoles`): the later frame never
 * saw what stands there, so it is a surface a moving object uncovered — and what a moving object
 * uncovers is behind it, so the hole takes the farther of the two frames' surfaces at that pixel.
 * The mark is kept for the device pass that follows this reference, which may treat a hole's pixels
 * more carefully than a projected one's.
 *
 * **The interface is not in the frames generated from**: a menu drawn into them would be projected
 * with whatever moved beneath it and warp. It is composited over the generated frame afterwards,
 * from its own layer, at the display's rate (`composeInterface`).
 *
 * **Linear motion, and what that gives up.** A surface is placed along the straight line between
 * its two positions, which is exact for a camera or an object moving at constant velocity across one
 * render interval and wrong for anything turning within it; a turn fast enough to matter shows as a
 * surface slightly off its arc for one generated frame. And a surface the later frame does not show
 * — hidden in it, visible in the earlier one — is not projected at all: at small `t` it is a hole
 * filled from the earlier frame, which is right, and at large `t` it is the same, which is late.
 *
 * Images are row-major; colour is four floats a pixel, premultiplied; depth is view distance, larger
 * further; motion is two floats a pixel in pixels of this image. The engine's motion target stores
 * uv with rows running upward, and converting it is the device pass's business rather than this.
 */

export interface FrameImage {
  readonly width: number;
  readonly height: number;
  readonly colour: Float32Array;
  readonly depth: Float32Array;
  /** Where each pixel's surface was in the frame before, as an offset in pixels. */
  readonly motion: Float32Array;
}

/** Which pixel of the later frame lands on each pixel at time `t`, and at what depth. */
export interface Projection {
  readonly width: number;
  readonly height: number;
  /** The later frame's pixel landing here, or -1 where none does. */
  readonly source: Int32Array;
  readonly depth: Float32Array;
}

/**
 * How far two depths may differ, as a fraction of the nearer, and still be one surface.
 *
 * What it gives up: a surface moving toward or away from the camera changes its own depth between
 * frames, and one moving five per cent of its distance in a render interval reads as a different
 * surface, so it takes the later frame's colour at small `t` too — its colour a render interval
 * late, not wrong.
 */
const SAME_SURFACE = 0.05;

export function createProjection(width: number, height: number): Projection {
  const pixels = width * height;
  return { width, height, source: new Int32Array(pixels), depth: new Float32Array(pixels) };
}

/**
 * Scatter the later frame's pixels to where they stand at time `t`: 0 is the earlier frame and 1
 * the later. The nearest surface wins a pixel two land on.
 */
export function projectForward(
  motion: Float32Array,
  depth: Float32Array,
  t: number,
  out: Projection,
): void {
  const { width, height, source } = out;
  source.fill(-1);
  out.depth.fill(Infinity);
  const back = 1 - t;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = y * width + x;
      const tx = Math.round(x + back * (motion[from * 2] as number));
      const ty = Math.round(y + back * (motion[from * 2 + 1] as number));
      if (tx < 0 || tx >= width || ty < 0 || ty >= height) continue;
      const at = ty * width + tx;
      const z = depth[from] as number;
      if (z < (out.depth[at] as number)) {
        out.depth[at] = z;
        source[at] = from;
      }
    }
  }
}

function copyColour(out: Float32Array, at: number, from: Float32Array, index: number): void {
  for (let c = 0; c < 4; c += 1) out[at * 4 + c] = from[index * 4 + c] as number;
}

/**
 * Colour every projected pixel from the frame nearer in time, and mark every pixel nothing landed on
 * — whose colour is left for `fillHoles`.
 *
 * The earlier frame is used only where it shows the same surface where the motion says it was: its
 * depth there within `SAME_SURFACE` of the later frame's. Where it does not, the surface was hidden
 * in it, and the later frame is the only one that saw it.
 */
export function resolveGenerated(
  projection: Projection,
  before: FrameImage,
  after: FrameImage,
  t: number,
  out: Float32Array,
  mask: Uint8Array,
): void {
  const { width, height, source } = projection;
  const early = t < 0.5;
  for (let at = 0; at < source.length; at += 1) {
    const from = source[at] as number;
    if (from < 0) {
      mask[at] = 1;
      continue;
    }
    mask[at] = 0;
    if (early) {
      const x = Math.round((from % width) + (after.motion[from * 2] as number));
      const y = Math.round(Math.floor(from / width) + (after.motion[from * 2 + 1] as number));
      if (x >= 0 && x < width && y >= 0 && y < height) {
        const was = y * width + x;
        const then = before.depth[was] as number;
        const now = after.depth[from] as number;
        if (Math.abs(then - now) <= SAME_SURFACE * Math.min(then, now)) {
          copyColour(out, at, before.colour, was);
          continue;
        }
      }
    }
    copyColour(out, at, after.colour, from);
  }
}

/** Fill every marked pixel from the farther of the two frames' surfaces there. The mark stays. */
export function fillHoles(
  out: Float32Array,
  before: FrameImage,
  after: FrameImage,
  mask: Uint8Array,
): void {
  for (let at = 0; at < mask.length; at += 1) {
    if (mask[at] !== 1) continue;
    const behind = (before.depth[at] as number) > (after.depth[at] as number) ? before : after;
    copyColour(out, at, behind.colour, at);
  }
}

/** The interface over the generated frame, premultiplied, from its own layer and never projected. */
export function composeInterface(out: Float32Array, overlay: Float32Array): void {
  for (let i = 0; i < out.length; i += 4) {
    const keep = 1 - (overlay[i + 3] as number);
    for (let c = 0; c < 4; c += 1) {
      out[i + c] = (overlay[i + c] as number) + (out[i + c] as number) * keep;
    }
  }
}

/**
 * The milliseconds frame generation adds to every rendered frame, stated rather than hidden.
 *
 * **A generated frame sits between two rendered ones, so it cannot be shown until the later one
 * exists**, and the later one is then held back while the frames generated before it are shown:
 * `displayHz / renderHz − 1` display intervals, and the generation before the first of them. At
 * the render rate nothing is generated and nothing is added. The rates must be a whole multiple
 * apart, or the generated frames would fall unevenly between rendered ones and the motion judder.
 *
 * What would make it wrong: extrapolation — generating from the earlier frame alone, ahead of the
 * later — adds no hold-back and fills no hole from a frame it has not got. That is a different
 * trade, and this reference does not make it.
 */
export function frameGenLatency(displayHz: number, renderHz: number, generationMs: number): number {
  const ratio = displayHz / renderHz;
  const whole = Math.round(ratio);
  if (!(whole >= 1) || Math.abs(ratio - whole) > 1e-9) {
    throw new RangeError(
      `frame generation: a display at ${displayHz} Hz over a render at ${renderHz} Hz is not a ` +
        'whole multiple, so generated frames would fall unevenly between rendered ones',
    );
  }
  if (whole === 1) return 0;
  return ((whole - 1) * 1000) / displayHz + generationMs;
}

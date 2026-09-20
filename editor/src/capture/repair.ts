/**
 * The repair brush: painting over what a capture was unsure of, one undoable stroke at a time.
 *
 * **A capture says how much it trusts each texel, and this is the tool that uses that.** The
 * delighting stage writes a confidence beside the material it recovered, and the brush is weighted
 * by it: a texel the capture was sure about resists the brush, and one it was unsure about takes it
 * fully. That is what makes this a *repair* rather than a paint tool — the measurement wins unless
 * the measurement was weak, and somebody fixing a patch of shadow baked into an albedo cannot
 * quietly overwrite the half of the wall that came out right.
 *
 * **What it gives up**: a texel the capture was wrongly confident about cannot be painted over at
 * full strength. That is deliberate and is the trade a repair tool makes; what would make it wrong
 * is a capture whose confidence is not worth trusting, and the way out is then to lower the
 * confidence rather than to make the brush ignore it.
 *
 * **One command per stroke, which is the whole reason a stroke is a thing.** A brush that emitted a
 * command per pointer move fills an undo stack with two hundred entries for one gesture. The stroke
 * remembers what each texel held **the first time it was touched**, so taking it back restores what
 * was there before the gesture rather than a half-painted value from the middle of it.
 */
import type { Command } from '@driftengine/tools';

export interface RepairLayer {
  readonly width: number;
  readonly height: number;
  /** Four a texel, RGBA: what a stroke adds on top of the decoded material. */
  readonly texels: Float32Array;
  /**
   * One a texel: how much the capture trusts what it recovered there, 0 to 1.
   *
   * From the delighting stage's own channel. A layer with no capture behind it is all zeros, and
   * the brush then paints at full strength everywhere — which is right, because nothing was
   * measured there to defend.
   */
  readonly confidence: Float32Array;
}

export function createRepairLayer(
  width: number,
  height: number,
  confidence?: Float32Array,
): RepairLayer {
  const texels = new Float32Array(width * height * 4);
  const trust = confidence ?? new Float32Array(width * height);
  if (trust.length !== width * height) {
    throw new Error(`a ${width}×${height} layer needs ${width * height} confidence values`);
  }
  return { width, height, texels, confidence: trust };
}

export interface BrushSettings {
  /** In texels. A texel at the centre takes the full weight and one at the edge takes none. */
  readonly radius: number;
  /** What the stroke paints towards, RGBA. */
  readonly colour: readonly [number, number, number, number];
  /** How far towards it one touch moves a texel of no confidence at all, 0 to 1. */
  readonly strength: number;
}

export interface Stroke {
  readonly layer: RepairLayer;
  readonly settings: BrushSettings;
  /** Texel index → the four values it held before this stroke touched it. */
  readonly before: Map<number, Float32Array>;
  /** How many texels the stroke has moved. Zero means there is nothing to undo. */
  touched: number;
}

export function beginStroke(layer: RepairLayer, settings: BrushSettings): Stroke {
  return { layer, settings, before: new Map(), touched: 0 };
}

/**
 * Paint at a point in texel coordinates, from the last one to this one.
 *
 * The centre of texel `(x, y)` is `(x + 0.5, y + 0.5)`, so a stroke at an integer coordinate sits
 * on a corner and covers four texels evenly — which is what a caller converting from a hit on a
 * surface hands in, and rounding it here would make the brush jump by a texel.
 */
export function paintAt(stroke: Stroke, x: number, y: number): void {
  const { layer, settings } = stroke;
  const radius = Math.max(0, settings.radius);
  const from = Math.max(0, Math.floor(x - radius));
  const to = Math.min(layer.width - 1, Math.ceil(x + radius));
  const top = Math.max(0, Math.floor(y - radius));
  const bottom = Math.min(layer.height - 1, Math.ceil(y + radius));

  for (let ty = top; ty <= bottom; ty += 1) {
    for (let tx = from; tx <= to; tx += 1) {
      const dx = tx + 0.5 - x;
      const dy = ty + 0.5 - y;
      const away = Math.sqrt(dx * dx + dy * dy);
      if (away > radius) continue;
      const falloff = radius > 0 ? 1 - away / radius : 1;
      const at = ty * layer.width + tx;
      /*
       * **The confidence is what the brush is weighted by**, and it multiplies rather than gates:
       * a texel at 0.5 moves half as far as one at 0, so an edge between a trusted region and an
       * untrusted one is a gradient rather than a cut.
       */
      const trust = layer.confidence[at] as number;
      const weight = settings.strength * falloff * (1 - Math.min(1, Math.max(0, trust)));
      if (weight <= 0) continue;

      if (!stroke.before.has(at)) {
        stroke.before.set(at, layer.texels.slice(at * 4, at * 4 + 4));
        stroke.touched += 1;
      }
      for (let k = 0; k < 4; k += 1) {
        const was = layer.texels[at * 4 + k] as number;
        layer.texels[at * 4 + k] = was + ((settings.colour[k] as number) - was) * weight;
      }
    }
  }
}

/**
 * The stroke as one command, or `null` where it moved nothing.
 *
 * **Null rather than an empty command**, because a click that landed on a fully trusted texel is a
 * click that did nothing, and an undo stack that grows an entry for it makes the previous action
 * take two presses to take back.
 */
export function endStroke(stroke: Stroke): Command | null {
  if (stroke.touched === 0) return null;
  const layer = stroke.layer;
  const after = new Map<number, Float32Array>();
  for (const at of stroke.before.keys()) {
    after.set(at, layer.texels.slice(at * 4, at * 4 + 4));
  }
  const write = (values: ReadonlyMap<number, Float32Array>): void => {
    for (const [at, four] of values) layer.texels.set(four, at * 4);
  };
  return {
    label: `repair ${stroke.touched} texels`,
    /* Already painted by the time this runs, and writing it again has to be harmless. */
    apply: () => write(after),
    revert: () => write(stroke.before),
  };
}

/**
 * What a SAM 2 tracker keeps between frames, and how it chooses what a new frame reads: the host's
 * half of the video memory, as the upstream's `Sam2VideoModel` does it.
 *
 * **A frame reads every prompted frame's memory and the six frames before it** — after it, tracking
 * backwards — each at its distance, which picks a row of a learned temporal table; a prompted frame
 * sits at distance zero, which the upstream indexes as the table's last row. **And the object
 * pointers** of the prompted frames up to it and of the frames up to fifteen before it, each placed
 * by a sine of its distance over the most there could be, projected to the memory's width; a
 * pointer wider than a memory token is cut into as many tokens as it takes.
 *
 * **A memory is kept at bfloat16**, rounded to nearest even as the upstream stores it; what the
 * tracker holds is the rounded value, so a frame reads what the upstream's reads.
 */
import type { WeightSource } from '@driftengine/texture';

import { sam2PointerPositions } from './sam2Positions.ts';

/** One object's output on one frame, as the tracker keeps it. */
export interface Sam2Output {
  /** `[(size / 4)²]`: the mask's logits, −1024 everywhere when the object is absent. */
  readonly lowRes: Float32Array;
  /** `[dim]`: the object pointer, or the learned one for an absent object. */
  readonly pointer: Float32Array;
  readonly score: number;
  /** `[cells, memory.dim]` rounded to bfloat16, once the memory is encoded. */
  memory: Float32Array | null;
}

/** One object's history: its prompted frames' outputs and the frames it was tracked on. */
export interface Sam2History {
  readonly prompted: Map<number, Sam2Output>;
  readonly tracked: Map<number, Sam2Output>;
}

/** Rounds every value to bfloat16, to nearest even, in place. */
export function toBfloat16(values: Float32Array): void {
  const bits = new Uint32Array(values.buffer, values.byteOffset, values.length);
  for (let i = 0; i < bits.length; i += 1) {
    const word = bits[i] as number;
    if ((word & 0x7f800000) === 0x7f800000) {
      bits[i] = (word & 0xffff0000) | ((word & 0xffff) === 0 ? 0 : 0x400000);
      continue;
    }
    bits[i] = ((word + 0x7fff + ((word >>> 16) & 1)) & 0xffff0000) >>> 0;
  }
}

/** The memories a frame reads, each with its distance, prompted frames first. */
export function memoriesFor(
  history: Sam2History,
  frame: number,
  frames: number,
  reverse: boolean,
): readonly (readonly [distance: number, output: Sam2Output])[] {
  const chosen: (readonly [number, Sam2Output])[] = [...history.prompted.values()].map(
    (output) => [0, output] as const,
  );
  for (let distance = frames - 1; distance > 0; distance -= 1) {
    const output = history.tracked.get(reverse ? frame + distance : frame - distance);
    if (output !== undefined) chosen.push([distance, output]);
  }
  return chosen.filter(([, output]) => output.memory !== null);
}

/** The object pointers a frame reads, each with its distance. */
export function pointersFor(
  history: Sam2History,
  frame: number,
  videoFrames: number,
  most: number,
  reverse: boolean,
): {
  readonly distances: readonly number[];
  readonly pointers: readonly Float32Array[];
  readonly span: number;
} {
  const span = Math.min(videoFrames, most);
  const distances: number[] = [];
  const pointers: Float32Array[] = [];
  for (const [at, output] of history.prompted) {
    if (reverse ? at >= frame : at <= frame) {
      distances.push((frame - at) * (reverse ? -1 : 1));
      pointers.push(output.pointer);
    }
  }
  for (let distance = 1; distance < span; distance += 1) {
    const at = reverse ? frame + distance : frame - distance;
    if (at < 0 || at >= videoFrames) break;
    const output = history.tracked.get(at);
    if (output !== undefined) {
      distances.push(distance);
      pointers.push(output.pointer);
    }
  }
  return { distances, pointers, span };
}

/**
 * The memory tokens and their positions a frame's memory attention reads: the frames' cells, each
 * frame's positions its cells' sines plus its distance's temporal row, then the pointers cut into
 * tokens of `width`, each carrying its pointer's projected sine position.
 */
export function memoryTokens(
  weights: WeightSource,
  memories: readonly (readonly [number, Sam2Output])[],
  pointers: {
    readonly distances: readonly number[];
    readonly pointers: readonly Float32Array[];
    readonly span: number;
  },
  cellPositions: Float32Array,
  width: number,
  dim: number,
): {
  readonly memory: Float32Array;
  readonly positions: Float32Array;
  readonly pointerTokens: number;
} {
  const temporal = tensor(weights, 'memory_temporal_positional_encoding');
  const cells = cellPositions.length / width;
  const rows = temporal.length / width;
  const splits = dim / width;
  const pointerTokens = pointers.pointers.length * splits;
  const total = memories.length * cells + pointerTokens;
  const memory = new Float32Array(total * width);
  const positions = new Float32Array(total * width);
  memories.forEach(([distance, output], m) => {
    memory.set(output.memory as Float32Array, m * cells * width);
    const row = ((distance - 1 + rows) % rows) * width;
    for (let i = 0; i < cells * width; i += 1) {
      positions[m * cells * width + i] = Math.fround(
        (cellPositions[i] as number) + (temporal[row + (i % width)] as number),
      );
    }
  });
  if (pointerTokens > 0) {
    const at = memories.length * cells * width;
    const sine = sam2PointerPositions(
      pointers.distances.map((distance) => Math.fround(distance / Math.fround(pointers.span - 1))),
      dim,
    );
    const weight = tensor(weights, 'temporal_positional_encoding_projection_layer.weight');
    const bias = tensor(weights, 'temporal_positional_encoding_projection_layer.bias');
    pointers.pointers.forEach((pointer, p) => {
      for (let s = 0; s < splits; s += 1) {
        const token = at + (p * splits + s) * width;
        memory.set(pointer.subarray(s * width, (s + 1) * width), token);
        for (let o = 0; o < width; o += 1) {
          let sum = bias[o] as number;
          for (let c = 0; c < dim; c += 1)
            sum += (weight[o * dim + c] as number) * (sine[p * dim + c] as number);
          positions[token + o] = Math.fround(sum);
        }
      }
    });
  }
  return { memory, positions, pointerTokens };
}

function tensor(weights: WeightSource, name: string): Float32Array {
  const held = weights.get(name);
  if (held === undefined) throw new Error(`the memory has no "${name}"`);
  return held.data;
}

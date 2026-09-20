/**
 * Encoding a material's channels together, because they are correlated.
 *
 * **This is the claim the DriftTexture design rests on and the one thing about it that has to be
 * measured rather than asserted.** A material's albedo, roughness and normal are not independent
 * pictures of the same surface — they are three descriptions of the same scratches, the same
 * wear, the same grain. Compressing them separately pays for that structure three times. So the
 * encoder fits **one** latent that every channel is decoded from, and the test beside this file
 * measures what that saves against encoding them apart.
 *
 * **And it measures the case where the saving is not there.** Two channels that share nothing need
 * a second latent component and get one; a design that claimed a saving for independent channels
 * would be claiming one that does not exist.
 *
 * ---
 *
 * **A fitted linear decoder rather than a trained one, deliberately.** The plan says to start with
 * a fitted grid-plus-small-network scheme, and the reason is worth keeping: a trained encoder is
 * not needed for the *format* to be correct, and making the format work first means the training
 * in a later wave is an improvement to something shipping rather than a prerequisite for it.
 *
 * The fit is a principal-component basis over the channel vectors, which is exact, deterministic
 * and cheap: the covariance is at most four by four. The "network" is one layer with no hidden
 * width, so `evalNetwork` runs it with no activation on the output — which is what the header of
 * `inference.ts` insists on, and what a linear decode needs anyway.
 *
 * **The dequantisation is folded into the weights.** A latent byte is 0–1; the projection it stands
 * for is somewhere else entirely. Rescaling at decode would be a second place for the range to be
 * wrong, so the scale goes into the weight matrix and the offset into the bias, and the decode is
 * one matrix multiply against exactly what the format already stores.
 */
import {
  DECODE_OP,
  addDecodeNode,
  createDecodeGraph,
  evalNetwork,
  reduceNormalMip,
  needsVarianceMips,
  type ChannelSpec,
  type DecodeGraph,
  type LatentImage,
  type NetworkShape,
} from '@driftengine/texture';

export interface ChannelInput {
  readonly spec: ChannelSpec;
  /** `width * height` values, row-major with x fastest. */
  readonly data: Float32Array;
}

/**
 * The most latent components a sampled texel can carry: three, not four.
 *
 * `SAMPLE_LATENT` fills a four-lane register and the fourth lane is the format's alpha, which an
 * image with fewer channels reads as 1. A fourth component would be read by the network as a
 * constant — silently, and only where the encoder had wanted to use it.
 */
export const LATENT_MAX_COMPONENTS = 3;

/** How much of the channels' variance a component has to explain before it is worth its bytes. */
const COMPONENT_THRESHOLD = 0.01;

export interface EncodedMaterial {
  readonly latent: Uint8Array;
  readonly latentWidth: number;
  readonly latentHeight: number;
  readonly components: number;
  readonly weights: Float32Array;
  readonly shape: NetworkShape;
  readonly graph: DecodeGraph;
  readonly mips: readonly { width: number; height: number; data: Uint8Array }[];
  /**
   * The roughness a variance-preserving mip reduction handed back, or `null`.
   *
   * Non-null exactly when a channel's semantic says mipping it must preserve the normal
   * distribution. A normal map averaged naively loses the disagreement between neighbouring
   * normals, and the surface reads as polished at distance — the roughness is where that
   * disagreement goes instead of being thrown away.
   */
  readonly mipRoughness: Float32Array | null;
}

export interface EncodeMaterialOptions {
  /** 0 to 1. Buys latent resolution, and with it size and accuracy. */
  readonly quality: number;
  /**
   * One of `ADDRESS_MODE`. Defaults to lattice clamp, which is what every bake before 2026-09-17
   * produced. A tiling surface texture wants `ADDRESS_MODE.CENTRE_WRAP`.
   */
  readonly addressMode?: number;
}

/** Latent grid size for a quality, as a fraction of the source. Monotonic by construction. */
function latentSizeFor(width: number, height: number, quality: number): [number, number] {
  const q = Math.min(1, Math.max(0, quality));
  /* An eighth at quality 0 up to the full size at 1, rounded to whole texels and never below 2. */
  const scale = 0.125 + 0.875 * q;
  return [Math.max(2, Math.round(width * scale)), Math.max(2, Math.round(height * scale))];
}

/** Average the source down to the latent grid, by box filter over whole source texels. */
function downsample(
  data: Float32Array,
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
  out: Float32Array,
  stride: number,
  offset: number,
): void {
  for (let y = 0; y < outHeight; y += 1) {
    const y0 = Math.floor((y * height) / outHeight);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / outHeight));
    for (let x = 0; x < outWidth; x += 1) {
      const x0 = Math.floor((x * width) / outWidth);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / outWidth));
      let sum = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          sum += data[sy * width + sx] as number;
          count += 1;
        }
      }
      out[(y * outWidth + x) * stride + offset] = count === 0 ? 0 : sum / count;
    }
  }
}

/**
 * The top `want` principal directions of a small covariance, by power iteration with deflation.
 *
 * Deterministic: the start vector is fixed rather than random, and the iteration count is fixed
 * rather than a convergence test — a bake whose output depends on how quickly something converged
 * is a bake that produces a different container from the same source.
 */
function principalAxes(covariance: Float64Array, size: number, want: number): number[][] {
  const work = Float64Array.from(covariance);
  const axes: number[][] = [];
  const eigenvalues: number[] = [];
  for (let k = 0; k < want; k += 1) {
    let vector: number[] = Array.from({ length: size }, (_, i) => (i === k % size ? 1 : 0.5));
    let value = 0;
    for (let step = 0; step < 64; step += 1) {
      const next = new Array<number>(size).fill(0);
      for (let r = 0; r < size; r += 1) {
        for (let c = 0; c < size; c += 1) {
          next[r] = (next[r] as number) + (work[r * size + c] as number) * (vector[c] as number);
        }
      }
      const length = Math.hypot(...next);
      if (length < 1e-12) break;
      for (let i = 0; i < size; i += 1) next[i] = (next[i] as number) / length;
      vector = next;
      value = length;
    }
    axes.push(vector);
    eigenvalues.push(value);
    /* Deflate, so the next iteration finds the next direction rather than the same one. */
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        work[r * size + c] =
          (work[r * size + c] as number) - value * (vector[r] as number) * (vector[c] as number);
      }
    }
  }
  AXIS_VALUES.length = 0;
  for (const value of eigenvalues) AXIS_VALUES.push(value);
  return axes;
}

/** The eigenvalues the last `principalAxes` found, so the caller can drop the useless ones. */
const AXIS_VALUES: number[] = [];

export function encodeMaterial(
  channels: readonly ChannelInput[],
  width: number,
  height: number,
  options: EncodeMaterialOptions,
): EncodedMaterial {
  if (channels.length === 0) throw new Error('encodeMaterial: no channels');
  const count = channels.length;
  const [latentWidth, latentHeight] = latentSizeFor(width, height, options.quality);
  const texels = latentWidth * latentHeight;

  /* Every channel, averaged onto the latent grid, interleaved so a texel's values are adjacent. */
  const grid = new Float32Array(texels * count);
  for (let c = 0; c < count; c += 1) {
    const channel = channels[c] as ChannelInput;
    downsample(channel.data, width, height, latentWidth, latentHeight, grid, count, c);
  }

  const mean = new Float64Array(count);
  for (let at = 0; at < texels; at += 1) {
    for (let c = 0; c < count; c += 1)
      mean[c] = (mean[c] as number) + (grid[at * count + c] as number);
  }
  for (let c = 0; c < count; c += 1) mean[c] = (mean[c] as number) / texels;

  const covariance = new Float64Array(count * count);
  for (let at = 0; at < texels; at += 1) {
    for (let r = 0; r < count; r += 1) {
      const dr = (grid[at * count + r] as number) - (mean[r] as number);
      for (let c = 0; c < count; c += 1) {
        const dc = (grid[at * count + c] as number) - (mean[c] as number);
        covariance[r * count + c] = (covariance[r * count + c] as number) + dr * dc;
      }
    }
  }
  for (let i = 0; i < covariance.length; i += 1) {
    covariance[i] = (covariance[i] as number) / Math.max(1, texels - 1);
  }

  const wanted = Math.min(count, LATENT_MAX_COMPONENTS);
  const axes = principalAxes(covariance, count, wanted);
  let total = 0;
  for (const value of AXIS_VALUES) total += value;
  /*
   * Keep the components that explain something. Two channels carrying the same structure need one;
   * two carrying different structure need two, and the encoder says so rather than spending bytes
   * either way.
   */
  let components = 0;
  for (let k = 0; k < axes.length; k += 1) {
    if (k > 0 && (AXIS_VALUES[k] as number) < total * COMPONENT_THRESHOLD) break;
    components += 1;
  }

  /* Project every latent texel onto the basis, and find each component's range as we go. */
  const projected = new Float32Array(texels * components);
  const low = new Float64Array(components).fill(Infinity);
  const high = new Float64Array(components).fill(-Infinity);
  for (let at = 0; at < texels; at += 1) {
    for (let k = 0; k < components; k += 1) {
      const axis = axes[k] as number[];
      let value = 0;
      for (let c = 0; c < count; c += 1) {
        value += ((grid[at * count + c] as number) - (mean[c] as number)) * (axis[c] as number);
      }
      projected[at * components + k] = value;
      if (value < (low[k] as number)) low[k] = value;
      if (value > (high[k] as number)) high[k] = value;
    }
  }

  const latent = new Uint8Array(texels * components);
  for (let at = 0; at < texels; at += 1) {
    for (let k = 0; k < components; k += 1) {
      const span = (high[k] as number) - (low[k] as number);
      const normalised =
        span === 0 ? 0 : ((projected[at * components + k] as number) - (low[k] as number)) / span;
      latent[at * components + k] = Math.round(Math.min(1, Math.max(0, normalised)) * 255);
    }
  }

  /*
   * One layer, `components` in, and **one output per texel component rather than one per input
   * channel**. A `ChannelSpec` says which of a texel's four lanes its channel occupies, so a
   * decode that wrote its outputs in the order the channels were handed in would put roughness in
   * the red lane whenever somebody passed roughness first — right in every test that encoded all
   * four in order, wrong for every other caller, and silent either way. Lanes nothing was encoded
   * into stay zero.
   *
   * The dequantisation is folded in: `value = Σ axis[k][c] * (low[k] + q[k] * span[k]) + mean[c]`.
   */
  let outputs = 0;
  for (const channel of channels) outputs = Math.max(outputs, channel.spec.component + 1);
  const shape: NetworkShape = { inputs: components, hidden: [], outputs };
  const weights = new Float32Array(components * outputs + outputs);
  for (let c = 0; c < count; c += 1) {
    const lane = (channels[c] as ChannelInput).spec.component;
    let bias = mean[c] as number;
    for (let k = 0; k < components; k += 1) {
      const axis = axes[k] as number[];
      const span = (high[k] as number) - (low[k] as number);
      weights[lane * components + k] = (axis[c] as number) * span;
      bias += (axis[c] as number) * (low[k] as number);
    }
    weights[components * outputs + lane] = bias;
  }

  const graph = createDecodeGraph(2);
  addDecodeNode(graph, DECODE_OP.SAMPLE_LATENT, 0, 0, 0);
  addDecodeNode(graph, DECODE_OP.EVAL_NETWORK, 0, 0, 1);
  graph.result = 1;
  graph.addressMode = options.addressMode ?? 0;

  const { mips } = buildMips(latent, latentWidth, latentHeight, components);
  const roughness = varianceRoughness(channels, width, height);

  return {
    latent,
    latentWidth,
    latentHeight,
    components,
    weights,
    shape,
    graph,
    mips,
    mipRoughness: roughness,
  };
}

/**
 * The roughness a variance-preserving reduction hands back, or `null` for channels that need none.
 *
 * **Computed from the source channels and not from the latent**, which is the mistake the first
 * version made. The latent is a principal-component projection: three normal channels whose
 * structure is one direction collapse to *one* component, so a check for three latent components
 * finds none and silently skips the reduction on exactly the surfaces that need it. What decides
 * is the semantic of the channels that went in.
 *
 * Averaging normals that disagree flattens them, and a surface that reads as polished at distance
 * is the defect `needsVarianceMips` exists to prevent. The disagreement goes into a roughness the
 * caller ships beside the mip rather than being thrown away.
 */
function varianceRoughness(
  channels: readonly ChannelInput[],
  width: number,
  height: number,
): Float32Array | null {
  const normal = channels.filter((channel) => needsVarianceMips(channel.spec.semantic));
  /* Three components or it is not a normal, and reducing two of one would invent the third. */
  if (normal.length < 3) return null;
  const src = new Float32Array(width * height * 3);
  for (const channel of normal) {
    const component = channel.spec.component;
    if (component > 2) continue;
    for (let at = 0; at < width * height; at += 1) {
      src[at * 3 + component] = channel.data[at] as number;
    }
  }
  const outNormal = new Float32Array(Math.max(1, width >> 1) * Math.max(1, height >> 1) * 3);
  const outRoughness = new Float32Array(Math.max(1, width >> 1) * Math.max(1, height >> 1));
  reduceNormalMip(src, width, height, outNormal, outRoughness);
  return outRoughness;
}

/** The mip chain, halving to one texel. */
function buildMips(
  base: Uint8Array,
  width: number,
  height: number,
  components: number,
): { mips: { width: number; height: number; data: Uint8Array }[] } {
  const mips: { width: number; height: number; data: Uint8Array }[] = [
    { width, height, data: base },
  ];

  let current = mips[0] as { width: number; height: number; data: Uint8Array };
  while (current.width > 1 || current.height > 1) {
    const nextWidth = Math.max(1, current.width >> 1);
    const nextHeight = Math.max(1, current.height >> 1);
    const data = new Uint8Array(nextWidth * nextHeight * components);
    for (let y = 0; y < nextHeight; y += 1) {
      for (let x = 0; x < nextWidth; x += 1) {
        for (let k = 0; k < components; k += 1) {
          let sum = 0;
          let taken = 0;
          for (let dy = 0; dy < 2; dy += 1) {
            for (let dx = 0; dx < 2; dx += 1) {
              const sx = Math.min(current.width - 1, x * 2 + dx);
              const sy = Math.min(current.height - 1, y * 2 + dy);
              sum += current.data[(sy * current.width + sx) * components + k] as number;
              taken += 1;
            }
          }
          data[(y * nextWidth + x) * components + k] = Math.round(sum / taken);
        }
      }
    }
    current = { width: nextWidth, height: nextHeight, data };
    mips.push(current);
  }
  return { mips };
}

/** The latent as the interpreter takes it: normalised floats, `components` wide, with its chain. */
export function latentImageOf(encoded: EncodedMaterial): LatentImage {
  return {
    data: Float32Array.from(encoded.latent, (value) => value / 255),
    width: encoded.latentWidth,
    height: encoded.latentHeight,
    channels: encoded.components,
    mips: encoded.mips.slice(1).map((level) => ({
      data: Float32Array.from(level.data, (value) => value / 255),
      width: level.width,
      height: level.height,
    })),
  };
}

const SCRATCH = new Float32Array(64);
const INPUT = new Float32Array(4);

/** Decode at a coordinate, the way the graph does, without building a resource table. */
export function decodeMaterialAt(
  encoded: EncodedMaterial,
  u: number,
  v: number,
  out: Float32Array,
): void {
  const su = Math.min(1, Math.max(0, u)) * (encoded.latentWidth - 1);
  const sv = Math.min(1, Math.max(0, v)) * (encoded.latentHeight - 1);
  const x0 = Math.floor(su);
  const y0 = Math.floor(sv);
  const x1 = Math.min(encoded.latentWidth - 1, x0 + 1);
  const y1 = Math.min(encoded.latentHeight - 1, y0 + 1);
  const fx = su - x0;
  const fy = sv - y0;
  for (let k = 0; k < encoded.components; k += 1) {
    const at = (x: number, y: number): number =>
      (encoded.latent[(y * encoded.latentWidth + x) * encoded.components + k] as number) / 255;
    const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
    const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
    INPUT[k] = top * (1 - fy) + bottom * fy;
  }
  evalNetwork(encoded.shape, encoded.weights, INPUT, out, SCRATCH);
}

/** What the encoded material costs: the latent, its mips, and the weights. */
export function materialBytes(encoded: EncodedMaterial): number {
  let bytes = 0;
  for (const mip of encoded.mips) bytes += mip.data.byteLength;
  return bytes + encoded.weights.byteLength;
}

import type { MixBus } from '../mix/bus.ts';
import type { AudioListenerGraph } from './listener.ts';

/**
 * First-order ambisonics: a soundfield rather than a source, decoded through virtual speakers.
 *
 * **What this is for, and it is not "a better panner".** A `SpatialSource` is one sound at one
 * point and costs one HRTF convolution. A soundfield is a whole *scene* of sound — a recording of a
 * room, a forest, a street — carried in four channels that hold direction rather than position, and
 * decoded at a **fixed** cost however much is in it. Six convolutions for an entire ambience, where
 * placing the same ambience as separate sources would be six per *sound*.
 *
 * ## The format, and why it is the standard one rather than a convenient one
 *
 * **ACN channel order, SN3D normalisation, four channels: W, Y, Z, X.** That is what a B-format
 * recording carries and what every capture tool emits, so a consumer with a real recording drops it
 * in. A private ordering would be one shuffle nobody could see, in a file this engine did not make.
 * The ambisonic frame is **x forward, y left, z up**, which is also the standard and is *not* this
 * engine's frame; `ambisonicFromWorld` is the one place that conversion happens.
 *
 * ## The decode, and the rotation that is deliberately not here
 *
 * Six virtual speakers on an octahedron — the six world axes — each fed a cardioid of the field and
 * panned through the same HRTF model `SpatialSource` uses. **The decode matrix is constant**, and
 * that is the whole trick: the speakers are fixed in the *world*, so the head's rotation is applied
 * once, by the `AudioListener` the panners already answer to. A decoder that rotated the field as
 * well would apply it twice, and the symptom — a soundfield that counter-rotates at double speed as
 * a player turns — reads as a broken recording rather than as a double transform.
 *
 * *Cost:* a consumer wanting a **head-locked** field, which is what a music bed wants, cannot have
 * one this way, because the listener's own orientation is baked into the render. *What would make
 * this wrong:* that consumer, and the answer then is a second decode with the speakers placed in
 * the head's frame — not a rotation added to this one.
 *
 * **Six rather than four, because the field carries height and a four-speaker horizontal ring
 * throws it away.** A decoder that discarded Z would make the format's third channel decoration,
 * which is the silent no-op this repository's rules exist to prevent. *Cost:* two more HRTF
 * convolutions per field. *What would reverse it:* a measurement showing six is too many on a
 * phone, and the honest answer then is a horizontal-only decode a consumer opts into by name.
 */

/** Where each component sits in an ACN-ordered first-order field. */
export const ACN_W = 0;
export const ACN_Y = 1;
export const ACN_Z = 2;
export const ACN_X = 3;

/** How many channels a first-order field carries. */
export const FOA_CHANNELS = 4;

/**
 * The virtual speaker layout: the six world axes, in this engine's own frame.
 *
 * An octahedron is a spherical 2-design, so the projection decode below reconstructs a first-order
 * field exactly rather than approximately — which is the reason to spend six on a shape rather than
 * six on a ring.
 */
export const FOA_SPEAKERS: readonly (readonly [number, number, number])[] = [
  [0, 0, -1],
  [0, 0, 1],
  [-1, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
];

/**
 * A direction in this engine's world axes, as the ambisonic frame reads it.
 *
 * The engine is **y up and −z forward**, the OpenGL convention every other part of it uses.
 * Ambisonics is **x forward, y left, z up**. So forward is `−z`, left is `−x`, and up is `y`, and
 * this is the one function that knows it: a second conversion anywhere would be the drift this
 * repository has been bitten by twice.
 */
export function ambisonicFromWorld(x: number, y: number, z: number, out: Float32Array): void {
  out[0] = -z;
  out[1] = -x;
  out[2] = y;
}

/**
 * Encode a mono signal arriving from a world direction into a first-order field.
 *
 * `dir` need not be unit; it is normalised here, because a caller handing a difference of two
 * positions is the ordinary case and a caller who normalised first pays one square root twice.
 * A zero direction encodes as omnidirectional — all `W`, no direction — which is what a sound with
 * no bearing *is*, rather than a NaN.
 */
export function encodeFoa(
  gain: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  out: Float32Array,
  at = 0,
): void {
  const length = Math.hypot(dirX, dirY, dirZ);
  out[at + ACN_W] = gain;
  if (!(length > 0)) {
    out[at + ACN_Y] = 0;
    out[at + ACN_Z] = 0;
    out[at + ACN_X] = 0;
    return;
  }
  ambisonicFromWorld(dirX / length, dirY / length, dirZ / length, DIRECTION);
  out[at + ACN_X] = gain * (DIRECTION[0] as number);
  out[at + ACN_Y] = gain * (DIRECTION[1] as number);
  out[at + ACN_Z] = gain * (DIRECTION[2] as number);
}

/**
 * How much of a field a speaker in a world direction should be given.
 *
 * The projection decode: a **cardioid** pointed at the speaker, `(W + d · (X, Y, Z)) / speakers`.
 * For a field holding one source it is unity where the speaker faces the source, zero on the
 * antipode, and the gains over an octahedron sum to exactly one — so a field is neither louder nor
 * quieter for having been decoded.
 *
 * `dir` is in **world** axes and is converted here. It need not be unit.
 */
export function foaDecodeGain(
  field: ArrayLike<number>,
  at: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  speakers: number,
): number {
  const length = Math.hypot(dirX, dirY, dirZ);
  if (!(length > 0) || !(speakers > 0)) return 0;
  ambisonicFromWorld(dirX / length, dirY / length, dirZ / length, DIRECTION);
  const w = field[at + ACN_W] ?? 0;
  const x = field[at + ACN_X] ?? 0;
  const y = field[at + ACN_Y] ?? 0;
  const z = field[at + ACN_Z] ?? 0;
  const dot =
    (DIRECTION[0] as number) * x + (DIRECTION[1] as number) * y + (DIRECTION[2] as number) * z;
  return (w + dot) / speakers;
}

/**
 * The decode matrix: four coefficients per speaker, in ACN order, ready to be uploaded as gains.
 *
 * **Built once, because it never changes.** The speakers are world-fixed and the head's rotation is
 * the `AudioListener`'s to apply, so there is nothing here that depends on where anybody is looking
 * — which is what makes a soundfield cost a fixed number of nodes rather than a fixed number of
 * per-frame parameter writes.
 */
export function foaDecodeMatrix(
  speakers: readonly (readonly [number, number, number])[] = FOA_SPEAKERS,
): Float32Array {
  const matrix = new Float32Array(speakers.length * FOA_CHANNELS);
  for (let s = 0; s < speakers.length; s++) {
    const speaker = speakers[s];
    if (speaker === undefined) continue;
    ambisonicFromWorld(speaker[0], speaker[1], speaker[2], DIRECTION);
    const at = s * FOA_CHANNELS;
    matrix[at + ACN_W] = 1 / speakers.length;
    matrix[at + ACN_X] = (DIRECTION[0] as number) / speakers.length;
    matrix[at + ACN_Y] = (DIRECTION[1] as number) / speakers.length;
    matrix[at + ACN_Z] = (DIRECTION[2] as number) / speakers.length;
  }
  return matrix;
}

export interface AmbisonicOptions {
  /** Where this lands in the mix. The console's `effects` bus when omitted. */
  readonly bus?: MixBus;
  readonly loop?: boolean;
  /** How far from the listener's head the virtual speakers sit, in metres. */
  readonly radius?: number;
}

/**
 * A default that keeps the panners' own distance attenuation out of the way.
 *
 * The speakers are a rendering construct rather than objects in the world, so the distance model
 * must not fade them: one metre is the panners' own `refDistance`, where the inverse law is exactly
 * unity. A larger radius would quietly attenuate every soundfield in the scene.
 */
const SPEAKER_RADIUS = 1;

/** Scratch for the axis conversion, claimed once: every function above is on a per-frame path. */
const DIRECTION = new Float32Array(3);

export class AmbisonicSoundfield {
  private readonly node: AudioBufferSourceNode;
  private readonly splitter: ChannelSplitterNode;
  private readonly level: GainNode;
  private readonly speakerSums: GainNode[] = [];
  private readonly panners: PannerNode[] = [];
  private readonly coefficients: GainNode[] = [];
  private started = false;
  private stopped = false;
  private radius: number;

  /**
   * **Refused at construction rather than decoded wrongly.**
   *
   * A buffer with the wrong channel count is a file that is not B-format, and a decoder that took
   * the first four channels of a stereo file would produce a plausible, silent-in-two-thirds
   * result. The house rule is fail fast and loud at init; this is init.
   */
  constructor(
    private readonly listener: AudioListenerGraph,
    buffer: AudioBuffer,
    options: AmbisonicOptions = {},
  ) {
    if (buffer.numberOfChannels !== FOA_CHANNELS) {
      throw new Error(
        `a first-order soundfield needs ${FOA_CHANNELS} channels in ACN order (W, Y, Z, X) and ` +
          `this buffer has ${buffer.numberOfChannels}. A stereo or mono file is a source, not a ` +
          'field: use createSpatialSource.',
      );
    }

    const mix = listener.console;
    const context = mix.context;
    this.radius = options.radius ?? SPEAKER_RADIUS;

    this.node = context.createBufferSource();
    this.node.buffer = buffer;
    this.node.loop = options.loop === true;
    /*
     * Discrete, not `speakers`. The default interpretation would *up-mix or down-mix* four channels
     * into whatever it thought they meant — and W, Y, Z, X are not left, right, centre and low
     * frequency. Mixed that way a field comes out as an unrecognisable blur that still plays.
     */
    this.node.channelCount = FOA_CHANNELS;
    this.node.channelCountMode = 'explicit';
    this.node.channelInterpretation = 'discrete';

    this.splitter = context.createChannelSplitter(FOA_CHANNELS);
    this.node.connect(this.splitter);

    this.level = context.createGain();
    this.level.gain.value = 1;
    const bus = options.bus ?? mix.bus('effects');
    this.level.connect(bus.input);

    const matrix = foaDecodeMatrix();
    for (let s = 0; s < FOA_SPEAKERS.length; s++) {
      const sum = context.createGain();
      sum.gain.value = 1;
      const panner = context.createPanner();
      /* The same head model a placed source uses, for the same reason: a virtual speaker behind
         the listener has to sound behind them or the decode has bought nothing. */
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 1;
      panner.rolloffFactor = 1;
      sum.connect(panner);
      panner.connect(this.level);
      this.speakerSums.push(sum);
      this.panners.push(panner);

      for (let c = 0; c < FOA_CHANNELS; c++) {
        const gain = context.createGain();
        gain.gain.value = matrix[s * FOA_CHANNELS + c] ?? 0;
        this.splitter.connect(gain, c);
        gain.connect(sum);
        this.coefficients.push(gain);
      }
    }

    this.place(listener.x, listener.y, listener.z);
  }

  /**
   * Put the speaker rig around a point — the listener's head.
   *
   * Called whenever the listener moves. It writes six positions and nothing else: the decode does
   * not depend on where anybody is looking, so there is no matrix to recompute here.
   */
  place(x: number, y: number, z: number): void {
    for (let s = 0; s < this.panners.length; s++) {
      const speaker = FOA_SPEAKERS[s];
      const panner = this.panners[s];
      if (speaker === undefined || panner === undefined) continue;
      writePosition(
        panner,
        x + speaker[0] * this.radius,
        y + speaker[1] * this.radius,
        z + speaker[2] * this.radius,
      );
    }
  }

  /** Follow the listener this field was built against. The ordinary per-frame call. */
  follow(): void {
    this.place(this.listener.x, this.listener.y, this.listener.z);
  }

  /** How loud the whole field is, before the bus. */
  setGain(gain: number): void {
    this.level.gain.value = Number.isFinite(gain) ? Math.max(0, gain) : 0;
  }

  start(when = 0): void {
    if (this.started) return;
    this.started = true;
    this.node.start(when);
  }

  stop(): void {
    if (!this.started || this.stopped) return;
    this.stopped = true;
    try {
      this.node.stop();
    } catch {
      // Already ended. Nothing to undo about a node we were about to discard.
    }
  }

  dispose(): void {
    this.stop();
    try {
      for (const gain of this.coefficients) gain.disconnect();
      for (const sum of this.speakerSums) sum.disconnect();
      for (const panner of this.panners) panner.disconnect();
      this.splitter.disconnect();
      this.level.disconnect();
      this.node.disconnect();
    } catch {
      // The graph was torn down under us; there is nothing left to disconnect from.
    }
  }
}

/**
 * Where a panner thinks it is, through whichever surface the browser has.
 *
 * The same pair `SpatialSource.writePosition` uses and for the same reason: the deprecated setter
 * steps where the parameters can glide, and a browser has one or the other.
 */
function writePosition(panner: PannerNode, x: number, y: number, z: number): void {
  const modern = panner as unknown as Record<string, { value: number } | undefined>;
  if (modern.positionX !== undefined) {
    modern.positionX.value = x;
    if (modern.positionY !== undefined) modern.positionY.value = y;
    if (modern.positionZ !== undefined) modern.positionZ.value = z;
    return;
  }
  (panner as unknown as { setPosition?: (x: number, y: number, z: number) => void }).setPosition?.(
    x,
    y,
    z,
  );
}

/** Build a soundfield and place it around the listener. The shape `createSpatialSource` sets. */
export function createAmbisonicSoundfield(
  listener: AudioListenerGraph,
  buffer: AudioBuffer,
  options: AmbisonicOptions = {},
): AmbisonicSoundfield {
  return new AmbisonicSoundfield(listener, buffer, options);
}

/**
 * Placeholder buffer synthesis: the stand-in a sound slot uses until a real
 * file exists for it.
 *
 * Deliberately plain, and generic to any game. These exist so a build is
 * audible and its timing can be felt while the real sounds are being made —
 * they are not an attempt at the final thing, and treating them as one is the
 * mistake the whole slot arrangement is designed to prevent.
 */

/** A short noise burst shaped by an envelope — the workhorse placeholder. */
/**
 * Makeup gain for the three-pole cascade below.
 *
 * **Why three poles and not one.** Every filtered-noise sound in this engine ran
 * through a single pole, and a single pole is only 6 dB per octave — so at three or
 * four octaves above its own cutoff it has taken off barely twenty decibels, and what
 * survives is still broadband. Which is exactly what a listener hears: white noise
 * everywhere, a waterfall that sounds like static. Lowering the cutoff did not fix it
 * and could not — the leak is the slope, not the corner.
 *
 * Three poles in series is 18 dB per octave, which is a filter you can actually hear
 * working. A landing becomes a thud, a slide becomes a scrape, and a waterfall becomes
 * water rather than static with a swell on it — and every existing caller gets it
 * without changing a single one of their numbers, because the corner frequency they
 * each chose is unchanged. Only the slope past it moved.
 *
 * The cascade costs amplitude — each stage takes another bite out of the noise's own
 * power — so this puts the level back. Measured to bring a mid-range colour term out
 * at roughly what one pole used to.
 */
const POLE_MAKEUP = 2.6;

export function noiseBuffer(
  ctx: BaseAudioContext,
  seconds: number,
  decay: number,
  colour: (t: number) => number,
): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(rate * seconds));
  const buffer = ctx.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  let p1 = 0;
  let p2 = 0;
  let p3 = 0;
  for (let i = 0; i < length; i++) {
    const t = i / length;
    const white = Math.random() * 2 - 1;
    const c = colour(t);
    // Three poles, not one. See POLE_MAKEUP.
    p1 += (white - p1) * c;
    p2 += (p1 - p2) * c;
    p3 += (p2 - p3) * c;
    data[i] = p3 * POLE_MAKEUP * (1 - t) ** decay;
  }
  return buffer;
}

/** A pitched blip: a sine sweep, for anything that should read as a signal. */
export function toneBuffer(
  ctx: BaseAudioContext,
  seconds: number,
  fromHz: number,
  toHz: number,
  decay: number,
): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(rate * seconds));
  const buffer = ctx.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  let phase = 0;
  for (let i = 0; i < length; i++) {
    const t = i / length;
    const hz = fromHz + (toHz - fromHz) * t;
    phase += (hz / rate) * Math.PI * 2;
    data[i] = Math.sin(phase) * (1 - t) ** decay * 0.6;
  }
  return buffer;
}

/**
 * A struck metal ring: inharmonic partials over a bright transient.
 *
 * The one thing that separates metal from every other synthesised hit is that its
 * partials are **not** whole multiples of the fundamental. A harmonic stack reads as a
 * bell at best and an organ at worst; detuning the partials by irrational-ish ratios
 * is what makes the ear hear a struck bar. The ratios below are near a free bar's own
 * modes rather than exact, which keeps it from ringing like a tuned instrument.
 *
 * Each partial decays at its own rate, faster the higher it is, because that is what
 * real metal does and it is most of why a synthesised clang usually sounds like a
 * synthesiser: hold the top partials as long as the bottom and you get a chime.
 *
 * @param seconds Total length. Metal rings on; too short and it is a click.
 * @param baseHz The fundamental the partials are built off.
 * @param decay How fast the whole thing dies away.
 */
export function metalBuffer(
  ctx: BaseAudioContext,
  seconds: number,
  baseHz: number,
  decay: number,
): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(rate * seconds));
  const buffer = ctx.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  // Inharmonic on purpose. Whole multiples of these would be a bell.
  const partials = [1, 2.76, 5.4, 8.93, 13.34, 18.64];
  const phases = new Float64Array(partials.length);

  for (let i = 0; i < length; i++) {
    const t = i / length;
    let sample = 0;
    for (let p = 0; p < partials.length; p++) {
      const ratio = partials[p] ?? 1;
      phases[p] = (phases[p] ?? 0) + ((baseHz * ratio) / rate) * Math.PI * 2;
      // Higher partials die first, which is the whole difference between struck
      // metal and a chime.
      const fade = (1 - t) ** (decay * (1 + p * 0.55));
      sample += (Math.sin(phases[p] ?? 0) * fade) / (1 + p * 0.9);
    }
    // A short noise transient: the strike itself, before anything has begun to ring.
    const strike = t < 0.012 ? (Math.random() * 2 - 1) * (1 - t / 0.012) * 0.7 : 0;
    // Body over transient: the ring is the part that says *metal*, so it is weighted
    // above the strike rather than under it.
    data[i] = (sample * 0.52 + strike) * (1 - t) ** 0.6;
  }
  return buffer;
}

/** Silence, for a slot whose only honest placeholder is nothing at all. */
export function silentBuffer(ctx: BaseAudioContext): AudioBuffer {
  return ctx.createBuffer(1, 1, ctx.sampleRate);
}

/**
 * A continuous environmental bed, built to loop without a seam.
 *
 * Three things make a loop audible as a loop, and all three are handled here.
 * The filters are warmed up before anything is recorded, so the buffer does not
 * begin at silence and fade in. The join is crossfaded with equal-power
 * weights, so the wrap has neither a click nor the ~3 dB hole a linear
 * crossfade of noise leaves in the middle. And any slow swell is placed at a
 * whole number of cycles per loop — the same reason the wind field uses integer
 * harmonics — so it arrives back exactly where it started instead of turning
 * the wrap into a lurch far more noticeable than the noise it rides on.
 */
export interface AmbienceOptions {
  /** Loop length. Longer costs memory but takes longer to recognise. */
  seconds: number;
  /** One-pole low-pass coefficient, 0–1. Lower is darker. */
  colour: number;
  /**
   * Second, slower follower subtracted from the first — a high-pass. Removes
   * the rumble that otherwise dominates any heavily filtered noise.
   */
  bodyCut?: number;
  /** Slow level movement: how deep, 0–1, and how many whole cycles per loop. */
  swellDepth?: number;
  swellCycles?: number;
  /** Sharp transients per second, and how fast each one decays. */
  transientRate?: number;
  transientDecay?: number;
  /** Peak amplitude of the finished bed. */
  gain?: number;
}

export function ambienceBuffer(ctx: BaseAudioContext, options: AmbienceOptions): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(rate * options.seconds));
  // Fade over an eighth of the loop: long enough to hide the join in noise,
  // short enough that most of the buffer is still unblended material.
  const fade = Math.max(1, Math.min(Math.floor(length / 8), Math.floor(rate * 0.35)));

  const colour = options.colour;
  const bodyCut = options.bodyCut ?? 0;
  const transientRate = options.transientRate ?? 0;
  const transientDecay = options.transientDecay ?? 60;
  const transientChance = transientRate / rate;

  let p1 = 0;
  let p2 = 0;
  let low = 0;
  let body = 0;
  let transient = 0;

  const step = (): number => {
    const white = Math.random() * 2 - 1;
    // Three poles, as in `noiseBuffer` and for the same reason.
    p1 += (white - p1) * colour;
    p2 += (p1 - p2) * colour;
    low += (p2 - low) * colour;
    body += (low - body) * bodyCut;
    // A spark is a step that decays away, not a tone.
    if (transientChance > 0 && Math.random() < transientChance) {
      transient = (Math.random() * 2 - 1) * 0.9;
    }
    transient -= transient * (transientDecay / rate);
    return (low - body) * POLE_MAKEUP + transient;
  };

  /*
   * Settle the filters first. Both start at zero, and the slow one — the
   * high-pass follower — takes a second or more of signal to reach its working
   * point. Recording from cold puts an audible swell at the head of the buffer
   * that the crossfade then smears across the join.
   */
  const slowest = Math.max(Math.min(bodyCut > 0 ? bodyCut : colour, colour), 1e-4);
  const warmup = Math.min(Math.ceil(5 / slowest), rate * 3);
  for (let i = 0; i < warmup; i++) step();

  const raw = new Float32Array(length + fade);
  for (let i = 0; i < raw.length; i++) raw[i] = step();

  const buffer = ctx.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  const gain = options.gain ?? 1;
  const swellDepth = options.swellDepth ?? 0;
  const swellCycles = Math.max(0, Math.round(options.swellCycles ?? 0));

  for (let i = 0; i < length; i++) {
    let sample = raw[i] ?? 0;
    if (i < fade) {
      // Equal power, so noise keeps its level straight through the join.
      const t = i / fade;
      sample = sample * Math.sqrt(t) + (raw[length + i] ?? 0) * Math.sqrt(1 - t);
    }
    const swell =
      swellCycles > 0
        ? 1 -
          swellDepth +
          swellDepth * (0.5 + 0.5 * Math.sin((i / length) * swellCycles * Math.PI * 2))
        : 1;
    data[i] = sample * swell * gain;
  }
  return buffer;
}

/**
 * Fire: a broadband hiss with sparks over it.
 *
 * The hiss alone reads as static; the sparks are what make it fire, and they
 * have to be irregular — anything periodic turns a hearth into a machine.
 */
export function fireLoopBuffer(ctx: BaseAudioContext, seconds = 4): AudioBuffer {
  return ambienceBuffer(ctx, {
    seconds,
    colour: 0.22,
    bodyCut: 0.004,
    swellDepth: 0.25,
    swellCycles: 3,
    transientRate: 26,
    transientDecay: 900,
    gain: 0.5,
  });
}

/**
 * Water: a slow, dark wash that breathes.
 *
 * Nearly all the energy is low, and the swell is the part carrying the meaning
 * — flat filtered noise at this darkness is indistinguishable from a fan.
 */
export function waterLoopBuffer(ctx: BaseAudioContext, seconds = 6): AudioBuffer {
  return ambienceBuffer(ctx, {
    seconds,
    colour: 0.05,
    bodyCut: 0.0015,
    swellDepth: 0.55,
    swellCycles: 2,
    gain: 0.85,
  });
}

/** Wind: mid-heavy rush, swelling harder and faster than water. */
export function windLoopBuffer(ctx: BaseAudioContext, seconds = 5): AudioBuffer {
  return ambienceBuffer(ctx, {
    seconds,
    colour: 0.1,
    bodyCut: 0.02,
    swellDepth: 0.7,
    swellCycles: 3,
    gain: 0.6,
  });
}

/**
 * A skate scrape: the sound of an edge losing its bite.
 *
 * Bright filtered noise with a slow chatter in it, so it reads as *grinding*
 * rather than as hiss. The caller sweeps its playback rate with the drift's
 * charge, which is what turns a texture into a meter you can hear — the pitch
 * rising under you is the drift telling you how long you have held it.
 *
 * Loops without a seam: the chatter completes a whole number of cycles across
 * the buffer, and the tail crossfades into the head.
 */
export function driftScrapeBuffer(ctx: BaseAudioContext, seconds = 1.6): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(seconds * rate));
  const buffer = ctx.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);

  /*
   * Two poles of a resonant band, run over white noise.
   *
   * `f` sets where the band sits and is the whole difference between a scrape and a
   * hiss. It was 0.34 — high enough that most of what survived the filter was still
   * broadband top end, so a slide read as plain white noise. Down at 0.15 the band is
   * in the low mids where a hard wheel on
   * stone actually lives, and the tighter `q` narrows it further, so what comes
   * through reads as a *material* being dragged rather than as noise being played.
   */
  let low = 0;
  let band = 0;
  const f = 0.15;
  const q = 0.14;
  /** Whole cycles across the buffer, so the chatter meets itself at the loop. */
  const chatterCycles = 11;

  let seed = 0x2f6e2b1;
  const noise = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed / 0x7fffffff) % 1;
  };

  for (let i = 0; i < length; i++) {
    const t = i / length;
    const chatter = 0.62 + 0.38 * Math.abs(Math.sin(Math.PI * chatterCycles * t));
    const input = noise();
    low += f * band;
    band += f * (input - low - q * band);
    // Louder per unit of noise than before, because a narrower band passes far less
    // through: the same 0.55 on this filter is a slide nobody can hear.
    data[i] = band * chatter * 1.5;
  }

  // Equal-power crossfade of the tail into the head.
  const fade = Math.min(Math.floor(rate * 0.04), Math.floor(length / 4));
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    const a = Math.cos(t * Math.PI * 0.5);
    const b = Math.sin(t * Math.PI * 0.5);
    const head = data[i] ?? 0;
    const tail = data[length - fade + i] ?? 0;
    data[i] = head * b + tail * a;
  }
  return buffer;
}

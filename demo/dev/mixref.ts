/**
 * One mix, rendered offline, so a rewrite of it can be proved rather than believed.
 *
 * **This page exists because audio has no picture.** Every other change in this repository is
 * settled by photographing it; a mix cannot be, so the evidence is samples — and samples are only
 * evidence while two renders of one build agree exactly, which an `OfflineAudioContext` does and a
 * live one never could.
 *
 * `scripts/audio-baseline.mjs` drives this before the mix is rewritten and freezes what comes back.
 * `scripts/audio-check.mjs` drives it afterwards and compares. Nothing here is engine API.
 *
 * **Everything is scheduled through `at()` rather than left to "now".** Offline there is no now:
 * `currentTime` holds at zero for the whole time the timeline is being described, so a move left to
 * the clock lands on instant zero along with every other move, and the render is a single chord of
 * every change the mix was ever asked for.
 */
import {
  AudioGraph,
  MixConsole,
  addReverbZone,
  createListener,
  createSpatialSource,
} from '../../packages/audio/src/index';

/** 48 kHz, because the measured figures this feeds are quoted in samples at that rate. */
const RATE = 48000;
/** Four seconds: long enough to carry the four scheduled moves and their ramps. */
const SECONDS = 4;

/**
 * The signal under test: two partials, built from a formula.
 *
 * **Not from `synth.ts`, deliberately.** A baseline that moves when synthesis is tuned is not a
 * baseline — it is a second thing to keep in sync, and the first tuning pass on a placeholder
 * buffer would be reported as the mix having changed. Two sine partials are reproducible by
 * arithmetic on any machine, at any sample rate, forever.
 *
 * A fundamental at 110 Hz and a partial at 277: low enough that the lift's high-pass and the slam's
 * low shelf both have something to act on, and not harmonically related, so a filter moving is
 * audible in the spectrum rather than hidden under a harmonic.
 */
function stem(context: BaseAudioContext): AudioBuffer {
  const buffer = context.createBuffer(1, RATE * SECONDS, RATE);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    const t = i / RATE;
    data[i] = 0.4 * Math.sin(2 * Math.PI * 110 * t) + 0.2 * Math.sin(2 * Math.PI * 277 * t);
  }
  return buffer;
}

/** The rendered channels, as base64 of their raw float bytes. See `channels` for why. */
export interface RenderedMix {
  readonly left: string;
  readonly right: string;
  readonly length: number;
  readonly sampleRate: number;
}

/**
 * Both channels as base64, rather than as arrays of numbers.
 *
 * A four-second stereo render is 384,000 floats. As JSON numbers that is nearly three megabytes of
 * decimal text crossing the debugging protocol for a value the caller immediately turns back into
 * floats; as base64 of the underlying bytes it is a third of that and it is *exact*, which decimal
 * text is not obliged to be. The digest is computed on the other side, in one place, because two
 * implementations of one decision drift.
 */
function channels(rendered: AudioBuffer): RenderedMix {
  const encode = (data: Float32Array): string => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0);
    return btoa(binary);
  };
  return {
    left: encode(rendered.getChannelData(0)),
    right: encode(rendered.getChannelData(1)),
    length: rendered.length,
    sampleRate: rendered.sampleRate,
  };
}

/**
 * The mix, with a fixed sequence of moves on an explicit clock.
 *
 * The moves are chosen to drive every stage the graph has: both stem levels, the master filter, the
 * lift, the slam, the transport rate and a fade. **A stage no move reaches is a stage the identity
 * gate cannot see**, and the whole point of this render is that it exercises the parts a rewrite
 * could plausibly get wrong.
 *
 * The sends stay at zero, and that is load-bearing rather than incidental: `impulseResponse` fills
 * a convolver from `Math.random`, so a render carrying wet signal is a different render every time.
 * A send at zero contributes exactly zero — the identity holds through multiplication by zero
 * rather than through luck — and `audio-baseline.mjs` renders twice and compares before it trusts
 * any of this.
 */
export async function renderMixRef(): Promise<RenderedMix> {
  const context = new OfflineAudioContext(2, RATE * SECONDS, RATE);
  const graph = await AudioGraph.create({
    stemCount: 2,
    context,
    levels: { music: 0.8, effects: 0.6 },
  });
  if (graph === null) throw new Error('no graph: this browser gave no audio at all');

  const buffer = stem(context);
  graph.loadStem(0, buffer);
  graph.loadStem(1, buffer);

  graph.at(0);
  graph.setStemGain(0, 1);
  graph.setStemGain(1, 0.5);
  graph.start();

  graph.at(1);
  graph.layout.masterFilter.setCutoff(2000);
  graph.layout.lift.setAmount(0.5);

  graph.at(2);
  graph.layout.slam.strike(1);
  graph.setPlaybackRate(1.2);

  graph.at(3);
  /*
   * A duck rather than a fade to an absolute level: 0.25 of a music bus sitting at 0.8 is the 0.2
   * the removed `fadeMusic` was asked for. **This is where the render stopped matching the frozen
   * baseline, and it is a fix rather than a regression** — `fadeMusic` scheduled on
   * `context.currentTime`, which offline is zero for the whole time a timeline is being described,
   * so the fade landed at instant zero however late it was asked for. A bus schedules on the mix's
   * clock, so it lands here, at three seconds, where it was asked for.
   */
  graph.layout.music.duck(0.25, 0.5);

  return channels(await context.startRendering());
}

(globalThis as { __renderMixRef?: typeof renderMixRef }).__renderMixRef = renderMixRef;

/*
 * ---------------------------------------------------------------------------------------------
 * The scenes `scripts/audio-check.mjs` measures.
 *
 * Each renders offline and hands back samples. **Every one that can carry wet signal is built on a
 * seeded generator**, because `impulseResponse` fills a convolver from whatever random source it is
 * given and an unseeded one builds a different hall every time — which would make a reverb tail
 * unassertable and would look, from the outside, exactly like a flaky test.
 * ---------------------------------------------------------------------------------------------
 */

/**
 * A small deterministic generator, so a reverb is the same reverb on every run.
 *
 * mulberry32. Not chosen for statistical quality — it is filling a noise burst that gets an
 * exponential envelope — but for being four lines that any reader can check by eye.
 */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One sample at full scale: the cleanest thing to measure a delay or a decay against. */
function impulse(context: BaseAudioContext): AudioBuffer {
  const buffer = context.createBuffer(1, 128, context.sampleRate);
  buffer.getChannelData(0)[0] = 1;
  return buffer;
}

/** A steady tone, for measuring a pitch shift by counting how often it crosses zero. */
function tone(context: BaseAudioContext, hz: number, seconds: number): AudioBuffer {
  const length = Math.floor(context.sampleRate * seconds);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = Math.sin((2 * Math.PI * hz * i) / context.sampleRate);
  }
  return buffer;
}

/** A console on an offline context, with a listener already placed and still. */
function placedListener(context: BaseAudioContext, seed = 1) {
  const mix = new MixConsole(context, { random: seeded(seed) });
  const listener = createListener(mix);
  listener.set(0, 0, 0, 0, 0, 1 / 60);
  listener.set(0, 0, 0, 0, 0, 1 / 60);
  return { mix, listener };
}

/** A source at `x` metres to the side, heard through the head model. */
async function renderHrtf(x: number): Promise<RenderedMix> {
  const context = new OfflineAudioContext(2, RATE / 2, RATE);
  const { listener } = placedListener(context);
  const source = createSpatialSource(listener, impulse(context));
  source.place(x, 0, 0, 1 / 60);
  source.start(0);
  return channels(await context.startRendering());
}

/** The same source, blocked by `amount` of wall. */
async function renderOcclusion(amount: number): Promise<RenderedMix> {
  const context = new OfflineAudioContext(2, RATE / 2, RATE);
  const { listener } = placedListener(context);
  const source = createSpatialSource(listener, impulse(context), { occlusionRate: 1000 });
  source.setOcclusion(amount);
  // A whole second of step, so the smoothing has arrived before anything is rendered.
  source.place(0, 0, -2, 1);
  source.place(0, 0, -2, 1);
  source.start(0);
  return channels(await context.startRendering());
}

/**
 * An impulse through a zone, rendered long enough to hear the tail end.
 *
 * The listener stands at the centre, so the zone is at full wet and the measurement is of the
 * convolver rather than of the crossfade.
 */
async function renderZone(seconds: number, decay: number): Promise<RenderedMix> {
  const context = new OfflineAudioContext(2, RATE * 4, RATE);
  const { mix, listener } = placedListener(context);
  const zone = addReverbZone(
    listener,
    'room',
    { x: 0, y: 0, z: 0, radius: 10, blend: 2 },
    {
      seconds,
      decay,
      wet: 1,
    },
  );
  listener.set(0, 0, 0, 0, 0, 1 / 60);
  // Dry out of the way: what is being measured is the tail, not the hit that caused it.
  zone.from.setLevel(0);
  const node = context.createBufferSource();
  node.buffer = impulse(context);
  node.connect(zone.bus.input);
  node.start(0);
  return channels(await context.startRendering());
}

/**
 * A tone on a source moving at a constant speed along the line of sight.
 *
 * Rendered rather than asked: the pitch is measured out of the samples by counting zero crossings,
 * so what is asserted is what a browser produced and not what our own arithmetic said it would.
 */
async function renderDoppler(metresPerSecond: number): Promise<RenderedMix> {
  const context = new OfflineAudioContext(2, RATE, RATE);
  const { listener } = placedListener(context);
  const source = createSpatialSource(listener, tone(context, 1000, 1), {
    doppler: true,
    maxDopplerCents: 1200,
    refDistance: 100,
    rolloff: 0,
  });
  source.place(0, 0, -100, 1 / 60);
  source.place(0, 0, -100 + metresPerSecond / 60, 1 / 60);
  source.start(0);
  return channels(await context.startRendering());
}

/** A two-level tree, with one of four states applied. */
async function renderBuses(mode: string): Promise<RenderedMix> {
  const context = new OfflineAudioContext(2, RATE / 2, RATE);
  const mix = new MixConsole(context, { random: seeded(2) });
  const group = mix.bus('group');
  const left = mix.bus('left', { parent: group });
  const right = mix.bus('right', { parent: group });

  if (mode === 'solo-left') left.setSolo(true);
  if (mode === 'mute-left') left.setMute(true);
  if (mode === 'snapshot') {
    left.setLevel(0.25);
    mix.snapshot('quiet');
    left.setLevel(1);
    mix.recall('quiet');
  }

  /*
   * Started **after** the state is applied and after its ramp has settled, which the first version
   * of this scene did not do — and every mode then measured identical, because an impulse at
   * instant zero samples the fader before a single `setTargetAtTime` has moved it. The mute check
   * passed while measuring nothing at all, which is the more dangerous half of that mistake.
   */
  const SETTLED = 0.3;
  for (const bus of [left, right]) {
    const node = context.createBufferSource();
    node.buffer = impulse(context);
    node.connect(bus.input);
    node.start(SETTLED);
  }
  return channels(await context.startRendering());
}

const exposed = globalThis as Record<string, unknown>;
exposed.__renderMixRef = renderMixRef;
exposed.__renderHrtf = renderHrtf;
exposed.__renderOcclusion = renderOcclusion;
exposed.__renderZone = renderZone;
exposed.__renderDoppler = renderDoppler;
exposed.__renderBuses = renderBuses;

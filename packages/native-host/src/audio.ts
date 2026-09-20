/**
 * Web Audio for a host with no browser: the Rust engine's contexts, with Opus decoded where it
 * cannot, and underruns counted.
 *
 * **The engine's mix is Web Audio from end to end** — `AudioGraph` and `MixConsole` build nodes on a
 * context and never touch a device — so the host's job is a Web Audio implementation, not a mixer.
 * It is `node-web-audio-api` (IRCAM, BSD-3-Clause), `web-audio-api-rs` with prebuilt binaries,
 * which plays through JACK on Linux, and PipeWire provides that. Chosen by the maintainer on
 * 2026-09-19.
 *
 * **Opus is decoded here**, by libopus as WebAssembly (`ogg-opus-decoder`, MIT), because the Rust
 * engine's decoder refuses it (measured: "unsupported audio codec") and Opus is the first format the
 * engine's sound registry looks for. Anything else goes to the Rust engine's own decoder. A decode
 * comes back at the context's sample rate, as the specification's `decodeAudioData` does: Opus is
 * always 48 kHz, so a context at another rate has it resampled, by the same engine rendering it
 * offline.
 *
 * **Sample rate and buffer size are the host's to ask for** — `sampleRate` and `latencyHint`, given
 * to every context the engine creates, and what the device gave is reported once it runs; under
 * JACK the server sets the buffer, so the latency asked for is a request. **An underrun is counted**
 * from the context's `renderCapacity` and said once, rather than heard as a click and never
 * reported.
 *
 * What it gives up: a browser's autoplay rule, which has no meaning here, so a context runs from
 * the moment it is made; and the decoders' sample-for-sample agreement with Chrome's, which no
 * gate compares yet.
 */

import { createRequire } from 'node:module';

import { OggOpusDecoder } from 'ogg-opus-decoder';

import { correctAutomation } from './audioParams.ts';

type WebAudioModule = {
  AudioContext: typeof AudioContext;
  OfflineAudioContext: typeof OfflineAudioContext;
  AudioBuffer: typeof AudioBuffer;
};

/* A native module published as CommonJS. */
const webAudio = createRequire(import.meta.url)('node-web-audio-api') as WebAudioModule;

export interface AudioDefaults {
  readonly sampleRate?: number;
  /** A category, or seconds of buffer. */
  readonly latencyHint?: AudioContextLatencyCategory | number;
  /** `none` for a context with no output device: a check, a CI machine. */
  readonly sink?: 'default' | 'none';
}

/** An Ogg stream whose first page carries an Opus header. */
export function isOggOpus(bytes: Uint8Array): boolean {
  const text = (at: number, length: number) =>
    String.fromCharCode(...bytes.subarray(at, at + length));
  return bytes.length > 36 && text(0, 4) === 'OggS' && text(28, 8) === 'OpusHead';
}

/**
 * How many samples an Ogg Opus stream holds: its last page's granule position less the header's
 * pre-skip. The decoder drops the pre-skip and hands back the last packet whole, so it runs long;
 * a browser's decode ends where the stream says it does. Measured on the fixture: 24,312 decoded,
 * 24,000 kept, and those are Chrome's samples at no offset, to within 9.5e-6 — two builds of libopus
 * rounding differently, about −100 dB.
 */
function opusLength(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let granule = 0;
  for (let at = 0; at + 27 <= bytes.length && view.getUint32(at) === 0x4f676753;) {
    granule = Number(view.getBigInt64(at + 6, true));
    const segments = bytes[at + 26] as number;
    let length = 0;
    for (let s = 0; s < segments; s += 1) length += bytes[at + 27 + s] as number;
    at += 27 + segments + length;
  }
  /* The header is the first page's packet, after its 27 bytes and its segment table. */
  const preSkip = view.getUint16(27 + (bytes[26] as number) + 10, true);
  return Math.max(0, granule - preSkip);
}

/** Opus to an `AudioBuffer` at `target`'s rate. */
async function decodeOpus(bytes: Uint8Array, target: BaseAudioContext): Promise<AudioBuffer> {
  const decoder = new OggOpusDecoder();
  await decoder.ready;
  try {
    const decoded = await decoder.decodeFile(bytes);
    if (decoded.errors.length > 0) {
      throw new Error(
        `[driftengine] the Opus stream did not decode: ${decoded.errors[0]?.message ?? ''}`,
      );
    }
    const channels = decoded.channelData.length;
    const frames = Math.min(decoded.samplesDecoded, opusLength(bytes));
    const at48 = new webAudio.AudioBuffer({
      numberOfChannels: channels,
      length: frames,
      sampleRate: decoded.sampleRate,
    });
    decoded.channelData.forEach((samples, channel) =>
      at48.copyToChannel(samples.subarray(0, frames) as Float32Array<ArrayBuffer>, channel),
    );
    if (decoded.sampleRate === target.sampleRate) return at48;
    /*
     * The length as Chrome works it out — divided by the ratio of the rates, truncated — which
     * makes 24,000 samples at 48 kHz 22,049 at 44.1 kHz rather than 22,050, because the ratio is
     * not exact in a double. Measured in Chrome's own decode of the fixture.
     */
    const length = Math.floor(frames / (decoded.sampleRate / target.sampleRate));
    const resampler = new webAudio.OfflineAudioContext(channels, length, target.sampleRate);
    const source = resampler.createBufferSource();
    source.buffer = at48;
    source.connect(resampler.destination);
    source.start();
    return await resampler.startRendering();
  } finally {
    decoder.free();
  }
}

/** `decodeAudioData`, in both of its shapes: a promise, and the two callbacks. */
function decodeWith(
  context: BaseAudioContext,
  engine: (data: ArrayBuffer) => Promise<AudioBuffer>,
  data: ArrayBuffer,
  success?: DecodeSuccessCallback | null,
  failure?: DecodeErrorCallback | null,
): Promise<AudioBuffer> {
  const bytes = new Uint8Array(data);
  const decoding = isOggOpus(bytes) ? decodeOpus(bytes, context) : engine(data);
  return decoding.then(
    (buffer) => {
      success?.(buffer);
      return buffer;
    },
    (error: unknown) => {
      failure?.(error as DOMException);
      throw error;
    },
  );
}

/** Watches a context's render capacity and counts the updates in which it could not keep up. */
export class UnderrunCounter {
  underruns = 0;

  constructor(capacity: EventTarget & { start(options?: { updateInterval?: number }): void }) {
    capacity.addEventListener('update', (event) => {
      if (((event as Event & { underrunRatio?: number }).underrunRatio ?? 0) <= 0) return;
      this.underruns += 1;
      if (this.underruns === 1) {
        console.warn(
          '[driftengine] audio underran: the output could not be fed in time. Counted from here on.',
        );
      }
    });
    capacity.start({ updateInterval: 1 });
  }
}

/** The two context classes a page has, over the Rust engine, with the host's defaults. */
export function hostAudioContexts(defaults: AudioDefaults = {}): WebAudioModule {
  /* The Rust engine's scheduled ramps, corrected to Chrome's (`audioParams.ts`). */
  correctAutomation();
  const options = {
    ...(defaults.sampleRate === undefined ? {} : { sampleRate: defaults.sampleRate }),
    ...(defaults.latencyHint === undefined ? {} : { latencyHint: defaults.latencyHint }),
    ...(defaults.sink === 'none' ? { sinkId: { type: 'none' } } : {}),
  };
  class HostAudioContext extends webAudio.AudioContext {
    readonly underruns: UnderrunCounter | null;
    constructor(asked: AudioContextOptions = {}) {
      super({ ...options, ...asked });
      /*
       * Reported once the device has said what it gave, which it does a few milliseconds after the
       * context starts: under JACK the server sets the buffer, so `latencyHint` is a request
       * (measured here: 21 ms for either category, PipeWire's quantum). Asked for rather than
       * listened for, because starting the render-capacity watch below starts the context before
       * a `statechange` listener could hear it.
       */
      if (defaults.sink !== 'none') {
        let tries = 0;
        const report = (): void => {
          tries += 1;
          if (this.outputLatency <= 0 && tries < 50) {
            setTimeout(report, 20).unref();
            return;
          }
          const frames = Math.round(this.outputLatency * this.sampleRate);
          console.log(
            `[driftengine] audio: ${this.sampleRate} Hz, ${frames} frames of output latency (${(this.outputLatency * 1000).toFixed(1)} ms)`,
          );
        };
        setTimeout(report, 20).unref();
      }
      /* Nothing renders against a clock with no device, so there is nothing to underrun. */
      this.underruns =
        defaults.sink === 'none'
          ? null
          : new UnderrunCounter(
              (this as unknown as { renderCapacity: EventTarget & { start(): void } })
                .renderCapacity,
            );
    }
    override decodeAudioData(
      data: ArrayBuffer,
      success?: DecodeSuccessCallback | null,
      failure?: DecodeErrorCallback | null,
    ): Promise<AudioBuffer> {
      return decodeWith(this, (bytes) => super.decodeAudioData(bytes), data, success, failure);
    }
  }
  class HostOfflineAudioContext extends webAudio.OfflineAudioContext {
    override decodeAudioData(
      data: ArrayBuffer,
      success?: DecodeSuccessCallback | null,
      failure?: DecodeErrorCallback | null,
    ): Promise<AudioBuffer> {
      return decodeWith(this, (bytes) => super.decodeAudioData(bytes), data, success, failure);
    }
  }
  return {
    AudioContext: HostAudioContext as unknown as typeof AudioContext,
    OfflineAudioContext: HostOfflineAudioContext as unknown as typeof OfflineAudioContext,
    AudioBuffer: webAudio.AudioBuffer,
  };
}

/** Give the page its audio globals, and hand back what takes them away again. */
export function installAudio(
  defaults: AudioDefaults = {},
  scope: Record<string, unknown> = globalThis as Record<string, unknown>,
): () => void {
  const contexts = hostAudioContexts(defaults);
  const held = (['AudioContext', 'OfflineAudioContext', 'AudioBuffer'] as const).map(
    (name) => [name, name in scope, scope[name]] as const,
  );
  scope['AudioContext'] = contexts.AudioContext;
  scope['OfflineAudioContext'] = contexts.OfflineAudioContext;
  scope['AudioBuffer'] = contexts.AudioBuffer;
  return () => {
    for (const [name, had, value] of held) {
      if (had) scope[name] = value;
      else delete scope[name];
    }
  };
}

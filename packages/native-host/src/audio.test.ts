import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { AudioGraph, slamInsert } from '@driftengine/audio';
import { UnderrunCounter, hostAudioContexts, isOggOpus } from './audio.ts';

/**
 * **What this file is for: the engine's mix, heard through a host with no browser.** The engine's
 * audio is Web Audio from end to end, so the host supplies a Web Audio implementation — the Rust
 * engine `node-web-audio-api` — and fills the one gap it has that the engine cannot do without:
 * Opus, the engine's first format, which that engine's decoder refuses (measured: "unsupported
 * audio codec"). The tests run with no output device, which is the offline and the `none` sink.
 *
 * The fixture is half a second of 440 Hz, mono, 48 kHz:
 * `ffmpeg -f lavfi -i "sine=frequency=440:duration=0.5:sample_rate=48000" -ac 1 -c:a libopus -b:a 64k tone.opus`
 */

const OPUS = new Uint8Array(readFileSync(new URL('./fixtures/tone.opus', import.meta.url)));
const opusBytes = () => OPUS.slice().buffer;

/** Zero crossings upward in a window, which a tone at `hz` makes `hz` times a second. */
function crossings(samples: Float32Array, from: number, to: number): number {
  let count = 0;
  for (let at = from + 1; at < to; at += 1) {
    if ((samples[at - 1] as number) < 0 && (samples[at] as number) >= 0) count += 1;
  }
  return count;
}

/** A mono 16-bit WAV of `seconds` of silence, as bytes. */
function silentWav(rate: number, seconds: number): ArrayBuffer {
  const frames = Math.round(rate * seconds);
  const bytes = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(bytes);
  const text = (at: number, value: string) =>
    [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + frames * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, frames * 2, true);
  return bytes;
}

const { AudioContext, OfflineAudioContext } = hostAudioContexts({ sink: 'none' });
let contexts: { close?: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const context of contexts) await context.close?.();
  contexts = [];
});
function live(sampleRate: number) {
  const context = new AudioContext({ sampleRate });
  contexts.push(context);
  return context;
}

describe('audio on the native host', () => {
  test('OPUS IS KNOWN BY ITS OGG PAGE, and nothing else is taken for it', () => {
    expect(isOggOpus(OPUS)).toBe(true);
    expect(isOggOpus(new Uint8Array(silentWav(48000, 0.01)))).toBe(false);
  });

  test('OPUS DECODES, which the Web Audio engine alone refuses', async () => {
    const buffer = await live(48000).decodeAudioData(opusBytes());
    expect(buffer.sampleRate).toBe(48000);
    /* The stream's own length — final granule 24,312 less a pre-skip of 312 — as Chrome decodes it. */
    expect(buffer.length).toBe(24000);
    /* 440 Hz over the middle 0.3 s is 132 upward crossings. */
    const crossed = crossings(buffer.getChannelData(0), 4800, 4800 + 14400);
    expect(Math.abs(crossed - 132)).toBeLessThanOrEqual(1);
  });

  test('AT ANOTHER RATE THE DECODE IS THE CONTEXT’S RATE, as a browser’s decode is', async () => {
    const buffer = await live(44100).decodeAudioData(opusBytes());
    expect(buffer.sampleRate).toBe(44100);
    /* Chrome's length for it: 24,000 ÷ (48,000 ÷ 44,100) is 22,049.999… in a double, truncated. */
    expect(buffer.length).toBe(22049);
    /* Still 440 Hz: 132 crossings over 0.3 s, now 13,230 samples. */
    const crossed = crossings(buffer.getChannelData(0), 4410, 4410 + 13230);
    expect(Math.abs(crossed - 132)).toBeLessThanOrEqual(1);
  });

  test('ANYTHING ELSE GOES TO THE WEB AUDIO ENGINE’S OWN DECODER', async () => {
    const buffer = await live(48000).decodeAudioData(silentWav(48000, 0.25));
    expect(buffer.duration).toBeCloseTo(0.25, 3);
  });

  test('THE ENGINE’S OWN MIX PLAYS AN OPUS STEM ON IT', async () => {
    const context = new OfflineAudioContext(2, 24000, 48000);
    const graph = await AudioGraph.create({ stemCount: 1, context, random: () => 0.5 });
    if (graph === null) throw new Error('the graph did not build on this context');
    graph.loadStem(0, await context.decodeAudioData(opusBytes()));
    graph.at(0);
    graph.setStemGain(0, 1);
    graph.start();
    const rendered = await context.startRendering();
    const left = rendered.getChannelData(0);
    let energy = 0;
    for (let at = 4800; at < 19200; at += 1) energy += (left[at] as number) ** 2;
    expect(Math.sqrt(energy / 14400), 'the mix carried the stem to its output').toBeGreaterThan(
      0.05,
    );
  });
});

describe('the engine’s slam, rendered', () => {
  /**
   * The wet arm's shaper is oversampled and so late, by 128 samples in this engine and 192 in
   * Chrome; the slam gives the dry arm the same oversampling around a curve that changes nothing
   * (`packages/audio/src/mix/inserts.test.ts` says why). Rendered here, where that latency is real:
   * the same noise through each arm alone, and the lag at which the two agree best.
   */
  test('ITS TWO ARMS ARRIVE TOGETHER, rather than a shaper’s latency apart', async () => {
    const LENGTH = 4096;
    const render = async (arm: 'dry' | 'wet'): Promise<Float32Array> => {
      const context = new OfflineAudioContext(1, LENGTH, 48000);
      const slam = slamInsert(context, () => 0);
      const noise = context.createBuffer(1, LENGTH, 48000);
      const samples = noise.getChannelData(0);
      let seed = 12345;
      for (let at = 0; at < LENGTH; at += 1) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        /* Quiet enough that the soft clip is a straight line. */
        samples[at] = ((seed / 4294967296) * 2 - 1) * 0.01;
      }
      const source = context.createBufferSource();
      source.buffer = noise;
      source.connect(slam.align.input);
      source.connect(slam.wetInput);
      slam.align.output.connect(slam.input);
      slam.dryGain.gain.value = arm === 'dry' ? 1 : 0;
      slam.wetGain.gain.value = arm === 'wet' ? 1 : 0;
      slam.output.connect(context.destination);
      source.start();
      return (await context.startRendering()).getChannelData(0);
    };
    const dry = await render('dry');
    const wet = await render('wet');
    let lag = 0;
    let best = Number.NEGATIVE_INFINITY;
    for (let shift = -300; shift <= 300; shift += 1) {
      let agreement = 0;
      for (let at = 1000; at < 3000; at += 1) {
        agreement += (dry[at] as number) * (wet[at + shift] as number);
      }
      if (agreement > best) {
        best = agreement;
        lag = shift;
      }
    }
    expect(lag).toBe(0);
  });
});

describe('underruns', () => {
  test('ARE COUNTED, and said once, rather than dropped without a word', () => {
    const capacity = Object.assign(new EventTarget(), { start: vi.fn(), stop: vi.fn() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const counter = new UnderrunCounter(capacity);
      expect(capacity.start).toHaveBeenCalled();
      for (const underrunRatio of [0, 0.25, 0, 0.5]) {
        capacity.dispatchEvent(Object.assign(new Event('update'), { underrunRatio }));
      }
      expect(counter.underruns).toBe(2);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('underran')).length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});

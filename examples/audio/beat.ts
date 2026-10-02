/**
 * Two bars of a beat, written sample by sample, so the example ships no audio file.
 *
 * A kick that sweeps down from 150 Hz, a clap on two and four, hats on the eighths and a sub note
 * under each kick: enough low end for the kick detector to find, and enough of a groove to hear the
 * music duck under the bell. The noise comes from a fixed sequence, so the loop is the same loop
 * every time the page opens.
 */
const BPM = 92;
const BEATS = 8;
/** Where the kicks fall, in beats from the start of the two bars. */
const KICKS = [0, 1.5, 2, 3.75, 4, 5.5, 6, 6.75];

export function beatBuffer(context: BaseAudioContext): AudioBuffer {
  const rate = context.sampleRate;
  const beat = 60 / BPM;
  const length = Math.floor(rate * beat * BEATS);
  const buffer = context.createBuffer(2, length, rate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  let seed = 0x2f6b1d;
  const noise = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x80000000 - 1;
  };
  /* One hit at `at` beats, `seconds` long, panned from -1 to 1; `voice` is the sample at time t. */
  const hit = (at: number, seconds: number, pan: number, voice: (t: number) => number): void => {
    const start = Math.floor(at * beat * rate);
    const count = Math.min(Math.floor(seconds * rate), length - start);
    for (let i = 0; i < count; i += 1) {
      const sample = voice(i / rate);
      left[start + i] = (left[start + i] ?? 0) + sample * (1 - Math.max(0, pan));
      right[start + i] = (right[start + i] ?? 0) + sample * (1 + Math.min(0, pan));
    }
  };
  for (const at of KICKS) {
    let phase = 0;
    hit(at, 0.45, 0, (t) => {
      phase += ((45 + 105 * Math.exp(-t * 28)) / rate) * Math.PI * 2;
      return Math.sin(phase) * Math.exp(-t * 7) * 0.55;
    });
    hit(at, 0.6, 0, (t) => Math.sin(t * 55 * Math.PI * 2) * Math.exp(-t * 4) * 0.2);
  }
  for (const at of [1, 3, 5, 7]) {
    hit(at, 0.25, 0.1, (t) => noise() * Math.exp(-t * 22) * 0.25);
  }
  for (let at = 0; at < BEATS; at += 0.5) {
    let last = 0;
    hit(at, 0.06, at % 1 === 0 ? -0.4 : 0.4, (t) => {
      /* The difference of two noise samples: noise with its low end taken out, which is a hat. */
      const next = noise();
      const sample = (next - last) * Math.exp(-t * 70) * 0.08;
      last = next;
      return sample;
    });
  }
  return buffer;
}

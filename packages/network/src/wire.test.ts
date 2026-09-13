/**
 * A frame survives the round trip, and a malformed one is refused rather than half-read.
 *
 * The second half is the one worth writing tests for. Bytes arrive from another machine, and the
 * failure that matters is not a message that fails to decode — it is one that decodes into
 * plausible nonsense and gets applied to a simulation.
 */
import { describe, expect, it } from 'vitest';
import {
  FINGERPRINT_BYTES,
  INPUT_HEADER_BYTES,
  MESSAGE_ACK,
  MESSAGE_FINGERPRINT,
  MESSAGE_INPUT,
  MESSAGE_JOIN,
  MESSAGE_STATE,
  MESSAGE_WELCOME,
  PROTOCOL_VERSION,
  createDecoded,
  decode,
  encodeAck,
  encodeFingerprint,
  encodeInput,
  encodeJoin,
  encodeState,
  encodeWelcome,
} from './wire.ts';

const buffer = new Uint8Array(256);
const out = createDecoded();

describe('the wire format', () => {
  it('round-trips a single input, which is a run of one', () => {
    const payload = new Uint8Array([3, 1, 4, 1, 5]);
    const length = encodeInput(buffer, 2, 4_182, payload);
    expect(length).toBe(INPUT_HEADER_BYTES + payload.length);

    expect(decode(buffer.subarray(0, length), out)).toBe(true);
    expect(out.kind).toBe(MESSAGE_INPUT);
    expect(out.participant).toBe(2);
    expect(out.tick).toBe(4_182);
    expect(out.count).toBe(1);
    expect(Array.from(buffer.subarray(out.payloadAt, out.payloadAt + out.payloadBytes))).toEqual([
      3, 1, 4, 1, 5,
    ]);
  });

  /**
   * A run of consecutive ticks, which is what a lossy link needs and what every packet carries.
   *
   * Each payload is `payloadBytes` long and the *i*th belongs to `tick + i`. A reader that treated
   * `payloadBytes` as the whole message would apply four inputs' worth of bytes to one tick.
   */
  it('round-trips a run of inputs, each belonging to the next tick', () => {
    const stride = 2;
    const payloads = new Uint8Array([10, 11, 20, 21, 30, 31, 40, 41]);
    const length = encodeInput(buffer, 1, 100, payloads, stride, 4);
    expect(length).toBe(INPUT_HEADER_BYTES + stride * 4);

    expect(decode(buffer.subarray(0, length), out)).toBe(true);
    expect(out.count).toBe(4);
    expect(out.payloadBytes).toBe(stride);
    expect(out.tick).toBe(100);

    const seen: number[][] = [];
    for (let i = 0; i < out.count; i++) {
      const at = out.payloadAt + i * out.payloadBytes;
      seen.push(Array.from(buffer.subarray(at, at + out.payloadBytes)));
    }
    expect(seen).toEqual([
      [10, 11],
      [20, 21],
      [30, 31],
      [40, 41],
    ]);
  });

  it('refuses a run whose payloads are shorter than the count claims', () => {
    const length = encodeInput(buffer, 0, 0, new Uint8Array([1, 2, 3, 4]), 2, 4);
    expect(length).toBe(-1);
  });

  it('refuses a run of nothing', () => {
    expect(encodeInput(buffer, 0, 0, new Uint8Array([1]), 1, 0)).toBe(-1);
  });

  /**
   * A tick above 2^31, which is where a signed read would wrap into a negative number.
   *
   * At 60 Hz that is thirteen months in, so nobody would find it by playing. A session that reached
   * it would start applying inputs to negative ticks, which every window check rejects, and the
   * symptom would be a peer that silently stopped accepting anything.
   */
  it('round-trips a tick past the signed range', () => {
    const length = encodeInput(buffer, 1, 4_000_000_000, new Uint8Array([1]));
    decode(buffer.subarray(0, length), out);
    expect(out.tick).toBe(4_000_000_000);
  });

  it('round-trips a state message', () => {
    const payload = new Uint8Array([9, 9, 9]);
    const length = encodeState(buffer, 77, payload);
    expect(decode(buffer.subarray(0, length), out)).toBe(true);
    expect(out.kind).toBe(MESSAGE_STATE);
    expect(out.tick).toBe(77);
    expect(out.payloadBytes).toBe(3);
  });

  it('round-trips a fingerprint, digest included', () => {
    const digest = '0123456789abcdef';
    const length = encodeFingerprint(buffer, 3, 500, digest);
    expect(length).toBe(FINGERPRINT_BYTES);
    expect(decode(buffer.subarray(0, length), out)).toBe(true);
    expect(out.digest).toBe(digest);
    expect(out.participant).toBe(3);
    expect(out.tick).toBe(500);
  });

  it('round-trips the handshake and the acknowledgement', () => {
    let length = encodeJoin(buffer);
    expect(decode(buffer.subarray(0, length), out)).toBe(true);
    expect(out.kind).toBe(MESSAGE_JOIN);
    expect(out.tick).toBe(PROTOCOL_VERSION);

    length = encodeWelcome(buffer, 4, 9_431, 3);
    expect(decode(buffer.subarray(0, length), out)).toBe(true);
    expect(out.kind).toBe(MESSAGE_WELCOME);
    expect(out.participant).toBe(4);
    expect(out.tick).toBe(9_431);
    expect(out.payloadBytes).toBe(3);

    length = encodeAck(buffer, 1, 42);
    expect(decode(buffer.subarray(0, length), out)).toBe(true);
    expect(out.kind).toBe(MESSAGE_ACK);
    expect(out.tick).toBe(42);
  });

  /**
   * A payload whose declared length runs past the buffer is refused.
   *
   * This is the one that matters. A truncated packet — a link that cut a message in half, or a
   * hostile one — must not decode into a payload that reads whatever bytes happen to follow.
   */
  it('refuses a message whose payload is shorter than it claims', () => {
    const length = encodeInput(buffer, 0, 1, new Uint8Array([1, 2, 3, 4]));
    /* Two bytes short of what the header promises. */
    expect(decode(buffer.subarray(0, length - 2), out)).toBe(false);
    expect(out.kind).toBe(0);
  });

  it('refuses a truncated header', () => {
    encodeInput(buffer, 0, 1, new Uint8Array([1]));
    for (let cut = 0; cut < INPUT_HEADER_BYTES; cut++) {
      expect(decode(buffer.subarray(0, cut), out), `${cut} bytes`).toBe(false);
    }
  });

  it('refuses a kind it does not know', () => {
    const unknown = new Uint8Array([200, 0, 0, 0, 0, 0, 0, 0]);
    expect(decode(unknown, out)).toBe(false);
  });

  it('refuses an empty message', () => {
    expect(decode(new Uint8Array(0), out)).toBe(false);
  });

  /**
   * Encoding answers -1 rather than throwing, because the caller is a frame loop.
   *
   * `AGENTS.md`: fail fast at init, never throw in the frame loop. A buffer too small is a sizing
   * bug at the send site and the honest report is a value that can be branched on there.
   */
  it('answers -1 for a buffer too small rather than throwing', () => {
    const tiny = new Uint8Array(4);
    expect(encodeInput(tiny, 0, 0, new Uint8Array([1, 2, 3, 4]))).toBe(-1);
    expect(encodeState(tiny, 0, new Uint8Array([1, 2, 3, 4]))).toBe(-1);
    expect(encodeFingerprint(tiny, 0, 0, '0123456789abcdef')).toBe(-1);
    expect(encodeWelcome(tiny, 0, 0, 0)).toBe(-1);
    expect(encodeAck(tiny, 0, 0)).toBe(-1);
  });

  it('refuses a digest that is not sixteen hex characters', () => {
    expect(encodeFingerprint(buffer, 0, 0, 'abc')).toBe(-1);
  });

  it('clears the decoded fields, so a failed decode cannot show the previous message', () => {
    encodeInput(buffer, 7, 123, new Uint8Array([1]));
    decode(buffer.subarray(0, INPUT_HEADER_BYTES + 1), out);
    expect(out.participant).toBe(7);

    expect(decode(new Uint8Array([200]), out)).toBe(false);
    expect(out.participant).toBe(0);
    expect(out.tick).toBe(0);
    expect(out.payloadBytes).toBe(0);
  });
});

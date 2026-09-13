/**
 * The framing, which is small on purpose.
 *
 * **An input payload is opaque bytes and this file never looks inside one.** `AGENTS.md`: engine
 * APIs take positions, colours, sizes and time and never another game's noun. A wire format that
 * knew a player had a throttle would be a racing engine's wire format.
 *
 * ---
 *
 * ## Fixed widths rather than varints
 *
 * A varint saves two bytes on a tick number and costs a branch per field and a length that cannot
 * be known before encoding. At sixty inputs a second with a payload of a handful of bytes, the
 * saving is under a kilobyte a minute and the cost is that nothing can be written into a
 * preallocated buffer without measuring first. Fixed widths make an input frame a constant size,
 * which is what lets a session own one buffer for the process.
 *
 * ## The widths, and what each one refuses
 *
 * - **Participant, one byte.** 255 participants in a session, and 255 is not a limit anybody is
 *   near: lockstep stops being viable in single figures, and an authoritative host with 255
 *   predicting clients has bandwidth problems long before it has an id problem.
 * - **Tick, four bytes.** At 60 Hz an unsigned 32-bit tick counter is 2.2 years of continuous
 *   simulation. A session that reaches it has a different problem.
 * - **Payload length, two bytes.** 65,535 bytes, which is far more than an input and far less than
 *   a full world. A state message that does not fit is a state message that should have been a
 *   delta.
 *
 * ## The version is in every `join`, not in every message
 *
 * A byte per message to say what the protocol was is a byte per message spent on something that
 * cannot change mid-session. The handshake carries it and a mismatch is refused there, which is the
 * one place a peer can still be told why.
 */

export const PROTOCOL_VERSION = 1;

export const MESSAGE_JOIN = 1;
export const MESSAGE_WELCOME = 2;
export const MESSAGE_INPUT = 3;
export const MESSAGE_FINGERPRINT = 4;
export const MESSAGE_STATE = 5;
export const MESSAGE_ACK = 6;
export const MESSAGE_PING = 7;

/**
 * Header bytes before an input run's payloads: kind, participant, first tick, count, stride.
 *
 * **An input message carries a *run* of consecutive ticks, and a run of one is the degenerate
 * case.** That is not generality for its own sake — it is what makes lockstep survive a lossy link.
 * An input is only useful for the tick it names, so retransmitting a lost one after a round trip
 * delivers it too late to use; sending the last few inputs in *every* packet covers a loss before
 * anybody notices, and costs a handful of bytes on a message that already has a header. A test at
 * 15% loss is what turned this from a nicety into a requirement: without it a dropped input is lost
 * for good and that peer's world is permanently wrong.
 */
export const INPUT_HEADER_BYTES = 1 + 1 + 4 + 1 + 2;
/** Header bytes before a state payload: kind, tick, length. */
export const STATE_HEADER_BYTES = 1 + 4 + 2;
/** A fingerprint message is fixed: kind, participant, tick, and eight bytes of digest. */
export const FINGERPRINT_BYTES = 1 + 1 + 4 + 8;

function writeU32(into: Uint8Array, at: number, value: number): void {
  const v = value >>> 0;
  into[at] = v & 0xff;
  into[at + 1] = (v >>> 8) & 0xff;
  into[at + 2] = (v >>> 16) & 0xff;
  into[at + 3] = (v >>> 24) & 0xff;
}

function readU32(from: Uint8Array, at: number): number {
  return (
    ((from[at] as number) |
      ((from[at + 1] as number) << 8) |
      ((from[at + 2] as number) << 16) |
      ((from[at + 3] as number) << 24)) >>>
    0
  );
}

/** What a decoded message turned out to be. `kind` 0 means it did not decode. */
export interface DecodedMessage {
  kind: number;
  participant: number;
  tick: number;
  /** Where the payloads start, and how long **each one** is. Zero when there is none. */
  payloadAt: number;
  payloadBytes: number;
  /** How many consecutive ticks this message carries, starting at `tick`. One for everything else. */
  count: number;
  /** The sixteen-hex-character digest, for a fingerprint message; empty otherwise. */
  digest: string;
}

export function createDecoded(): DecodedMessage {
  return { kind: 0, participant: 0, tick: 0, payloadAt: 0, payloadBytes: 0, count: 0, digest: '' };
}

/**
 * Write an input frame into `into`, answering how many bytes it used, or -1 when it does not fit.
 *
 * **-1 rather than a throw**, because the caller is a frame loop and `AGENTS.md` forbids throwing
 * in one. A buffer too small is a caller's sizing bug and the honest report is a value they can
 * branch on at the send site.
 */
export function encodeInput(
  into: Uint8Array,
  participant: number,
  firstTick: number,
  payloads: Uint8Array,
  stride: number = payloads.length,
  count = 1,
): number {
  const total = INPUT_HEADER_BYTES + stride * count;
  if (into.length < total || stride > 0xffff || count > 0xff || count < 1) return -1;
  if (payloads.length < stride * count) return -1;
  into[0] = MESSAGE_INPUT;
  into[1] = participant & 0xff;
  writeU32(into, 2, firstTick);
  into[6] = count & 0xff;
  into[7] = stride & 0xff;
  into[8] = (stride >>> 8) & 0xff;
  into.set(payloads.subarray(0, stride * count), INPUT_HEADER_BYTES);
  return total;
}

export function encodeState(into: Uint8Array, tick: number, payload: Uint8Array): number {
  const total = STATE_HEADER_BYTES + payload.length;
  if (into.length < total || payload.length > 0xffff) return -1;
  into[0] = MESSAGE_STATE;
  writeU32(into, 1, tick);
  into[5] = payload.length & 0xff;
  into[6] = (payload.length >>> 8) & 0xff;
  into.set(payload, STATE_HEADER_BYTES);
  return total;
}

export function encodeFingerprint(
  into: Uint8Array,
  participant: number,
  tick: number,
  digest: string,
): number {
  if (into.length < FINGERPRINT_BYTES || digest.length !== 16) return -1;
  into[0] = MESSAGE_FINGERPRINT;
  into[1] = participant & 0xff;
  writeU32(into, 2, tick);
  for (let i = 0; i < 8; i++) {
    into[6 + i] = Number.parseInt(digest.slice(i * 2, i * 2 + 2), 16) & 0xff;
  }
  return FINGERPRINT_BYTES;
}

export function encodeJoin(into: Uint8Array): number {
  if (into.length < 3) return -1;
  into[0] = MESSAGE_JOIN;
  into[1] = PROTOCOL_VERSION & 0xff;
  into[2] = (PROTOCOL_VERSION >>> 8) & 0xff;
  return 3;
}

export function encodeWelcome(
  into: Uint8Array,
  participant: number,
  tick: number,
  participants: number,
): number {
  if (into.length < 7) return -1;
  into[0] = MESSAGE_WELCOME;
  into[1] = participant & 0xff;
  writeU32(into, 2, tick);
  into[6] = participants & 0xff;
  return 7;
}

export function encodeAck(into: Uint8Array, participant: number, tick: number): number {
  if (into.length < 6) return -1;
  into[0] = MESSAGE_ACK;
  into[1] = participant & 0xff;
  writeU32(into, 2, tick);
  return 6;
}

const HEX = '0123456789abcdef';

/**
 * Read a message's header into `out`. `false` when the bytes are not a message this version knows.
 *
 * **A payload is located rather than copied.** `payloadAt` and `payloadBytes` point into the buffer
 * the caller was handed, which the transport may reuse the moment the sink returns — the same
 * borrow `MessageSink` documents. A caller keeping a payload copies it, and one feeding it straight
 * to `RewindLoop.supply` does not need to.
 */
export function decode(message: Uint8Array, out: DecodedMessage): boolean {
  out.kind = 0;
  out.participant = 0;
  out.tick = 0;
  out.payloadAt = 0;
  out.payloadBytes = 0;
  out.count = 0;
  out.digest = '';
  if (message.length < 1) return false;

  const kind = message[0] as number;
  switch (kind) {
    case MESSAGE_INPUT: {
      if (message.length < INPUT_HEADER_BYTES) return false;
      const count = message[6] as number;
      const stride = (message[7] as number) | ((message[8] as number) << 8);
      if (count < 1 || stride < 1) return false;
      if (message.length < INPUT_HEADER_BYTES + stride * count) return false;
      out.kind = kind;
      out.participant = message[1] as number;
      out.tick = readU32(message, 2);
      out.payloadAt = INPUT_HEADER_BYTES;
      out.payloadBytes = stride;
      out.count = count;
      return true;
    }
    case MESSAGE_STATE: {
      if (message.length < STATE_HEADER_BYTES) return false;
      const length = (message[5] as number) | ((message[6] as number) << 8);
      if (message.length < STATE_HEADER_BYTES + length) return false;
      out.kind = kind;
      out.tick = readU32(message, 1);
      out.payloadAt = STATE_HEADER_BYTES;
      out.payloadBytes = length;
      return true;
    }
    case MESSAGE_FINGERPRINT: {
      if (message.length < FINGERPRINT_BYTES) return false;
      out.kind = kind;
      out.participant = message[1] as number;
      out.tick = readU32(message, 2);
      let digest = '';
      for (let i = 0; i < 8; i++) {
        const byte = message[6 + i] as number;
        digest += (HEX[(byte >>> 4) & 0xf] as string) + (HEX[byte & 0xf] as string);
      }
      out.digest = digest;
      return true;
    }
    case MESSAGE_JOIN: {
      if (message.length < 3) return false;
      out.kind = kind;
      /* The version rides in `tick`, which is the only numeric field a join has. */
      out.tick = (message[1] as number) | ((message[2] as number) << 8);
      return true;
    }
    case MESSAGE_WELCOME: {
      if (message.length < 7) return false;
      out.kind = kind;
      out.participant = message[1] as number;
      out.tick = readU32(message, 2);
      out.payloadBytes = message[6] as number;
      return true;
    }
    case MESSAGE_ACK:
    case MESSAGE_PING: {
      if (message.length < 6) return false;
      out.kind = kind;
      out.participant = message[1] as number;
      out.tick = readU32(message, 2);
      return true;
    }
    default:
      return false;
  }
}

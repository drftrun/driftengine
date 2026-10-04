/**
 * The seam a caller supplies, and the three roles a session can hold.
 *
 * **`AGENTS.md` settles the shape without being asked**: *"Nothing here may call a platform API
 * directly when a consumer might want a different one ... Same for any clock, network or filesystem
 * access — take the capability as a parameter, ship a browser implementation as the default."* So
 * `Transport` is an interface, `LoopbackTransport` is the one that needs no network, and the two
 * real ones are beside them.
 *
 * ---
 *
 * ## Three roles, because a relay need not be a simulator
 *
 * Most netcode assumes the machine that relays messages is the machine that runs the simulation.
 * That assumption fails the moment the relay is written in another language — and a service that
 * forwards messages, hosts rooms and re-simulates replays for anti-cheat is exactly the kind of
 * thing written in another language. Such a service cannot run this simulation, because this
 * engine is TypeScript.
 *
 * So the roles separate:
 *
 * - **Relay** forwards messages and reads none of them. Language-agnostic, and a Rust service is a
 *   perfectly good one. Lockstep needs nothing more than this.
 * - **Authority** runs the simulation and its state is the truth. A browser peer today; a Node
 *   process once the packages can be imported without a bundler.
 * - **Participant** sends inputs, receives inputs or state, and predicts locally.
 *
 * A session declares which it holds. Nothing in the protocol assumes the relay and the authority
 * are the same process.
 *
 * ## Delivery is drained, never pushed into a frame
 *
 * A transport does not call back into a simulation. It collects what has arrived and a caller
 * drains it at a point of their choosing, which is the top of a tick. A callback that fired
 * mid-frame would deliver an input into the middle of a step that had already read its inputs, and
 * the resulting world would depend on packet timing — which is the one thing a deterministic
 * simulation must not do.
 */

/** Which participant a message is for or from. Small integers, assigned by the host. */
export type PeerId = number;

/** Send to everyone the transport can reach. */
export const BROADCAST: PeerId = -1;

export type TransportState = 'connecting' | 'open' | 'closed';

/** What a role means is in this file's header, not in these names. */
export type SessionRole = 'relay' | 'authority' | 'participant';

/**
 * Where a drained message goes.
 *
 * The bytes are **borrowed**, not given: the array is the transport's and may be reused as soon as
 * this returns. A sink that needs to keep one copies it. That is the same contract `MessageQueue`
 * and the render passes use, and it is what keeps a drain allocation-free.
 */
export type MessageSink = (from: PeerId, message: Uint8Array) => void;

export interface Transport {
  readonly state: TransportState;
  /** This end's own id, or -1 before a host has assigned one. */
  readonly self: PeerId;
  /** Queue a message. Whether it arrives, in order, or at all is the implementation's business. */
  send(to: PeerId, message: Uint8Array): void;
  /** Hand every message that has arrived to the sink, oldest first, and clear them. */
  drain(into: MessageSink): void;
  close(): void;
}

/**
 * The message as a view of an `ArrayBuffer`, which is what a socket or a channel will send.
 *
 * Everything this package sends is already one, so this is a check and no copy. A message on
 * shared memory, which a browser refuses to send, is copied off it.
 */
export function sendable(message: Uint8Array): Uint8Array<ArrayBuffer> {
  return message.buffer instanceof ArrayBuffer
    ? (message as Uint8Array<ArrayBuffer>)
    : message.slice();
}

const UTF8 = new TextEncoder();

/**
 * A received message's bytes, whatever the socket or channel handed over, or null where nothing
 * can be read out of it — which the transport counts as dropped.
 *
 * Browsers deliver an `ArrayBuffer` once `binaryType` is set, `ws` under Node delivers a `Buffer`,
 * and a **text frame** arrives as a string. A text frame is lossless UTF-8 by the protocol, so its
 * bytes are exactly what the sender wrote, and it is read as them. It was discarded until 4.8.3,
 * on the ground that a payload through UTF-8 loses every byte above 0x7f — which is true of binary
 * data somebody sent as text, and not of a server that speaks text, whose every message then
 * vanished without a count. **What this gives up** is nothing a sender can still lose: binary bytes
 * sent as text were mangled before they reached this, by the sender.
 */
export function receivedBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') return UTF8.encode(data);
  return null;
}

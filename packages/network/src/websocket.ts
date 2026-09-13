/**
 * `Transport` over a WebSocket, which is the browser default.
 *
 * **Ordered and reliable, which is the wrong guarantee for inputs and the right one for this
 * topology.** A dropped input frame blocks the frames behind it while TCP retransmits, and by the
 * time it arrives the tick it belonged to is usually past — so a lockstep peer waits for news it no
 * longer needs. The unordered answer is `WebRtcTransport` beside this.
 *
 * It is the default anyway, for a reason outside the protocol: WebSocket and WebTransport are what
 * a relay service realistically speaks, whatever language it is written in. A transport nothing can
 * connect to is not a default.
 *
 * ---
 *
 * ## The socket is supplied and its type is declared structurally
 *
 * No `WebSocket` type is named. `@driftengine/network` imports `@driftengine/entities` and nothing
 * else, and that is the property that lets an authoritative host run it — a package that named a
 * DOM type would compile only where a DOM does. The shape below is what a browser `WebSocket` and
 * a Node `ws` socket both satisfy, which is also what makes the tests possible.
 *
 * The socket is **supplied rather than constructed**, so a consumer owns the URL, the protocols,
 * the credentials and the reconnection policy. A transport that opened its own connection would be
 * making four decisions that belong to whoever is paying for the server.
 */
import {
  BROADCAST,
  type MessageSink,
  type PeerId,
  type Transport,
  type TransportState,
} from './transport.ts';

/** What a browser `WebSocket` and a Node `ws` both satisfy. Named here so neither is imported. */
export interface SocketLike {
  readonly readyState: number;
  binaryType?: string;
  send(data: ArrayBufferView | ArrayBuffer): void;
  close(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

/** The `readyState` values, which are the same three numbers everywhere. */
const OPEN = 1;
const CLOSED = 3;

export interface WebSocketTransportOptions {
  readonly socket: SocketLike;
  /** This end's id, or -1 to wait for a host to assign one through a welcome. */
  readonly self?: PeerId;
  /**
   * How many messages may queue before the oldest is dropped.
   *
   * A bound rather than none, because a socket that stops draining is a socket behind a paused tab
   * or a stalled link, and an unbounded queue there is a leak that ends the session with a crash
   * instead of a disconnection. **The oldest goes**, because in a simulation the newest input is
   * the one still worth having.
   */
  readonly maxQueued?: number;
}

export class WebSocketTransport implements Transport {
  readonly self: PeerId;

  private readonly socket: SocketLike;
  private readonly maxQueued: number;
  private readonly arrived: Uint8Array[] = [];
  private closedByUs = false;
  private droppedCount = 0;

  constructor(options: WebSocketTransportOptions) {
    this.socket = options.socket;
    this.self = options.self ?? -1;
    this.maxQueued = Math.max(1, options.maxQueued ?? 1024);

    /* Binary frames, or every message arrives as a string and every payload is corrupted by the
       round trip through UTF-8. Set before any listener, because a frame can arrive immediately. */
    if ('binaryType' in this.socket) this.socket.binaryType = 'arraybuffer';

    this.socket.addEventListener('message', (event) => {
      const data = (event as { data?: unknown }).data;
      const bytes = toBytes(data);
      if (bytes === null) return;
      if (this.arrived.length >= this.maxQueued) {
        this.arrived.shift();
        this.droppedCount += 1;
      }
      this.arrived.push(bytes);
    });
  }

  get state(): TransportState {
    if (this.closedByUs || this.socket.readyState === CLOSED) return 'closed';
    return this.socket.readyState === OPEN ? 'open' : 'connecting';
  }

  /** Messages dropped because nothing drained. A consumer watching for a stalled tab reads this. */
  get dropped(): number {
    return this.droppedCount;
  }

  /**
   * Send, or do nothing if the socket is not open yet.
   *
   * **Nothing is queued while connecting, deliberately.** Every message this package sends is
   * addressed to a tick, and a tick that has passed by the time the socket opens is a tick nobody
   * can use. Flushing a backlog of stale inputs on connect is worse than having sent none.
   */
  send(_to: PeerId, message: Uint8Array): void {
    if (this.state !== 'open') return;
    this.socket.send(message);
  }

  drain(into: MessageSink): void {
    for (const message of this.arrived) into(BROADCAST, message);
    this.arrived.length = 0;
  }

  close(): void {
    this.closedByUs = true;
    this.arrived.length = 0;
    this.socket.close();
  }
}

/**
 * A message's bytes, whatever the socket handed over, or null.
 *
 * Browsers deliver an `ArrayBuffer` when `binaryType` is set, `ws` under Node delivers a `Buffer`,
 * and a socket left on its default delivers a string. The first two are usable and the third is
 * not: a payload that has been through UTF-8 has had every byte above 0x7f replaced.
 */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

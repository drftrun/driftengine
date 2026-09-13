/**
 * `Transport` over a WebRTC data channel, which is what peer lockstep actually wants.
 *
 * **Unreliable and unordered, and that is the feature.** An input is only useful for the tick it
 * names: a frame that took two retransmissions to arrive is a frame whose tick has been simulated,
 * corrected and forgotten. Reliable ordered delivery makes the input *behind* it wait for that —
 * head-of-line blocking, paid on every drop, on a link where the sender is about to send a newer
 * one anyway. `{ ordered: false, maxRetransmits: 0 }` is the configuration, and `unreliableChannel`
 * below is the one line of it worth not getting wrong.
 *
 * ---
 *
 * ## Signalling is a service and is not here
 *
 * Two peers cannot exchange WebRTC offers over WebRTC. Something else — a WebSocket, a REST
 * endpoint, a person pasting a string — has to carry the first messages, and that something is a
 * *service*: it has an address, an operator, and a lifetime longer than a session. Building one
 * into a transport would make this package own a server.
 *
 * So a consumer opens the connection, does whatever signalling they already do, and hands over a
 * channel. That is the same shape `KeyValueStore` has for persistence and `Transport` has for the
 * network one level up.
 *
 * ## What this limits about testing, stated rather than discovered
 *
 * A data channel needs two real peer connections and an ICE exchange. There is no headless harness
 * for that here, so what is tested is everything on this side of the channel — queueing, draining,
 * the state mapping, and that the channel is configured unreliably — against a double. **The
 * channel itself is exercised by `demo/dev/network.html`, in a browser, against a loopback pair.**
 * That is a weaker guarantee than the loopback transport has, and it is why WebSocket is the
 * default rather than this.
 */
import {
  BROADCAST,
  type MessageSink,
  type PeerId,
  type Transport,
  type TransportState,
} from './transport.ts';

/** What an `RTCDataChannel` satisfies. Declared rather than imported; see `websocket.ts`. */
export interface DataChannelLike {
  readonly readyState: string;
  binaryType?: string;
  send(data: ArrayBufferView | ArrayBuffer): void;
  close(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

/** The part of `RTCPeerConnection` `unreliableChannel` needs. */
export interface PeerConnectionLike {
  createDataChannel(label: string, options: Record<string, unknown>): DataChannelLike;
}

/**
 * A channel configured the way a simulation wants one.
 *
 * **`maxRetransmits: 0` and `ordered: false` together**, and both matter. Unordered alone still
 * retransmits, so a drop still costs a round trip before the data arrives — late, for a tick that
 * has gone. Zero retransmissions alone still delivers in order, so a lost frame still blocks the
 * ones behind it. Either on its own reads like the fix and is half of it.
 */
export function unreliableChannel(
  connection: PeerConnectionLike,
  label = 'drift',
): DataChannelLike {
  return connection.createDataChannel(label, { ordered: false, maxRetransmits: 0 });
}

export interface WebRtcTransportOptions {
  readonly channel: DataChannelLike;
  readonly self?: PeerId;
  /** See `WebSocketTransportOptions.maxQueued`; the oldest goes for the same reason. */
  readonly maxQueued?: number;
}

export class WebRtcTransport implements Transport {
  readonly self: PeerId;

  private readonly channel: DataChannelLike;
  private readonly maxQueued: number;
  private readonly arrived: Uint8Array[] = [];
  private closedByUs = false;
  private droppedCount = 0;

  constructor(options: WebRtcTransportOptions) {
    this.channel = options.channel;
    this.self = options.self ?? -1;
    this.maxQueued = Math.max(1, options.maxQueued ?? 1024);

    if ('binaryType' in this.channel) this.channel.binaryType = 'arraybuffer';

    this.channel.addEventListener('message', (event) => {
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
    if (this.closedByUs) return 'closed';
    const ready = this.channel.readyState;
    if (ready === 'open') return 'open';
    if (ready === 'connecting') return 'connecting';
    return 'closed';
  }

  get dropped(): number {
    return this.droppedCount;
  }

  send(_to: PeerId, message: Uint8Array): void {
    if (this.state !== 'open') return;
    this.channel.send(message);
  }

  drain(into: MessageSink): void {
    for (const message of this.arrived) into(BROADCAST, message);
    this.arrived.length = 0;
  }

  close(): void {
    this.closedByUs = true;
    this.arrived.length = 0;
    this.channel.close();
  }
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

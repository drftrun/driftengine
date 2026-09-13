/**
 * Everything on this side of a socket, against a double.
 *
 * A real WebSocket and a real data channel are exercised by `demo/dev/network.html` in a browser.
 * What is here is the part that has bugs anyway: the state mapping, the bound queue, and whether a
 * payload survives the trip — which it does not if `binaryType` is left alone, because a string
 * round trip through UTF-8 replaces every byte above 0x7f.
 */
import { describe, expect, it, vi } from 'vitest';
import { WebSocketTransport } from './websocket.ts';
import { WebRtcTransport, unreliableChannel } from './webrtc.ts';

class FakeSocket {
  readyState = 1;
  binaryType = 'blob';
  readonly sent: Uint8Array[] = [];
  closed = false;
  private listeners: ((event: unknown) => void)[] = [];

  send(data: ArrayBufferView | ArrayBuffer): void {
    this.sent.push(new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer.slice(0)));
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (type === 'message') this.listeners.push(listener);
  }
  deliver(data: unknown): void {
    for (const listener of this.listeners) listener({ data });
  }
}

class FakeChannel {
  readyState = 'open';
  binaryType = 'blob';
  closed = false;
  private listeners: ((event: unknown) => void)[] = [];

  send(): void {}
  close(): void {
    this.closed = true;
    this.readyState = 'closed';
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (type === 'message') this.listeners.push(listener);
  }
  deliver(data: unknown): void {
    for (const listener of this.listeners) listener({ data });
  }
}

describe('the WebSocket transport', () => {
  it('asks for binary frames, or every payload is corrupted by a UTF-8 round trip', () => {
    const socket = new FakeSocket();
    new WebSocketTransport({ socket });
    expect(socket.binaryType).toBe('arraybuffer');
  });

  it('hands over what arrived, once', () => {
    const socket = new FakeSocket();
    const transport = new WebSocketTransport({ socket });
    socket.deliver(new Uint8Array([1, 2, 3]).buffer);

    const seen: number[][] = [];
    transport.drain((_from, message) => seen.push(Array.from(message)));
    transport.drain((_from, message) => seen.push(Array.from(message)));
    expect(seen).toEqual([[1, 2, 3]]);
  });

  it('accepts a Buffer-shaped view as well as an ArrayBuffer', () => {
    const socket = new FakeSocket();
    const transport = new WebSocketTransport({ socket });
    socket.deliver(new Uint8Array([9, 8]));

    const seen: number[][] = [];
    transport.drain((_from, message) => seen.push(Array.from(message)));
    expect(seen).toEqual([[9, 8]]);
  });

  it('ignores a string frame rather than delivering mangled bytes', () => {
    const socket = new FakeSocket();
    const transport = new WebSocketTransport({ socket });
    socket.deliver('not bytes');

    const seen: unknown[] = [];
    transport.drain((_from, message) => seen.push(message));
    expect(seen).toEqual([]);
  });

  /**
   * A stalled reader drops the *oldest*, which is the choice a simulation wants.
   *
   * The newest input is the one still worth having; the oldest names a tick that has already been
   * simulated, corrected and forgotten.
   */
  it('bounds its queue and drops the oldest', () => {
    const socket = new FakeSocket();
    const transport = new WebSocketTransport({ socket, maxQueued: 3 });
    for (let i = 0; i < 6; i++) socket.deliver(new Uint8Array([i]).buffer);

    const seen: number[] = [];
    transport.drain((_from, message) => seen.push(message[0] as number));
    expect(seen).toEqual([3, 4, 5]);
    expect(transport.dropped).toBe(3);
  });

  /**
   * Nothing is queued while connecting, and this is the assertion for it.
   *
   * Every message here is addressed to a tick. Flushing a backlog of stale inputs on connect is
   * worse than having sent none, because each one triggers a rewind to a tick nobody cares about.
   */
  it('sends nothing before the socket is open', () => {
    const socket = new FakeSocket();
    socket.readyState = 0;
    const transport = new WebSocketTransport({ socket });
    expect(transport.state).toBe('connecting');

    transport.send(0, new Uint8Array([1]));
    expect(socket.sent).toEqual([]);

    socket.readyState = 1;
    transport.send(0, new Uint8Array([1]));
    expect(socket.sent.length).toBe(1);
  });

  it('reports closed after close, and closes the socket under it', () => {
    const socket = new FakeSocket();
    const transport = new WebSocketTransport({ socket });
    transport.close();
    expect(transport.state).toBe('closed');
    expect(socket.closed).toBe(true);
  });
});

describe('the WebRTC transport', () => {
  /**
   * **Both options, and either alone is half the fix.** Unordered still retransmits, so a drop
   * still costs a round trip. Zero retransmissions still delivers in order, so a lost frame still
   * blocks the ones behind it.
   */
  it('opens an unreliable, unordered channel', () => {
    const createDataChannel = vi.fn(() => new FakeChannel());
    unreliableChannel({ createDataChannel }, 'sim');
    expect(createDataChannel).toHaveBeenCalledWith('sim', { ordered: false, maxRetransmits: 0 });
  });

  it('maps every channel state onto a transport state', () => {
    const channel = new FakeChannel();
    const transport = new WebRtcTransport({ channel });

    channel.readyState = 'connecting';
    expect(transport.state).toBe('connecting');

    channel.readyState = 'open';
    expect(transport.state).toBe('open');

    /* 'closing' and 'closed' are both closed: neither will carry another message. */
    channel.readyState = 'closing';
    expect(transport.state).toBe('closed');
    channel.readyState = 'closed';
    expect(transport.state).toBe('closed');
  });

  it('delivers and bounds the same way the socket does', () => {
    const channel = new FakeChannel();
    const transport = new WebRtcTransport({ channel, maxQueued: 2 });
    for (let i = 0; i < 4; i++) channel.deliver(new Uint8Array([i]).buffer);

    const seen: number[] = [];
    transport.drain((_from, message) => seen.push(message[0] as number));
    expect(seen).toEqual([2, 3]);
    expect(transport.dropped).toBe(2);
  });
});

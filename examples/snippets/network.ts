/**
 * The parts of networking one page cannot show: a real link, an authority with predicting clients,
 * a remote body drawn smoothly, what a script can see of a session, and fixed point.
 *
 * A snippet, typechecked with the examples and quoted by the manual's networking chapter.
 */
import { World, defineComponent } from '@driftengine/entities';
import type { Entity, WorldSnapshot } from '@driftengine/entities';
import {
  AuthorityHost,
  InputLog,
  PredictingClient,
  RewindLoop,
  ScriptSession,
  StateInterpolator,
  WebRtcTransport,
  WebSocketTransport,
  simAdd,
  simFrom,
  simMul,
  simTo,
  unreliableChannel,
  worldSnapshotter,
} from '@driftengine/network';
import type { LockstepSession, Replicator } from '@driftengine/network';

const Body = defineComponent('SnippetBody', { x: 'f64', z: 'f64' });

// #region transports
/** A relay over a WebSocket, which every browser and server has. Messages are binary frames. */
export function overWebSocket(url: string): WebSocketTransport {
  return new WebSocketTransport({ socket: new WebSocket(url) });
}

/**
 * Peer to peer over WebRTC, on a channel that neither orders nor retransmits: a late input is
 * worth nothing, and the session's redundancy already covers a lost one. Signalling, the offer and
 * answer exchange, is the page's, since every game does it through its own server.
 */
export function overWebRtc(connection: RTCPeerConnection, self: number): WebRtcTransport {
  return new WebRtcTransport({ channel: unreliableChannel(connection), self });
}
// #endregion

// #region authority
/**
 * One world is the truth. The host steps it and publishes what it holds; a client predicts its own
 * player, and when the host's state arrives for a tick it already ran, rewinds to it and replays its
 * own inputs over the top.
 */
export function authority(transport: WebSocketTransport, world: World, bodies: readonly Entity[]) {
  const inputs = new InputLog({ participants: bodies.length, depth: 64, inputBytes: 1 });
  const loop = new RewindLoop<WorldSnapshot>({
    step: (dt) => {
      for (const body of bodies) {
        world.write(body, Body, 'x', (world.read(body, Body, 'x') as number) + dt);
      }
    },
    snapshotter: worldSnapshotter(world),
    inputs,
    fixedDt: 1 / 60,
    depth: 16,
  });
  /* What crosses the wire is the game's to choose: here each body's position as two doubles. */
  const view = new DataView(new ArrayBuffer(16 * bodies.length));
  const replicator: Replicator = {
    encode(into) {
      bodies.forEach((body, i) => {
        view.setFloat64(i * 16, world.read(body, Body, 'x') as number);
        view.setFloat64(i * 16 + 8, world.read(body, Body, 'z') as number);
      });
      into.set(new Uint8Array(view.buffer));
      return view.byteLength;
    },
    apply(from) {
      const read = new DataView(from.buffer, from.byteOffset, from.byteLength);
      bodies.forEach((body, i) => {
        world.write(body, Body, 'x', read.getFloat64(i * 16));
        world.write(body, Body, 'z', read.getFloat64(i * 16 + 8));
      });
    },
  };
  return new AuthorityHost({ transport, loop, inputs, replicator, stateEvery: 3 });
}

export function client(
  transport: WebSocketTransport,
  loop: RewindLoop<WorldSnapshot>,
  inputs: InputLog,
  replicator: Replicator,
  self: number,
) {
  return new PredictingClient({ transport, loop, inputs, replicator, self });
}
// #endregion

// #region smooth
/**
 * Another player's body, drawn between the last two states that arrived, four ticks behind, so it
 * glides where the newest state alone would step every third tick.
 */
const remote = new StateInterpolator(16, 16, 4);

export function received(tick: number, state: Uint8Array): void {
  remote.push(tick, state);
}

export function drawnAt(renderTick: number, out: { x: number; z: number }): boolean {
  const sample = remote.sample(renderTick);
  if (sample === null) return false;
  const from = new DataView(sample.from.buffer, sample.from.byteOffset, 16);
  const to = new DataView(sample.to.buffer, sample.to.byteOffset, 16);
  out.x = from.getFloat64(0) + (to.getFloat64(0) - from.getFloat64(0)) * sample.alpha;
  out.z = from.getFloat64(8) + (to.getFloat64(8) - from.getFloat64(8)) * sample.alpha;
  return true;
}
// #endregion

// #region script
/**
 * What a script sees of a session: who it is, whether it is the authority, how far confirmed the
 * inputs are, and a few scalars per participant it can publish and read. The page points one at
 * whichever session it runs and hands it to the script as an argument.
 */
export function scriptView(session: LockstepSession<WorldSnapshot>): ScriptSession {
  return new ScriptSession({ self: session.self, participants: session.participants }).follow(
    session,
  );
}
// #endregion

// #region fixed
/**
 * Fixed point, 48.16 in a double, for a simulation that wants its arithmetic exact on every
 * machine whatever anyone argues about floating point. Every operation is a function.
 */
export function fixedStep(position: number, velocity: number, dt: number): number {
  const next = simAdd(simFrom(position), simMul(simFrom(velocity), simFrom(dt)));
  return simTo(next);
}
// #endregion

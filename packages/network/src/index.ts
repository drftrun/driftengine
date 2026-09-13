/*! DriftEngine | Copyright 2026 Drift Technologies | Apache-2.0 | https://github.com/drftrun/driftengine */
/**
 * `@driftengine/network` — a transport seam, rewind and replay, and the two models built on them.
 *
 * **One rewind core under both models**, because prediction and rollback are the same operation:
 * put the state back to tick *T*, correct what was wrong about *T*, step forward to where we were.
 * A lockstep peer does it when a guessed input turns out wrong; a predicting client does it when
 * its authority disagrees.
 *
 * **It imports `@driftengine/entities` and nothing else.** `boundaries.test.mjs` already makes the
 * argument, about physics: a deterministic simulation with no renderer in its module graph is what
 * an authoritative host runs. A network package that reaches no renderer is one such a host can
 * run, and the test asserts it rather than this paragraph claiming it.
 *
 * **Nothing here knows what an input is.** A payload is a fixed number of bytes a consumer encodes,
 * per `AGENTS.md`: an engine that knows a player presses a brake pedal has stopped being
 * game-agnostic, and this is the place most netcode gives that up.
 */
export { RewindLoop } from './rewind.ts';
export type { RewindOptions, SimStep, Snapshotter } from './rewind.ts';

export { InputLog, repeatLastInput } from './inputLog.ts';
export type { InputLogOptions, InputPredictor } from './inputLog.ts';

export { BROADCAST } from './transport.ts';
export type { MessageSink, PeerId, SessionRole, Transport, TransportState } from './transport.ts';

export { ScriptSession } from './scriptSession.ts';
export type { ScriptSessionOptions, SessionStatus } from './scriptSession.ts';

export { createFixture, FIXTURE_BODIES } from './fixture.ts';
export type { FixtureMath, FixtureResult } from './fixture.ts';

export {
  SIM_FRACTION_BITS,
  SIM_MAX,
  SIM_MIN,
  SIM_ONE,
  simAbs,
  simAdd,
  simCompare,
  simDiv,
  simFrom,
  simFromInt,
  simMax,
  simMin,
  simMul,
  simNeg,
  simSqrt,
  simSub,
  simTo,
} from './simNumber.ts';
export type { Sim } from './simNumber.ts';

export { AuthorityHost, PredictingClient, StateInterpolator } from './authority.ts';
export type { AuthorityOptions, ClientOptions, Replicator } from './authority.ts';

export { LockstepSession } from './lockstep.ts';
export type { Desync, LockstepOptions, LockstepStatus } from './lockstep.ts';

export { WebSocketTransport } from './websocket.ts';
export type { SocketLike, WebSocketTransportOptions } from './websocket.ts';

export { WebRtcTransport, unreliableChannel } from './webrtc.ts';
export type { DataChannelLike, PeerConnectionLike, WebRtcTransportOptions } from './webrtc.ts';

export { LoopbackNetwork, LoopbackTransport } from './loopback.ts';
export type { Impairment, LoopbackOptions } from './loopback.ts';

export {
  FINGERPRINT_BYTES,
  INPUT_HEADER_BYTES,
  MESSAGE_ACK,
  MESSAGE_FINGERPRINT,
  MESSAGE_INPUT,
  MESSAGE_JOIN,
  MESSAGE_PING,
  MESSAGE_STATE,
  MESSAGE_WELCOME,
  PROTOCOL_VERSION,
  STATE_HEADER_BYTES,
  createDecoded,
  decode,
  encodeAck,
  encodeFingerprint,
  encodeInput,
  encodeJoin,
  encodeState,
  encodeWelcome,
} from './wire.ts';
export type { DecodedMessage } from './wire.ts';

export { Fingerprint, fingerprintSnapshot } from './fingerprint.ts';
export { combineSnapshotters, randomSnapshotter, worldSnapshotter } from './snapshotter.ts';
export type { SavablePosition } from './snapshotter.ts';

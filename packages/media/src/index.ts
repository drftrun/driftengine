/*! DriftEngine | Copyright 2026 Drift Technologies | Apache-2.0 | https://github.com/drftrun/driftengine */
/**
 * Recording what the engine draws: encoding a clip, and delivering frames to it.
 *
 * The muxer dependency lives here rather than in core, which is the point — a game that
 * records nothing installs no muxer.
 */

export { ClipEncoder, frameTimestampUs } from './clipEncoder.ts';
export type { ClipAudioCodec, ClipEncoderOptions } from './clipEncoder.ts';
export { clipEncodingSupported, offlineEncodingSupported } from './clipSupport.ts';
export type { ClipEncodeRequest } from './clipSupport.ts';
export { framesReachEncoder } from './frameDelivery.ts';
export type { FrameDelivery } from './frameDelivery.ts';

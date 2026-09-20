/*! DriftEngine | Copyright 2026 Drift Technologies | Apache-2.0 | https://github.com/drftrun/driftengine */
/**
 * Sound: layered stems, synthesis, rhythm analysis, and where a source sits.
 *
 * A package because nothing in the renderer ever imported it — the cleanest boundary in the
 * tree, and 3,151 lines a silent game does not carry.
 */

export { SoundRegistry } from './registry.ts';
export { AudioGraph } from './graph.ts';
export { MASTER_OPEN_HZ, cutoffForSpeed } from './filters.ts';
/* The two lines that make Web Audio audible on an iPhone, for a consumer whose audio is one
   decoded file through its own chain rather than a stem player. `AudioGraph` already calls both
   and in this order; anything building its own context has to do the same. */
export { audioContextConstructor, claimPlaybackSession } from './session.ts';
export { AUDIO_FORMATS, audioCandidateUrls } from './formats.ts';
export { fetchAudioManifest, parseAudioManifest } from './manifest.ts';
export type { AudioFormat } from './formats.ts';
export { AmbientLoop } from './ambientLoop.ts';
export { analyseTrack, emptyBeatMap } from './rhythm/beatMap.ts';
export { TapTempo, beatGrid } from './rhythm/beatGrid.ts';
export { KickDetector, kickPulseAfter } from './rhythm/kickDetector.ts';
export type { KickDetectorNodes } from './rhythm/kickDetector.ts';
export type { BeatMap } from './rhythm/beatMap.ts';
export { RHYTHM_BANDS } from './rhythm/bands.ts';
export type { Band, BandEnergies, BandName } from './rhythm/bands.ts';
export { distanceGain, stereoPan } from './positional.ts';
/* The mix as a tree. `AudioGraph` is built on this and forwards to it, so a consumer only reaches
   for these when it wants a bus of its own. */
export { MixConsole } from './mix/console.ts';
export { MixBus } from './mix/bus.ts';
export type { MixInsert, InsertOptions, BusOptions } from './mix/bus.ts';
export type { MixConsoleOptions, MixSnapshot } from './mix/console.ts';
export { liftInsert, masterFilterInsert, slamInsert } from './mix/inserts.ts';
export type { LiftInsert, MasterFilterInsert, SlamInsert } from './mix/inserts.ts';
export { convolverInsert, delayInsert, impulseResponse } from './mix/returns.ts';
export type { DelayInsert } from './mix/returns.ts';
export { defaultLayout } from './mix/defaultLayout.ts';
export type { DefaultLayout } from './mix/defaultLayout.ts';
/* Placing a sound in the world. Standalone rather than methods on the console, so a consumer that
   never places one does not carry the panner — see `SpatialSource` and the size gate. */
export { createListener, AudioListenerGraph } from './spatial/listener.ts';
export type { OcclusionProbe } from './spatial/listener.ts';
export { createSpatialSource, SpatialSource } from './spatial/source.ts';
export type { SpatialOptions } from './spatial/source.ts';
export {
  occlusionCutoffHz,
  occlusionGainFor,
  smoothToward,
  ProbeScheduler,
} from './spatial/occlusion.ts';
export { MAX_OPEN_ZONES, addReverbZone, ReverbZone, SourceZoneSend } from './spatial/zones.ts';
/* A soundfield rather than a source: four channels of direction, decoded at a fixed cost. */
export {
  ACN_W,
  ACN_X,
  ACN_Y,
  ACN_Z,
  AmbisonicSoundfield,
  FOA_CHANNELS,
  FOA_SPEAKERS,
  ambisonicFromWorld,
  createAmbisonicSoundfield,
  encodeFoa,
  foaDecodeGain,
  foaDecodeMatrix,
} from './spatial/ambisonic.ts';
export type { AmbisonicOptions } from './spatial/ambisonic.ts';
export type { ZoneShape, ZoneOptions } from './spatial/zones.ts';
export {
  ambienceBuffer,
  driftScrapeBuffer,
  fireLoopBuffer,
  metalBuffer,
  noiseBuffer,
  silentBuffer,
  toneBuffer,
  waterLoopBuffer,
  windLoopBuffer,
} from './synth.ts';
export type { AmbienceOptions } from './synth.ts';
export type { AudioGraphOptions, MixLevels } from './graph.ts';
export type { SoundSlot, SoundSource, SoundOrigin, FetchLike } from './registry.ts';
export { RenderedPulse } from './rhythm/renderedPulse.ts';

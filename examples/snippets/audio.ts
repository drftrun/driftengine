/**
 * The parts of sound the courtyard does not show: a mix rendered offline, the beats of a track, a
 * loop placed the cheap way, a space heard from outside it, a soundfield, and slots from a folder.
 *
 * A snippet, typechecked with the examples and quoted by the manual's sound chapter.
 */
import {
  AudioGraph,
  RenderedPulse,
  TapTempo,
  analyseTrack,
  audioCandidateUrls,
  beatGrid,
  createAmbisonicSoundfield,
  distanceGain,
  fetchAudioManifest,
  silentBuffer,
  stereoPan,
} from '@driftengine/audio';
import type {
  AmbientLoop,
  AudioListenerGraph,
  BeatMap,
  ReverbZone,
  SoundRegistry,
  SpatialSource,
} from '@driftengine/audio';

// #region offline
/**
 * A mix rendered to a buffer, for a clip: the same graph on an offline context, every move
 * scheduled at the instant it belongs to rather than at a clock that is not running.
 */
export async function renderClip(score: AudioBuffer, seconds: number): Promise<AudioBuffer> {
  const context = new OfflineAudioContext(2, Math.ceil(seconds * 48000), 48000);
  const graph = await AudioGraph.create({
    stemCount: 1,
    context,
    levels: { music: 0.8, effects: 1 },
  });
  if (graph === null) throw new Error('no graph on an offline context');
  graph.loadStem(0, score);
  graph.setStemGain(0, 1);
  graph.at(0);
  graph.start();
  /* Halfway through, the score goes under for two seconds. */
  graph.at(seconds / 2);
  graph.layout.music.duck(0.2, 0.3);
  graph.at(seconds / 2 + 2);
  graph.layout.music.duck(1, 0.5);
  return context.startRendering();
}
// #endregion

// #region beats
/**
 * Where the kicks are in a whole track, found once ahead of time; the same pulse a live detector
 * would give, read at any instant of a rendered clip; and, for music whose tempo is known, a grid.
 */
export function beatsOf(
  track: AudioBuffer,
  bpm: number,
): { map: BeatMap; pulse: RenderedPulse; grid: BeatMap } {
  const map = analyseTrack(track.getChannelData(0), track.sampleRate);
  const pulse = new RenderedPulse(track);
  const grid = beatGrid(bpm, 0, track.duration);
  return { map, pulse, grid };
}

/** Or the player taps along, and the tempo is what they tapped. */
export const tapper = new TapTempo();
export function tapped(nowMs: number): number | null {
  tapper.tap(nowMs);
  return tapper.bpm;
}
// #endregion

// #region cheap
/**
 * A fire heard the cheap way: a loop through the effects, louder as you near it and on its side
 * of your head. Right for anything diffuse, where how close and which way is all a player reads.
 */
export function hearFire(
  loop: AmbientLoop,
  fire: readonly [number, number],
  ears: readonly [number, number],
  yaw: number,
): void {
  const dx = fire[0] - ears[0];
  const dz = fire[1] - ears[1];
  loop.setGain(distanceGain(Math.hypot(dx, dz), 25));
  loop.setPan(stereoPan(dx, dz, yaw));
}
// #endregion

// #region inside
/**
 * A voice inside the crypt carries the crypt's tail even to a listener outside it, which a
 * listener-based zone alone cannot do. One gain node, since the zone's convolver already exists.
 */
export function listenInto(voice: SpatialSource, crypt: ReverbZone): void {
  voice.attachZone(crypt);
}
// #endregion

// #region field
/**
 * A four-channel ambisonic recording, a forest at night, decoded around the listener's head at a
 * fixed cost however many birds are in it. It follows the listener; turning the head turns it.
 */
export function forest(listener: AudioListenerGraph, recording: AudioBuffer): () => void {
  const field = createAmbisonicSoundfield(listener, recording, { loop: true });
  field.setGain(0.6);
  field.start();
  return () => field.follow();
}
// #endregion

// #region manifest
/**
 * A folder of sounds announcing itself: a manifest written at build time names them, and each
 * becomes a slot that tries every format it might have been saved in, silent if none loads.
 */
export async function registerFolder(sounds: SoundRegistry): Promise<string[]> {
  const names = await fetchAudioManifest('/audio/manifest.json');
  for (const name of names) {
    sounds.register(name, { urls: audioCandidateUrls(name), synth: silentBuffer });
  }
  return names;
}
// #endregion

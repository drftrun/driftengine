/**
 * What a browser can record a clip in, and what that choice commits the file to.
 *
 * Split out of `frameRecorder.ts`, and the reason is the caller rather than the code.
 * A game asks `supportedClipMimeType` at boot to decide whether an export button
 * should exist at all, which is a question about the *browser* — but asking it used to
 * drag `FrameRecorder` and `offerClip` into the same bundle chunk, and those are only
 * wanted once somebody actually exports something. A probe with no imports of its own
 * can be read from anywhere for nothing.
 */

/**
 * Container and codec preferences, best first.
 *
 * **The first two ask for AAC by name, and that is the point of them.** The list used
 * to open with `video/mp4;codecs=avc1`, which names the video codec and leaves the
 * audio to the browser — so a recording that *could* have been AAC was only AAC if the
 * browser felt like it, and there was no way to find out afterwards which it had been.
 * Asking explicitly makes the answer a fact `isTypeSupported` reports before a single
 * frame is recorded, and `describeClipMime` reads it back off the accepted string.
 *
 * This matters more than it looks, because the audio codec is what decides whether the
 * file can be posted. MP4 carrying Opus is legal ISO and Android's MediaCodec cannot
 * decode it, so the TikTok app refuses it outright.
 *
 * `avc1` unqualified follows the profile-qualified form because a build can accept the
 * general string and reject a specific profile, and either is better than falling to
 * WebM. WebM stays last: it is a real file that real desktop uploaders take, and it is
 * the only thing some browsers can produce.
 */
const MIME_CANDIDATES = [
  'video/mp4;codecs="avc1.640028,mp4a.40.2"',
  'video/mp4;codecs="avc1,mp4a.40.2"',
  /*
   * Opus named on purpose, and *above* the bare `avc1` that would otherwise match it.
   *
   * It looks like asking for the worse file, and it is not: on a build with no AAC
   * encoder the browser picks Opus for `codecs=avc1` anyway — verified, it is what every
   * `MediaRecorder` clip in this project has carried — so the choice is not between AAC
   * and Opus here, it is between an Opus file that says so and an Opus file that does
   * not. Naming it turns a vague "could not confirm AAC" into the accurate warning, with
   * the remux to go with it. Anywhere AAC exists, the two candidates above match first.
   */
  'video/mp4;codecs="avc1,opus"',
  'video/mp4;codecs=avc1',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
] as const;

/** What a recording MIME type commits the file to. See `describeClipMime`. */
export interface ClipMimeDescription {
  readonly container: 'mp4' | 'webm' | 'unknown';
  /**
   * `unspecified` is not a synonym for "fine". It means the string named no audio
   * codec, so the browser chose one and the file does not say which — the state this
   * type exists to stop a caller from having to guess about.
   */
  readonly audio: 'aac' | 'opus' | 'unspecified';
  /**
   * True only for MP4 carrying AAC: the one combination every share target on a phone
   * ingests without transcoding.
   *
   * Deliberately false for `unspecified`, which is a claim about knowledge rather than
   * about the file. A caller that reports "this may not upload" on a file that turns
   * out fine has been slightly annoying; one that stays quiet on a file that dies at
   * an upload screen has wasted a clip nobody can re-record.
   */
  readonly shareable: boolean;
}

/**
 * Read back what a recording MIME type promises, without recording anything.
 *
 * Pure, and string-parsing rather than clever: the accepted candidate above is the only
 * evidence available about a `MediaRecorder` file's audio codec, since the blob's `type`
 * is just the string it was handed.
 */
export function describeClipMime(mime: string): ClipMimeDescription {
  const lower = mime.toLowerCase();
  const container = lower.startsWith('video/mp4')
    ? 'mp4'
    : lower.startsWith('video/webm')
      ? 'webm'
      : 'unknown';
  // `mp4a.40.2` is AAC-LC; `mp4a.40.5`/`.29` are the HE variants, all of them AAC as
  // far as anything receiving the file is concerned.
  const audio = lower.includes('mp4a.40') ? 'aac' : lower.includes('opus') ? 'opus' : 'unspecified';
  return { container, audio, shareable: container === 'mp4' && audio === 'aac' };
}

/**
 * Whether this browser can record at all, and in what.
 *
 * MP4 first where it exists, because it is the format every social app accepts
 * without transcoding — a WebM upload that silently fails on a phone is worse
 * than no export button.
 */
export function supportedClipMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const mime of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch {
      // Some engines throw rather than returning false. Same answer either way.
    }
  }
  return null;
}

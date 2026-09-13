import { expect, test } from 'vitest';
import { describeClipMime } from './clipMime.ts';

/**
 * The only question this answers: will the file that comes out of this MIME type upload
 * to a phone's share targets?
 *
 * It is string parsing, which is not usually worth a test — except that the accepted
 * candidate string is the *only* evidence a `MediaRecorder` file carries about its audio
 * codec (the blob's `type` is just the string it was handed), and getting it wrong means
 * either a warning on a good clip or silence on a broken one.
 */
test('only MP4 carrying AAC is shareable', () => {
  expect(describeClipMime('video/mp4;codecs="avc1.640028,mp4a.40.2"')).toEqual({
    container: 'mp4',
    audio: 'aac',
    shareable: true,
  });
  // The HE variants are AAC to anything receiving the file.
  expect(describeClipMime('video/mp4;codecs="avc1,mp4a.40.5"').audio).toBe('aac');

  /*
   * Opus in MP4 is the file TikTok refuses — legal ISO, and Android's MediaCodec decodes
   * Opus only in Matroska, WebM and Ogg.
   */
  expect(describeClipMime('video/mp4;codecs="avc1,opus"')).toEqual({
    container: 'mp4',
    audio: 'opus',
    shareable: false,
  });

  /*
   * The case that used to be invisible: a string that names the video codec and leaves
   * the audio to the browser. Not shareable, because that is a statement about what is
   * *known* rather than about the file — staying quiet here is how a clip dies at an
   * upload screen with no explanation.
   */
  expect(describeClipMime('video/mp4;codecs=avc1')).toEqual({
    container: 'mp4',
    audio: 'unspecified',
    shareable: false,
  });

  // WebM is a real file and a real desktop upload, and never a phone share target.
  expect(describeClipMime('video/webm;codecs=vp9,opus').shareable).toBe(false);
  expect(describeClipMime('video/webm').container).toBe('webm');

  // Case is not significant in a MIME type, and a browser may hand one back normalised.
  expect(describeClipMime('VIDEO/MP4;CODECS="AVC1,MP4A.40.2"').shareable).toBe(true);
});

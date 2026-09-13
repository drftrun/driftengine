import { expect, test } from 'vitest';
import { audioCandidateUrls } from './formats.ts';

test('a slot answers to whatever format the sound arrived in', () => {
  // Dropping in an mp3 must need no conversion and no configuration: asking a
  // composer to transcode before they can hear their own track in the game is
  // friction with nothing on the other side of it.
  const urls = audioCandidateUrls('track-1');
  expect(urls).toContain('/audio/track-1.mp3');
  expect(urls).toContain('/audio/track-1.opus');
  expect(urls).toContain('/audio/track-1.wav');
  expect(urls[0], 'opus preferred, since payload budgets are always tight').toBe(
    '/audio/track-1.opus',
  );
});

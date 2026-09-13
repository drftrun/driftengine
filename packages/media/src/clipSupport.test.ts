import { afterEach, expect, test } from 'vitest';
import { clipCodecs, clipEncodingSupported } from './clipSupport.ts';

/**
 * The ladder's levels, against frames a consumer actually asks for.
 *
 * This is the contract the encoder rests on and the one that was wrong: both rungs used to be
 * level 4.0, whose 8192 macroblocks cannot represent anything above 1080, so `isConfigSupported`
 * refused 1440 and 4K before `configure` was ever reached. Every expectation below is read off
 * the H.264 level table by hand and was confirmed against Chrome 149 on an RX 9070 XT, where the
 * accepted-refused boundary fell on exactly these numbers.
 */

const CODECS_ASKED: string[] = [];

afterEach(() => {
  CODECS_ASKED.length = 0;
  delete (globalThis as { VideoEncoder?: unknown }).VideoEncoder;
});

test('a frame is asked for at the smallest level that can represent it', () => {
  /* 68 x 120 = 8160 macroblocks, inside level 4.0's 8192. What ships today. */
  expect(clipCodecs(1080, 1920)).toEqual(['avc1.640028', 'avc1.42E028']);
  expect(clipCodecs(1920, 1080)).toEqual(['avc1.640028', 'avc1.42E028']);
  /* 90 x 90 = 8100. Square 1440 fits 4.0 where portrait 1440 does not, which is why the
     measurement's table has one yes in a row of noes. */
  expect(clipCodecs(1440, 1440)).toEqual(['avc1.640028', 'avc1.42E028']);
  /* 120 x 72 = 8640: past 4.0's 8192 and inside 4.2's 8704. The one size 4.2 buys. */
  expect(clipCodecs(1920, 1152)).toEqual(['avc1.64002A', 'avc1.42E02A']);
  /* 160 x 90 = 14400 and 135 x 135 = 18225, both inside level 5.0's 22080. */
  expect(clipCodecs(2560, 1440)).toEqual(['avc1.640032', 'avc1.42E032']);
  expect(clipCodecs(2160, 2160)).toEqual(['avc1.640032', 'avc1.42E032']);
  /* 240 x 135 = 32400, past 5.0 and inside level 5.1's 36864. This is 4K, and it is the frame
     the old ladder refused. */
  expect(clipCodecs(3840, 2160)).toEqual(['avc1.640033', 'avc1.42E033']);
  /* 480 x 270 = 129600, inside level 6.0's 139264. */
  expect(clipCodecs(7680, 4320)).toEqual(['avc1.64003C', 'avc1.42E03C']);
});

test('the boundary is the level table, to the macroblock', () => {
  /* 64 x 128 = 8192 exactly, which level 4.0 holds. */
  expect(clipCodecs(1024, 2048)).toEqual(['avc1.640028', 'avc1.42E028']);
  /* 65 x 128 = 8320, one macroblock column over, which it does not. */
  expect(clipCodecs(1040, 2048)).toEqual(['avc1.64002A', 'avc1.42E02A']);
  /* Partial macroblocks count whole: 1080 is 67.5 columns and costs 68. */
  expect(clipCodecs(1080, 1080)).toEqual(['avc1.640028', 'avc1.42E028']);
});

test('a frame no level can hold is refused here rather than by the browser', () => {
  /* 1024 x 1024 = 1,048,576 macroblocks against level 6.0's 139,264. An empty ladder is what
     turns into "this browser cannot encode video at that size", one rung earlier than a
     round trip to a codec that was always going to say no. */
  expect(clipCodecs(16_384, 16_384)).toEqual([]);
});

test('the browser is asked once per request, and the rungs in order', async () => {
  /* The studio asks eighteen times at boot to grey out a panel, and the answer cannot change
     between two of them. Stubbed rather than mocked: `isConfigSupported` is the whole of what
     this touches. Level 5.1 refused and 6.0 accepted is not this card, it is a browser that
     draws its line somewhere else, which is the case the ladder exists for. */
  class FakeVideoEncoder {
    static isConfigSupported(config: { codec: string }): Promise<{ supported: boolean }> {
      CODECS_ASKED.push(config.codec);
      return Promise.resolve({ supported: config.codec === 'avc1.64003C' });
    }
  }
  (globalThis as { VideoEncoder?: unknown }).VideoEncoder = FakeVideoEncoder;
  const request = { width: 3840, height: 2160, fps: 120, bitrate: 24_000_000 };
  expect(await clipEncodingSupported(request)).toBe(false);
  expect(CODECS_ASKED).toEqual(['avc1.640033', 'avc1.42E033']);

  const eightK = { width: 7680, height: 4320, fps: 60, bitrate: 24_000_000 };
  expect(await clipEncodingSupported(eightK)).toBe(true);
  /* The High rung answered, so the baseline one is never asked. */
  expect(CODECS_ASKED).toEqual(['avc1.640033', 'avc1.42E033', 'avc1.64003C']);

  await clipEncodingSupported(eightK);
  expect(CODECS_ASKED).toHaveLength(3);
});

test('a browser without WebCodecs answers no rather than throwing', async () => {
  expect(
    await clipEncodingSupported({ width: 1080, height: 1920, fps: 30, bitrate: 2_500_000 }),
  ).toBe(false);
});

import { afterEach, expect, test } from 'vitest';

import { browserFrameSource } from './browserFrames.ts';

/**
 * **A clip the browser cannot decode is refused where it is opened, not three stages later.**
 *
 * Chrome on Linux plays no HEVC, and every recent phone records it by default. What that looks like
 * is the worst shape a failure can take: the container parses, `loadedmetadata` fires, `duration` is
 * correct to the millisecond — and `videoWidth` is zero, because there is no decodable video track
 * behind it. Nothing complains. The capture then asks for a frame, draws a zero-wide image into a
 * zero-wide canvas, and dies inside `getImageData` with "the source width is 0", which names
 * neither the clip nor the codec and sends a reader to the canvas code.
 *
 * Measured on this machine 2026-09-20: `canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"')` is the
 * empty string and `avc1` is `probably`, against a 1920×1080 HEVC recording that reported
 * `duration` 23.368 and `videoWidth` 0.
 */

const held = {
  document: (globalThis as { document?: unknown }).document,
  URL: globalThis.URL,
};

afterEach(() => {
  (globalThis as { document?: unknown }).document = held.document;
  globalThis.URL = held.URL;
});

/** A video element that reports what a decoder made of the file, and nothing else. */
function fakeVideo(size: { width: number; height: number; duration: number }) {
  const listeners = new Map<string, (() => void)[]>();
  return {
    preload: '',
    muted: false,
    playsInline: false,
    error: null,
    videoWidth: size.width,
    videoHeight: size.height,
    duration: size.duration,
    currentTime: 0,
    set src(_value: string) {
      /* The decoder answers on the next turn, as a real one does. */
      queueMicrotask(() => {
        for (const listener of listeners.get('loadedmetadata') ?? []) listener();
      });
    },
    addEventListener(event: string, listener: () => void): void {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    removeEventListener(event: string, listener: () => void): void {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((one) => one !== listener),
      );
    },
    removeAttribute(): void {},
    load(): void {},
    pause(): void {},
  };
}

function withVideo(size: { width: number; height: number; duration: number }): void {
  (globalThis as { document?: unknown }).document = {
    createElement: () => fakeVideo(size),
  };
  globalThis.URL = {
    createObjectURL: () => 'blob:clip',
    revokeObjectURL: () => {},
  } as unknown as typeof URL;
}

test('A CLIP THE BROWSER CANNOT DECODE IS REFUSED BY NAME, NOT BY A CANVAS ERROR LATER', async () => {
  withVideo({ width: 0, height: 0, duration: 23.368 });
  await expect(browserFrameSource(new Blob([new Uint8Array(4)]))).rejects.toThrow(
    /cannot decode|codec/i,
  );
});

test('the refusal says what was wrong with the clip rather than what the code was doing', async () => {
  /*
   * **The message is the whole of the fix.** A person who records on a phone and drops the file in
   * gets this once and knows to convert; the same person facing "the source width is 0" goes
   * looking through the capture package.
   */
  withVideo({ width: 0, height: 0, duration: 23.368 });
  const thrown = await browserFrameSource(new Blob([new Uint8Array(4)])).catch(
    (reason: unknown) => reason,
  );
  const said = thrown instanceof Error ? thrown.message : String(thrown);
  expect(said).toMatch(/23\.37|23\.368/);
  expect(said.toLowerCase()).toContain('h.264');
});

test('a clip with a decodable track is not refused', async () => {
  /*
   * The control: the same path with a size behind it gets as far as needing a canvas, which is a
   * later failure and a different one. Without this, a guard that refused everything would pass.
   */
  withVideo({ width: 640, height: 360, duration: 2 });
  const thrown = await browserFrameSource(new Blob([new Uint8Array(4)])).catch(
    (reason: unknown) => reason,
  );
  const said = thrown instanceof Error ? thrown.message : String(thrown);
  expect(said.toLowerCase()).not.toContain('h.264');
});

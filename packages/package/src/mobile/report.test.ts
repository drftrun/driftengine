import { describe, expect, it, vi } from 'vitest';

import { deviceReport } from './report.ts';

function stubDevice(options: { gpu?: boolean; renderer?: string; ua?: string } = {}): void {
  vi.stubGlobal('navigator', {
    userAgent: options.ua ?? 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126.0.0.0',
    ...(options.gpu === true ? { gpu: {} } : {}),
  });
  vi.stubGlobal('globalThis', globalThis);
  vi.stubGlobal('document', {
    createElement: () => ({
      getContext: () =>
        options.renderer === undefined
          ? null
          : {
              getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 37446 }),
              getParameter: () => options.renderer,
            },
    }),
  });
}

describe('deviceReport', () => {
  /*
   * **Every value is what the device said.** This exists because a pinned desktop Chromium cannot
   * see the class of failure that matters here — WebKit enforces a sixteen-byte uniform array
   * stride that Dawn does not, so the shaders that draw everything compiled on every desktop
   * browser and on no iPhone. A report of guesses would be worse than none.
   */
  it('reports what the device says about its renderer', () => {
    stubDevice({ renderer: 'Apple GPU', gpu: false });
    const report = deviceReport();
    expect(report.webglRenderer).toBe('Apple GPU');
    expect(report.webgpu).toBe('absent');
    vi.unstubAllGlobals();
  });

  it('reports WebGPU where the device offers it', () => {
    stubDevice({ renderer: 'Adreno (TM) 750', gpu: true });
    expect(deviceReport().webgpu).toBe('present');
    vi.unstubAllGlobals();
  });

  /*
   * A value that could not be read is empty rather than plausible. An invented renderer string is
   * exactly what the capability clamp would then match against, which is how a phone ends up in
   * the wrong tier.
   */
  it('leaves what it could not read empty rather than filling it in', () => {
    stubDevice({});
    expect(deviceReport().webglRenderer).toBe('');
    vi.unstubAllGlobals();
  });

  it('pulls the platform version out of the user agent it was given', () => {
    stubDevice({
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) Version/18.2 Safari',
    });
    expect(deviceReport().platform).toBe('iOS 18.2');
    vi.unstubAllGlobals();
    stubDevice({ ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126.0.0.0' });
    expect(deviceReport().platform).toBe('Android 14');
    vi.unstubAllGlobals();
  });

  it('names the WebView build, which is what a compile failure is attributed to', () => {
    stubDevice({ ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126.0.6478.71' });
    expect(deviceReport().engine).toBe('Chrome 126.0.6478.71');
    vi.unstubAllGlobals();
    stubDevice({
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) Version/18.2 Safari/605.1',
    });
    expect(deviceReport().engine).toBe('Safari 18.2');
    vi.unstubAllGlobals();
  });
});

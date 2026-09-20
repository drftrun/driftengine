import { describe, expect, it } from 'vitest';

import { parseManifest } from './manifest.ts';

const valid = {
  id: 'dev.example.title',
  name: 'Title',
  entry: 'dist/index.html',
  window: { width: 1280, height: 720, mode: 'borderless', resizable: true },
  backend: { webgpu: 'prefer', allowSoftwareRenderer: false },
  features: { clipExport: false, gamepad: true },
  targets: ['win-x64'],
  steam: { appId: null },
};

describe('parseManifest', () => {
  it('accepts a complete manifest and returns it typed', () => {
    expect(parseManifest(valid).id).toBe('dev.example.title');
  });

  /*
   * A reverse-DNS id is what every one of the three platforms keys an application on, and a
   * wrong one is not discovered until signing or until saves land in the wrong directory.
   * Rejecting it here costs nothing; rejecting it at notarisation costs a build.
   */
  it('refuses an id that is not reverse-DNS, and names the field', () => {
    expect(() => parseManifest({ ...valid, id: 'Title' })).toThrow(/id/);
  });

  it('refuses an unknown target rather than silently skipping it', () => {
    expect(() => parseManifest({ ...valid, targets: ['ps5'] })).toThrow(/ps5/);
  });

  /*
   * **A game on the native host is mounted rather than loaded.** There is no page there to find a
   * canvas in, so the manifest names the module whose `mount(canvas)` the host calls — and a native
   * target with no such module is refused here, where the reason is one field, rather than after a
   * bundle has been built around nothing.
   */
  it('takes the module a native target mounts, and refuses the target without one', () => {
    const native = { ...valid, targets: ['native-linux-x64'], native: { entry: 'src/native.ts' } };
    expect(parseManifest(native).native).toEqual({ entry: 'src/native.ts' });
    expect(parseManifest(valid).native).toBeNull();
    expect(() => parseManifest({ ...valid, targets: ['native-linux-x64'] })).toThrow(
      /native-linux-x64.*"native.entry"/,
    );
  });

  it('refuses an unknown webgpu policy', () => {
    expect(() =>
      parseManifest({ ...valid, backend: { webgpu: 'maybe', allowSoftwareRenderer: false } }),
    ).toThrow(/maybe/);
  });

  /*
   * The engine badge is on by default and can be turned off, which is the honest arrangement: a
   * consumer who does not want it says so in one line rather than being unable to.
   */
  it('shows the engine splash by default, for long enough to be read', () => {
    const { splash } = parseManifest(valid);
    expect(splash.show).toBe(true);
    expect(splash.minMs).toBe(1400);
  });

  it('takes a splash that is turned off, and one with its own duration', () => {
    expect(parseManifest({ ...valid, splash: { show: false } }).splash.show).toBe(false);
    expect(parseManifest({ ...valid, splash: { minMs: 800 } }).splash.minMs).toBe(800);
  });

  /*
   * A splash long enough to be a wait is a splash somebody will be annoyed by, and one that
   * outlives a broken boot hides the failure. Both ends are clamped rather than trusted.
   */
  it('clamps a duration that would be a wait or a flash', () => {
    expect(parseManifest({ ...valid, splash: { minMs: 90_000 } }).splash.minMs).toBe(6000);
    expect(parseManifest({ ...valid, splash: { minMs: -5 } }).splash.minMs).toBe(0);
  });

  /*
   * An installer puts this in front of a person, so it is defaulted from something real rather
   * than left blank: the id's own organisation label is already in the manifest.
   */
  /* The engine's mark rather than Electron's, which would brand a game as its framework. */
  it('defaults the icon to none, meaning the engine mark', () => {
    expect(parseManifest(valid).icon).toBeNull();
    expect(parseManifest({ ...valid, icon: 'art/icon.png' }).icon).toBe('art/icon.png');
  });

  it('takes the publisher from the id when none is given', () => {
    expect(parseManifest(valid).publisher).toBe('example');
    expect(parseManifest({ ...valid, publisher: 'Drift Technologies' }).publisher).toBe(
      'Drift Technologies',
    );
  });

  /*
   * Defaults are filled rather than demanded, because a manifest a person writes by hand
   * should be short. What is not defaulted is anything whose wrong value is silent.
   */
  it('defaults the window and the features when they are absent', () => {
    const { window, features } = parseManifest({
      id: 'dev.example.title',
      name: 'Title',
      entry: 'dist/index.html',
      backend: { webgpu: 'prefer', allowSoftwareRenderer: false },
      targets: ['win-x64'],
      steam: { appId: null },
    });
    expect(window.width).toBe(1280);
    expect(features.clipExport).toBe(false);
  });
});

describe('the android block', () => {
  /*
   * **Absent means nothing asked for, which is the posture the manifest template documents.** A
   * game that needs the network says so, and the asking is then visible in the store listing
   * rather than granted to every game the packager ever builds.
   */
  it('defaults to no permissions and no cleartext', () => {
    const parsed = parseManifest(valid);
    expect(parsed.android.permissions).toEqual([]);
    expect(parsed.android.cleartextTraffic).toBe(false);
  });

  it('takes the short name a consumer writes and stores what the XML needs', () => {
    const parsed = parseManifest({ ...valid, android: { permissions: ['INTERNET'] } });
    expect(parsed.android.permissions).toEqual(['android.permission.INTERNET']);
  });

  it('leaves a qualified name as it was written', () => {
    const parsed = parseManifest({
      ...valid,
      android: { permissions: ['android.permission.ACCESS_NETWORK_STATE'] },
    });
    expect(parsed.android.permissions).toEqual(['android.permission.ACCESS_NETWORK_STATE']);
  });

  it('refuses a permission that would break out of the XML attribute', () => {
    expect(() =>
      parseManifest({ ...valid, android: { permissions: ['INTERNET" /><uses-permission x="'] } }),
    ).toThrow(/not a permission name/);
  });

  it('refuses the wrong shape rather than quietly ignoring it', () => {
    expect(() => parseManifest({ ...valid, android: { permissions: 'INTERNET' } })).toThrow(
      /must be an array/,
    );
    expect(() => parseManifest({ ...valid, android: { permissions: [3] } })).toThrow(
      /expected strings/,
    );
  });

  it('takes cleartext only when it is asked for exactly', () => {
    expect(
      parseManifest({ ...valid, android: { cleartextTraffic: true } }).android.cleartextTraffic,
    ).toBe(true);
    /* Not `'true'`, not `1`: a security posture is not something to be talked into by a truthy. */
    expect(
      parseManifest({ ...valid, android: { cleartextTraffic: 'true' } }).android.cleartextTraffic,
    ).toBe(false);
  });
});

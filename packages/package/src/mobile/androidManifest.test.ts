import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  checkPermission,
  fullPermissionName,
  NO_ANDROID_OPTIONS,
  withAndroidManifest,
} from './androidManifest.ts';

/**
 * The real template, not a fixture of one.
 *
 * A hand-written snippet would let this file pass while the thing a build actually copies drifts
 * away from it — and the two properties that matter here, that `<application>` exists to be
 * inserted before and that `usesCleartextTraffic` exists to be rewritten, are properties *of that
 * file*. `withAndroidManifest` throws on either being absent, and asserting against the template
 * is what makes those throws reachable by a test rather than by a consumer's build.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const template = await readFile(
  join(HERE, '..', '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
  'utf8',
);

describe('fullPermissionName', () => {
  it('expands a short name, which is what a permission is called everywhere but the XML', () => {
    expect(fullPermissionName('INTERNET')).toBe('android.permission.INTERNET');
  });

  it('leaves a qualified name alone, including one from a library', () => {
    expect(fullPermissionName('android.permission.INTERNET')).toBe('android.permission.INTERNET');
    expect(fullPermissionName('com.android.vending.BILLING')).toBe('com.android.vending.BILLING');
  });
});

describe('checkPermission', () => {
  it('accepts the shapes Android uses', () => {
    expect(() => checkPermission('INTERNET')).not.toThrow();
    expect(() => checkPermission('android.permission.ACCESS_NETWORK_STATE')).not.toThrow();
  });

  it('refuses what would end the XML attribute it is written into', () => {
    /* The name is interpolated into `android:name="..."`, so a quote in it is a manifest nobody
       wrote. Refused at parse time, where a consumer can still fix the field. */
    expect(() => checkPermission('INTERNET" />< malicious')).toThrow(/not a permission name/);
    expect(() => checkPermission('has space')).toThrow(/not a permission name/);
    expect(() => checkPermission('')).toThrow(/not a permission name/);
  });
});

describe('withAndroidManifest', () => {
  it('changes nothing at all when nothing is asked for', () => {
    /*
     * The property every game that has never heard of this depends on: byte-identical output, so
     * the APK it builds tomorrow is the APK it built yesterday.
     */
    expect(withAndroidManifest(template, NO_ANDROID_OPTIONS)).toBe(template);
  });

  it('writes the permission the report asked for', () => {
    const out = withAndroidManifest(template, {
      permissions: ['android.permission.INTERNET'],
      cleartextTraffic: false,
    });
    expect(out).toContain('<uses-permission android:name="android.permission.INTERNET" />');
  });

  it('puts them before <application>, where the schema wants them', () => {
    const out = withAndroidManifest(template, {
      permissions: ['android.permission.INTERNET'],
      cleartextTraffic: false,
    });
    expect(out.indexOf('<uses-permission')).toBeLessThan(out.indexOf('<application'));
  });

  it('keeps the order asked for, so a diff of two builds reads the way the manifest does', () => {
    const out = withAndroidManifest(template, {
      permissions: ['android.permission.INTERNET', 'android.permission.ACCESS_NETWORK_STATE'],
      cleartextTraffic: false,
    });
    expect(out.indexOf('INTERNET')).toBeLessThan(out.indexOf('ACCESS_NETWORK_STATE'));
  });

  it('rewrites the cleartext attribute rather than adding a second one', () => {
    /*
     * Two `android:usesCleartextTraffic` attributes on one element is a build failure, and
     * appending is the obvious way to write this and the way that produces it.
     */
    const out = withAndroidManifest(template, { permissions: [], cleartextTraffic: true });
    expect(out.match(/android:usesCleartextTraffic/g)).toHaveLength(1);
    expect(out).toContain('android:usesCleartextTraffic="true"');
    expect(out).not.toContain('android:usesCleartextTraffic="false"');
  });

  it('leaves the default posture in place when cleartext is not asked for', () => {
    const out = withAndroidManifest(template, {
      permissions: ['android.permission.INTERNET'],
      cleartextTraffic: false,
    });
    expect(out).toContain('android:usesCleartextTraffic="false"');
  });

  it('refuses to silently do nothing if the template stops declaring the attribute', () => {
    const stripped = template.replace(/\s*android:usesCleartextTraffic="(?:true|false)"/, '');
    expect(() =>
      withAndroidManifest(stripped, { permissions: [], cleartextTraffic: true }),
    ).toThrow(/no longer declares/);
  });

  it('refuses to guess where a permission goes if <application> is gone', () => {
    const stripped = template.replace('<application', '<applicationX');
    expect(() =>
      withAndroidManifest(stripped, {
        permissions: ['android.permission.INTERNET'],
        cleartextTraffic: false,
      }),
    ).toThrow(/no <application>/);
  });

  it('produces a manifest that is still one well-formed document', () => {
    /*
     * Crude but real: the element counts have to balance, and an insertion that lands inside
     * another element's tag would not. `aapt2` is the authority and it is exercised by the build,
     * not by this file.
     */
    const out = withAndroidManifest(template, {
      permissions: ['android.permission.INTERNET'],
      cleartextTraffic: true,
    });
    expect(out.match(/<manifest[\s>]/g)).toHaveLength(1);
    expect(out.match(/<\/manifest>/g)).toHaveLength(1);
    expect(out.match(/<application[\s>]/g)).toHaveLength(1);
    expect(out.match(/<activity[\s>]/g)).toHaveLength(1);
  });
});

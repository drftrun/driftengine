import { describe, expect, it } from 'vitest';

import { planSigning } from './signing.ts';

describe('planSigning', () => {
  /*
   * The case that decides whether a build runs at all. An unsigned arm64 binary is killed by the
   * loader on the machine that produced it, so "no certificate" cannot mean "no signature".
   */
  it('ad-hoc signs macOS when there is no identity, because unsigned will not launch', () => {
    const plan = planSigning('mac-arm64', {}, 'darwin');
    expect(plan.mode).toBe('adhoc');
    expect(plan.notarise).toBe(false);
    expect(plan.reason).toMatch(/loader|unsigned/i);
  });

  it('signs macOS for real when a certificate is in the environment', () => {
    const plan = planSigning(
      'mac-arm64',
      { CSC_LINK: '/tmp/cert.p12', CSC_KEY_PASSWORD: 'x' },
      'darwin',
    );
    expect(plan.mode).toBe('real');
    expect(plan.notarise).toBe(false);
  });

  /* Notarisation is a separate credential from signing, and half of it is not a state to be in. */
  it('notarises only when all three Apple credentials are present', () => {
    const partial = planSigning(
      'mac-arm64',
      {
        CSC_LINK: '/tmp/cert.p12',
        APPLE_ID: 'a@b.c',
        APPLE_TEAM_ID: 'TEAM',
      },
      'darwin',
    );
    expect(partial.notarise).toBe(false);
    const full = planSigning(
      'mac-arm64',
      {
        CSC_LINK: '/tmp/cert.p12',
        APPLE_ID: 'a@b.c',
        APPLE_APP_SPECIFIC_PASSWORD: 'pw',
        APPLE_TEAM_ID: 'TEAM',
      },
      'darwin',
    );
    expect(full.notarise).toBe(true);
  });

  it('leaves Windows unsigned when there is no certificate, and says what that costs', () => {
    const plan = planSigning('win-x64', {}, 'linux');
    expect(plan.mode).toBe('none');
    expect(plan.reason).toMatch(/SmartScreen/i);
  });

  it('prefers the Windows-specific certificate over the shared one', () => {
    expect(planSigning('win-x64', { WIN_CSC_LINK: '/tmp/w.pfx' }, 'linux').mode).toBe('real');
    expect(planSigning('win-x64', { CSC_LINK: '/tmp/any.p12' }, 'linux').mode).toBe('real');
  });

  /* An empty variable is not a certificate. A shell that exports `CSC_LINK=` would otherwise
     produce a build that claims to be signed and is not. */
  it('treats an empty variable as absent', () => {
    expect(planSigning('win-x64', { CSC_LINK: '' }, 'linux').mode).toBe('none');
  });

  /*
   * **Android has no unsigned option at all**, which makes it the odd one out: the platform
   * refuses to install an unsigned APK, so the choice is between a key somebody owns and a key the
   * packager generates. A generated one is `adhoc` in the same sense macOS's is — a signature that
   * is not an identity — and the reason has to say what that costs, because it is not the same
   * cost as macOS's.
   */
  it('treats a generated Android keystore as ad-hoc, and says what it cannot do', () => {
    const plan = planSigning('android', {}, 'linux');
    expect(plan.mode).toBe('adhoc');
    expect(plan.reason).toMatch(/developer mode/i);
    expect(plan.reason).toMatch(/Play Store|publish/i);
    /* And not macOS's reason, which is the bug this test exists for. */
    expect(plan.reason).not.toMatch(/Gatekeeper|Apple Silicon/i);
  });

  it('signs Android for real from a keystore in the environment', () => {
    expect(
      planSigning('android', { DRIFT_ANDROID_KEYSTORE: '/keys/upload.jks' }, 'linux').mode,
    ).toBe('real');
  });

  /* iOS free provisioning lasts seven days, which is a fact a build log should carry. */
  it('reports iOS free provisioning as ad-hoc, with its expiry', () => {
    const plan = planSigning('ios', {}, 'darwin');
    expect(plan.mode).toBe('adhoc');
    expect(plan.reason).toMatch(/seven days|7 days/i);
  });

  it('never signs Linux', () => {
    expect(planSigning('linux-x64', { CSC_LINK: '/tmp/cert.p12' }, 'linux').mode).toBe('none');
  });

  /*
   * **The native host's Linux build is a Linux artifact too**, and before it was named here it fell
   * through to the Mac branch: a Linux build reported as ad-hoc signed by rcodesign, and refused
   * outright with a certificate in the environment.
   */
  it('never signs the native host on Linux either, and never refuses it over a certificate', () => {
    const plan = planSigning('native-linux-x64', { CSC_LINK: '/tmp/cert.p12' }, 'linux');
    expect([plan.mode, plan.crossSign, plan.refusal]).toEqual(['none', false, null]);
  });
});

/*
 * **macOS built from Linux**, which is the cross-build route.
 *
 * electron-builder packs the `.app` happily off a Mac — its own refusal fires on Windows only —
 * and then skips signing with a warning, because `isSignAllowed()` returns false anywhere but
 * darwin. So the artifact it produces here on its own is *unsigned*, and an unsigned arm64 binary
 * is killed by the loader before it draws anything. `rcodesign` is what puts a signature on it
 * from Linux, and `crossSign` is how the build knows to apply one itself rather than trust
 * electron-builder to have done it.
 */
describe('planSigning across hosts', () => {
  it('ad-hoc signs a Mac target built on Linux, and names the signer that does it', () => {
    const plan = planSigning('mac-arm64', {}, 'linux');
    expect(plan.mode).toBe('adhoc');
    expect(plan.crossSign).toBe(true);
    expect(plan.refusal).toBeNull();
    expect(plan.reason).toMatch(/rcodesign/i);
  });

  it('names what a Linux-built Mac artifact cannot do', () => {
    const plan = planSigning('mac-arm64', {}, 'linux');
    /* No `.dmg`: that is `hdiutil`, and `hdiutil` is macOS only. */
    expect(plan.reason).toMatch(/dmg/i);
    /* And nothing on this side can prove it launches — worth printing on every build. */
    expect(plan.reason).toMatch(/launch/i);
  });

  it('applies to both Mac architectures rather than just arm64', () => {
    expect(planSigning('mac-x64', {}, 'linux').crossSign).toBe(true);
  });

  /*
   * **The refusal that matters.** `CSC_NAME` is a keychain identity and there is no keychain here.
   * A `.p12` in `CSC_LINK` is signable by rcodesign in principle, and this build does not wire it.
   * Either way the artifact comes out ad-hoc — and an ad-hoc build that the person who made it
   * believes is Developer ID signed is worse than no build at all, because they will ship it.
   */
  it('refuses rather than silently downgrading a real certificate to ad-hoc', () => {
    const plan = planSigning('mac-arm64', { CSC_LINK: '/tmp/cert.p12' }, 'linux');
    expect(plan.refusal).not.toBeNull();
    expect(plan.refusal).toMatch(/ad-hoc|Developer ID/i);
    expect(
      planSigning('mac-arm64', { CSC_NAME: 'Developer ID Application: X' }, 'linux').refusal,
    ).not.toBeNull();
  });

  it('signs on the Mac with codesign rather than cross-signing', () => {
    expect(planSigning('mac-arm64', {}, 'darwin').crossSign).toBe(false);
    expect(planSigning('mac-arm64', {}, 'darwin').reason).not.toMatch(/rcodesign/i);
  });

  /* Nothing else cross-signs: Linux is unsigned, and Android and iOS carry their own signers. */
  it('never cross-signs a target that is not macOS', () => {
    for (const target of ['linux-x64', 'native-linux-x64', 'win-x64', 'android', 'ios'] as const) {
      expect(planSigning(target, {}, 'linux').crossSign).toBe(false);
      expect(planSigning(target, {}, 'linux').refusal).toBeNull();
    }
  });
});

import type { Target } from './manifest.ts';

/**
 * Whether this build is signed, ad-hoc signed, or not signed at all — and why.
 *
 * **Three modes rather than a boolean**, because the middle one is load-bearing: Apple Silicon's
 * loader refuses to execute an unsigned binary outright, which is not Gatekeeper and which no user
 * gesture works around. A macOS build with no certificate must therefore carry *a* signature, and
 * `codesign --sign -` is the one available for free. It is not a substitute for a Developer ID: a
 * downloaded `.dmg` carries `com.apple.quarantine`, an ad-hoc signature does not satisfy
 * Gatekeeper, and the first launch is refused until the flag is cleared.
 *
 * **Everything is read from the environment and nothing from `drift.package.json`.** The manifest
 * is committed; a certificate and its password are not, and a packager that read them from a
 * committed file would be teaching people to commit them. The variable names are
 * `electron-builder`'s own, so there is no translation layer to maintain.
 *
 * **`reason` is printed on every build.** An artifact whose signature status was not stated is the
 * failure this module exists to prevent: the person who built it finds out from a player.
 */
export type SigningMode = 'none' | 'adhoc' | 'real';

export interface SigningPlan {
  readonly mode: SigningMode;
  /** Notarisation is a separate credential from signing, and needs a paid Developer ID. */
  readonly notarise: boolean;
  /** What was decided and what it costs, in words a build log should carry. */
  readonly reason: string;
  /**
   * Whether this build applies the macOS signature itself, because electron-builder will not.
   *
   * True exactly when a Mac target is built somewhere that is not a Mac. `isSignAllowed()` returns
   * false off darwin, and electron-builder then packs on regardless: it logs one warning and
   * produces an unsigned `.app`, which is the artifact Apple Silicon's loader refuses. `rcodesign`
   * puts the signature on afterwards, and this is the flag that says somebody still has to.
   */
  readonly crossSign: boolean;
  /** Non-null means refuse to build, and this is what to print. */
  readonly refusal: string | null;
}

/** The ordinary case: the host signs for itself, with its own signer, and nothing is refused. */
const HOST_SIGNED = { crossSign: false, refusal: null } as const;

/**
 * The machine a build is running on, spelled the way `process.platform` spells it.
 *
 * **Passed in rather than read**, and that is this half of the package's rule rather than a
 * preference: `signing.ts` is typechecked with no ambient Node types — see the `exclude` list in
 * `tsconfig.json` — because a consumer bundles this source for a browser, and a `process` reaching
 * one of their bundles is the failure that config exists to prevent. Taking it as an argument also
 * makes every test name the host it means instead of inheriting whichever machine ran it.
 */
export type BuildHost = string;

function has(env: Readonly<Record<string, string | undefined>>, name: string): boolean {
  const value = env[name];
  return typeof value === 'string' && value.length > 0;
}

export function planSigning(
  target: Target,
  env: Readonly<Record<string, string | undefined>>,
  platform: BuildHost,
): SigningPlan {
  if (target === 'linux-x64' || target === 'native-linux-x64') {
    return {
      ...HOST_SIGNED,
      mode: 'none',
      notarise: false,
      /* No signature is expected of a Linux artifact by anything that runs one. An AppImage can
         carry a detached GPG signature and nothing checks it by default, so producing one would be
         ceremony rather than protection. The native host's archive is the same case. */
      reason: 'Linux artifacts are not signed; nothing on the platform checks one',
    };
  }

  if (target === 'android') {
    /*
     * **Android is the one platform with no unsigned option to offer**: it refuses to install an
     * unsigned APK outright, so a build always signs and the only question is with whose key.
     */
    if (has(env, 'DRIFT_ANDROID_KEYSTORE')) {
      return {
        ...HOST_SIGNED,
        mode: 'real',
        notarise: false,
        reason: 'signed with the keystore in DRIFT_ANDROID_KEYSTORE',
      };
    }
    return {
      ...HOST_SIGNED,
      mode: 'adhoc',
      notarise: false,
      reason:
        'a generated throwaway key: installs on a device with developer mode on, cannot be ' +
        'published to the Play Store, and an upgrade signed with a different generated key is ' +
        'refused by the device as an impostor — which is why the generated one is kept',
    };
  }

  if (target === 'ios') {
    if (has(env, 'APPLE_TEAM_ID')) {
      return {
        ...HOST_SIGNED,
        mode: 'real',
        notarise: false,
        reason: 'signed with the Apple team in APPLE_TEAM_ID',
      };
    }
    return {
      ...HOST_SIGNED,
      mode: 'adhoc',
      notarise: false,
      reason:
        'free provisioning: a build installs to your own device and stops running after seven ' +
        'days, which is the Apple ID path rather than the paid Developer Program',
    };
  }

  if (target === 'win-x64') {
    if (has(env, 'WIN_CSC_LINK') || has(env, 'CSC_LINK')) {
      return {
        ...HOST_SIGNED,
        mode: 'real',
        notarise: false,
        reason: 'Authenticode signing from the certificate in the environment',
      };
    }
    return {
      ...HOST_SIGNED,
      mode: 'none',
      notarise: false,
      reason:
        'unsigned: Windows will run it and SmartScreen will warn on first launch. A Steam depot ' +
        'raises no warning, because the client delivering it is signed',
    };
  }

  const real = has(env, 'CSC_LINK') || has(env, 'CSC_NAME');

  /*
   * **macOS from somewhere that is not macOS.** electron-builder's own refusal fires on Windows
   * alone, so a Mac target packs here and comes out unsigned unless this build signs it — see
   * `crossSign` above for why that is fatal rather than cosmetic.
   */
  if (platform !== 'darwin') {
    /*
     * **A certificate in the environment is refused rather than ignored.** `CSC_NAME` names an
     * identity in a keychain and there is no keychain here; `CSC_LINK` is a `.p12`, which
     * rcodesign can use in principle and this build does not wire. Either way the artifact would
     * come out ad-hoc — and an ad-hoc build whose author believes it carries a Developer ID is
     * worse than no build, because that is the one they ship to strangers.
     */
    if (real) {
      return {
        mode: 'adhoc',
        notarise: false,
        crossSign: true,
        reason: 'refused before signing; see the refusal',
        refusal:
          `a Developer ID certificate is in the environment and this is ${platform}, which ` +
          'cannot use one: CSC_NAME is a keychain identity and there is no keychain here, and ' +
          'the .p12 route is not wired. The build would be ad-hoc while reporting a certificate. ' +
          'Build it on a Mac, or unset CSC_LINK and CSC_NAME to get an ad-hoc build on purpose',
      };
    }
    return {
      mode: 'adhoc',
      notarise: false,
      crossSign: true,
      refusal: null,
      reason:
        'ad-hoc signed by rcodesign, because electron-builder skips signing off a Mac and an ' +
        'unsigned binary is refused by the loader on Apple Silicon. The artifact is a .zip: a ' +
        '.dmg is built by hdiutil, which exists only on macOS. A downloaded copy is still ' +
        'refused by Gatekeeper until `xattr -dr com.apple.quarantine` clears the flag, and ' +
        'nothing on this host can prove the result launches — open it on a Mac before it ships',
    };
  }

  const notarise =
    real &&
    has(env, 'APPLE_ID') &&
    has(env, 'APPLE_APP_SPECIFIC_PASSWORD') &&
    has(env, 'APPLE_TEAM_ID');
  if (real) {
    return {
      ...HOST_SIGNED,
      mode: 'real',
      notarise,
      reason: notarise
        ? 'Developer ID signing and notarisation from the environment'
        : 'Developer ID signing; not notarised, so a download is still refused until it is',
    };
  }
  return {
    ...HOST_SIGNED,
    mode: 'adhoc',
    notarise: false,
    reason:
      'ad-hoc signed: an unsigned binary is refused by the loader on Apple Silicon, so this is ' +
      'the minimum that runs. A downloaded copy is still refused by Gatekeeper until ' +
      '`xattr -dr com.apple.quarantine` clears the flag',
  };
}

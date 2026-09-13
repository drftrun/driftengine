/**
 * `drift.package.json`, parsed once and trusted afterwards.
 *
 * **Every rejection names its field.** A packaging manifest is written by hand, usually once, and
 * a wrong value surfaces at signing or at first launch on a machine the author does not have. The
 * cost of validating here is a few dozen lines; the cost of not validating is a build.
 *
 * **What is defaulted and what is not** is the only interesting decision in this file. Window size
 * and features default, because a short manifest is easier to read and a wrong window is visible
 * immediately. The id, the entry, the targets and the backend policy do not, because each of them
 * is silent when wrong: the wrong id writes saves to a directory nobody looks in.
 */
import { checkPermission, fullPermissionName } from './mobile/androidManifest.ts';

export type WebGpuPolicy = 'prefer' | 'require' | 'off';
export type Target = 'win-x64' | 'mac-arm64' | 'mac-x64' | 'linux-x64' | 'android' | 'ios';

/** The two that are a phone rather than a desktop, and differ in almost every way that matters. */
export const MOBILE_TARGETS: readonly Target[] = ['android', 'ios'];

const POLICIES: readonly WebGpuPolicy[] = ['prefer', 'require', 'off'];
const TARGETS: readonly Target[] = [
  'win-x64',
  'mac-arm64',
  'mac-x64',
  'linux-x64',
  'android',
  'ios',
];
/**
 * How long the engine badge holds the screen before the game gets it.
 *
 * **Both ends are clamped rather than trusted.** Long enough to be read is about a second and a
 * half; past six seconds it is a wait somebody resents, and a splash that outlives a failed boot
 * hides the failure behind a logo. Zero is allowed and means the badge shows only for as long as
 * the game takes to paint, which on a fast machine is a flash.
 */
const SPLASH_DEFAULT_MS = 1400;
const SPLASH_MAX_MS = 6000;

/** Reverse-DNS, which is what all three platforms key an application on. */
const ID = /^[a-z0-9]+(\.[a-z0-9][a-z0-9-]*)+$/;

export interface PackageManifest {
  readonly id: string;
  readonly name: string;
  readonly entry: string;
  readonly window: {
    readonly width: number;
    readonly height: number;
    readonly mode: 'windowed' | 'borderless' | 'fullscreen';
    readonly resizable: boolean;
  };
  readonly backend: { readonly webgpu: WebGpuPolicy; readonly allowSoftwareRenderer: boolean };
  readonly features: { readonly clipExport: boolean; readonly gamepad: boolean };
  readonly targets: readonly Target[];
  readonly steam: { readonly appId: number | null };
  readonly splash: { readonly show: boolean; readonly minMs: number };
  /**
   * What the Android build asks the platform for. Nothing, unless a game says otherwise.
   *
   * **`permissions` is empty by default and that default is the feature**: the manifest template
   * declares none, so a game asks for what it needs and the asking is visible in the store listing
   * rather than granted to every game the packager ever builds. `"INTERNET"` and
   * `"android.permission.INTERNET"` are both accepted.
   *
   * **`cleartextTraffic` is false by default and is the other half of reaching a relay.** The game
   * is served from `https://appassets.androidplatform.net`, which is a secure context, so Blink
   * refuses `ws://` from it as mixed content whatever Android's own policy says. Setting this true
   * sets `android:usesCleartextTraffic` *and* is what `MainActivity` reads at runtime to allow
   * mixed content in the WebView, so the platform and the renderer cannot disagree about it. A
   * relay on a LAN cannot hold a certificate, which is the case it exists for.
   */
  readonly android: {
    readonly permissions: readonly string[];
    readonly cleartextTraffic: boolean;
  };
  /**
   * Who an installer says this is from.
   *
   * Defaulted from the id's own organisation label rather than demanded, because it is right
   * there and a manifest a person writes by hand should be short — `dev.example.title` gives
   * `example`. It is worth setting properly before a Windows release: it is the name in the
   * installer's header and in Add or Remove Programs.
   */
  readonly publisher: string;
  /**
   * A 1024x1024 PNG for the application, relative to the project. `null` uses the engine's mark.
   *
   * **A default that is a real icon rather than none**, because electron-builder's fallback is
   * Electron's own logo — which ships a game branded as the framework that built it. The engine's
   * mark is at least honest about what made it, and a game replaces it in one line.
   */
  readonly icon: string | null;
}

function requireString(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`drift.package.json: "${field}" must be a non-empty string`);
  }
  return value;
}

export function parseManifest(raw: unknown): PackageManifest {
  if (typeof raw !== 'object' || raw === null) throw new Error('drift.package.json: not an object');
  const source = raw as Record<string, unknown>;

  const id = requireString(source, 'id');
  if (!ID.test(id)) {
    throw new Error(
      `drift.package.json: "id" must be reverse-DNS, like dev.example.title — got "${id}"`,
    );
  }

  const backendRaw = (source.backend ?? {}) as Record<string, unknown>;
  const webgpu = backendRaw.webgpu;
  if (typeof webgpu !== 'string' || !POLICIES.includes(webgpu as WebGpuPolicy)) {
    throw new Error(
      `drift.package.json: "backend.webgpu" must be one of ${POLICIES.join(', ')} — got "${String(webgpu)}"`,
    );
  }

  const targetsRaw = source.targets;
  if (!Array.isArray(targetsRaw) || targetsRaw.length === 0) {
    throw new Error('drift.package.json: "targets" must be a non-empty array');
  }
  for (const target of targetsRaw) {
    if (typeof target !== 'string' || !TARGETS.includes(target as Target)) {
      throw new Error(
        `drift.package.json: unknown target "${String(target)}" — expected one of ${TARGETS.join(', ')}`,
      );
    }
  }

  const windowRaw = (source.window ?? {}) as Record<string, unknown>;
  const featuresRaw = (source.features ?? {}) as Record<string, unknown>;
  const steamRaw = (source.steam ?? {}) as Record<string, unknown>;
  const splashRaw = (source.splash ?? {}) as Record<string, unknown>;
  const androidRaw = (source.android ?? {}) as Record<string, unknown>;
  const permissionsRaw = androidRaw.permissions ?? [];
  if (!Array.isArray(permissionsRaw)) {
    throw new Error('drift.package.json: "android.permissions" must be an array of strings');
  }
  const permissions = permissionsRaw.map((entry) => {
    if (typeof entry !== 'string') {
      throw new Error(
        `drift.package.json: "android.permissions" holds ${typeof entry}, expected strings`,
      );
    }
    checkPermission(entry);
    return fullPermissionName(entry);
  });
  const appId = steamRaw.appId;

  return {
    id,
    name: requireString(source, 'name'),
    entry: requireString(source, 'entry'),
    window: {
      width: typeof windowRaw.width === 'number' ? windowRaw.width : 1280,
      height: typeof windowRaw.height === 'number' ? windowRaw.height : 720,
      mode:
        windowRaw.mode === 'fullscreen' || windowRaw.mode === 'borderless'
          ? windowRaw.mode
          : 'windowed',
      resizable: windowRaw.resizable !== false,
    },
    backend: {
      webgpu: webgpu as WebGpuPolicy,
      allowSoftwareRenderer: backendRaw.allowSoftwareRenderer === true,
    },
    features: {
      clipExport: featuresRaw.clipExport === true,
      gamepad: featuresRaw.gamepad !== false,
    },
    targets: targetsRaw as readonly Target[],
    steam: { appId: typeof appId === 'number' ? appId : null },
    publisher:
      typeof source.publisher === 'string' && source.publisher.length > 0
        ? source.publisher
        : (id.split('.')[1] ?? id),
    icon: typeof source.icon === 'string' && source.icon.length > 0 ? source.icon : null,
    android: {
      permissions,
      cleartextTraffic: androidRaw.cleartextTraffic === true,
    },
    splash: {
      show: splashRaw.show !== false,
      minMs:
        typeof splashRaw.minMs === 'number'
          ? Math.min(SPLASH_MAX_MS, Math.max(0, splashRaw.minMs))
          : SPLASH_DEFAULT_MS,
    },
  };
}

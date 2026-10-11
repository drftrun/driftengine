/** What a game asks the Android manifest for, written into the copied template before Gradle runs. */

/** The `android` block of `drift.package.json`, already parsed. See `manifest.ts`. */
export interface AndroidOptions {
  /** Fully-qualified permission names, in the order they were asked for. */
  readonly permissions: readonly string[];
  /** Whether the app may open `http://` and `ws://` at all. */
  readonly cleartextTraffic: boolean;
  /** The activity's `android:screenOrientation`, one of `ANDROID_ORIENTATIONS`. */
  readonly orientation: AndroidOrientation;
}

/**
 * Every value Android documents for an activity's `android:screenOrientation`.
 *
 * **The whole list, not the two a landscape game wants**, because which way a game is held is the
 * game's decision and the engine has no reason to prefer one: a card game is held upright, a
 * racing game sideways, and `sensorLandscape` against `landscape` is whether a player may turn
 * the phone over. What the list buys is a refusal at parse time, since the value is written into
 * an XML attribute and Android answers one it does not know by ignoring it.
 */
export const ANDROID_ORIENTATIONS = [
  'unspecified',
  'behind',
  'landscape',
  'portrait',
  'reverseLandscape',
  'reversePortrait',
  'sensorLandscape',
  'sensorPortrait',
  'userLandscape',
  'userPortrait',
  'sensor',
  'fullSensor',
  'nosensor',
  'user',
  'fullUser',
  'locked',
] as const;

export type AndroidOrientation = (typeof ANDROID_ORIENTATIONS)[number];

/** Nothing asked for: what every build got before this existed, and still gets. */
export const NO_ANDROID_OPTIONS: AndroidOptions = Object.freeze({
  permissions: Object.freeze([]) as readonly string[],
  cleartextTraffic: false,
  orientation: 'unspecified',
});

/** Refuse an orientation Android does not document, at parse time where a consumer can fix it. */
export function checkOrientation(value: unknown): AndroidOrientation {
  const known = ANDROID_ORIENTATIONS.find((name) => name === value);
  if (known === undefined) {
    throw new Error(
      `drift.package.json: "android.orientation" is ${JSON.stringify(value)}, expected one of ` +
        `${ANDROID_ORIENTATIONS.join(', ')}.`,
    );
  }
  return known;
}

/**
 * `INTERNET` and `android.permission.INTERNET` are the same thing, written two ways.
 *
 * A consumer writes the short name because that is what the permission is called everywhere except
 * in the XML, and the long one because that is what the XML says. Both are accepted and the long
 * form is what is written, since a short name in the manifest is a permission Android does not
 * recognise and silently does not grant — the same silence this whole field exists to end.
 */
export function fullPermissionName(name: string): string {
  return name.includes('.') ? name : `android.permission.${name}`;
}

/**
 * What a permission name may contain.
 *
 * Checked because the name is interpolated into an XML attribute: a quote or a bracket in it ends
 * the attribute and produces a manifest that either fails to parse or parses into something nobody
 * wrote. Android's own names are dotted upper snake case, and a custom one from a library follows
 * the same shape.
 */
const PERMISSION = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/;

/** Refuse a name that cannot go into the XML, at parse time where a consumer can fix it. */
export function checkPermission(name: string): void {
  if (!PERMISSION.test(name)) {
    throw new Error(
      `drift.package.json: "${name}" is not a permission name — expected something like ` +
        `"INTERNET" or "android.permission.INTERNET", letters, digits, underscores and dots only.`,
    );
  }
}

/**
 * The template manifest with a game's permissions in it, its cleartext policy set, and its
 * activity held the way the game asked.
 *
 * **Written into the copy, not into the template**, the way the icon already is: `buildAndroid`
 * stages `packages/package/android/` into `out/android/project` and edits it there, so this
 * repository's own tree is never the thing a consumer's build modifies.
 *
 * **Why this exists at all.** The template declares one activity and no permissions, deliberately:
 * a game that needs the network should ask for it, and the asking should be visible in the store
 * listing rather than granted to everybody by default. That default was right and there was no way
 * to depart from it — the template is copied wholesale, none of the eight `-Pdrift*` properties
 * reaches the manifest, and the only door was `--resources`, which moves the desktop shell and the
 * iOS spec along with the Gradle project. So an online game shipped an APK whose process is not
 * permitted to open a socket: every connection fails, the relay logs nothing because no packet
 * leaves, and neither end can say why. Reported from outside exactly that way.
 *
 * Returns the source unchanged when nothing is asked for, which is what keeps a game that has never
 * heard of this byte-identical to the build before it.
 */
export function withAndroidManifest(xml: string, options: AndroidOptions): string {
  const permissions = options.permissions.map(fullPermissionName);
  let out = xml;

  if (permissions.length > 0) {
    /* The element, not any tag that starts with its name: `[\s>]` is what separates
       `<application` from an `<applicationInfo` somebody adds later. */
    const at = out.search(/<application[\s>]/);
    if (at === -1) {
      throw new Error('the Android manifest template has no <application> element to precede');
    }
    /*
     * Before `<application>` and at its indentation. The schema requires `uses-permission` to be a
     * child of `manifest` rather than of `application`, and Android's own tooling orders them
     * first; `aapt2` accepts either order, and a reader of the built manifest should not have to
     * hunt for them.
     */
    const indent = indentOf(out, at);
    const block = permissions
      .map((name) => `${indent}<uses-permission android:name="${name}" />`)
      .join('\n');
    out = `${out.slice(0, at - indent.length)}${block}\n\n${indent}${out.slice(at)}`;
  }

  /*
   * The attribute is rewritten rather than appended, because the template already carries it with
   * `false`. Two of them is a build error, and a second one appended after the first is the shape
   * that produces it.
   */
  const cleartext = options.cleartextTraffic ? 'true' : 'false';
  const replaced = out.replace(
    /android:usesCleartextTraffic="(?:true|false)"/,
    `android:usesCleartextTraffic="${cleartext}"`,
  );
  if (replaced === out && options.cleartextTraffic) {
    throw new Error(
      'the Android manifest template no longer declares android:usesCleartextTraffic, so asking ' +
        'for cleartext traffic would do nothing',
    );
  }

  /*
   * **Rewritten on the activity for the same reason**: the template carries `unspecified`, which
   * leaves the choice to the phone. Held by the manifest rather than by `lockOrientation` at run
   * time, because the activity is laid out before any of the game's code runs, and a lock taken
   * then turns a picture the player has already seen.
   */
  const oriented = replaced.replace(
    /android:screenOrientation="[A-Za-z]+"/,
    `android:screenOrientation="${options.orientation}"`,
  );
  if (
    !/android:screenOrientation="[A-Za-z]+"/.test(replaced) &&
    options.orientation !== 'unspecified'
  ) {
    throw new Error(
      'the Android manifest template no longer declares android:screenOrientation, so asking for ' +
        `"${options.orientation}" would do nothing`,
    );
  }
  return oriented;
}

/** The whitespace at the start of the line `at` falls on, so an inserted element lines up. */
function indentOf(xml: string, at: number): string {
  const lineStart = xml.lastIndexOf('\n', at) + 1;
  return xml.slice(lineStart, at);
}

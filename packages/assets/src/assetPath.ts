/**
 * Turning a path a model file wrote into paths worth trying. One responsibility: candidates.
 *
 * **No filesystem, no network, no opinion about either.** This is string work only, and it
 * exists because every format has the same problem and none of them solve it: a model names
 * its textures with a path that was true on the machine that exported it, and is true almost
 * nowhere else. Deciding *how* to look is the host's job, because only the host knows
 * whether it is reading a folder, a zip, a URL or a bundle somebody dragged in. Deciding
 * *what to look for* is the same everywhere, so it is written once, here.
 *
 * What goes wrong without it, from the asset this was built against:
 *
 * - `textures\carbon.jpg` uses backslashes, which are a path separator on one platform and
 *   an ordinary filename character on the others.
 * - the absolute path beside it is `G:\SketchfabRipper_v1.18.0-b2\tools\blender-292\...`,
 *   a drive on somebody else's computer. Trying it cannot succeed and, on a host that maps
 *   unknown roots, is the one candidate that could succeed *wrongly*.
 * - the file may have been moved since export, so the basename alone, beside the model or
 *   in the folder next to it, is worth trying after the declared path and never before it.
 *
 * Order matters and is the whole value: most specific first, so an asset carrying two
 * `wheel.jpg` files in different folders resolves each to its own rather than to whichever
 * the search happened to reach.
 */

/**
 * A texture a model named, with its bytes when the model carried them inline.
 *
 * One type for both cases because the difference is the *format's* business and not the
 * baker's: glTF may embed an image in its binary chunk or in a data URI, and may equally
 * point at a file beside itself, while FBX and OBJ only ever name a path. A reader reports
 * whichever it has, and the resolver looks up only what arrived without bytes.
 */
export interface AssetReference {
  /** What the source called it. Used to address the texture later, and to find it now. */
  readonly name: string;
  /** Present when the model carried the image itself, so nothing needs resolving. */
  readonly bytes?: Uint8Array;
}

/** Backslashes to forward slashes, and any drive letter or leading root removed. */
function normalise(declared: string): string {
  const forward = declared.replace(/\\/g, '/');
  /* `C:/x`, `//host/x` and `/x` are all absolute somewhere; keep only the part below them. */
  return forward.replace(/^[a-zA-Z]:\//, '').replace(/^\/+/, '');
}

/** Everything after the last separator. */
export function basenameOf(declared: string): string {
  const normalised = normalise(declared);
  return normalised.slice(normalised.lastIndexOf('/') + 1);
}

/**
 * Paths to try for a reference, best first, relative to the folder holding the model.
 *
 * Deduplicated, because a texture declared as plain `carbon.jpg` would otherwise produce the
 * same candidate three times, and a host that logs its attempts would report three failures
 * for one missing file.
 *
 * `subfolders` are the conventional places a bundle puts its images. They are tried with the
 * basename only, and last, so they can never outrank a path the file actually stated.
 */
export function assetCandidates(
  declared: string,
  subfolders: readonly string[] = ['textures', 'Textures', 'tex', 'maps', 'images'],
): string[] {
  const normalised = normalise(declared);
  if (normalised === '') return [];
  const base = basenameOf(declared);

  const out: string[] = [normalised];
  /* A declared path with folders in it may have lost them; the basename beside the model
     is the single most common way an asset arrives after being repacked. */
  if (base !== normalised) out.push(base);
  for (const folder of subfolders) out.push(`${folder}/${base}`);

  return [...new Set(out)];
}

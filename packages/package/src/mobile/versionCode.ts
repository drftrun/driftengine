/**
 * The integer Android orders upgrades by, derived from the version name.
 *
 * **Two digits per part**, so `1.4.2` is `10402`. That holds until a part reaches a hundred, which
 * is stated here rather than discovered on the release that stops installing — at which point the
 * scheme has to widen and every prior code has to stay below the new ones.
 *
 * **Never zero.** A project with no `package.json` has no version, `0.0.0` computes to nothing, and
 * Gradle refuses the build with a message about a positive integer rather than about the missing
 * file. One is the floor, and it is a real version code rather than an error.
 */
export function versionCodeFor(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  return Math.max(1, major * 10000 + minor * 100 + patch);
}

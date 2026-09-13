/**
 * The major version of an Electron, from whatever the runtime or the installed package says it is.
 *
 * **A tiny module of its own because both callers need the same answer and neither can be trusted
 * to parse it in passing.** The build reads a version out of `electron/package.json`, which may
 * carry a prerelease suffix; the main process reads `process.versions.electron`, which is a plain
 * triple. `null` for anything that is not a version at all, because a plan that guesses a major it
 * could not read is worse than one that says it does not know.
 */
export function electronMajor(version: string | undefined | null): number | null {
  if (typeof version !== 'string') return null;
  const match = /^(\d+)\./.exec(version.trim());
  if (match === null) return null;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) && major > 0 ? major : null;
}

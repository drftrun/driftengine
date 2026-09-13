/**
 * Fill a defaults object from a partial one, ignoring keys whose value is `undefined`.
 *
 * **`{ ...DEFAULTS, ...given }` is the obvious spelling and it destroys the default it was
 * written to preserve.** A spread copies every own key, including one explicitly set to
 * `undefined` — so a caller writing `{ retractLambda: settings.lambda }`, where `settings.lambda`
 * is `number | undefined`, does not fall back to the default. It overwrites it with `undefined`,
 * and what comes out of the arithmetic downstream is `NaN`.
 *
 * That is not a hypothetical: measured on `Boom`, a timing of `{ retractLambda: undefined }` takes
 * the arm's fraction from 0.96 to `NaN` on the first step, which is a camera that never recovers.
 * And it is invisible to TypeScript here, because this repository does not run
 * `exactOptionalPropertyTypes` — the flag that separates "absent" from "present and undefined".
 * Under it, forty call sites in this tree pass an optional straight into an optional slot; the
 * pattern is ordinary and the hazard is only in what receives it.
 *
 * So the merge is a function rather than a spread, and every `Partial<T>` over a `T` of defaults
 * goes through it. One implementation, for the reason `Boom`'s own header gives about the arm it
 * smooths: a third caller must not be able to get this wrong again.
 */
export function withDefaults<T extends object>(defaults: T, given: Partial<T>): T {
  const merged = { ...defaults };
  for (const key of Object.keys(given) as (keyof T)[]) {
    const value = given[key];
    if (value !== undefined) merged[key] = value as T[keyof T];
  }
  return merged;
}

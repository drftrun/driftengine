/**
 * Reading a renderer's console line off an event whose shape has changed, and deciding whether it
 * is worth forwarding.
 *
 * **Pure, and tested, because the failure of getting it wrong is silence.** A packaged game has no
 * developer tools and no console a player can open, so this forwarding is the only way anything the
 * renderer says reaches a bug report. Reading the wrong argument does not throw and does not warn:
 * it compares `undefined` against a string for every message, forwards none of them, and is
 * indistinguishable from a game that never logged.
 *
 * The two shapes, both of which are `console-message` on `WebContents`:
 *
 *   - **Electron 35 and newer.** One object first, carrying `message` and a string `level` of
 *     `debug`, `info`, `warning` or `error`. The old positional arguments follow it, deprecated.
 *   - **Before that, fully positional**: `(event, level: 0..3, message, line, sourceId)`, where the
 *     event itself carries neither. **Its own typings say otherwise** — `electron.d.ts` at 33.4.11
 *     declares `(event, messageDetails)` with the details as an object — and reading them is what
 *     produced a first version of this module that handled two object shapes and forwarded nothing
 *     on the runtime it was written to rescue. The positional form below is what a probe against
 *     that binary actually received. The object-second shape is still accepted, because it is what
 *     the typings promise and costs one branch to keep.
 */
export type ConsoleLevel = 'debug' | 'verbose' | 'info' | 'warning' | 'error';

export interface ConsoleLine {
  readonly level: ConsoleLevel;
  readonly message: string;
}

/** 0 to 3, as the older event numbers them. */
const BY_NUMBER: readonly ConsoleLevel[] = ['verbose', 'info', 'warning', 'error'];

const NAMED: readonly string[] = ['debug', 'verbose', 'info', 'warning', 'error'];

function levelOf(value: unknown): ConsoleLevel | null {
  if (typeof value === 'string' && NAMED.includes(value)) return value as ConsoleLevel;
  if (typeof value === 'number' && Number.isInteger(value)) return BY_NUMBER[value] ?? null;
  return null;
}

function fieldsOf(value: unknown): { level: unknown; message: unknown } | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return { level: record.level, message: record.message };
}

/**
 * The line a listener was handed, whichever shape it came in, or `null` when neither carried one.
 *
 * The first argument is preferred when it carries a level, which is the newer shape; the second is
 * read otherwise. The third is the positional message the newer shape also passes, used only when
 * an object carried a level without a message.
 */
export function consoleLine(first: unknown, second: unknown, third: unknown): ConsoleLine | null {
  /*
   * The positional form first, because it is unambiguous: a number where an object would be is the
   * older event, and no newer one puts a level there without also putting one on its first
   * argument — which the loop below would have taken anyway.
   */
  if (
    typeof second === 'number' &&
    typeof third === 'string' &&
    fieldsOf(first)?.level === undefined
  ) {
    const level = levelOf(second);
    if (level !== null) return { level, message: third };
  }
  for (const candidate of [fieldsOf(first), fieldsOf(second)]) {
    if (candidate === null) continue;
    const level = levelOf(candidate.level);
    if (level === null) continue;
    const message =
      typeof candidate.message === 'string'
        ? candidate.message
        : typeof third === 'string'
          ? third
          : '';
    return { level, message };
  }
  return null;
}

/**
 * Whether a line at this level is forwarded.
 *
 * Errors in both kinds of build: an error nobody can quote is an error nobody can fix. Warnings in
 * development only — they are where a framework's advice and a game's own diagnostics live, and a
 * shipped game printing them to a terminal nobody is watching buries the line that matters.
 */
export function forwardsConsole(level: ConsoleLevel, development: boolean): boolean {
  if (level === 'error') return true;
  return development && level === 'warning';
}

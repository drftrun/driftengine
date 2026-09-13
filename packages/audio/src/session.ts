/**
 * Getting an AudioContext, and keeping it when a device tries to take it away.
 *
 * Separate from the graph because it is a question about the browser rather than about this
 * engine's mix. An application building its own audio outside `AudioGraph` needs exactly
 * these two and none of the rest, which is why both are already on the package barrel.
 */

/**
 * The page's audio session, where the browser has one to give.
 *
 * WebKit-only, and not in the DOM lib, so it is described here structurally rather
 * than asserted onto `Navigator`.
 */
interface AudioSessionLike {
  type: string;
}

/**
 * Claim the **playback** session, so a phone in a pocket is still audible.
 *
 * This is the whole of "no audio at all" on an iPhone that plays every other site,
 * and it is a policy rather than a fault anywhere below. iOS files
 * Web Audio under the *ambient* session, and an ambient session is exactly what the
 * hardware ringer switch silences — while a `<video>` or an `<audio>` element is
 * filed under playback and is not. So a page built out of `AudioContext`, which is
 * every page this engine draws, is the one kind that goes completely quiet on a
 * phone whose owner flicked one switch, with nothing wrong in the graph, the gesture
 * or the files. Everything else on the web keeps working, which is what makes it
 * read as a bug in the game.
 *
 * `playback` is the honest declaration for a game whose sound is a pillar: this
 * page's audio *is* the point of it. It also means the page interrupts whatever else
 * the phone was playing — which is the correct trade for a soundtrack that starts
 * with the world, and the reason this is not claimed until a graph is actually being
 * built.
 *
 * Safari-only today (Chrome and Firefox expose no `audioSession`), and every failure
 * mode here is a no-op: a browser without the property, or one that refuses the
 * value, is left exactly as it was.
 */
/**
 * Tell WebKit that this page's audio is the point of it, before any context exists.
 *
 * **Exported for a second consumer that cannot use `AudioGraph`.** This class is a stem
 * player for a game soundtrack; an application that decodes one file and runs it through
 * its own chain needs this line and not the graph, and a copy of it in another repository
 * is a second version of an iOS behaviour that will be wrong the next time WebKit moves.
 *
 * The ordering is the part a copy gets wrong and the part a diff cannot show: claimed
 * **before** the context is constructed, so the context is born into the right session.
 * See `autoplay.test.ts` for what it is for: iOS puts Web Audio in the *ambient* session,
 * which the ringer switch silences, so a page built out of `AudioContext` is the one kind
 * that goes quiet in a pocket.
 */
export function claimPlaybackSession(): void {
  if (typeof navigator === 'undefined') return;
  const session = (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession;
  if (session === undefined || session === null) return;
  try {
    session.type = 'playback';
  } catch {
    // A property that exists but will not take the value is not a failure to
    // report: the graph below is built either way, at whatever volume the phone
    // is willing to give it.
  }
}

/**
 * The live-context constructor this browser has, prefixed or not.
 *
 * `webkitAudioContext` is the only one on iOS before 14.5, and a browser old enough
 * to need it is exactly the browser nobody testing this owns.
 */
export function audioContextConstructor(): typeof AudioContext | undefined {
  if (typeof AudioContext !== 'undefined') return AudioContext;
  const prefixed = (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return prefixed;
}

/** A name for a thrown thing, for the one telemetry string that reports silence. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * The long tail: seconds of impulse, and how fast it decays inside them.
 *
 * Long enough to carry a whole airborne moment — a jump is under a second, a glide
 * several — and decaying slowly enough that the music is *spread out* rather than
 * merely echoed. Beyond about eight seconds it stops sounding like a space and
 * starts sounding like a stuck effect.
 */

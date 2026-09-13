/**
 * Filling the screen on a handheld, from a gesture that is already happening.
 *
 * A browser tab on a phone keeps its URL bar, and the game keeps whatever is left.
 * There is no declaration that changes that — no manifest key, no meta tag, and
 * nothing anywhere on the web platform that marks a page as a game and is granted
 * anything for it. A page fills a phone's screen in exactly two ways: it is an
 * *installed* app whose manifest asks for `display: fullscreen`, or it calls
 * `requestFullscreen` from a user gesture. This is the second one. The manifest is
 * the consumer's to ship and covers the installed case; between them every Android
 * entry point is covered, and iPhone Safari is covered by neither because it has no
 * element fullscreen at all — only the installed route.
 *
 * Game-agnostic (AGENTS.md): an element and a gesture. It knows nothing about what
 * is being drawn into the element.
 *
 * **Handheld only, and once.** Two restraints, both of them about not taking a
 * decision away from somebody who has already made it:
 *
 * A desktop player has a window they chose the size of, and a key that toggles
 * fullscreen whenever they want it. Seizing the whole display because they clicked
 * a menu button is the behaviour every embedded video player has been hated for.
 * So the request is made where the screen is small and there is no other way to
 * reclaim the space, and nowhere else.
 *
 * And a player who leaves fullscreen — the back gesture, the notification shade,
 * the system button — has said something. Asking again on their next tap would be
 * an argument they cannot win, since every tap is another gesture and every gesture
 * is another chance to ask. One attempt per page load, whether it is granted,
 * refused or undone.
 */

/** What the decision needs to know. Every field is observed, none of it inferred. */
export interface FullscreenConditions {
  /**
   * A handheld, decided by the pointer rather than by the user agent string.
   *
   * `(pointer: coarse)` is the property that actually matters — a finger, no
   * hover, no window to speak of — and unlike a UA sniff it is right about a
   * tablet, right about a phone in desktop-site mode, and right about a laptop
   * with a touchscreen that is being driven by its trackpad.
   */
  readonly coarsePointer: boolean;
  /** Whether the API exists here at all. False on iPhone Safari. */
  readonly supported: boolean;
  /** Already filling the screen: asking again is a no-op that can still reject. */
  readonly alreadyFullscreen: boolean;
  /** Asked once already this page load, granted or not. See the header. */
  readonly askedBefore: boolean;
}

/**
 * Whether to ask for fullscreen on the gesture currently being handled.
 *
 * Pure, so all four restraints are checkable without a browser — which is the whole
 * of this module's logic. The call itself is one line and is verified by hand, per
 * AGENTS.md's rule that DOM is not unit-tested.
 */
export function fullscreenWanted(conditions: FullscreenConditions): boolean {
  const { coarsePointer, supported, alreadyFullscreen, askedBefore } = conditions;
  return coarsePointer && supported && !alreadyFullscreen && !askedBefore;
}

/**
 * Ask for fullscreen on the next gesture of any kind, once, on a handheld.
 *
 * Returns the way to stop listening. The listeners are passive and in the capture
 * phase, matching the audio unlock that shares this moment: a page whose first
 * gesture has to both start the audio graph and claim the screen should do both from
 * that one gesture, not ask for a second one.
 *
 * Failure is silence by design. `requestFullscreen` rejects when the browser is not
 * satisfied that a gesture is in progress, when an ancestor iframe has no
 * `allowfullscreen`, and on platforms that expose the method and refuse it anyway.
 * None of those is worth a message to somebody who did not ask for fullscreen in the
 * first place and whose game is running either way.
 */
export function requestFullscreenOnGesture(element: HTMLElement): () => void {
  const events = ['pointerdown', 'keydown', 'touchstart'] as const;
  let asked = false;

  function stop(): void {
    for (const event of events) window.removeEventListener(event, fire, true);
  }

  function fire(): void {
    const wanted = fullscreenWanted({
      coarsePointer: matchesCoarsePointer(),
      supported: typeof element.requestFullscreen === 'function',
      alreadyFullscreen: document.fullscreenElement !== null,
      askedBefore: asked,
    });
    // Detached either way: on a desktop the answer will never change, and on a
    // handheld the one attempt has now been made.
    asked = true;
    stop();
    if (!wanted) return;
    // Floating deliberately. There is nothing to do with the rejection but ignore
    // it, and awaiting it would hold up the gesture that is unlocking the audio.
    void element.requestFullscreen().catch(() => {
      /* Refused. The game is running regardless. */
    });
  }

  for (const event of events) window.addEventListener(event, fire, true);
  return stop;
}

/** `(pointer: coarse)`, defensively — an engine without `matchMedia` is a test one. */
function matchesCoarsePointer(): boolean {
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

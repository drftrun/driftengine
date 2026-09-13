/**
 * The one bit of state the fixed loop and the engine badge have to share.
 *
 * **The problem it solves.** The badge holds the screen for a few seconds after the game's first
 * frame reaches it — deliberately, because the badge is a hold and not merely a cover. Without a
 * gate the game is *running* for that whole time behind an opaque black plate: an intro animation
 * plays to nobody, a music cue starts and is three seconds in by the time anyone hears it, and a
 * countdown is already counting. Every one of those is content the player paid for and did not
 * get.
 *
 * So the loop freezes on the frame it just drew, and resumes when the plate is gone.
 *
 * **Why a module-level holder rather than a parameter.** `createRenderer` mounts the badge and
 * `startLoop` runs the loop, and a consumer calls them separately with nothing passed between —
 * threading a handle through would make this a thing every game has to wire, which is the whole
 * failure the default-on badge exists to avoid. There is exactly one screen, so there is exactly
 * one badge, and a singleton is the honest shape for it rather than a convenience.
 *
 * **`ui/` writes it and `core/` reads it**, which is why the state lives here rather than in
 * `ui/splash.ts`: the fixed loop must not import a module that touches the DOM. This file names
 * neither of them and knows only that something may be holding frames back.
 */

/** What is holding frames, if anything. Set by the badge, read by the loop. */
let holder: (() => boolean) | null = null;

/**
 * Register what decides whether frames are held, and hand back the way to stop deciding.
 *
 * The last registration wins, and releasing only clears the gate if it is still yours — two
 * badges cannot exist at once, but a badge that was released after a second one mounted must
 * not open a gate it no longer owns.
 */
export function holdFrames(frozen: () => boolean): () => void {
  holder = frozen;
  return () => {
    if (holder === frozen) holder = null;
  };
}

/**
 * Whether this frame should be skipped entirely.
 *
 * A null check and at most one call, per frame, for the handful of frames a badge is up and none
 * at all afterwards — the badge clears the holder when it leaves. Nothing here allocates.
 */
export function framesHeld(): boolean {
  return holder !== null && holder();
}

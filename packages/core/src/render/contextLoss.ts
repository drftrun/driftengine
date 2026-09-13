/**
 * Notice a lost drawing context, notice it coming back, and ask the browser for it.
 *
 * The engine owns the GL context, so it owns noticing both halves. A game reaching for
 * `renderer.canvas.addEventListener('webglcontextlost')` would be the game reaching into
 * the engine's internals.
 *
 * `preventDefault` is not politeness: it is the browser's signal that the page intends to
 * restore rather than to die. Without it the context is gone for good and the player is
 * looking at a black canvas that nothing will ever repaint.
 *
 * **The restore is a separate sink, and that is the point.** Routing it to `onLost` would
 * report a fault at the moment the fault ended, which reads in a bug report as a device
 * that lost its context twice. `NFD6QQ` is the report that proved the restore half was
 * missing altogether: the promise `preventDefault` makes was made 29 s into a session on
 * an Adreno 619, and nothing in either repository had ever been listening to keep it.
 *
 * Restoring is *not* the same as redrawing. Every resource the renderer holds is created
 * in its constructor and `readonly` thereafter — the same reason a quality change is
 * construction-time — so a listener that wants pixels again has to take the page through
 * a reload. This function only makes the moment observable.
 */
/**
 * Returns a detach function, which a renderer that can be torn down has to call.
 *
 * The listeners used to be anonymous and therefore unremovable. That is invisible in a
 * game whose renderer lives as long as its page, and a leak in one that does not: a game
 * embedded in a website is mounted and unmounted every time the player enters and leaves
 * it, and each mount left a pair of listeners holding the previous renderer alive through
 * their closures.
 */
export function attachContextLoss(
  canvas: HTMLCanvasElement,
  onLost: () => void,
  onRestored: () => void,
): () => void {
  const lost = (event: Event): void => {
    event.preventDefault();
    onLost();
  };
  const restored = (): void => {
    onRestored();
  };
  canvas.addEventListener('webglcontextlost', lost);
  canvas.addEventListener('webglcontextrestored', restored);
  return () => {
    canvas.removeEventListener('webglcontextlost', lost);
    canvas.removeEventListener('webglcontextrestored', restored);
  };
}

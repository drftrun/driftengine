/**
 * A store's own features: achievements, presence, and whatever a platform adds to them.
 *
 * **Opt-in, and there is deliberately no default implementation.** A consumer that never asks for
 * an achievement must not acquire a store SDK, must not ship one to a browser, and must not have
 * to explain one in a privacy policy. That is the same promise SDF text makes, and it is the
 * reason this interface has no `BrowserPlatformServices` beside it: there is nothing honest for
 * one to do.
 *
 * A consumer that wants these supplies them from its shell. A consumer that does not passes
 * nothing and the engine never calls them.
 *
 * **Both methods return nothing and neither may throw.** An achievement that fails to unlock is
 * not a reason for a frame to stop, and a store that is offline is an ordinary state — an
 * implementation that wants to report a failure logs it.
 *
 * **What would make this wrong** is a platform feature the engine itself needs in order to draw,
 * which none of these is.
 */
export interface PlatformServices {
  unlockAchievement(id: string): void;
  setRichPresence(text: string): void;
}

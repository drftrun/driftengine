/**
 * Binding an `OrbitView` to an element: drag, wheel, pinch.
 *
 * `OrbitView` deliberately reads no events and touches no DOM — it owns what a gesture
 * *means*, because that is the part every consumer would otherwise get subtly differently.
 * This is the other half: the part that owns the events, because that is where the element
 * is. It lived twice, once in the website's canvas component and once in the engine's own
 * harness, which is exactly the arrangement that lets two consumers of one engine disagree
 * about how a drag feels.
 *
 * Returns its own teardown. Every listener it adds, it removes — a harness that swaps
 * scenes forty times in a session would otherwise accumulate forty sets of them, all still
 * driving views belonging to disposed scenes.
 */

import type { OrbitView } from './orbit';

/**
 * How far a gesture must travel before it counts as taking the camera.
 *
 * Enough that a tap, or the first moments of a scroll, are not a drag; small enough that
 * anybody who meant to turn the scene never notices it is there. A page has to be able to
 * scroll *past* a demo without wrestling it.
 */
const TAKE_THRESHOLD_PX = 10;

export interface OrbitControlOptions {
  /** Called when the viewer takes the camera, or hands it back. */
  readonly onTaken?: (taken: boolean) => void;
  /**
   * Whether a wheel event over the canvas is the scene's to consume.
   *
   * True in a harness, where the canvas is the page. False on a page that scrolls, where
   * swallowing the wheel traps a reader inside a demo they were scrolling past — which is
   * a worse fault than a demo that cannot be zoomed.
   */
  readonly captureWheel?: boolean;
}

export function bindOrbitControls(
  element: HTMLElement,
  view: OrbitView,
  options: OrbitControlOptions = {},
): () => void {
  const captureWheel = options.captureWheel ?? false;
  let pointerId: number | null = null;
  let lastX = 0;
  let lastY = 0;
  let travelled = 0;
  /** Finger distance when a pinch began, so a pinch is read as a ratio. */
  let pinchDistance = 0;
  const touches = new Map<number, { x: number; y: number }>();

  const report = (): void => options.onTaken?.(view.taken);

  const onPointerDown = (event: PointerEvent): void => {
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.size === 2) {
      /* A second finger cancels the drag and starts a pinch, rather than fighting it. */
      pointerId = null;
      const [a, b] = [...touches.values()];
      pinchDistance = Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0));
      return;
    }
    if (pointerId !== null) return;
    pointerId = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    travelled = 0;
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (touches.has(event.pointerId)) {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (touches.size === 2) {
      const [a, b] = [...touches.values()];
      const distance = Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0));
      if (pinchDistance > 0 && distance > 0) {
        /* A ratio, not a notch count: a pinch means "this much closer", and converting it
           through steps and back loses the directness that makes it feel attached. */
        view.scale(distance / pinchDistance);
        report();
      }
      pinchDistance = distance;
      return;
    }
    if (event.pointerId !== pointerId) return;

    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    travelled += Math.abs(dx) + Math.abs(dy);
    lastX = event.clientX;
    lastY = event.clientY;
    if (travelled < TAKE_THRESHOLD_PX) return;
    view.drag(dx, dy);
    report();
  };

  const onPointerUp = (event: PointerEvent): void => {
    touches.delete(event.pointerId);
    if (touches.size < 2) pinchDistance = 0;
    if (event.pointerId === pointerId) pointerId = null;
  };

  const onWheel = (event: WheelEvent): void => {
    if (captureWheel) event.preventDefault();
    view.zoom(event.deltaY < 0 ? 1 : -1);
    report();
  };

  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove);
  element.addEventListener('pointerup', onPointerUp);
  element.addEventListener('pointercancel', onPointerUp);
  element.addEventListener('wheel', onWheel, { passive: !captureWheel });

  return () => {
    element.removeEventListener('pointerdown', onPointerDown);
    element.removeEventListener('pointermove', onPointerMove);
    element.removeEventListener('pointerup', onPointerUp);
    element.removeEventListener('pointercancel', onPointerUp);
    element.removeEventListener('wheel', onWheel);
    touches.clear();
  };
}

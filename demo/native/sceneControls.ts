/**
 * What the dev harness does for a scene once it is mounted, and a scene does not do for itself:
 * its camera turned by a drag, zoomed by the wheel and a pinch, and let go by a double click.
 *
 * `demo/dev/main.ts` binds a scene's `view` with the shared binder, `demo/controls.ts`, which is
 * the one it and the website both use, so a drag feels the same wherever a scene is shown. This
 * host mounted scenes as that harness does and bound nothing, so a drag on the native window moved
 * no camera — reported by the maintainer on 2026-09-19. The binder is not reimplemented here: two
 * copies of one gesture are how two consumers of one engine come to disagree about a drag.
 */

import { bindOrbitControls } from '../controls.ts';
import type { OrbitView } from '../orbit.ts';
import type { NativeCanvas } from '../../packages/native-host/src/canvas.ts';

/** Bind `view`, where the scene has one, and hand back what unbinds it. */
export function bindSceneControls(canvas: NativeCanvas, view: OrbitView | undefined): () => void {
  const element = canvas as unknown as HTMLElement;
  const unbind =
    view === undefined ? () => undefined : bindOrbitControls(element, view, { captureWheel: true });
  canvas.ondblclick = () => view?.release();
  return () => {
    unbind();
    canvas.ondblclick = null;
  };
}

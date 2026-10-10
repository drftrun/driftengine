/**
 * Which grade a pass applies to what it draws, decided once for both backends.
 *
 * **Every pass grades where nothing after it will**, so a colour handed to the renderer means linear
 * light wherever it lands. Three facts decide where that is:
 *
 * - **A probe's face or a capture stores radiance** for something else to light with or to show, so
 *   it is never graded. The frame grades what it reads of one; graded at the bake as well, the curve
 *   would be applied twice.
 * - **A frame whose resolve grades** (`hdrScene` over a scene target) leaves every pass before the
 *   resolve linear, because grading early throws away the range the float target exists to keep.
 * - **Past the present, a pass lands on the canvas the resolve has already written**, so nothing
 *   after it will grade it and it grades itself with the frame's forward code, composite or not. An
 *   interface drawn after `endFrame` escapes the screen-space chain; it does not escape the grade.
 *
 * **An interface takes the screen encode and not the curve** (`interfaceGrade`). A tone curve and
 * an exposure are how a scene's light is brought to the screen, and a caption or a panel is not
 * light: its colour was picked for the screen, so it is encoded wherever the frame is and comes out
 * as picked under every transform, at every exposure. What it gives up is an interface drawn inside
 * a frame whose resolve grades (`hdrScene`): that one is part of the picture the resolve tone maps,
 * and is drawn after `endFrame` to stay out of it. What would make any of this wrong is a composite
 * step running after the present, which none does.
 */
import { forwardTransformCode } from './vertexDefaults.ts';

/**
 * The `uOutputTransform` a pass uploads: `storing` inside a probe's face or a capture, `presented`
 * once the frame's resolve has run, `resolveGrades` where that resolve applies the transform.
 */
export function passGradeCode(
  storing: boolean,
  presented: boolean,
  resolveGrades: boolean,
  outputTransform: string,
): number {
  if (storing) return 0;
  return presented || !resolveGrades ? forwardTransformCode(outputTransform) : 0;
}

/** The `uOutputExposure` beside it: the frame's exposure wherever the pass grades, else one. */
export function passGradeExposure(
  storing: boolean,
  presented: boolean,
  resolveGrades: boolean,
  exposure: number,
): number {
  if (storing) return 1;
  return presented || !resolveGrades ? exposure : 1;
}

/**
 * The code an interface draws with, given the pass's: the screen encode wherever the pass grades at
 * all, and nothing where it does not. Never a curve, so never an exposure either: a screen-space
 * caption, a panel or a 2D layer keeps the colour it was picked as whatever the scene is graded by.
 */
export function interfaceGrade(passCode: number): number {
  return passCode === 0 ? 0 : 1;
}

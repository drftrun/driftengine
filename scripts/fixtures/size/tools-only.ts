/*
 * **The overlay is named here, and it was not.** The four panels and the undo stack were the
 * whole fixture, so the figure this gate reports and the README quotes was silent about anything
 * a panel did not reach — and `createToolsOverlay` arrived tree-shaken straight out of the
 * measurement, leaving the gate green and the stated cost wrong by however much it weighs. A size
 * fixture measures what it imports and nothing else, which is the same shape as a scope nobody
 * re-reads.
 */
import {
  consolePanel,
  createToolsOverlay,
  createUndoStack,
  inspectorPanel,
  networkPanel,
  paintOverlay,
  profilerPanel,
} from '@driftengine/tools';
export const entry = [
  inspectorPanel,
  consolePanel,
  profilerPanel,
  networkPanel,
  createUndoStack,
  createToolsOverlay,
  paintOverlay,
];

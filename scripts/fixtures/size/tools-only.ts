import {
  consolePanel,
  createUndoStack,
  inspectorPanel,
  networkPanel,
  profilerPanel,
} from '@driftengine/tools';
export const entry = [inspectorPanel, consolePanel, profilerPanel, networkPanel, createUndoStack];

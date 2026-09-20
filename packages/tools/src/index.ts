/*! DriftEngine | Copyright 2026 Drift Technologies | Apache-2.0 | https://github.com/drftrun/driftengine */
/**
 * The editor panels a shipped game can carry.
 *
 * **The argument is the split, not the panels.** An inspector, a console, a profiler and a network
 * panel are what somebody wants while a game is running — on a tester's machine, on a console
 * devkit, in a build nobody can attach a debugger to. A scene tree and an asset browser are not:
 * they need a project, and a shipped game has none. So those two stayed in the editor and these
 * four became a package, and **a game that never imports this package pays nothing at all** — which
 * is a claim the size gate makes rather than a claim this paragraph makes.
 *
 * **The command stack came with them, because the alternative is an in-game inspector that cannot
 * undo.** `Panel.route` returns a `Command` or nothing, which is what makes "a panel mutates only
 * through commands" a signature rather than a convention; a game carrying the panels carries that
 * rule too, and gets undo for free.
 *
 * **`Selection` came with them for the same reason**: the inspector's whole subject is what is
 * selected, and three panels sharing one selection by reference is how the editor already works.
 */
export type { Command, UndoStack } from './command.ts';
export { createUndoStack } from './command.ts';

export type { Panel, UiEvent } from './panel.ts';
export {
  PANEL_PREFIX,
  createPanelRoot,
  emptyPanel,
  keyEvent,
  panelIdOf,
  pointerEvent,
  treeShape,
  wheelEvent,
} from './panel.ts';

export type { Selection } from './selection.ts';
export {
  addToSelection,
  clearSelection,
  createSelection,
  isSelected,
  primarySelection,
  selectOnly,
  selectRange,
  selectedEntities,
  toggleSelection,
} from './selection.ts';

export { divergenceIsUnaccounted, divergentComponents } from './divergence.ts';

/*
 * The four panels a game carries. The scene tree and the asset browser are deliberately not here:
 * both need a project on disk, and a shipped game has none.
 */
export type {
  InspectableWorld,
  InspectorRow,
  InspectorView,
  InspectorWorld,
  RowKind,
} from './inspector.ts';
export {
  MIXED,
  addComponentCommand,
  createInspectorView,
  fieldEditable,
  inspectorPanel,
  inspectorRows,
  removeComponentCommand,
  rowText,
  setFieldCommand,
} from './inspector.ts';

export type {
  ConsoleView,
  ConsoleWorld,
  LogEntry,
  LogFilter,
  LogRing,
  Severity,
  SourceCursor,
} from './console.ts';
export {
  DISPLAY_LIMIT,
  appendLog,
  consolePanel,
  createConsoleView,
  createLogFilter,
  createLogRing,
  displayText,
  filteredEntries,
  jumpToSourceCommand,
  logEntries,
} from './console.ts';

export type { FrameHistory, ProfilerRow, ProfilerView, ProfilerWorld } from './profiler.ts';
export {
  createFrameHistory,
  createProfilerView,
  formatMs,
  historyValues,
  occupancy,
  profilerPanel,
  profilerRows,
  pushFrame,
} from './profiler.ts';

export type { NetworkReadout, NetworkView, NetworkWorld, RollbackHistory } from './network.ts';
export {
  componentDivergence,
  createNetworkView,
  createRollbackHistory,
  networkPanel,
  pushRollback,
  rollbackValues,
} from './network.ts';

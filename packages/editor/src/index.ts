/*! DriftEngine | Copyright 2026 Drift Technologies | Apache-2.0 | https://github.com/drftrun/driftengine */
/**
 * `@driftengine/editor` — the model of a scene editor.
 *
 * A tree of what exists, an inspector over what is selected, and play-in-editor. No pixels: the
 * panel builders produce `@driftengine/ui2d` nodes and the consumer draws them, the way `DebugLines`
 * produces segments and `drawLines` draws them.
 *
 * **A package rather than part of core**, because it imports `@driftengine/entities` and core does
 * not — that package imports no other engine package, deliberately, and having core reach it to
 * serve an editor would invert that for every game that never opens one.
 */
export { SceneTree } from './sceneTree.ts';
export type { TreeRow } from './sceneTree.ts';
export { Inspector, fieldKindOf } from './inspector.ts';
export type { FieldKind, InspectorField } from './inspector.ts';
export { EditorHost } from './editorHost.ts';
export type { EditorMode, EditorWorld } from './editorHost.ts';
export {
  FIELD_ROW_PREFIX,
  TREE_ROW_PREFIX,
  buildInspectorPanel,
  buildTreePanel,
  formatValue,
  rowIndexOf,
} from './panel.ts';

import {
  EditorHost,
  Inspector,
  SceneTree,
  buildInspectorPanel,
  buildTreePanel,
  rowIndexOf,
} from '@driftengine/editor';
export const entry = [
  EditorHost,
  Inspector,
  SceneTree,
  buildTreePanel,
  buildInspectorPanel,
  rowIndexOf,
];

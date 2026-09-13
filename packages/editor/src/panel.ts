/**
 * The tree and the inspector as `UiNode` trees a consumer lays out, routes and draws.
 *
 * **Nodes and not pixels.** `@driftengine/ui2d` already has the layout engine, the hit test, the
 * focus order and the pointer router; what was missing was anything turning what an editor *holds*
 * into nodes for it. That is the same shape `DebugLines` has against `drawLines`, one level up.
 *
 * **Text is set and not drawn.** `drawUiTree` reports a node with text to a `UiContentSink` and
 * draws none itself, because core already has two text renderers and ui2d's own header calls that
 * the honest seam. This does the same thing: the row carries the string, the consumer's sink draws
 * it with whichever renderer it uses.
 *
 * **Rows are rebuilt in place.** A builder that made fresh nodes every frame would allocate in a
 * frame path, which `AGENTS.md` forbids. These reuse the children they made last time and only ever
 * grow, so a panel settles after the largest tree it has shown.
 *
 * **Every row carries a name**, `row:<index>` or `field:<index>`, so `routeUiPointer` hands back the
 * node that was activated and `rowIndexOf` turns it into the row. That is one parse rather than a
 * map from node to row that has to be kept in step with the tree.
 */
import { addUiChild, createUiNode } from '@driftengine/ui2d';
import type { UiNode } from '@driftengine/ui2d';
import type { Inspector } from './inspector.ts';
import type { SceneTree } from './sceneTree.ts';

/** How far one level of depth indents a tree row, in layout units. */
const INDENT = 12;

/** The prefix a tree row's name carries, and the one an inspector field's carries. */
export const TREE_ROW_PREFIX = 'row:';
export const FIELD_ROW_PREFIX = 'field:';

/**
 * Which row a node is, or `-1` for a node that is not one.
 *
 * Takes the node `routeUiPointer` returned, so a caller writes
 * `const at = rowIndexOf(routeUiPointer(...), TREE_ROW_PREFIX)` and has the row it clicked.
 */
export function rowIndexOf(node: UiNode | null, prefix: string): number {
  if (node === null || !node.name.startsWith(prefix)) return -1;
  const at = Number.parseInt(node.name.slice(prefix.length), 10);
  return Number.isInteger(at) && at >= 0 ? at : -1;
}

/** A row that exists, reused; or a new one appended. */
function rowAt(into: UiNode, index: number, prefix: string): UiNode {
  const existing = into.children[index];
  if (existing !== undefined) {
    existing.hidden = false;
    return existing;
  }
  const made = createUiNode({
    direction: 'row',
    width: 'grow',
    height: 18,
    interactive: true,
    focusable: true,
    name: `${prefix}${index}`,
  });
  addUiChild(into, made);
  return made;
}

/** Rows past what is needed are hidden rather than removed, so the pool survives. */
function hideFrom(into: UiNode, index: number): void {
  for (let at = index; at < into.children.length; at++) {
    (into.children[at] as UiNode).hidden = true;
  }
}

/**
 * Fill `into` with one row per line of the tree's last rebuild.
 *
 * **The indent is padding rather than a spacer node**, which halves the node count and means a hit
 * test on a row covers the indent too — clicking to the left of a deep row's label selects that row,
 * which is what every tree does and what a spacer would have broken.
 *
 * **Nothing here marks the selected row and `UiNode` grows no field for it.** A `selected` flag on
 * every node in every interface in every game, to serve a panel most of them never build, is the
 * same trade this package refused when it put node names in `SceneTree` instead of on `SceneNode`.
 * `tree.rowOf(tree.selected)` is the index, the caller already has the tree, and how a selected row
 * looks is a decision about a consumer's palette rather than about an editor.
 */
export function buildTreePanel(tree: SceneTree, into: UiNode): number {
  const rows = tree.rows;
  for (let at = 0; at < rows.length; at++) {
    const row = rows[at]!;
    const node = rowAt(into, at, TREE_ROW_PREFIX);
    node.paddingLeft = row.depth * INDENT;
    node.text = row.hasChildren ? `${row.expanded ? '-' : '+'} ${row.name}` : `  ${row.name}`;
  }
  hideFrom(into, rows.length);
  return rows.length;
}

/**
 * Fill `into` with one row per inspector field.
 *
 * The label carries the group where a field belongs to a component, because two components can
 * declare the same field name and a panel showing `health` twice with no way to tell them apart is
 * worse than one that is a little wordier.
 */
export function buildInspectorPanel(inspector: Inspector, into: UiNode): number {
  const fields = inspector.fields;
  for (let at = 0; at < fields.length; at++) {
    const field = fields[at]!;
    const node = rowAt(into, at, FIELD_ROW_PREFIX);
    const label = field.group === 'transform' ? field.label : `${field.group}.${field.label}`;
    node.text = `${label}  ${formatValue(field.value, field.kind)}`;
  }
  hideFrom(into, fields.length);
  return fields.length;
}

/**
 * A value as a row shows it.
 *
 * **A boolean reads as a word and an enum as its number**, which is as far as this can honestly go:
 * the variant list belongs to the module that declared the enum, and a component is handed
 * `enum:Mood` — a name and no variants. A consumer holding the list formats its own.
 */
export function formatValue(value: unknown, kind: string): string {
  if (value === null || value === undefined) return '—';
  if (kind === 'boolean') return value ? 'true' : 'false';
  if (kind === 'text') return String(value);
  if (typeof value !== 'number') return String(value);
  if (kind === 'integer' || kind === 'enum' || kind === 'entity') return String(Math.trunc(value));
  return Number.isInteger(value) ? value.toFixed(1) : value.toFixed(3);
}

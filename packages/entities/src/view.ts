/**
 * A live handle on a component's columns, for a caller that indexes them directly.
 *
 * **A holder of this object holds the object and never an array.** A column grows by
 * reallocation, so a hoisted `Float64Array` goes stale the first time anything adds a component —
 * and `system.ts` makes `add` immediate on purpose, so that happens *during* a walk. The failure
 * would be a write into an array nothing reads any more: no error, no wrong type, just a value
 * that never arrives.
 *
 * So the store refreshes this object's properties after a reallocation rather than handing back a
 * new object. A caller that hoisted it at the top of a loop is still correct at the bottom.
 *
 * **What this costs** is one live object per store, and a property load on every field access
 * rather than a captured local. **What would make it wrong** is a caller holding one past its
 * world's disposal — which is why a generated script reaches one through a call per loop rather
 * than caching it across frames.
 *
 * ---
 *
 * ## Absence is a column, not a value
 *
 * An optional field has two entries here: the value column under its own name, and a `Uint8Array`
 * under `presenceColumn(field)`. A reader that consults only the value column reads whatever the
 * slot last held, which for a cleared field is the value it was cleared from.
 */

/** Every array shape a column can be. `unknown[]` is the boxed case — today, `String`. */
export type ViewColumn =
  | Int8Array
  | Int16Array
  | Int32Array
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | unknown[];

/**
 * A component's storage, addressable by field name.
 *
 * `sparse` maps an entity's *index* — not its handle — to a position in every column here. Taking
 * the index from a handle is `entity % 2 ** 26`, which is what a caller that cannot import
 * `entityIndex` writes inline.
 */
export interface ComponentView {
  sparse: Int32Array;
  [field: string]: ViewColumn;
}

/**
 * Point a view at the arrays a store holds now.
 *
 * Called when a view is first asked for and again after every reallocation. It rewrites the
 * existing object rather than returning a new one, because the object identity is the contract: a
 * caller hoisted it, and handing back a second object would leave the first one pointing at
 * storage nothing reads.
 *
 * It lives here rather than on the store so that the two halves of this mechanism — what a view
 * *is* and what keeps one current — are one file. **What that costs** is passing the store's two
 * internals in. **What would make it wrong** is a store whose columns are not a map, at which point
 * this signature is the thing to change rather than the call sites.
 */
export function refreshView(
  view: ComponentView,
  sparse: Int32Array,
  columns: ReadonlyMap<string, ViewColumn>,
): void {
  view.sparse = sparse;
  for (const [field, column] of columns) view[field] = column;
}

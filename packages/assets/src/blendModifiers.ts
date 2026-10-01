/**
 * Which of an object's modifiers the direct `.blend` reader can honour, and which it must refuse.
 *
 * **A modifier is a recipe, and the file stores only its ingredients.** The mesh a Subdivision
 * Surface, an Array or a geometry-nodes tree produces is computed by Blender every time and never
 * written, so a reader that drew the stored mesh would draw the wrong shape and say nothing. So
 * every modifier is refused by name unless it is one of the few whose effect is known exactly:
 *
 * - **Disabled for render**: it does nothing to a render, so it does nothing here.
 * - **Smooth by Angle**, and the "Auto Smooth" group Blender 4.1 adds to every older file that had
 *   auto smooth on: sharp edges by angle, which `cornerNormals` applies exactly.
 *
 * What would make this wrong: a geometry-nodes group named like Blender's that does something
 * else. The group's own wiring is checked for the nodes that one is built from, not only its name.
 */

import type { BlendStruct } from './blendData.ts';

/** What an object's modifier stack means for the direct reader. */
export interface ModifierVerdict {
  /** An angle to split normals at, from a Smooth by Angle modifier, or null. */
  readonly splitAngle: number | null;
  /** The modifiers that need Blender to evaluate them, by name and kind. */
  readonly refusals: readonly string[];
}

/** `eModifierMode_Render`. */
const MODE_RENDER = 1 << 1;

/** The bundled smoothing groups' names, and the nodes every one of them is built from. */
const SMOOTH_GROUPS = ['Smooth by Angle', 'Auto Smooth'];
const SMOOTH_NODES = ['GeometryNodeSetShadeSmooth', 'GeometryNodeInputMeshEdgeAngle'];

function kindOf(modifier: BlendStruct): string {
  return modifier.type.replace(/ModifierData$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
}

/** The value a geometry-nodes modifier gives the group input named `input`. */
function groupInput(modifier: BlendStruct, group: BlendStruct, input: string): number | null {
  if (!group.has('tree_interface')) return null;
  const root = group.sub('tree_interface').sub('root_panel');
  let identifier: string | null = null;
  for (const address of root.pointers('items_array', root.int('items_num'))) {
    const item = root.file.at(address, root.scope);
    if (item?.type === 'bNodeTreeInterfaceSocket' && item.text('name') === input)
      identifier = item.text('identifier');
  }
  if (identifier === null) return null;
  const properties = modifier.sub('settings').deref('properties', 'IDProperty');
  for (const property of properties?.sub('data').list('group', 'IDProperty') ?? []) {
    if (property.string('name') !== identifier) continue;
    const data = property.sub('data');
    const type = property.int('type');
    /* IDP_FLOAT 2 stores its bits in `val`; IDP_DOUBLE 8 in `val` and `val2`; IDP_INT 1, IDP_BOOLEAN 10. */
    if (type === 2)
      return new DataView(new Int32Array([data.int('val')]).buffer).getFloat32(0, true);
    if (type === 8)
      return new DataView(new Int32Array([data.int('val'), data.int('val2')]).buffer).getFloat64(
        0,
        true,
      );
    if (type === 1 || type === 10) return data.int('val');
  }
  return null;
}

function isSmoothGroup(group: BlendStruct): boolean {
  const name = group.idName().replace(/\.\d{3}$/, '');
  if (!SMOOTH_GROUPS.includes(name)) return false;
  const nodes = new Set(group.list('nodes').map((node) => node.string('idname')));
  return SMOOTH_NODES.every((node) => nodes.has(node));
}

/** Judge an object's modifier stack. */
export function judgeModifiers(object: BlendStruct): ModifierVerdict {
  let splitAngle: number | null = null;
  const refusals: string[] = [];
  const name = object.idName();
  for (const modifier of object.list('modifiers')) {
    const header = modifier.sub('modifier');
    if ((header.int('mode') & MODE_RENDER) === 0) continue;
    const label = `"${name}" has a ${kindOf(modifier)} modifier ("${header.string('name')}")`;
    if (modifier.type === 'NodesModifierData') {
      const group = modifier.deref('node_group');
      if (group !== null && isSmoothGroup(group)) {
        const ignore = groupInput(modifier, group, 'Ignore Sharpness');
        if (ignore !== null && ignore !== 0)
          refusals.push(`${label} that ignores the mesh's own sharp edges`);
        splitAngle = groupInput(modifier, group, 'Angle') ?? Math.PI / 6;
        continue;
      }
    }
    refusals.push(`${label}, which Blender evaluates`);
  }
  return { splitAngle, refusals };
}

/**
 * Instances into parts: each template instantiated through the reader with the props it declares,
 * each prefab placement an entity based on the prefab, and every result flattened at its place.
 *
 * A prop the template does not declare is left out rather than refused: the protocols hand every
 * template the same set, and a template that ignores one declares none — the scripts' own rule is
 * that a template "declare all of these, even the ones you ignore", which the reference's host
 * enforces and a remake need not.
 */
import type { ScriptRead } from '../script/reader.ts';
import type { Value } from '../script/values.ts';
import type { ScriptEntity } from '../script/world.ts';
import { flatten, identity } from './flatten.ts';
import type { Flattened, Matrix } from './flatten.ts';
import type { Instance } from './instances.ts';

/** `T(x, y, z) · Ry(yaw)`. */
export function placement(x: number, y: number, z: number, yaw: number): Matrix {
  const m = identity();
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

export interface Instantiated extends Flattened {
  /** Instances that named nothing the scripts declare. */
  readonly missing: Map<string, number>;
  readonly entities: number;
}

export function instantiateAll(read: ScriptRead, instances: readonly Instance[]): Instantiated {
  const prefabs = new Map<string, ScriptEntity>();
  const index = (e: ScriptEntity): void => {
    if (e.prefab && !prefabs.has(e.name)) prefabs.set(e.name, e);
    for (const c of e.children) index(c);
  };
  index(read.world.root);
  const holder = read.world.create('', null);
  const out: Instantiated = { parts: [], markers: [], missing: new Map(), entities: 0 };
  const count = (e: ScriptEntity): number => e.children.reduce((n, c) => n + count(c), 1);
  for (const inst of instances) {
    const template = read.world.templates.get(inst.name);
    let entity: ScriptEntity;
    if (template !== undefined) {
      const declared = new Set(template.props.map((p) => p.name));
      const props = new Map<string, Value>([...inst.props].filter(([k]) => declared.has(k)));
      entity = read.instantiate(inst.name, props, holder);
    } else {
      const prefab = prefabs.get(inst.name);
      if (prefab === undefined) {
        out.missing.set(inst.name, (out.missing.get(inst.name) ?? 0) + 1);
        continue;
      }
      entity = read.world.create('', holder);
      entity.bases.push(prefab);
    }
    for (const name of inst.bases ?? []) {
      const base = prefabs.get(name);
      if (base === undefined) out.missing.set(name, (out.missing.get(name) ?? 0) + 1);
      else entity.bases.push(base);
    }
    (out as { entities: number }).entities += count(entity);
    flatten(entity, placement(inst.position[0], inst.y, inst.position[1], inst.yaw), out);
    /* The instance is flattened; release it so a city's worth never sits in memory at once. */
    holder.children.length = 0;
    holder.named.clear();
  }
  return out;
}

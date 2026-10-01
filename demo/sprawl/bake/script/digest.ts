/**
 * The evaluated world written out canonically, for a content hash: two reads that agree in every
 * entity, component, base, tag and pair write the same text, and a read that differs anywhere —
 * one generator draw, one rounding — writes a different one.
 *
 * Numbers are written as JavaScript's shortest round-trip form with their type, which is exact.
 * Order is creation order, which evaluation fixes.
 */
import type { Value } from './values.ts';
import { pathOf } from './world.ts';
import type { ScriptEntity } from './world.ts';

function text(value: Value): string {
  switch (value.k) {
    case 'num':
      return `${value.type}:${value.v}`;
    case 'str':
      return JSON.stringify(value.v);
    case 'entity':
      return value.entity ? `@${pathOf(value.entity) || value.entity.name}` : '@0';
    case 'symbol':
      return `#${value.name}`;
    case 'struct':
      return value.fields
        ? `{${[...value.fields].map(([k, v]) => `${k}=${text(v)}`).join(',')}}`
        : `{${value.items.map(text).join(',')}}`;
    case 'vector':
      return `[${value.items.map(text).join(',')}]`;
    case 'pair':
      return `(${text(value.first)},${text(value.second)})`;
    default:
      return value.k;
  }
}

/** Every entity below `root`, one line each, depth first. */
export function writeWorld(root: ScriptEntity): string {
  const lines: string[] = [];
  const visit = (entity: ScriptEntity): void => {
    lines.push(
      [
        pathOf(entity) || entity.name,
        entity.prefab ? 'prefab' : '',
        entity.bases.map((b) => pathOf(b) || b.name).join(','),
        [...entity.tags].join(','),
        [...entity.components].map(([k, v]) => `${k}=${text(v)}`).join(';'),
        entity.pairs.map((p) => `(${text(p.first)},${text(p.second)})`).join(';'),
      ].join('|'),
    );
    for (const child of entity.children) visit(child);
  };
  visit(root);
  return lines.join('\n');
}

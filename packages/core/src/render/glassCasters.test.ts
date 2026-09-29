import { describe, expect, it } from 'vitest';
import { GlassCasterList } from './glassCasters.ts';
import { glassOf } from './shadowCasters.ts';
import type { ResolvedGlass } from './glass.ts';
import type { InstancedHandle, MeshHandle } from './backend/api.ts';
import type { MeshInstances } from './instances.ts';

const glass = (transmission: number): ResolvedGlass => ({
  transmission,
  frost: 0.25,
  tint: [1, 0.5, 0.25],
});
const mesh = { id: 'pane' } as unknown as MeshHandle;
const batch = { id: 'panes' } as unknown as InstancedHandle;
const data = { count: 4 } as unknown as MeshInstances;

describe('glass casters', () => {
  it('REPLAYS EVERY GLASS CASTER IN ORDER, each with its own glass', () => {
    const list = new GlassCasterList();
    const model = new Float32Array(16).fill(2);
    list.recordMesh(mesh, model, null, glass(0.9));
    list.recordInstanced(batch, data, null, glass(0.5));
    list.recordSkinned(mesh, model, new Float32Array(16), null, glass(0.3));
    const seen: string[] = [];
    list.replay({
      mesh: (_m, at, _material, g) => seen.push(`mesh ${g.transmission} ${at[0]}`),
      instanced: (_b, d, _material, g) => seen.push(`instanced ${g.transmission} ${d.count}`),
      skinnedMesh: (_m, _at, _p, _material, g) => seen.push(`skinned ${g.transmission}`),
    });
    expect(seen).toEqual(['mesh 0.9 2', 'instanced 0.5 4', 'skinned 0.3']);
    expect(list.count).toBe(3);
  });

  it('KEEPS ITS OWN COPY OF A MODEL MATRIX, because a caller reuses its scratch', () => {
    const list = new GlassCasterList();
    const model = new Float32Array(16).fill(1);
    list.recordMesh(mesh, model, null, glass(0.9));
    model.fill(7);
    let first = -1;
    list.replay({
      mesh: (_m, at) => {
        first = at[0] as number;
      },
      instanced: () => {},
      skinnedMesh: () => {},
    });
    expect(first).toBe(1);
  });

  it('ALLOCATES NOTHING ONCE WARM: a second frame reuses the first frame s entries', () => {
    const list = new GlassCasterList();
    const model = new Float32Array(16);
    for (let frame = 0; frame < 2; frame++) {
      list.clear();
      for (let i = 0; i < 3; i++) list.recordMesh(mesh, model, null, glass(0.9));
    }
    expect(list.count).toBe(3);
    expect(list.pooled).toBe(3);
  });

  it('SAYS WHETHER A CASTER S MATERIAL IS GLASS, and zero transmission is not', () => {
    const out = glass(0);
    expect(glassOf({ glass: { transmission: 0.8, frost: 0.5 } }, out)).toBe(true);
    expect(out.transmission).toBeCloseTo(0.8, 9);
    expect(glassOf({ glass: { transmission: 0, frost: 0.5 } }, out)).toBe(false);
    expect(glassOf(null, out)).toBe(false);
    expect(glassOf(undefined, out)).toBe(false);
  });
});

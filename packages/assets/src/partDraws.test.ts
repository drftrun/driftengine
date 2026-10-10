import { describe, expect, it } from 'vitest';
import type {
  GlassOptions,
  InstancedHandle,
  MeshHandle,
  MeshInstances,
  RendererApi,
  ShadowCasterSink,
} from '@driftengine/core';

import { PartDraws } from './partDraws.ts';
import type { DrftPart } from './loadProgress.ts';

/** A part with everything a container gives one, so a case states only what it is about. */
function part(name: string, over: Partial<DrftPart> = {}): DrftPart {
  return {
    mesh: { name } as unknown as MeshHandle,
    albedo: -1,
    orm: -1,
    normal: -1,
    emissive: -1,
    roughnessScale: 1,
    metallicScale: 1,
    occlusionStrength: 0,
    opacity: 1,
    reflectivity: 0,
    cutout: 0,
    blend: false,
    doubleSided: false,
    glass: null,
    instances: null,
    reveal: 1,
    ...over,
  };
}

function copies(name: string): DrftPart['instances'] {
  return {
    batch: { name } as unknown as InstancedHandle,
    data: { count: 3 } as unknown as MeshInstances,
  };
}

/** Every call the drawer makes, as `[method, what it named, the material set when it was made]`. */
function recordingRenderer(): { renderer: RendererApi; calls: unknown[][] } {
  const calls: unknown[][] = [];
  let material: unknown = null;
  const named = (target: unknown): unknown => (target as { name?: string } | null)?.name;
  const record =
    (method: string) =>
    (target: unknown, ...rest: unknown[]): void => {
      calls.push([method, named(target), structuredClone(material), ...rest]);
    };
  const renderer = {
    setMaterial: (m: unknown) => {
      material = m === null ? null : { ...(m as object) };
      calls.push(['setMaterial', material === null ? null : 'material']);
    },
    setSurfaceReflectivity: (amount: number) => calls.push(['reflectivity', amount]),
    drawMesh: record('drawMesh'),
    drawTranslucentMesh: (mesh: unknown, model: unknown, opacity: number, options: unknown) =>
      calls.push(['drawTranslucentMesh', named(mesh), opacity, options]),
    drawInstanced: record('drawInstanced'),
    drawTranslucentInstanced: (batch: unknown, data: unknown, opacity: number, options: unknown) =>
      calls.push(['drawTranslucentInstanced', named(batch), opacity, options]),
    prepareMesh: (mesh: unknown, m: unknown, options: unknown) =>
      calls.push(['prepareMesh', named(mesh), { ...(m as object) }, options]),
    prepareInstanced: (batch: unknown, m: unknown, options: unknown) =>
      calls.push(['prepareInstanced', named(batch), { ...(m as object) }, options]),
    ready: async () => {
      calls.push(['ready']);
    },
  } as unknown as RendererApi;
  return { renderer, calls };
}

const pane: GlassOptions = { transmission: 0.9, frost: 0 };

/*
 * **A loaded model drawn by the rules a baked container needs, none of which a caller can see
 * being missed**: a part's whole material, its copies through the instanced path, a blended part
 * translucent whatever its opacity and writing no depth, a blended batch translucent too, glass as
 * glass with its options kept from frame to frame, each part's own reflectivity, and nothing left
 * set for the caller's draws after it.
 */
describe('PartDraws', () => {
  it('DRAWS EACH PART BY THE RULES ITS CONTAINER NEEDS, AND LEAVES NOTHING SET', () => {
    const { renderer, calls } = recordingRenderer();
    const parts = [
      part('stone', { cutout: 0.5, doubleSided: true, reflectivity: 0.25 }),
      part('arch', { instances: copies('arches') }),
      part('grime', { blend: true }),
      part('leaves', { blend: true, instances: copies('ivy') }),
      part('lantern', { blend: true, glass: pane }),
      part('veil', { opacity: 0.5 }),
    ];
    const draws = new PartDraws(renderer);
    expect(draws.draw(parts, null)).toBe(6);
    const drawn = calls.filter((c) => String(c[0]).startsWith('draw'));
    expect(drawn.map((c) => [c[0], c[1]])).toEqual([
      ['drawMesh', 'stone'],
      ['drawInstanced', 'arches'],
      ['drawTranslucentMesh', 'grime'],
      ['drawTranslucentInstanced', 'ivy'],
      ['drawTranslucentMesh', 'lantern'],
      ['drawTranslucentMesh', 'veil'],
    ]);
    /* The stone's material carries its cutout and its two faces; the reflectivity is its own. */
    expect(drawn[0]?.[2]).toMatchObject({ cutout: 0.5, doubleSided: true });
    expect(calls).toContainEqual(['reflectivity', 0.25]);
    /* Blended parts write no depth; glass draws as glass; an opacity below one is kept. */
    expect(drawn[2]?.slice(2)).toEqual([1, { depthWrite: false }]);
    expect(drawn[3]?.slice(2)).toEqual([1, { depthWrite: false }]);
    expect(drawn[4]?.slice(2)).toEqual([1, { depthWrite: false, glass: pane }]);
    expect(drawn[5]?.[2]).toBe(0.5);
    /* Nothing of the last part is left for whatever the caller draws next. */
    expect(calls.slice(-2)).toEqual([
      ['setMaterial', null],
      ['reflectivity', 0],
    ]);

    /* The glass's options are the same object next frame, so a frame allocates none. */
    calls.length = 0;
    draws.draw(parts, null);
    const again = calls.filter((c) => c[0] === 'drawTranslucentMesh' && c[1] === 'lantern');
    expect(again[0]?.[3]).toBe(drawn[4]?.[3]);
  });

  /*
   * **What casts is what stands in the light**: a blended part that is not glass is a decal on the
   * surface beneath it and would shadow its own stone, so it casts nothing; glass casts as glass;
   * copies cast through the instanced path; and each caster offers its material, so a cutout casts
   * the shape in its texture.
   */
  it('CASTS EVERY PART BUT A DECAL, GLASS AS GLASS AND COPIES AS COPIES, EACH WITH ITS MATERIAL', () => {
    const { renderer } = recordingRenderer();
    const parts = [
      part('stone', { cutout: 0.5 }),
      part('arch', { instances: copies('arches') }),
      part('grime', { blend: true }),
      part('lantern', { blend: true, glass: pane }),
    ];
    const cast: unknown[][] = [];
    const sink = {
      mesh: (mesh: unknown, _model: unknown, material: unknown) =>
        cast.push(['mesh', (mesh as { name: string }).name, { ...(material as object) }]),
      instanced: (batch: unknown, _data: unknown, material: unknown) =>
        cast.push(['instanced', (batch as { name: string }).name, { ...(material as object) }]),
    } as unknown as ShadowCasterSink;
    new PartDraws(renderer).cast(sink, parts, null);
    expect(cast.map((c) => [c[0], c[1]])).toEqual([
      ['mesh', 'stone'],
      ['instanced', 'arches'],
      ['mesh', 'lantern'],
    ]);
    expect(cast[0]?.[2]).toMatchObject({ cutout: 0.5, glass: undefined });
    expect(cast[2]?.[2]).toMatchObject({ glass: pane });
  });

  /*
   * **Prepared as it will be drawn**: each part's pipelines compiled in its own material, the
   * blended ones as translucent too, copies through the batch, and `ready()` awaited last.
   */
  it('PREPARES EACH PART IN ITS MATERIAL, TRANSLUCENT WHERE IT WILL BE DRAWN SO, THEN WAITS', async () => {
    const { renderer, calls } = recordingRenderer();
    const parts = [
      part('stone', { doubleSided: true }),
      part('arch', { instances: copies('arches') }),
      part('grime', { blend: true }),
      part('veil', { opacity: 0.5 }),
    ];
    await new PartDraws(renderer).prepare(parts, null);
    expect(calls.map((c) => [c[0], c[1], c[3]])).toEqual([
      ['prepareMesh', 'stone', { translucent: false }],
      ['prepareInstanced', 'arches', { translucent: false }],
      ['prepareMesh', 'grime', { translucent: true }],
      ['prepareMesh', 'veil', { translucent: true }],
      ['ready', undefined, undefined],
    ]);
    expect(calls[0]?.[2]).toMatchObject({ doubleSided: true });
  });
});

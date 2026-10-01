import { solidSweep, transformSolid } from '@driftengine/core';
import { ATTR_TANGENT, ATTR_UVS, SURFACE_FLOATS, expandAssembly } from '@driftengine/drft';
import { describe, expect, it } from 'vitest';

import { readScripts } from '../script/reader.ts';
import { ScriptWorld } from '../script/world.ts';
import { flatten, identity } from './flatten.ts';
import type { Part } from './flatten.ts';
import { Kit } from './kit.ts';
import { surfaceOf } from './materials.ts';
import { primitiveSolid } from './primitives.ts';

const SCRIPT = [
  'city {',
  '  slab { Box: {2, 1, 4}',
  '    Position3: {10, 0, 0}',
  '    Rotation3: {0, 0.5, 0}',
  '    Scale3: {1, 2, 1} }',
  '  other { Box: {7, 3, 0.5}',
  '    Position3: {0, 5, 0} }',
  '  cone { Frustum: {segments: 8, smooth: false, length: 2, radius_bottom: 1, radius_top: 0.5}',
  '    Position3: {0, 0, -3}',
  '    Rotation3: {0.3, 0, 0} }',
  '  pipe { Tube: {segments: 10, smooth: true, length: 3, radius: 0.4, thickness: 0.1} }',
  '  sign { Box: {12, 18, 0.14} }',
  '  wall { Csg: {op: CsgUnion}',
  '    TextureTiling: {meters_x: 2, meters_y: 2}',
  '    body { Box: {4, 2, 0.2} }',
  '    hole { Box: {1, 1, 1}',
  '      CsgOperator: {op: CsgDifference} } }',
  '}',
].join('\n');

const read = readScripts(['k.flecs'], (f) => (f === 'k.flecs' ? SCRIPT : null));
const city = ScriptWorld.walk(read.world.root, ['city']);
const parts = city === null ? [] : flatten(city, identity()).parts;
const part = (name: string): Part => {
  const p = parts.find((x) => x.entity.name === name);
  if (p === undefined) throw new Error(`no ${name}`);
  return p;
};

/** A mesh's positions as a sorted set of rounded triples, so vertex order does not matter. */
const shape = (positions: ArrayLike<number>): string[] => {
  const out: string[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    out.push(
      [0, 1, 2]
        .map((a) => (Math.round((positions[i + a] as number) * 1e4) / 1e4 + 0).toFixed(4))
        .join(','),
    );
  }
  return out.sort();
};

describe('parts as copies of a kit', () => {
  const kit = new Kit();
  const expand = (p: Part) => {
    const copy = kit.copyOf(p, surfaceOf(p.material));
    if (copy === null) throw new Error(`no copy of ${p.entity.name}`);
    return {
      copy,
      mesh: expandAssembly(
        {
          attributes: ATTR_UVS | ATTR_TANGENT,
          surfaces: new Float32Array(SURFACE_FLOATS),
          pieces: new Uint32Array([copy.piece]),
          surfaceOf: new Uint32Array([0]),
          transforms: copy.matrix,
          uv: copy.uv,
        },
        (o) => kit.pieces[o] as (typeof kit.pieces)[number],
      ),
    };
  };

  it('A PART’S COPY EXPANDS TO EXACTLY THE PART: a turned, scaled box, a frustum, a tube', () => {
    expect(read.errors).toEqual([]);
    for (const name of ['slab', 'cone', 'pipe']) {
      const p = part(name);
      const direct = primitiveSolid(p.kind, p.spec);
      if (direct === null) throw new Error(name);
      expect(shape(expand(p).mesh.positions), name).toEqual(
        shape(transformSolid(direct, p.matrix).positions),
      );
    }
  });

  it('ONE PIECE SERVES EVERY BOX, WHATEVER ITS SIZE', () => {
    const a = kit.copyOf(part('slab'), surfaceOf(part('slab').material));
    const b = kit.copyOf(part('other'), surfaceOf(part('other').material));
    expect(a?.piece).toBe(b?.piece);
    /* 7 × 3 × 0.5 unturned at (0, 5, 0): the matrix is the size on its diagonal, then the place. */
    expect(Array.from(b?.matrix ?? [])).toEqual([7, 0, 0, 0, 3, 0, 0, 0, 0.5, 0, 5, 0]);
  });

  it('A PICTURE STANDS UPRIGHT: THE TOP OF A FACE SAMPLES THE TOP OF ITS IMAGE, WHICH THE ENGINE CALLS V 0', () => {
    /* A sign's front face, 18 m high: v is 0 along its top edge and 1 along its foot. Written the
       other way — v growing up the face, as a solid lays it out — every sign reads upside down. */
    const { mesh } = expand(part('sign'));
    const rows: string[] = [];
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      if ((mesh.normals[i * 3 + 2] as number) < 0.9) continue;
      rows.push(
        `${mesh.positions[i * 3 + 1]} ${Math.round((mesh.uvs?.[i * 2 + 1] as number) * 1e5) / 1e5}`,
      );
    }
    expect(rows.sort()).toEqual(['-9 1', '-9 1', '9 0', '9 0']);
  });

  it('a tiled cut wall’s coordinates are metres over the tile, across and up each face', () => {
    const { mesh } = expand(part('wall'));
    /* The +z face spans x −2..2 and y −1..1; at 2 m a tile, u runs −1..1, and v — down the
       picture, the repeats counted from the foot — from 0.5 at the top to 1.5 at the foot. */
    const us: number[] = [];
    const vs: number[] = [];
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      if (
        (mesh.normals[i * 3 + 2] as number) > 0.9 &&
        Math.abs((mesh.positions[i * 3 + 2] as number) - 0.1) < 1e-4
      ) {
        us.push(mesh.uvs?.[i * 2] as number);
        vs.push(mesh.uvs?.[i * 2 + 1] as number);
      }
    }
    expect([Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)]).toEqual([
      -1, 1, 0.5, 1.5,
    ]);
    /* On an end face u runs to the right of someone facing it — −z on +x, +z on −x — so neither
       end reads mirrored: u is −sign(nx) · z over the tile everywhere. */
    let ends = 0;
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      const nx = mesh.normals[i * 3] as number;
      if (Math.abs(nx) < 0.9) continue;
      ends++;
      const z = mesh.positions[i * 3 + 2] as number;
      expect(mesh.uvs?.[i * 2]).toBeCloseTo((-Math.sign(nx) * z) / 2, 5);
    }
    expect(ends).toBeGreaterThan(0);
  });
});

describe('swept spans', () => {
  const SPANS = [
    /* Wider on one side than the other, so a mirrored span would not pass for the right one. */
    'prof { SplineProfile: {profile: [{-1, 0}, {2, 0}, {2, 0.5}, {-1, 0.5}], slices: 4, cap_ends: true, uv_scale: 1} }',
    'run {',
    '  line { SplineMesh: {profile: prof, p0: {10, 14, 0}, t0: {20, 5, 0}, p1: {30, 19, 0}, t1: {20, 5, 0},',
    '    up0: {0, 1, 0}, up1: {0, 1, 0}, length: 20.6, v_scale: 2} }',
    '  bendA { SplineMesh: {profile: prof, p0: {0, 14, 0}, t0: {10, 0, 0}, p1: {10, 14, 10}, t1: {0, 0, 10},',
    '    up0: {0, 1, 0}, up1: {0, 1, 0}, length: 15.7, v_scale: 2} }',
    '  bendB { SplineMesh: {profile: prof, p0: {100, 14, 0}, t0: {10, 0, 0}, p1: {110, 14, 10}, t1: {0, 0, 10},',
    '    up0: {0, 1, 0}, up1: {0, 1, 0}, length: 15.7, v_scale: 2} }',
    '}',
  ].join('\n');
  const spans = readScripts(['s.flecs'], (f) => (f === 's.flecs' ? SPANS : null));
  const run = ScriptWorld.walk(spans.world.root, ['run']);
  const spanParts = run === null ? [] : flatten(run, identity()).parts;
  const span = (name: string): Part => {
    const p = spanParts.find((x) => x.entity.name === name);
    if (p === undefined) throw new Error(name);
    return p;
  };

  it('A STRAIGHT SPAN IS ONE UNIT SWEEP TURNED AND STRETCHED ONTO IT, EXACTLY THE SWEEP ALONG IT', () => {
    expect(spans.errors).toEqual([]);
    const kit = new Kit();
    const p = span('line');
    const copy = kit.copyOf(p, surfaceOf(p.material));
    if (copy === null) throw new Error('no copy');
    const mesh = expandAssembly(
      {
        attributes: 0,
        surfaces: new Float32Array(SURFACE_FLOATS),
        pieces: new Uint32Array([copy.piece]),
        surfaceOf: new Uint32Array([0]),
        transforms: copy.matrix,
        uv: copy.uv,
      },
      (o) => kit.pieces[o] as (typeof kit.pieces)[number],
    );
    /* The same profile swept straight from (10, 14, 0) to (30, 19, 0), climbing 5 m in 20. */
    const direct = solidSweep([-1, 0, 2, 0, 2, 0.5, -1, 0.5], [10, 14, 0, 30, 19, 0], true);
    expect(shape(mesh.positions)).toEqual(shape(direct.positions));
  });

  it('a bend is swept as it lies, and two alike share one piece', () => {
    const kit = new Kit();
    const a = kit.copyOf(span('bendA'), surfaceOf(span('bendA').material));
    const b = kit.copyOf(span('bendB'), surfaceOf(span('bendB').material));
    expect(a?.piece).toBe(b?.piece);
    expect(Array.from(b?.matrix.subarray(9) ?? [])).toEqual([100, 14, 0]);
    /* Swept along its curve: its four slices are five rings where a straight span has two, as the
       sweep itself builds them over five points and over two, caps and all. */
    const line = kit.copyOf(span('line'), surfaceOf(span('line').material));
    const count = (o: number | undefined) => (kit.pieces[o ?? -1]?.positions.length ?? 0) / 3;
    const profile = [-1, 0, 2, 0, 2, 0.5, -1, 0.5];
    const five =
      solidSweep(profile, [0, 0, 0, 1, 0, 0, 2, 0, 1, 3, 0, 2, 4, 0, 3], true).positions.length / 3;
    const two = solidSweep(profile, [0, 0, 0, 1, 0, 0], true).positions.length / 3;
    expect([count(a?.piece), count(line?.piece)]).toEqual([five, two]);
  });
});

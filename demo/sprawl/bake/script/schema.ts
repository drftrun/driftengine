/**
 * The members of the components the reference's scripts assign: their order, for positional
 * initialisers, and their types, for the type checker's hint and for storage.
 *
 * **The engine these scripts were written for is not public, so this table is read from how the
 * scripts use each component**: `Box: {w, h, t}` is three extents, `Rgba` is four bytes (the author
 * clamps channels at 255), `segments` is an integer. A member missing from the table hints `f32`,
 * which is what engine geometry uses; where that guess meets an integer member, the small integers
 * the corpus writes are exact in `f32` anyway.
 *
 * What would make an entry wrong: a capture where a value computed into it differs from the
 * reference by a rounding step. Templates are schemas too — their props — and the evaluator adds
 * them as it meets them, as it does the one `struct` the corpus declares.
 */
import type { NumType } from './numeric.ts';

/** A number, a string, an entity, a named schema, a vector of one (`Name[]`), or anything. */
export type MemberType = NumType | 'string' | 'entity' | 'any' | (string & {});

export interface Member {
  readonly name: string;
  readonly type: MemberType;
}

const xyz = (type: NumType = 'f32'): Member[] => [
  { name: 'x', type },
  { name: 'y', type },
  { name: 'z', type },
];
const members = (spec: string): Member[] =>
  spec.split(' ').map((entry) => {
    const [name, type] = entry.split(':');
    return { name: name as string, type: type ?? 'f32' };
  });

const ROUND = 'segments:i32 smooth:bool';

export const BUILT_IN_SCHEMAS: ReadonlyMap<string, readonly Member[]> = new Map<
  string,
  readonly Member[]
>([
  ['Position3', xyz()],
  ['Rotation3', xyz()],
  ['Scale3', xyz()],
  ['LookAt', xyz()],
  ['Rgba', members('r:u8 g:u8 b:u8 a:u8')],
  ['Box', xyz()],
  ['Quad', members('x y')],
  ['TrianglePrism', xyz()],
  ['RightTrianglePrism', xyz()],
  ['Texture', members('file:string width:i32 height:i32')],
  ['BlockRect', members('x0 z0 x1 z1')],
  ['ObstacleTop', members('h')],
  ['Position', members('x y')],
  ['EmitterRange', members('range')],
  ['Cylinder', members(`${ROUND} length`)],
  ['Cone', members(`${ROUND} length`)],
  ['Frustum', members(`${ROUND} length radius_bottom radius_top`)],
  ['Tube', members(`${ROUND} length radius thickness`)],
  ['Sphere', members(`${ROUND} radius`)],
  ['HemiSphere', members(`${ROUND} radius`)],
  ['IcoSphere', members(`${ROUND} radius`)],
  ['Capsule', members(`${ROUND} length radius`)],
  ['RoundedBox', members('x y z radius segments:i32')],
  ['Lathe', members('profile:any segments:i32 smooth:bool')],
  ['Extrude', members('profile:any height center:bool')],
  ['PbrMaterial', members('metallic roughness absorption')],
  ['Emissive', members('strength color:Rgba')],
  ['PbrTextures', members('albedo:entity emissive:entity roughness:entity')],
  ['NightLight', members('strength light offset flicker')],
  ['WindowLights', members('strength offset level:i32')],
  [
    'BuildingPalette',
    members('weight wall:Rgba trim:Rgba window:Rgba accent:Rgba lit variant:i32'),
  ],
  ['DistrictDef', members('kind:any seed_x seed_z share spacing accent:Rgba')],
  ['math.Rng', members('seed:u64')],
]);

/** The schema's members, or null for a component this table does not know. */
export function schemaOf(
  name: string,
  extra: ReadonlyMap<string, readonly Member[]>,
): readonly Member[] | null {
  return extra.get(name) ?? BUILT_IN_SCHEMAS.get(name) ?? null;
}

/**
 * The member's type, or null where the table does not say. The evaluator hints `f32` for an
 * unknown member and stores a float there as `f32`, leaving integers, entities and composites as
 * they came, because an unknown member may hold any of them.
 */
export function memberType(schema: readonly Member[] | null, name: string): MemberType | null {
  return schema?.find((m) => m.name === name)?.type ?? null;
}

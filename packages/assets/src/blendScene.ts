/**
 * Which objects of a `.blend` are drawn, and where: the scene walk, in Blender's coordinates.
 *
 * **"Drawn" means what a render of the open scene shows**, the same rule `scripts/blender/
 * export_gltf.py` applies before it hands the scene to Blender's exporter, so both routes into
 * the engine agree on what an asset contains. An object is drawn when it is linked into the scene
 * through at least one collection that is neither excluded from the view layer nor disabled for
 * rendering, and is not itself hidden from renders. Parenting does not hide: a child of a hidden
 * object is drawn where its parent would have put it, which is what Blender does.
 *
 * **A collection instance is expanded** into its objects, placed by the instancer and shifted by
 * the collection's instance offset. Before 2.8 there were no collections, and the scene's bases and
 * layer bits say the same thing.
 *
 * **What has to be evaluated is refused rather than guessed.** A constraint, a vertex parent or a
 * particle instancer changes where things are by running Blender, so the walk names it in
 * `refusals` and the caller declines the whole file. Animation does not refuse: Blender writes the
 * evaluated value of every animated property back to the datablock, so a saved file holds the
 * pose of the frame it was saved on.
 */

import type { BlendData, BlendStruct } from './blendData.ts';
import type { Mat4 } from './blendMatrix.ts';
import {
  axisAngleMatrix,
  compose,
  eulerMatrix,
  multiply,
  multiply3,
  quaternionMatrix,
  translation,
} from './blendMatrix.ts';

/** One drawn object, or an empty that carries others, at its place in the world. */
export interface BlendPlaced {
  readonly object: BlendStruct;
  readonly name: string;
  /** Blender's object type: 0 empty, 1 mesh, 10 light, 25 armature, and the rest. */
  readonly kind: number;
  /** World matrix, Blender space (Z up), column-major. */
  readonly world: Mat4;
  /** Index of the nearest placed ancestor, or -1. */
  readonly parent: number;
}

export const OB_EMPTY = 0;
export const OB_MESH = 1;
export const OB_LAMP = 10;
export const OB_CAMERA = 11;
export const OB_ARMATURE = 25;

/** Object types that draw nothing and so need nothing evaluated: cameras, speakers, probes. */
const INERT = new Set([OB_CAMERA, 12, 13, 22]);
const NEEDS_EVALUATION: Record<number, string> = {
  2: 'a curve',
  3: 'a NURBS surface',
  4: 'a text object',
  5: 'a metaball',
  26: 'a grease pencil object',
  27: 'a hair curves object',
  28: 'a point cloud',
  29: 'a volume',
  30: 'a grease pencil object',
};

const OB_HIDE_RENDER = 1 << 2;
const COLLECTION_HIDE_RENDER = 1 << 3;
const LAYER_COLLECTION_EXCLUDE = 1 << 4;
const OB_DUPLICOLLECTION = 1 << 8;
const OB_DUPLIVERTS = 1 << 4;
const OB_DUPLIFACES = 1 << 9;
const PARTYPE = 15;
const PAROBJECT = 0;
const PARSKEL = 4;
const PARBONE = 7;

/** The scene the file was saved looking at. */
export function activeScene(blend: BlendData): BlendStruct | null {
  const glob = blend.idsOf('GLOB')[0];
  const scene = glob?.has('curscene') === true ? glob.deref('curscene') : null;
  return scene ?? blend.idsOf('SC')[0] ?? null;
}

/**
 * The object's transform relative to its parent: location, rotation and scale, deltas folded in.
 *
 * `values`, where given, overrides what the file stores with what an animation says at a frame,
 * keyed by Blender's data path and index — `location[0]`, `rotation_quaternion[3]` — which is what
 * `Animation.values` fills (`blendAnimation.ts`).
 */
export function localMatrix(object: BlendStruct, values?: ReadonlyMap<string, number>): Mat4 {
  const read = (field: string, path: string, count: number, offset = 0): number[] => {
    const stored = object.has(field)
      ? object.floats(field)
      : new Array<number>(count).fill(field.includes('size') || field.includes('scale') ? 1 : 0);
    if (values === undefined) return stored;
    return stored.map((v, i) => values.get(`${path}[${i + offset}]`) ?? v);
  };
  const location = read('loc', 'location', 3);
  const deltaLocation = read('dloc', 'delta_location', 3);
  const scale = read('size', 'scale', 3);
  const deltaScale = object.has('dscale')
    ? read('dscale', 'delta_scale', 3)
    : read('dsize', 'delta_scale', 3);
  const mode = object.int('rotmode');
  let rotation;
  let delta;
  if (mode === 0) {
    rotation = quaternionMatrix(read('quat', 'rotation_quaternion', 4));
    delta = quaternionMatrix(read('dquat', 'delta_rotation_quaternion', 4));
  } else if (mode === -1) {
    /* Blender keys an axis-angle as four values, the angle first. */
    const angle = values?.get('rotation_axis_angle[0]') ?? object.float('rotAngle');
    rotation = axisAngleMatrix(read('rotAxis', 'rotation_axis_angle', 3, 1), angle);
    delta = axisAngleMatrix(object.floats('drotAxis'), object.float('drotAngle'));
  } else {
    rotation = eulerMatrix(read('rot', 'rotation_euler', 3), mode);
    delta = eulerMatrix(read('drot', 'delta_rotation_euler', 3), mode);
  }
  return compose(
    [0, 1, 2].map((i) => (location[i] as number) + (deltaLocation[i] as number)),
    multiply3(delta, rotation),
    [0, 1, 2].map((i) => (scale[i] as number) * (deltaScale[i] as number)),
  );
}

/** Walk the scene into placed objects, naming in `refusals` anything that needs Blender to run. */
export function placeObjects(
  blend: BlendData,
  refusals: string[],
  bonePose: (armature: BlendStruct, bone: string) => Mat4 | null,
): BlendPlaced[] {
  const scene = activeScene(blend);
  if (scene === null) {
    refusals.push('the file has no scene');
    return [];
  }
  const worlds = new Map<number, Mat4>();
  const world = (object: BlendStruct, depth = 0): Mat4 => {
    const cached = worlds.get(object.offset);
    if (cached !== undefined) return cached;
    let matrix = localMatrix(object);
    const parent = depth < 64 ? object.deref('parent') : null;
    if (parent !== null) {
      const type = object.int('partype') & PARTYPE;
      let base = world(parent, depth + 1);
      if (type === PARBONE) {
        const pose = bonePose(parent, object.string('parsubstr'));
        if (pose === null)
          refusals.push(`"${object.idName()}" is parented to a bone that is not there`);
        else base = multiply(base, pose);
      } else if (type !== PAROBJECT && type !== PARSKEL) {
        refusals.push(`"${object.idName()}" is parented to vertices, which Blender evaluates`);
      }
      matrix = multiply(base, multiply(object.floats('parentinv'), matrix));
    }
    if (object.list('constraints').length > 0) {
      refusals.push(`"${object.idName()}" has constraints, which Blender evaluates`);
    }
    worlds.set(object.offset, matrix);
    return matrix;
  };

  const placed: BlendPlaced[] = [];
  const index = new Map<number, number>();

  const place = (object: BlendStruct, outer: Mat4 | null, holder: number, depth: number): void => {
    const kind = object.int('type');
    if (INERT.has(kind)) return;
    const reason = NEEDS_EVALUATION[kind];
    if (reason !== undefined)
      refusals.push(`"${object.idName()}" is ${reason}, which Blender evaluates`);
    if (object.list('particlesystem').length > 0) {
      refusals.push(`"${object.idName()}" has a particle system, which Blender evaluates`);
    }
    const transflag = object.int('transflag');
    if (transflag & (OB_DUPLIVERTS | OB_DUPLIFACES)) {
      refusals.push(
        `"${object.idName()}" instances onto its vertices or faces, which Blender evaluates`,
      );
    }
    const own = world(object);
    const matrix = outer === null ? own : multiply(outer, own);
    let parent = holder;
    for (let up = object.deref('parent'), hops = 0; up !== null && hops < 64; hops++) {
      const found = outer === null ? index.get(up.offset) : undefined;
      if (found !== undefined) {
        parent = found;
        break;
      }
      up = up.deref('parent');
    }
    /*
     * An instancer carries its collection's offset in its own matrix, so its members sit at their
     * own world matrices beneath it. Blender's exporter writes the instancer the same way, which
     * keeps the two node trees comparable; the empty draws nothing, so nothing moves on screen.
     */
    const collection = transflag & OB_DUPLICOLLECTION ? object.deref('dup_group') : null;
    const offset = collection?.floats('dupli_ofs') ?? [0, 0, 0];
    const held =
      collection === null
        ? matrix
        : multiply(
            matrix,
            translation(-(offset[0] as number), -(offset[1] as number), -(offset[2] as number)),
          );
    const at = placed.length;
    placed.push({ object, name: object.idName(), kind, world: held, parent });
    if (outer === null) index.set(object.offset, at);
    if (collection !== null && depth < 16) {
      for (const member of collectionObjects(collection, true)) place(member, held, at, depth + 1);
    }
  };

  const roots = sceneObjects(scene, blend);
  /* Parents first, so a child finds its parent's index already assigned. */
  const order = [...roots].sort((a, b) => depthOf(a) - depthOf(b));
  for (const object of order) place(object, null, -1, 0);
  return placed;
}

function depthOf(object: BlendStruct): number {
  let depth = 0;
  for (let up = object.deref('parent'); up !== null && depth < 64; up = up.deref('parent')) depth++;
  return depth;
}

/** The objects a collection holds directly and through its children, those that render. */
function collectionObjects(collection: BlendStruct, nested: boolean): BlendStruct[] {
  const out: BlendStruct[] = [];
  const seen = new Set<number>();
  const visit = (current: BlendStruct, depth: number): void => {
    for (const link of current.list('gobject')) {
      const object = link.deref('ob');
      if (object === null || seen.has(object.offset)) continue;
      seen.add(object.offset);
      if ((object.int('restrictflag') & OB_HIDE_RENDER) === 0) out.push(object);
    }
    if (!nested || depth > 32) return;
    for (const child of current.list('children')) {
      const inner = child.deref('collection');
      if (inner !== null && (inner.int('flag') & COLLECTION_HIDE_RENDER) === 0)
        visit(inner, depth + 1);
    }
  };
  visit(collection, 0);
  return out;
}

/** Every object the scene renders, once each. */
function sceneObjects(scene: BlendStruct, blend: BlendData): BlendStruct[] {
  if (!scene.has('master_collection')) {
    /* Before 2.8: bases on the scene, drawn when one of their layers is a visible scene layer. */
    const layers = scene.int('lay');
    return scene
      .list('base')
      .filter((base) => (base.int('lay') & layers) !== 0)
      .map((base) => base.deref('object'))
      .filter((object): object is BlendStruct => object !== null)
      .filter((object) => (object.int('restrictflag') & OB_HIDE_RENDER) === 0);
  }
  const master = scene.deref('master_collection');
  if (master === null) return [];
  const glob = blend.idsOf('GLOB')[0];
  const layers = scene.list('view_layers');
  const active =
    glob?.has('cur_view_layer') === true
      ? layers.find((layer) => layer.offset === glob.deref('cur_view_layer')?.offset)
      : undefined;
  const layer = active ?? layers[0];
  const top = layer?.list('layer_collections')[0];

  const out: BlendStruct[] = [];
  const seen = new Set<number>();
  const take = (collection: BlendStruct): void => {
    for (const link of collection.list('gobject')) {
      const object = link.deref('ob');
      if (object === null || seen.has(object.offset)) continue;
      if ((object.int('restrictflag') & OB_HIDE_RENDER) !== 0) continue;
      seen.add(object.offset);
      out.push(object);
    }
  };
  /*
   * Walk the layer collections where the view layer has them, since exclusion lives there; walk the
   * collections themselves where it does not, which is a file written without a synchronised view
   * layer and has nothing excluded.
   */
  const walkLayer = (lc: BlendStruct, depth: number): void => {
    if (depth > 64 || (lc.int('flag') & LAYER_COLLECTION_EXCLUDE) !== 0) return;
    const collection = lc.deref('collection');
    if (collection === null || (collection.int('flag') & COLLECTION_HIDE_RENDER) !== 0) return;
    take(collection);
    for (const child of lc.list('layer_collections')) walkLayer(child, depth + 1);
  };
  const walkCollection = (collection: BlendStruct, depth: number): void => {
    if (depth > 64 || (collection.int('flag') & COLLECTION_HIDE_RENDER) !== 0) return;
    take(collection);
    for (const child of collection.list('children')) {
      const inner = child.deref('collection');
      if (inner !== null) walkCollection(inner, depth + 1);
    }
  };
  if (top !== undefined) walkLayer(top, 0);
  else walkCollection(master, 0);
  return out;
}

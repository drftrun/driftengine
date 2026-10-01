/**
 * What the district's source holds, sorted into what the bake does with each thing.
 *
 * **Four kinds of placement.** A mesh placed once is *static* and is merged into its region with
 * every other static wearing the same material. A mesh placed more than once is a *prototype* and
 * its copies are drawn instanced, culled one by one. Anything animated is a *mover*, placed by its
 * action at run time. Lights, cameras and the empties that carry routes are read for what they say,
 * not drawn.
 *
 * **Coordinates leave here in the engine's**: Y up, as Blender's exporter converts them, so a
 * prototype's vertices and its copies' matrices agree with the glTF route that builds the vertices.
 * Every placement's matrix is `C · W · C⁻¹` for Blender's world matrix `W`.
 */
import type { BlendData, BlendPlaced, BlendStruct } from '@driftengine/assets';
import {
  Animation,
  OB_LAMP,
  OB_MESH,
  activeScene,
  judgeModifiers,
  localMatrix,
  materialSlots,
  placeObjects,
  readBlendSurface,
} from '@driftengine/assets';

export type Mat4 = number[];

export interface Placement {
  readonly name: string;
  readonly object: BlendStruct;
  /** World matrix, Y up, column-major. */
  readonly world: Mat4;
  /**
   * What it is drawn from, keyed so copies share one prototype: the mesh, its smoothing, and what
   * its slots' materials bake into its vertices. Copies wearing materials that differ only in their
   * pictures — the same facade in charcoal and in jade — share the geometry and each wear their own.
   */
  readonly key: string;
  /** The material in each slot, which the copy wears whatever piece it shares. */
  readonly slots: readonly (BlendStruct | null)[];
  /** The collection it was found in at the top of the scene, for a bake that keeps some only. */
  readonly collection: string;
}

export interface SceneLight {
  readonly name: string;
  readonly kind: 'point' | 'spot' | 'sun' | 'area';
  /** Position and the way it shines, Y up. */
  readonly position: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
  readonly color: readonly [number, number, number];
  /** Watts, as Blender states them. */
  readonly watts: number;
  readonly radius: number;
}

export interface SceneView {
  readonly name: string;
  readonly position: readonly [number, number, number];
  /** The direction the camera looks, Y up. */
  readonly forward: readonly [number, number, number];
  readonly fovDeg: number;
}

export interface DistrictScene {
  readonly statics: Placement[];
  readonly copies: Map<string, Placement[]>;
  readonly movers: Placement[];
  readonly lights: SceneLight[];
  readonly views: SceneView[];
  /** One object for each prototype key, to convert once. */
  readonly sample: Map<string, BlendStruct>;
  readonly refusals: string[];
}

const C: Mat4 = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
const C_INV: Mat4 = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + r] as number) * (b[c * 4 + k] as number);
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

export const toYUp = (world: Mat4): Mat4 => multiply(multiply(C, world), C_INV);

/** The top-level collection each object of the scene is reached through. */
function collectionsOf(blend: BlendData): Map<number, string> {
  const out = new Map<number, string>();
  const master = activeScene(blend)?.deref('master_collection');
  if (master === null || master === undefined) return out;
  const visit = (collection: BlendStruct, top: string, depth: number): void => {
    for (const link of collection.list('gobject')) {
      const object = link.deref('ob');
      if (object !== null && !out.has(object.offset)) out.set(object.offset, top);
    }
    if (depth > 16) return;
    for (const child of collection.list('children')) {
      const inner = child.deref('collection');
      if (inner !== null) visit(inner, depth === 0 ? inner.idName() : top, depth + 1);
    }
  };
  visit(master, '', 0);
  return out;
}

/** Whether an object moves: an action of its own, or NLA strips playing one, which is how the source's traffic is driven. */
function animated(object: BlendStruct): boolean {
  if (!object.has('adt') || object.ptr('adt') === 0n) return false;
  return new Animation(object).animated;
}

const laneCache = new Map<number, string>();
/**
 * What a material bakes into the vertices that wear it — base colour, alpha, glow and, where there
 * is no map for them, roughness and metal — as a key. Two materials with the same lanes can share a
 * piece's geometry; what differs between them is then only what their pictures say.
 */
function lanes(material: BlendStruct | null, version: number): string {
  if (material === null) return '-';
  let known = laneCache.get(material.offset);
  if (known === undefined) {
    const s = readBlendSurface(material, version);
    const r = (v: number): string => v.toFixed(3);
    known = [
      ...s.baseColor.map(r),
      r(s.alpha),
      s.alphaMode,
      ...s.emission.map((c) => r(c * s.emissionStrength)),
      s.roughnessMap === null ? r(s.roughness) : 'm',
      s.metallicMap === null ? r(s.metallic) : 'm',
      s.normalMap === null ? '' : 'n',
      s.emissionMap === null ? '' : 'e',
      s.baseColorMap === null ? '' : 'a',
    ].join('/');
    laneCache.set(material.offset, known);
  }
  return known;
}

/** Sort the scene. */
export function readScene(blend: BlendData): DistrictScene {
  const refusals: string[] = [];
  const placed = placeObjects(blend, refusals, () => null);
  const collections = collectionsOf(blend);
  const statics: Placement[] = [];
  const copies = new Map<string, Placement[]>();
  const movers: Placement[] = [];
  const lights: SceneLight[] = [];
  const sample = new Map<string, BlendStruct>();

  const moving = new Set<number>();
  placed.forEach((p, i) => {
    /* A thing is moving if it, or anything it hangs from, is animated. */
    let up: number = i;
    for (let hops = 0; up >= 0 && hops < 64; hops++) {
      if (animated((placed[up] as BlendPlaced).object)) {
        moving.add(i);
        break;
      }
      up = (placed[up] as BlendPlaced).parent;
    }
  });

  placed.forEach((p, i) => {
    const world = toYUp(p.world);
    if (p.kind === OB_LAMP) {
      const lamp = p.object.deref('data');
      if (lamp === null) return;
      const type = lamp.int('type');
      /* A light shines down its own -Z, which Y up is the matrix's second column. */
      const down = [-(world[4] as number), -(world[5] as number), -(world[6] as number)];
      const length = Math.hypot(down[0] as number, down[1] as number, down[2] as number) || 1;
      lights.push({
        name: p.name,
        kind: type === 1 ? 'sun' : type === 2 ? 'spot' : type === 4 ? 'area' : 'point',
        position: [world[12] as number, world[13] as number, world[14] as number],
        direction: [
          (down[0] as number) / length,
          (down[1] as number) / length,
          (down[2] as number) / length,
        ],
        color: [lamp.float('r'), lamp.float('g'), lamp.float('b')],
        watts: lamp.float('energy') * (lamp.has('exposure') ? 2 ** lamp.float('exposure') : 1),
        radius: lamp.has('radius') ? lamp.float('radius') : 0,
      });
      return;
    }
    if (p.kind !== OB_MESH) return;
    const mesh = p.object.deref('data');
    if (mesh === null) return;
    const verdict = judgeModifiers(p.object);
    refusals.push(...verdict.refusals);
    const slots = materialSlots(p.object, mesh);
    const key = `${mesh.offset}:${verdict.splitAngle}:${slots.map((m) => lanes(m, blend.header.version)).join(',')}`;
    const placement: Placement = {
      name: p.name,
      object: p.object,
      world,
      key,
      slots,
      collection: collections.get(p.object.offset) ?? '',
    };
    if (!sample.has(key)) sample.set(key, p.object);
    if (moving.has(i)) movers.push(placement);
    else {
      const list = copies.get(key);
      if (list === undefined) copies.set(key, [placement]);
      else list.push(placement);
    }
  });
  /* A mesh placed once is static; more than once, a prototype with copies. */
  for (const [key, list] of copies) {
    if (list.length === 1) {
      statics.push(list[0] as Placement);
      copies.delete(key);
    }
  }
  return { statics, copies, movers, lights, views: cameraViews(blend), sample, refusals };
}

/** Every camera in the file, as a place to stand and a direction to look. */
function cameraViews(blend: BlendData): SceneView[] {
  const out: SceneView[] = [];
  for (const object of blend.idsOf('OB')) {
    if (object.int('type') !== 11) continue;
    /* Cameras are not placed by the scene walk, which keeps only what renders; read them direct. */
    const world = toYUp(worldOf(object));
    const camera = object.deref('data');
    const lens = camera?.has('lens') === true ? camera.float('lens') : 50;
    const sensor = camera?.has('sensor_x') === true ? camera.float('sensor_x') : 36;
    /* Blender's lens is focal length over a sensor width; the engine's field of view is vertical. */
    const horizontal = 2 * Math.atan(sensor / (2 * lens));
    const vertical = 2 * Math.atan(Math.tan(horizontal / 2) * (9 / 16));
    /* A camera looks down its own -Z; Blender's Z is Y up's Y, so the matrix's second column. */
    const back = [world[4] as number, world[5] as number, world[6] as number];
    const length = Math.hypot(back[0] as number, back[1] as number, back[2] as number) || 1;
    out.push({
      name: object.idName(),
      position: [world[12] as number, world[13] as number, world[14] as number],
      forward: [
        -(back[0] as number) / length,
        -(back[1] as number) / length,
        -(back[2] as number) / length,
      ],
      fovDeg: (vertical * 180) / Math.PI,
    });
  }
  return out;
}

/** An object's world matrix through its parents, Blender's way, Z up. */
function worldOf(object: BlendStruct, depth = 0): Mat4 {
  const local = localMatrix(object);
  const parent = depth < 32 ? object.deref('parent') : null;
  if (parent === null) return local;
  return multiply(worldOf(parent, depth + 1), multiply(object.floats('parentinv'), local));
}

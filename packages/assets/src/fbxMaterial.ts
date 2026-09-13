/**
 * FBX materials and the textures they name. One responsibility: what a surface looks like.
 *
 * Split from `fbx.ts` because reading a record tree and interpreting a shading model are
 * different jobs with different ways of being wrong. The container either parses or it does
 * not; a material silently comes out the wrong colour.
 *
 * **This resolves nothing from disk.** A texture is reported as the string the file wrote,
 * and turning that into bytes belongs to the caller, which is the only party that knows
 * whether it is reading a folder, a zip or a URL. The same reasoning as the injected
 * `Inflate` in `fbx.ts`, for the same reason: this module is part of an engine that runs in
 * a browser and must not reach for a filesystem.
 *
 * **Why the declared path is the only one worth keeping.** These records carry an absolute
 * `FileName` as well, and it is the author's own machine: the asset this was built against
 * says `G:\SketchfabRipper_v1.18.0-b2\tools\blender-292\_sfTemp\textures\carbon.jpg`. That
 * path is dead everywhere except one computer that no longer has the file either. The
 * `RelativeFilename` beside it says `textures\carbon.jpg`, which is true relative to the
 * model and is what every other reader uses.
 */

import type { FbxNode } from './fbx.ts';
import type { AssetReference } from './assetPath.ts';

/** A surface, in the terms this engine's vertex attributes speak. */
export interface FbxMaterial {
  readonly name: string;
  readonly color: readonly [number, number, number];
  /** Highlight strength, 0 to 1. */
  readonly specular: number;
  /** Highlight width, 0 to 1, where 0 is a mirror. */
  readonly roughness: number;
  /** 1 is opaque. FBX states the inverse, when it states it at all. */
  readonly opacity: number;
  /** Self-illumination, 0 to 1. */
  readonly emissive: number;
  readonly emissiveColor: readonly [number, number, number];
  /** Index into `FbxMaterials.textures` for the albedo map, or -1 for an untextured surface. */
  readonly albedo: number;
  /** How much of the environment this surface mirrors, from `ReflectionFactor`. */
  readonly reflectivity: number;
  /**
   * The three map indices `DrftMaterial` carries, all -1 here.
   *
   * This reader resolves no maps but a normal, ORM or emissive one; an FBX that embeds them names
   * them in its own texture connections and wiring that up is its own piece of work. The fields
   * exist because `fbx.ts` pushes an `FbxMaterial` straight into a `DrftMaterial[]`, so the two
   * shapes have to agree.
   */
  readonly normalMap: number;
  readonly ormMap: number;
  readonly emissiveMap: number;
  /** The scales that go with an `ormMap`. Identity here, since there is never one. */
  readonly roughnessScale: number;
  readonly metallicScale: number;
  readonly occlusionStrength: number;
  /** Zero: an FBX material states no alpha test, so nothing is discarded. */
  readonly cutout: number;
}

export interface FbxMaterials {
  readonly byId: ReadonlyMap<number, FbxMaterial>;
  /**
   * Model id to its materials, in the order the file connected them.
   *
   * That order is load-bearing: `LayerElementMaterial` stores an *index into this list*,
   * not an object id, so reordering it repaints the model.
   */
  readonly ofModel: ReadonlyMap<number, readonly number[]>;
  /** Every texture the file names, with bytes where it embedded them itself. */
  readonly textures: readonly AssetReference[];
}

/** The engine's own defaults, for a property a material does not state. */
const DEFAULT_COLOR: readonly [number, number, number] = [0.8, 0.8, 0.8];
const DEFAULT_ROUGHNESS = 0.4277;

/**
 * What a surface with no material at all is shaded as.
 *
 * Exported so the geometry reader has no null to branch on. A geometry can genuinely reach
 * the reader wearing nothing, and a fallback stated once here is better than the same three
 * defaults spelled out at each use, which is how two of them end up disagreeing.
 */
export const FALLBACK_MATERIAL: FbxMaterial = {
  name: '',
  color: DEFAULT_COLOR,
  specular: 0,
  roughness: DEFAULT_ROUGHNESS,
  emissive: 0,
  opacity: 1,
  reflectivity: 0,
  normalMap: -1,
  ormMap: -1,
  emissiveMap: -1,
  roughnessScale: 1,
  metallicScale: 1,
  occlusionStrength: 0,
  cutout: 0,
  emissiveColor: [-1, -1, -1],
  albedo: -1,
};

/** A record's first property, when it is a string. */
function stringChild(node: FbxNode, name: string): string | undefined {
  const value = node.children.find((child) => child.name === name)?.properties[0];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * The bytes of an embedded image, if this video carries one.
 *
 * A `Content` record with nothing in it is common and means "this image lives outside the
 * file" rather than "this image is empty", so a zero length payload has to read as absent.
 * Treating it as present embeds a zero byte texture, which decodes to nothing and takes the
 * place of the path that would have worked.
 */
function contentOf(video: FbxNode): Uint8Array | undefined {
  const value = video.children.find((child) => child.name === 'Content')?.properties[0];
  return value instanceof Uint8Array && value.length > 0 ? value : undefined;
}

function propertiesOf(node: FbxNode): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>();
  for (const child of node.children) {
    if (child.name !== 'Properties70') continue;
    for (const property of child.children) {
      const name = property.properties[0];
      if (typeof name === 'string') out.set(name, property.properties.slice(4));
    }
  }
  return out;
}

function numberAt(values: unknown[] | undefined, at: number, fallback: number): number {
  const value = values?.[at];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function triple(
  values: unknown[] | undefined,
  fallback: readonly [number, number, number],
  scale = 1,
): [number, number, number] {
  if (values === undefined) return [fallback[0], fallback[1], fallback[2]];
  return normaliseColor([
    numberAt(values, 0, fallback[0]) * scale,
    numberAt(values, 1, fallback[1]) * scale,
    numberAt(values, 2, fallback[2]) * scale,
  ]);
}

/**
 * A colour whose components exceed one is a fraction that lost its decimal point.
 *
 * Measured in the asset this was built against, which stores `silver` as
 * `815686, 815686, 815686` and `copper` as `235294, 184314, 137255`. Those are not colours
 * and they are not a scale factor either: they are `0.815686` and `0.235294, 0.184314,
 * 0.137255` written as their fractional digits alone. Every one is six digits, which is what
 * makes the repair well defined rather than a guess, and `calipers` proves the reading —
 * it stores `8, 564706, 160784`, where the `8` is `000008` with its leading zeros lost the
 * moment it was read as a number.
 *
 * **Each channel is divided by its own digit count**, because each is its own fraction. That
 * is settled by the asset rather than argued: read this way the calipers come out
 * `0.8, 0.564706, 0.160784`, a gold, and the vendor's own reference render shows gold brake
 * calipers. A shared divisor taken from the largest channel was tried first, on the theory
 * that the `8` was `000008` with its leading zeros lost, and it produces a green caliper.
 * Looking at the reference is what decided it, which is the whole lesson of this pipeline.
 *
 * A component above one is never legitimate here: FBX's `DiffuseColor` is defined over nought
 * to one, and this engine has no high dynamic range material input for it to mean instead. So
 * the test cannot fire on a colour somebody meant.
 */
function normaliseColor(color: [number, number, number]): [number, number, number] {
  const digits = (value: number): number => {
    if (!(value > 1)) return value;
    let divisor = 1;
    while (value / divisor > 1) divisor *= 10;
    return value / divisor;
  };
  return [digits(color[0]), digits(color[1]), digits(color[2])];
}

/**
 * A Phong exponent as a roughness.
 *
 * The two describe the same thing from opposite ends: the exponent says how *tightly* a
 * highlight is gathered and rises without bound, roughness says how widely it is spread over
 * nought to one. `sqrt(2 / (n + 2))` is the usual correspondence and it lands where intuition
 * expects at both ends, with a mirror-like 1000 arriving at 0.04 and a flat 2 at 0.7.
 *
 * It is an approximation between two different shading models and is stated as one. What it
 * must not do is default to zero: an unstated exponent read as a mirror makes every surface
 * in an imported scene a black mirror, which reads as a lighting fault rather than a material
 * one.
 */
/**
 * How opaque a surface is, from whichever of the two spellings a writer used.
 *
 * They mean opposite things and that is the trap: `TransparencyFactor` is how *transparent*
 * a surface is, so opacity is one minus it, while `Opacity` is already what it says. Reading
 * one as the other turns every solid surface in an export invisible, and an invisible model
 * reads as a failed load rather than as a material fault.
 *
 * Silence means opaque. Defaulting the other way would make every material in a file that
 * omits both vanish, which is most files.
 */
function opacityOf(p: Map<string, unknown[]>): number {
  const clamp = (value: number): number => Math.min(1, Math.max(0, value));
  if (p.has('TransparencyFactor')) return clamp(1 - numberAt(p.get('TransparencyFactor'), 0, 0));
  if (p.has('Opacity')) return clamp(numberAt(p.get('Opacity'), 0, 1));
  return 1;
}

function roughnessFromShininess(exponent: number): number {
  if (!(exponent > 0)) return DEFAULT_ROUGHNESS;
  return Math.min(1, Math.max(0.02, Math.sqrt(2 / (exponent + 2))));
}

/**
 * Materials, their textures, and which model wears which.
 *
 * Textures reach a material through an `OP` connection, which is FBX for "this object feeds
 * that object's *named property*" — the property being `DiffuseColor`, `NormalMap`,
 * `SpecularColor` and so on. Only the albedo is used, because it is the only one this
 * renderer has a slot for; the rest are counted and reported rather than dropped in silence,
 * so a model that looks flatter than it should says why.
 */
export function readMaterials(root: FbxNode, warnings: string[]): FbxMaterials {
  const materialNodes = new Map<number, FbxNode>();
  const textureNodes = new Map<number, FbxNode>();
  const videoNodes = new Map<number, FbxNode>();
  for (const objects of root.children.filter((child) => child.name === 'Objects')) {
    for (const node of objects.children) {
      const id = node.properties[0];
      if (typeof id !== 'number') continue;
      if (node.name === 'Material') materialNodes.set(id, node);
      else if (node.name === 'Texture') textureNodes.set(id, node);
      else if (node.name === 'Video') videoNodes.set(id, node);
    }
  }

  /*
   * Which video backs which texture, from the connection table.
   *
   * A `Media` property naming the video by string exists too and is what older writers use,
   * so it is the fallback. The connection is preferred because a name is a name and an id is
   * a fact: two videos may be called the same thing, and only one of them is connected.
   */
  const videoOfTexture = new Map<number, FbxNode>();
  for (const connections of root.children.filter((child) => child.name === 'Connections')) {
    for (const c of connections.children) {
      const [kind, from, to] = c.properties;
      if (kind !== 'OO' || typeof from !== 'number' || typeof to !== 'number') continue;
      const video = videoNodes.get(from);
      if (video !== undefined && textureNodes.has(to)) videoOfTexture.set(to, video);
    }
  }
  for (const [id, node] of textureNodes) {
    if (videoOfTexture.has(id)) continue;
    const media = stringChild(node, 'Media');
    if (media === undefined) continue;
    for (const [, video] of videoNodes) {
      if (String(video.properties[1] ?? '') === media) {
        videoOfTexture.set(id, video);
        break;
      }
    }
  }

  /*
   * Texture id to an index in the reference list, deduplicated by what it resolves to.
   *
   * **FBX embeds its images as often as it points at them**, and the two look nothing alike.
   * An embedded texture's `RelativeFilename` is `*0`, a reference into the file's own video
   * list rather than a path, and the bytes live in the matching `Video` record's `Content`.
   * Treating that as a filename produces a hunt for a file called `*0`, which fails, and a
   * model that draws untextured while the image it needs sits inside the file being read.
   */
  const textures: AssetReference[] = [];
  const candidates = new Map<number, { reference: AssetReference; key: string }>();
  for (const [id, node] of textureNodes) {
    const declared = stringChild(node, 'RelativeFilename') ?? stringChild(node, 'FileName') ?? '';
    const video = videoOfTexture.get(id);
    const content = video === undefined ? undefined : contentOf(video);

    /* An embedded image names itself by its video's filename, because `*0` names nothing. */
    const name =
      content !== undefined
        ? (stringChild(video as FbxNode, 'RelativeFilename') ??
          stringChild(video as FbxNode, 'Filename') ??
          declared)
        : declared;

    if (content === undefined && (name === '' || name.startsWith('*'))) {
      warnings.push(
        name.startsWith('*')
          ? `texture "${name}" is embedded but its image is missing from the file; it will draw untextured`
          : 'a texture record states no filename and was skipped',
      );
      continue;
    }

    /*
     * Held as a candidate, not embedded yet.
     *
     * **A file names far more textures than this renderer can use.** One test character
     * carries normal, roughness and metallic maps beside every colour map, and embedding all
     * of them produced a 401 MB asset against the 94 MB the same model makes through OBJ —
     * three quarters of it maps that were reported as ignored in the same run. Nothing was
     * wrong with the ignoring; the list was simply built from every `Texture` record rather
     * than from the ones a material actually reaches. So an entry earns its place below, when
     * something binds it.
     */
    candidates.set(id, {
      reference: content === undefined ? { name } : { name, bytes: content },
      key: content === undefined ? `path:${name}` : `embedded:${id}`,
    });
  }

  /* Which texture feeds which material, and through which of the material's properties. */
  const albedoOfMaterial = new Map<number, number>();
  const ignoredSlots = new Map<string, number>();
  /** Allocate a slot for a texture the first time something actually binds it. */
  const claim = new Map<string, number>();
  for (const connections of root.children.filter((child) => child.name === 'Connections')) {
    for (const c of connections.children) {
      const [kind, from, to, slot] = c.properties;
      if (kind !== 'OP' || typeof from !== 'number' || typeof to !== 'number') continue;
      const candidate = candidates.get(from);
      if (candidate === undefined || !materialNodes.has(to)) continue;
      if (slot !== 'DiffuseColor') {
        if (typeof slot === 'string') ignoredSlots.set(slot, (ignoredSlots.get(slot) ?? 0) + 1);
        continue;
      }
      let at = claim.get(candidate.key);
      if (at === undefined) {
        at = textures.length;
        claim.set(candidate.key, at);
        textures.push(candidate.reference);
      }
      albedoOfMaterial.set(to, at);
    }
  }
  for (const [slot, count] of ignoredSlots) {
    warnings.push(
      `${count} ${slot} texture${count === 1 ? '' : 's'} ignored; this renderer has one texture slot, for colour`,
    );
  }

  const byId = new Map<number, FbxMaterial>();
  for (const [id, node] of materialNodes) {
    const p = propertiesOf(node);
    const emissiveColor = triple(
      p.get('EmissiveColor'),
      [0, 0, 0],
      numberAt(p.get('EmissiveFactor'), 0, 1),
    );
    const emissive = Math.min(1, Math.max(emissiveColor[0], emissiveColor[1], emissiveColor[2]));
    byId.set(id, {
      name:
        typeof node.properties[1] === 'string'
          ? ((node.properties[1] as string).split('\u0000')[0] ?? '')
          : '',
      color: triple(p.get('DiffuseColor'), DEFAULT_COLOR, numberAt(p.get('DiffuseFactor'), 0, 1)),
      specular: Math.min(1, Math.max(0, numberAt(p.get('SpecularFactor'), 0, 0))),
      roughness: roughnessFromShininess(
        numberAt(p.get('ShininessExponent'), 0, numberAt(p.get('Shininess'), 0, 0)),
      ),
      /*
       * FBX states how transparent a surface is, so opacity is one minus it. Both
       * spellings are read because writers disagree, and a file that says nothing is
       * opaque rather than invisible: defaulting the other way would make every material
       * in an export that omits it disappear.
       */
      opacity: opacityOf(p),
      /* FBX states this directly, and it is the property that decides whether paint reads as
         paint. Read past until now, which is why an imported car looked flat. */
      reflectivity: Math.min(1, Math.max(0, numberAt(p.get('ReflectionFactor'), 0, 0))),
      normalMap: -1,
      ormMap: -1,
      emissiveMap: -1,
      roughnessScale: 1,
      metallicScale: 1,
      occlusionStrength: 0,
      cutout: 0,
      emissive,
      /* A negative component means "inherit the albedo", which is the engine's own default
         and the right answer for a surface that names no emissive colour of its own. */
      emissiveColor: emissive > 0 ? emissiveColor : [-1, -1, -1],
      albedo: albedoOfMaterial.get(id) ?? -1,
    });
  }

  /* Model to its materials, in file order, because that order is what an index means. */
  const ofModel = new Map<number, number[]>();
  for (const connections of root.children.filter((child) => child.name === 'Connections')) {
    for (const c of connections.children) {
      const [kind, from, to] = c.properties;
      if (kind !== 'OO' || typeof from !== 'number' || typeof to !== 'number') continue;
      if (!byId.has(from)) continue;
      const list = ofModel.get(to);
      if (list === undefined) ofModel.set(to, [from]);
      else list.push(from);
    }
  }

  return { byId, ofModel, textures };
}

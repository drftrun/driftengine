/**
 * Assetto Corsa's `.kn5`. Tier 2: a real attempt, and explicitly not a guarantee.
 *
 * The format has no published specification. What is implemented here was verified against three
 * files from a production car mod, each of which parses to *exact EOF* — a binary walk that
 * consumes a 44 MB file to its last byte has no field misread anywhere in it, because a single
 * wrong width desynchronises everything after it. That is the evidence this reader rests on, and
 * `scripts/kn5-check.mjs` re-establishes it on demand.
 *
 * **It needs nothing from its host.** A `.kn5` embeds every texture it uses, so unlike a `.gltf`
 * naming external buffers or an `.fbx` storing deflated arrays, there is no capability to inject
 * and no sidecar to resolve. It is the one binary format here that reads from bytes alone.
 *
 * It reports what the file says and corrects none of it: the frame comes back as `declaredHand`
 * and `orient.ts` is what would transform it, for the same reason every other reader here reports
 * `declaredUp` instead of standing its own models up.
 */

import { DrftError } from '@driftengine/drft';
import type { DrftMaterial, DrftNode, MeshData } from '@driftengine/drft';
import type { AssetReference } from './assetPath.ts';
import type { Handedness, UpAxis } from './orient.ts';

/** A texture the file carried inline. Every `.kn5` texture is inline; none are named only. */
export interface Kn5Texture {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** One entry of the shared material palette, as the file states it. */
export interface Kn5Material {
  readonly name: string;
  readonly shader: string;
  /**
   * 0 opaque, 1 alpha blended, 2 alpha to coverage. **The file's own statement about the pass.**
   *
   * Read where the walk previously skipped two bytes it called "the flags". Measured across a
   * shipped car and its three levels of detail plus its collider, it takes only the values the
   * format defines — 61 and 9 in the full model, 33/6, 26/3, 16/2, and one opaque collider — and
   * it agrees with the *node's* transparency flag on 171 of 172 meshes, which is the cross-check
   * that says the field is being read and not merely decoded.
   */
  readonly blendMode: number;
  /** Whether `ksAlphaRef` is a live alpha test. Zero in every file measured here. */
  readonly alphaTested: boolean;
  /** `ksDiffuse`, `ksSpecularEXP`, `ksAlphaRef` and the rest, unmapped. */
  readonly props: ReadonlyMap<string, number>;
  /** Sampler name to texture name: `txDiffuse`, `txNormal`, `txMaps`, `txDetail`. */
  readonly textures: ReadonlyMap<string, string>;
}

/** `Kn5Material.blendMode` when the surface belongs in the blended pass. */
export const KN5_ALPHA_BLEND = 1;

/**
 * A position in the file that refuses instead of running off the end.
 *
 * Every read goes through here so that a malformed file fails with an offset somebody can look
 * at, which is the whole difference between a tier 2 refusal and a parser crash.
 */
export class Cursor {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  at = 0;

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
  }

  /** Refuses when `count` bytes are not there, naming where it ran out. */
  need(count: number, what: string): void {
    if (count < 0 || this.at + count > this.bytes.length) {
      throw new DrftError(
        `kn5: ${what} runs past the end of the file at offset ${this.at} ` +
          `(wanted ${count} bytes, ${this.bytes.length - this.at} remain)`,
      );
    }
  }

  i32(what = 'an integer'): number {
    this.need(4, what);
    const value = this.view.getInt32(this.at, true);
    this.at += 4;
    return value;
  }

  u32(what = 'an integer'): number {
    this.need(4, what);
    const value = this.view.getUint32(this.at, true);
    this.at += 4;
    return value;
  }

  f32(what = 'a float'): number {
    this.need(4, what);
    const value = this.view.getFloat32(this.at, true);
    this.at += 4;
    return value;
  }

  u16(what = 'a short'): number {
    this.need(2, what);
    const value = this.view.getUint16(this.at, true);
    this.at += 2;
    return value;
  }

  u8(what = 'a byte'): number {
    this.need(1, what);
    return this.bytes[this.at++] as number;
  }

  skip(count: number, what: string): void {
    this.need(count, what);
    this.at += count;
  }

  take(count: number, what: string): Uint8Array {
    this.need(count, what);
    const slice = this.bytes.subarray(this.at, this.at + count);
    this.at += count;
    return slice;
  }

  /** i32 length, then that many UTF-8 bytes. */
  str(what = 'a name'): string {
    const length = this.i32(`the length of ${what}`);
    return new TextDecoder().decode(this.take(length, what));
  }
}

/** Bytes each material property carries after its value, and does not explain. */
const PROPERTY_TRAILER = 36;

/** What the file says before its node tree begins. */
export interface Kn5Header {
  readonly version: number;
  readonly textures: Kn5Texture[];
  readonly materials: Kn5Material[];
  /** Where the node tree starts, so the caller carries on from here. */
  readonly cursor: Cursor;
}

/**
 * The magic, the version, the texture block and the material palette.
 *
 * Split from the node walk because it is the half that is pure data: no recursion, no transforms,
 * and nothing that needs a `MeshData` to exist.
 */
export function readKn5Header(buffer: ArrayBuffer): Kn5Header {
  const cursor = new Cursor(buffer);
  cursor.need(10, 'the kn5 header');
  const magic = new TextDecoder().decode(cursor.take(6, 'the magic'));
  if (magic !== 'sc6969') {
    throw new DrftError(`kn5: this is not a kn5 file — it begins "${magic}" and not "sc6969"`);
  }
  const version = cursor.i32('the version');
  /*
   * Version 6 carries one more word here than version 5 did. It reads 0 in every file measured,
   * and it is skipped by name instead of interpreted: a field whose meaning is unknown is better
   * passed over deliberately than guessed at.
   */
  if (version > 5) cursor.i32('the version 6 extra word');

  const textures: Kn5Texture[] = [];
  const textureCount = cursor.i32('the texture count');
  for (let i = 0; i < textureCount; i++) {
    cursor.i32(`the type of texture ${i}`);
    const name = cursor.str(`the name of texture ${i}`);
    const size = cursor.i32(`the size of texture "${name}"`);
    textures.push({ name, bytes: cursor.take(size, `the bytes of texture "${name}"`) });
  }

  const materials: Kn5Material[] = [];
  const materialCount = cursor.i32('the material count');
  for (let i = 0; i < materialCount; i++) {
    const name = cursor.str(`the name of material ${i}`);
    const shader = cursor.str(`the shader of material "${name}"`);
    const blendMode = cursor.u8(`the blend mode of material "${name}"`);
    const alphaTested = cursor.u8(`the alpha test flag of material "${name}"`) !== 0;
    if (version > 4) cursor.i32(`the depth mode of material "${name}"`);

    const props = new Map<string, number>();
    const propCount = cursor.i32(`the property count of material "${name}"`);
    for (let p = 0; p < propCount; p++) {
      const property = cursor.str(`a property name of material "${name}"`);
      props.set(property, cursor.f32(`the value of "${property}"`));
      cursor.skip(PROPERTY_TRAILER, `the trailer of property "${property}"`);
    }

    const textureSlots = new Map<string, string>();
    const slotCount = cursor.i32(`the sampler count of material "${name}"`);
    for (let s = 0; s < slotCount; s++) {
      const sampler = cursor.str(`a sampler name of material "${name}"`);
      cursor.i32(`the slot of sampler "${sampler}"`);
      textureSlots.set(sampler, cursor.str(`the texture bound to "${sampler}"`));
    }

    materials.push({ name, shader, blendMode, alphaTested, props, textures: textureSlots });
  }

  return { version, textures, materials, cursor };
}

/** Node types the format defines. Anything else is a refusal, not a skip. */
const NODE_DUMMY = 1;
const NODE_MESH = 2;
const NODE_ANIMATED = 3;

/** pos[3] normal[3] uv[2] tangent[3], all f32. */
const MESH_VERTEX_BYTES = 44;
/** The same, plus weights[4] and bone indices[4]. */
const ANIMATED_VERTEX_BYTES = 76;
/** layer:u32 lodIn:f32 lodOut:f32 sphere[3]:f32 radius:f32 renderable:u8. */
const MESH_TRAILER = 29;
/** An animated mesh states a layer and a lod window and stops there. */
const ANIMATED_TRAILER = 12;

/**
 * One node of the file's own graph.
 *
 * `matrix` is the node's **local** transform, row-major with the translation in row 3, which is
 * the row-vector convention the format inherits from DirectX. The world matrix is not stored
 * here: it is accumulated during the walk and applied to the geometry, because `MESH` is
 * world-space by the rule in the design's §5.1.
 */
export interface Kn5Node {
  readonly type: number;
  readonly name: string;
  readonly parent: number;
  readonly matrix: Float32Array;
  /** Index into the returned meshes, or -1 for a node that draws nothing. */
  readonly mesh: number;
  readonly castShadows: boolean;
  readonly isVisible: boolean;
  /** The author's own statement that this surface belongs in the blended pass. */
  readonly isTransparent: boolean;
  /** Zero in every car measured; non-zero in track models. Carried, never relied upon. */
  readonly lodIn: number;
  readonly lodOut: number;
}

/** Geometry as the file stores it, already carried into world space. */
export interface Kn5Mesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly tangents: Float32Array;
  readonly indices: Uint32Array;
  /** Index into the material palette from `readKn5Header`. */
  readonly material: number;
  /** Index into the returned nodes, so a mesh can name the node that placed it. */
  readonly node: number;
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Row-vector multiply: `out = a * b`, matching how the format composes a hierarchy. */
function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[row * 4 + k] as number) * (b[k * 4 + column] as number);
      out[row * 4 + column] = sum;
    }
  }
  return out;
}

/** A point through a row-vector matrix, translation included. */
function transformPoint(
  m: Float32Array,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  return [
    x * (m[0] as number) + y * (m[4] as number) + z * (m[8] as number) + (m[12] as number),
    x * (m[1] as number) + y * (m[5] as number) + z * (m[9] as number) + (m[13] as number),
    x * (m[2] as number) + y * (m[6] as number) + z * (m[10] as number) + (m[14] as number),
  ];
}

/** A direction through the same matrix: no translation, so normals and tangents share it. */
function transformDirection(
  m: Float32Array,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  return [
    x * (m[0] as number) + y * (m[4] as number) + z * (m[8] as number),
    x * (m[1] as number) + y * (m[5] as number) + z * (m[9] as number),
    x * (m[2] as number) + y * (m[6] as number) + z * (m[10] as number),
  ];
}

/**
 * Walk the node tree depth first, which is the order the file stores it in.
 *
 * **Every node is kept, including the `AC_`-prefixed ones.** The community converter skips them,
 * correctly for its purpose, since they carry no geometry an OBJ can hold. They are placement
 * anchors and convention markers, and this reader exists to preserve exactly that.
 */
export function readKn5Nodes(header: Kn5Header): { nodes: Kn5Node[]; meshes: Kn5Mesh[] } {
  const { cursor } = header;
  const nodes: Kn5Node[] = [];
  const meshes: Kn5Mesh[] = [];
  const worlds: Float32Array[] = [];

  const readNode = (parent: number): void => {
    const startedAt = cursor.at;
    const type = cursor.i32('a node type');
    const name = cursor.str('a node name');
    const childCount = cursor.i32(`the child count of "${name}"`);
    cursor.u8(`the active flag of "${name}"`);

    let matrix = IDENTITY;
    let mesh = -1;
    let flags = { castShadows: false, isVisible: true, isTransparent: false };

    if (type === NODE_DUMMY) {
      const local = new Float32Array(16);
      for (let i = 0; i < 16; i++) local[i] = cursor.f32(`the transform of "${name}"`);
      matrix = local;
    } else if (type === NODE_MESH || type === NODE_ANIMATED) {
      flags = {
        castShadows: cursor.u8(`the shadow flag of "${name}"`) !== 0,
        isVisible: cursor.u8(`the visibility flag of "${name}"`) !== 0,
        isTransparent: cursor.u8(`the transparency flag of "${name}"`) !== 0,
      };
      if (type === NODE_ANIMATED) {
        /*
         * Bones are read past by name and count, not interpreted. No file measured contains one,
         * so a skin built from these would be a claim nothing here can support — the geometry is
         * imported and the rig is left for a file that can prove it.
         */
        const boneCount = cursor.i32(`the bone count of "${name}"`);
        for (let b = 0; b < boneCount; b++) {
          const bone = cursor.str(`a bone name of "${name}"`);
          cursor.skip(64, `the bind matrix of bone "${bone}"`);
        }
      }
      mesh = meshes.length;
    } else {
      throw new DrftError(
        `kn5: node type ${type} is not one this reader understands, at "${name}", ` +
          `offset ${startedAt}. Known types are 1 (dummy), 2 (mesh) and 3 (animated mesh).`,
      );
    }

    const index = nodes.length;
    const world = parent < 0 ? matrix : multiply(matrix, worlds[parent] as Float32Array);
    worlds.push(world);
    nodes.push({ type, name, parent, matrix, mesh, ...flags, lodIn: 0, lodOut: 0 });

    if (type === NODE_MESH || type === NODE_ANIMATED) {
      const stride = type === NODE_MESH ? MESH_VERTEX_BYTES : ANIMATED_VERTEX_BYTES;
      const vertexCount = cursor.i32(`the vertex count of "${name}"`);
      cursor.need(vertexCount * stride, `the vertices of "${name}"`);
      const positions = new Float32Array(vertexCount * 3);
      const normals = new Float32Array(vertexCount * 3);
      const uvs = new Float32Array(vertexCount * 2);
      const tangents = new Float32Array(vertexCount * 4);
      for (let v = 0; v < vertexCount; v++) {
        const [px, py, pz] = transformPoint(world, cursor.f32(), cursor.f32(), cursor.f32());
        positions[v * 3] = px;
        positions[v * 3 + 1] = py;
        positions[v * 3 + 2] = pz;
        const [nx, ny, nz] = transformDirection(world, cursor.f32(), cursor.f32(), cursor.f32());
        normals[v * 3] = nx;
        normals[v * 3 + 1] = ny;
        normals[v * 3 + 2] = nz;
        uvs[v * 2] = cursor.f32();
        /* kn5 stores v with the opposite origin from every other format here. */
        uvs[v * 2 + 1] = 1 - cursor.f32();
        const [tx, ty, tz] = transformDirection(world, cursor.f32(), cursor.f32(), cursor.f32());
        tangents[v * 4] = tx;
        tangents[v * 4 + 1] = ty;
        tangents[v * 4 + 2] = tz;
        /*
         * The file states no bitangent sign. +1 is the convention every exporter in this pipeline
         * writes, and `orient.ts` flips it where a mirror makes it wrong.
         */
        tangents[v * 4 + 3] = 1;
        if (type === NODE_ANIMATED) cursor.skip(32, `the skin weights of "${name}"`);
      }

      const indexCount = cursor.i32(`the index count of "${name}"`);
      const indices = new Uint32Array(indexCount);
      for (let i = 0; i < indexCount; i++) indices[i] = cursor.u16(`an index of "${name}"`);
      const material = cursor.i32(`the material of "${name}"`);

      let lodIn = 0;
      let lodOut = 0;
      if (type === NODE_MESH) {
        cursor.need(MESH_TRAILER, `the trailer of "${name}"`);
        cursor.u32();
        lodIn = cursor.f32();
        lodOut = cursor.f32();
        cursor.skip(16, `the bounding sphere of "${name}"`);
        cursor.u8();
      } else {
        cursor.need(ANIMATED_TRAILER, `the trailer of "${name}"`);
        cursor.u32();
        lodIn = cursor.f32();
        lodOut = cursor.f32();
      }
      nodes[index] = { ...(nodes[index] as Kn5Node), lodIn, lodOut };
      meshes.push({ positions, normals, uvs, tangents, indices, material, node: index });
    }

    for (let c = 0; c < childCount; c++) readNode(index);
  };

  readNode(-1);
  return { nodes, meshes };
}

/**
 * Shaders this reader maps deliberately. Anything else warns once, by name.
 *
 * **A list of names, and it decides nothing.** It used to carry a second list beside it — the
 * shaders whose surfaces blend — and that list was wrong about a shipped car: all four of its
 * tyres are `ksTyres`, which the list called transparent, while the file states `alphaBlendMode`
 * 0 on the material and no transparency on the node. The file is right, it says so in two places,
 * and a name is a guess where a field is a fact. So blending is read from the material now and
 * this stays only for the warning, which is the thing a name genuinely can answer: a shader
 * nobody here has seen is still geometry somebody wants.
 */
/**
 * What a tested material's alpha reference actually is, where it states zero or states none.
 *
 * **Zero means the shader's own threshold, not "discard nothing".** A material that says it is
 * alpha tested has already said that something is meant to be discarded, so a reference of zero
 * cannot be read literally without contradicting the flag beside it. Assetto Corsa's `*AT*` shaders
 * carry a built-in reference and a material overrides it by stating one; stating zero is how a
 * material says it is not overriding anything.
 *
 * **A half, because that is the convention those shaders were authored against**, and because the
 * masks in question are two-valued: a grille's hole and a seat's stitching are cut out of a texture
 * whose alpha is 0 or 255, so any threshold strictly inside the range separates them identically.
 * What would make this wrong is a material whose mask is a soft gradient, which wants blending
 * rather than a test and says so with `alphaBlendMode`.
 */
const DEFAULT_ALPHA_REFERENCE = 0.5;

function alphaReference(stated: number): number {
  return stated > 0 ? stated : DEFAULT_ALPHA_REFERENCE;
}

const KNOWN_SHADERS = new Set([
  'ksPerPixelAlpha',
  'ksWindscreen',
  'ksTyres',
  'ksTree',
  'ksGrass',
  'ksFlags',
  'ksSkidMark',
  'ksPerPixel',
  'ksPerPixelNM',
  'ksPerPixelNM_UVMult',
  'ksPerPixelReflection',
  'ksPerPixelMultiMap',
  'ksPerPixelMultiMap_NMDetail',
  'ksPerPixelSimpleRefl',
  'ksMultilayer',
  'GL',
]);

/**
 * The opacity a blended surface takes, since `.kn5` states none of its own.
 *
 * `MATL` says a surface blends by carrying an opacity below 1, and that is the only channel the
 * container has for the fact. A `.kn5` material states *whether* it blends and never by how much:
 * the alpha is per texel, in the diffuse map, and the shader multiplies `uOpacity * coverage` —
 * so a value just under 1 puts the surface in the blended pass and leaves the picture to the
 * texture, which is what the file means. It is deliberately not 0.999 arrived at from anything in
 * the file: the number is a flag, and this constant is where that is admitted.
 */
const BLENDED_OPACITY = 0.999;

/** A Blinn-Phong exponent as a roughness, which is the standard inverse. */
function roughnessFromExponent(exponent: number): number {
  if (!(exponent > 0)) return 1;
  return Math.min(1, Math.max(0, Math.sqrt(2 / (exponent + 2))));
}

/** What a `.kn5` yields, in the shape every other reader in this directory returns. */
export interface Kn5Import {
  meshes: MeshData[];
  materials: DrftMaterial[];
  textures: AssetReference[];
  nodes: Kn5Node[];
  warnings: string[];
  declaredUp: UpAxis;
  declaredHand: Handedness;
}

/**
 * Read a `.kn5` into meshes, materials and the hierarchy that placed them.
 *
 * Materials are duplicated per mesh because `MATL` is parallel to `MESH` by ordinal while `.kn5`
 * addresses a shared palette — 70 entries against 172 meshes in the car this was built against.
 * The palette entry keeps its name, so nothing is lost by the duplication.
 */
export function kn5ToMeshes(buffer: ArrayBuffer): Kn5Import {
  const head = readKn5Header(buffer);
  const { nodes, meshes: sources } = readKn5Nodes(head);

  const warnings: string[] = [];
  const textures: AssetReference[] = head.textures.map((texture) => ({
    name: texture.name,
    bytes: texture.bytes,
  }));
  const textureIndex = new Map(head.textures.map((texture, at) => [texture.name, at]));

  /** A sampler's texture as an ordinal, or -1, warning once for a name the file did not carry. */
  const bind = (material: Kn5Material, sampler: string): number => {
    const named = material.textures.get(sampler);
    if (named === undefined) return -1;
    const at = textureIndex.get(named);
    if (at === undefined) {
      warnings.push(
        `kn5: material "${material.name}" binds ${sampler} to "${named}", which the file does ` +
          'not carry. That surface loads without the map.',
      );
      return -1;
    }
    return at;
  };

  const warned = new Set<string>();
  const meshes: MeshData[] = [];
  const materials: DrftMaterial[] = [];

  for (const source of sources) {
    const node = nodes[source.node] as Kn5Node;
    const material = head.materials[source.material];
    if (material === undefined) {
      throw new DrftError(
        `kn5: "${node.name}" names material ${source.material}, and the file carries ` +
          `${head.materials.length}.`,
      );
    }

    if (!KNOWN_SHADERS.has(material.shader) && !warned.has(material.shader)) {
      warned.add(material.shader);
      warnings.push(
        `kn5: shader "${material.shader}" is not one this reader maps, so surfaces using it take ` +
          'a default. Their geometry and textures are unaffected.',
      );
    }
    if (material.textures.has('txDetail') && !warned.has('txDetail')) {
      warned.add('txDetail');
      warnings.push(
        'kn5: this model uses detail maps, a second UV layer the container carries one of. ' +
          'Those surfaces lose their close-range texture.',
      );
    }
    /*
     * Said once, because a texture that is read past in silence is the failure this reader keeps
     * making. `txMaps` is carried by nearly every AC material and none of it reaches the container.
     */
    if (material.textures.has('txMaps') && !warned.has('txMaps')) {
      warned.add('txMaps');
      warnings.push(
        "kn5: this model's materials carry `txMaps`, which is not read: its channels are specular " +
          'intensity, reflection sharpness and reflection intensity, and the container has no ' +
          'packing for those. Each surface keeps the roughness its own `ksSpecularEXP` states.',
      );
    }

    const property = (name: string, fallback: number): number =>
      material.props.get(name) ?? fallback;
    /*
     * Both statements are the file's own, so both are honoured: the material's blend mode is the
     * surface's, the node's flag is this instance's, and they agree on 171 of 172 meshes in the
     * car measured. Neither of them is `ksAlphaRef`, which is what this used to read.
     */
    const blended = material.blendMode === KN5_ALPHA_BLEND || node.isTransparent;
    const diffuse = property('ksDiffuse', 0.6);

    meshes.push({
      positions: source.positions,
      normals: source.normals,
      uvs: source.uvs,
      tangents: source.tangents,
      indices: source.indices,
      colors: new Float32Array(source.positions.length).fill(1),
      emissive: new Float32Array(source.positions.length / 3).fill(property('ksEmissive', 0)),
    });

    materials.push({
      name: material.name,
      color: [diffuse, diffuse, diffuse],
      specular: property('ksSpecular', 0.9),
      roughness: roughnessFromExponent(property('ksSpecularEXP', 1)),
      emissive: property('ksEmissive', 0),
      emissiveColor: [-1, -1, -1],
      opacity: blended ? BLENDED_OPACITY : 1,
      /*
       * **`ksAlphaRef` is an alpha test and was being read as an opacity**, so a transparent
       * material stating the 0 that means "test nothing" came out invisible: nine meshes of a
       * hundred and two on the car this was reported from, including all four tyres and all four
       * rims. It is a threshold below which a fragment is discarded, which is what `cutout` is,
       * and it only applies where the material says it is tested.
       *
       * **No file measured here sets that flag**, so this path is carried on the format's word
       * rather than on evidence — stated plainly for the same reason the bone block is read past
       * rather than interpreted. What the change fixes is not this line but the one above it.
       */
      cutout: material.alphaTested ? alphaReference(property('ksAlphaRef', 0)) : 0,
      albedo: bind(material, 'txDiffuse'),
      normalMap: bind(material, 'txNormal'),
      /*
       * **`txMaps` is deliberately not bound here, and that is the correction of a real defect.**
       *
       * It was bound as `ormMap` for as long as this reader has existed, and the cost was measured
       * from outside: every AC car's paint rendered at roughness 1.0 — the widest probe blur there
       * is — while the file said 0.180. glTF's ORM is occlusion in R, roughness in G and metallic
       * in B. Two independent references give AC's `txMaps` as specular intensity in R, reflection
       * and specular *sharpness* in G, and reflection intensity in B. Sharpness is the inverse of
       * roughness, so a G pinned at 255 — which is what three bundles' paint maps hold — is a file
       * asking for the sharpest reflection available and was being read as the bluntest.
       *
       * **The half of that which needed no reference** is the line above: `roughness` is derived
       * from `ksSpecularEXP` and is right, and the shader *replaces* it with the map's G rather
       * than scaling it. So this reader computed the correct number and then discarded it for a
       * channel whose meaning `occlusionStrength: 0` already said was not established — about R
       * alone, while G and B were consumed as if the packing were known.
       *
       * Not binding it is not a claim about what `txMaps` means. It is declining to assert a
       * packing that is not there, which is `recognise.ts`'s principle and this file's own.
       *
       * **What would reverse it:** a shader reference for `ksPerPixelMultiMap` settling the curve
       * between sharpness and roughness, at which point the map's per-texel detail is worth
       * carrying properly. `docs/IMPROVEMENTS.md` holds the measurements and both routes.
       */
      ormMap: -1,
      emissiveMap: -1,
      roughnessScale: 1,
      metallicScale: 1,
      /* Nothing is bound above, so there is no occlusion to scale either. */
      occlusionStrength: 0,
      reflectivity: property('fresnelMaxLevel', property('fresnelC', 0)),
    });
  }

  /*
   * **Right-handed, and this was measured rather than assumed.** The format is Assetto Corsa's and
   * the simulator is a DirectX title, which is why this reader first declared the frame left-handed
   * and mirrored every model it read. A consumer importing a second car found the mirror by eye —
   * a badge reading backwards — and nothing numeric had caught it, because a mirrored car has the
   * same bounds, the same triangle count and the same consistent winding as an unmirrored one.
   *
   * What settles it: the rear badge of a shipped car, rasterised out of the file with no conversion
   * at all and viewed from behind, spells the model's name forwards, and spells it backwards
   * through a negate-X. The rest of the file agrees. Up is `+y`; the front bumper, the headlights and the indicators
   * are at `+z` and the tail lamps at `−z`; and the steering wheel, the driver's seat, the door
   * the author named for the left side, the left mirror, and the driver's eye position that the
   * simulator itself reads out of the car's own configuration are all at `+x`. In a right-handed
   * frame with that up and that forward, `+x` is the car's left — so the file, read exactly as
   * stored, is a left-hand-drive car.
   */
  return { meshes, materials, textures, nodes, warnings, declaredUp: '+y', declaredHand: 'right' };
}

/**
 * Decompose each node's row-vector 4x4 into the translation, rotation and scale `DrftNode` holds.
 *
 * The container stores a hierarchy as TRS and not as a matrix, which is what lets a consumer
 * animate one channel without disturbing the other two — a wheel spins about its own axis while
 * its suspension travel writes only the translation.
 */
export function toDrftNodes(nodes: readonly Kn5Node[]): DrftNode[] {
  return nodes.map((node) => {
    const m = node.matrix;
    const axis = (row: number): [number, number, number] => [
      m[row * 4] as number,
      m[row * 4 + 1] as number,
      m[row * 4 + 2] as number,
    ];
    const length = (v: [number, number, number]): number => Math.hypot(v[0], v[1], v[2]);
    const scale: [number, number, number] = [length(axis(0)), length(axis(1)), length(axis(2))];
    /*
     * The rotation is read out of the scale-normalised basis. A zero-length axis leaves that row
     * as identity: a degenerate basis has no rotation to recover, and inventing one would be
     * worse than the identity it collapses to.
     */
    const basis = [0, 1, 2].map((row) => {
      const v = axis(row);
      const l = scale[row] as number;
      if (l === 0) return [row === 0 ? 1 : 0, row === 1 ? 1 : 0, row === 2 ? 1 : 0] as const;
      return [v[0] / l, v[1] / l, v[2] / l] as const;
    });
    const [x0, x1, x2] = basis[0] as readonly [number, number, number];
    const [y0, y1, y2] = basis[1] as readonly [number, number, number];
    const [z0, z1, z2] = basis[2] as readonly [number, number, number];
    const trace = x0 + y1 + z2;
    let rotation: [number, number, number, number];
    if (trace > 0) {
      const s = Math.sqrt(trace + 1) * 2;
      rotation = [(y2 - z1) / s, (z0 - x2) / s, (x1 - y0) / s, s / 4];
    } else if (x0 > y1 && x0 > z2) {
      const s = Math.sqrt(1 + x0 - y1 - z2) * 2;
      rotation = [s / 4, (y0 + x1) / s, (z0 + x2) / s, (y2 - z1) / s];
    } else if (y1 > z2) {
      const s = Math.sqrt(1 + y1 - x0 - z2) * 2;
      rotation = [(y0 + x1) / s, s / 4, (z1 + y2) / s, (z0 - x2) / s];
    } else {
      const s = Math.sqrt(1 + z2 - x0 - y1) * 2;
      rotation = [(z0 + x2) / s, (z1 + y2) / s, s / 4, (x1 - y0) / s];
    }
    return {
      parent: node.parent,
      translation: [m[12] as number, m[13] as number, m[14] as number],
      rotation,
      scale,
      mesh: node.mesh,
      name: node.name,
    };
  });
}

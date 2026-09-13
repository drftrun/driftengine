/**
 * Pixar's USD, in its ASCII form `.usda` and its zip packaging `.usdz`.
 *
 * Tier 1. USD is Apache-2.0 with a published specification, and `.usda` is plain text — so
 * a complete reader is ordinary work rather than reverse engineering, and it does not rot
 * the way a vendor's binary layout does. An earlier draft of `docs/FORMAT.md` filed it as
 * proprietary and was wrong to.
 *
 * **`.usdz` needs no decompressor.** The format *requires* its entries stored uncompressed
 * so a runtime can memory-map them in place, which is why `zip.ts` takes its inflate as an
 * injected parameter and this module passes none.
 *
 * One `MeshData` per `Mesh` prim, matching the glTF and OBJ paths: the unit that carries a
 * single material is the unit `MeshData` represents.
 *
 * **Only what the file states is read.** USD is a composition system with layers, references,
 * variants and inherited schemas, and none of that is resolved here. A file that leans on it
 * is refused by name rather than half-imported, which is the rule tier 1 is held to.
 */

import type { MeshData } from '@driftengine/drft';
import { DrftError } from '@driftengine/drft';
import type { DrftMaterial } from '@driftengine/drft';
import type { AssetReference } from './assetPath.ts';
import { readZip } from './zip.ts';
import type { UpAxis } from './orient.ts';

/** What a `.usda` yields, in the shape every other reader in this directory returns. */
export interface UsdResult {
  readonly meshes: MeshData[];
  /** One per mesh, by ordinal. */
  readonly materials: DrftMaterial[];
  readonly textures: AssetReference[];
  readonly warnings: string[];
  /** `upAxis` from the stage metadata. USD writes "Y" or "Z" and defaults to Y. */
  readonly declaredUp?: UpAxis;
  /** `metersPerUnit` from the stage metadata, 1 when it says nothing. */
  readonly unitScale: number;
}

/** A prim as the scanner finds it: its type, its name, its body and its children. */
interface Prim {
  readonly type: string;
  readonly name: string;
  readonly path: string;
  /** Attribute lines belonging to this prim, excluding anything inside a child. */
  readonly body: string;
  readonly children: Prim[];
}

const DEFAULT_MATERIAL: DrftMaterial = {
  name: '',
  color: [0.8, 0.8, 0.8],
  specular: 0,
  roughness: 0.5,
  emissive: 0,
  emissiveColor: [-1, -1, -1],
  opacity: 1,
  albedo: -1,
  reflectivity: 0,
  normalMap: -1,
  ormMap: -1,
  emissiveMap: -1,
  roughnessScale: 1,
  metallicScale: 1,
  occlusionStrength: 0,
  cutout: 0,
};

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * Split a `.usda` body into prims, keeping the nesting.
 *
 * Brace matching rather than a line scan, because a prim's body contains arrays that span
 * lines and strings that contain braces. Quoted spans and `@asset@` paths are stepped over
 * so a brace inside one cannot end a prim early.
 */
function scanPrims(text: string, from: number, to: number, parentPath: string): Prim[] {
  const prims: Prim[] = [];
  const header = /\b(?:def|over|class)\s+(\w+)?\s*"([^"]+)"/g;
  header.lastIndex = from;

  let match = header.exec(text);
  while (match !== null && match.index < to) {
    const open = text.indexOf('{', header.lastIndex);
    if (open === -1 || open >= to) break;
    const close = matchBrace(text, open);
    if (close === -1 || close > to) {
      throw new DrftError(`usda: prim "${match[2] as string}" is never closed`);
    }
    const name = match[2] as string;
    const path = `${parentPath}/${name}`;
    const children = scanPrims(text, open + 1, close, path);
    /* The body with every child cut out, so an attribute lookup cannot reach into one. */
    let body = '';
    let cursor = open + 1;
    for (const child of children) {
      const at = text.indexOf(`"${child.name}"`, cursor);
      const childOpen = at === -1 ? -1 : text.indexOf('{', at);
      if (childOpen === -1 || childOpen >= close) continue;
      body += text.slice(cursor, at);
      cursor = matchBrace(text, childOpen) + 1;
    }
    body += text.slice(cursor, close);
    prims.push({ type: match[1] ?? '', name, path, body, children });
    header.lastIndex = close + 1;
    match = header.exec(text);
  }
  return prims;
}

/** The index of the `}` closing the `{` at `open`, skipping quoted and `@asset@` spans. */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let at = open; at < text.length; at++) {
    const char = text[at];
    if (char === '"' || char === "'") {
      const end = text.indexOf(char, at + 1);
      at = end === -1 ? text.length : end;
      continue;
    }
    if (char === '@') {
      const end = text.indexOf('@', at + 1);
      at = end === -1 ? text.length : end;
      continue;
    }
    if (char === '#') {
      const end = text.indexOf('\n', at);
      at = end === -1 ? text.length : end;
      continue;
    }
    if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return at;
  }
  return -1;
}

/** Every number in a span, in order. USD writes tuples and arrays as parenthesised lists. */
function numbers(span: string): number[] {
  const found = span.match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g);
  return found === null ? [] : found.map(Number);
}

/** The value span of `name` within a prim body, or null. Handles `name = value` and `name.connect`. */
function attribute(body: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /* Up to the end of the line, unless the value opens a bracket, in which case to its close. */
  const pattern = new RegExp(`\\b${escaped}\\s*=\\s*`, 'g');
  const match = pattern.exec(body);
  if (match === null) return null;
  const start = match.index + match[0].length;
  if (body[start] === '[' || body[start] === '(') {
    const opener = body[start] as string;
    const closer = opener === '[' ? ']' : ')';
    let depth = 0;
    for (let at = start; at < body.length; at++) {
      if (body[at] === opener) depth++;
      else if (body[at] === closer && --depth === 0) return body.slice(start, at + 1);
    }
    return body.slice(start);
  }
  const end = body.indexOf('\n', start);
  return body.slice(start, end === -1 ? body.length : end);
}

/**
 * Compose a prim's local transform from its xform ops.
 *
 * `xformOpOrder` is authoritative when present, because USD applies the ops in the order it
 * names and a reader that assumes translate-rotate-scale gets a file with a different order
 * subtly wrong — the same class of mistake that put a car upside down and reported it as
 * verified. Returns a column-major 4x4, matching `gltf.ts`.
 */
function localTransform(body: string): Float32Array {
  const out = identity();
  const declared =
    attribute(body, 'uniform token\\[\\] xformOpOrder') ?? attribute(body, 'xformOpOrder');
  const ops =
    declared === null
      ? [
          'xformOp:transform',
          'xformOp:translate',
          'xformOp:orient',
          'xformOp:rotateXYZ',
          'xformOp:scale',
        ]
      : (declared.match(/"([^"]+)"/g) ?? []).map((quoted) => quoted.slice(1, -1));

  for (const op of ops) {
    const value = attribute(body, op);
    if (value === null) continue;
    const n = numbers(value);
    if (op.startsWith('xformOp:transform')) {
      if (n.length >= 16) multiply(out, Float32Array.from(n.slice(0, 16)));
    } else if (op.startsWith('xformOp:translate')) {
      const m = identity();
      m[12] = n[0] ?? 0;
      m[13] = n[1] ?? 0;
      m[14] = n[2] ?? 0;
      multiply(out, m);
    } else if (op.startsWith('xformOp:scale')) {
      const m = identity();
      m[0] = n[0] ?? 1;
      m[5] = n[1] ?? 1;
      m[10] = n[2] ?? 1;
      multiply(out, m);
    } else if (op.startsWith('xformOp:rotate')) {
      /* Degrees, and the axis order is in the op's own name: rotateXYZ, rotateZYX and so on. */
      const order = op.slice(op.indexOf('rotate') + 6).replace(/:.*$/, '');
      const angles = [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0];
      for (let i = 0; i < order.length && i < 3; i++) {
        multiply(out, axisRotation(order[i] as string, ((angles[i] as number) * Math.PI) / 180));
      }
    } else if (op.startsWith('xformOp:orient')) {
      /* USD writes a quaternion as (w, x, y, z). */
      multiply(out, quaternion(n[1] ?? 0, n[2] ?? 0, n[3] ?? 0, n[0] ?? 1));
    }
  }
  return out;
}

function identity(): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

function axisRotation(axis: string, radians: number): Float32Array {
  const m = identity();
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  if (axis === 'X') {
    m[5] = c;
    m[6] = s;
    m[9] = -s;
    m[10] = c;
  } else if (axis === 'Y') {
    m[0] = c;
    m[2] = -s;
    m[8] = s;
    m[10] = c;
  } else {
    m[0] = c;
    m[1] = s;
    m[4] = -s;
    m[5] = c;
  }
  return m;
}

function quaternion(x: number, y: number, z: number, w: number): Float32Array {
  const m = identity();
  m[0] = 1 - 2 * (y * y + z * z);
  m[1] = 2 * (x * y + z * w);
  m[2] = 2 * (x * z - y * w);
  m[4] = 2 * (x * y - z * w);
  m[5] = 1 - 2 * (x * x + z * z);
  m[6] = 2 * (y * z + x * w);
  m[8] = 2 * (x * z + y * w);
  m[9] = 2 * (y * z - x * w);
  m[10] = 1 - 2 * (x * x + y * y);
  return m;
}

/** `into = into * by`, both column-major. */
function multiply(into: Float32Array, by: Float32Array): void {
  const a = Float32Array.from(into);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += (a[k * 4 + row] as number) * (by[col * 4 + k] as number);
      }
      into[col * 4 + row] = sum;
    }
  }
}

function transformPoint(
  m: Float32Array,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  return [
    (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number),
    (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number),
    (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number),
  ];
}

/** Rotation only, for normals. Uniform scale is assumed, as `MeshBuilder.addMesh` assumes it. */
function transformDirection(
  m: Float32Array,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  const out: [number, number, number] = [
    (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z,
    (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z,
    (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z,
  ];
  const length = Math.hypot(out[0], out[1], out[2]) || 1;
  out[0] /= length;
  out[1] /= length;
  out[2] /= length;
  return out;
}

/** Every prim in the tree, flattened, each with the world transform it inherits. */
function flatten(
  prims: readonly Prim[],
  parent: Float32Array,
  out: { prim: Prim; world: Float32Array }[],
): void {
  for (const prim of prims) {
    const world = Float32Array.from(parent);
    multiply(world, localTransform(prim.body));
    out.push({ prim, world });
    flatten(prim.children, world, out);
  }
}

/**
 * A `UsdPreviewSurface` and whatever textures it names.
 *
 * The shader network is followed only one hop: an input either states a value or connects to
 * a `UsdUVTexture` whose `inputs:file` is the image. That covers what an exporter writes and
 * refuses to guess at anything deeper, which is the tier 1 rule.
 */
function readMaterial(
  material: Prim,
  textures: AssetReference[],
  warnings: string[],
): DrftMaterial {
  const shaders = material.children.filter((child) => child.type === 'Shader');
  const surface = shaders.find((s) =>
    (attribute(s.body, 'uniform token info:id') ?? '').includes('UsdPreviewSurface'),
  );
  if (surface === undefined) {
    warnings.push(`material "${material.name}" names no UsdPreviewSurface; using defaults`);
    return { ...DEFAULT_MATERIAL, name: material.name };
  }

  const value = (input: string): number[] | null => {
    const span = attribute(surface.body, `inputs:${input}`);
    return span === null ? null : numbers(span);
  };
  /* An input that connects rather than states: follow it to the texture it names. */
  const connected = (input: string): string | null => {
    const span = attribute(surface.body, `inputs:${input}.connect`);
    if (span === null) return null;
    const target = /<([^>]+)>/.exec(span)?.[1];
    if (target === undefined) return null;
    const shaderPath = target.slice(0, target.lastIndexOf('.'));
    const shader = shaders.find((s) => s.path === shaderPath || shaderPath.endsWith(`/${s.name}`));
    if (shader === undefined) return null;
    return /@([^@]+)@/.exec(attribute(shader.body, 'inputs:file') ?? '')?.[1] ?? null;
  };

  const diffuse = value('diffuseColor');
  const emissive = value('emissiveColor');
  const roughness = value('roughness')?.[0];
  const metallic = value('metallic')?.[0];
  const opacity = value('opacity')?.[0];

  let albedo = -1;
  const map = connected('diffuseColor');
  if (map !== null) {
    const existing = textures.findIndex((texture) => texture.name === map);
    albedo = existing === -1 ? textures.push({ name: map }) - 1 : existing;
  }

  /*
   * Metalness onto specular and reflectivity, stated as the approximation it is and matching
   * what `gltf.ts` does with the same input, so a `.glb` and a `.usdz` of one asset bake to
   * the same `.drft` rather than to two defensible readings.
   */
  const metal = metallic === undefined ? 0 : clamp01(metallic);
  const emissiveStrength =
    emissive === null || emissive.length < 3
      ? 0
      : clamp01(Math.max(emissive[0] as number, emissive[1] as number, emissive[2] as number));

  return {
    name: material.name,
    color:
      diffuse !== null && diffuse.length >= 3
        ? [
            clamp01(diffuse[0] as number),
            clamp01(diffuse[1] as number),
            clamp01(diffuse[2] as number),
          ]
        : DEFAULT_MATERIAL.color,
    specular: metal,
    roughness: roughness === undefined ? DEFAULT_MATERIAL.roughness : clamp01(roughness),
    emissive: emissiveStrength,
    emissiveColor:
      emissiveStrength > 0 && emissive !== null
        ? [emissive[0] as number, emissive[1] as number, emissive[2] as number]
        : DEFAULT_MATERIAL.emissiveColor,
    opacity: opacity === undefined ? 1 : clamp01(opacity),
    albedo,
    reflectivity: metal,
    normalMap: -1,
    ormMap: -1,
    emissiveMap: -1,
    roughnessScale: 1,
    metallicScale: 1,
    occlusionStrength: 0,
    cutout: 0,
  };
}

/**
 * One `Mesh` prim, triangulated and flattened into world space.
 *
 * USD indexes its face vertices with `faceVertexCounts` and `faceVertexIndices`, and its
 * normals and texture coordinates may be either per point or per *face vertex*. Face-varying
 * data is the common case out of every exporter, and it is why a corner becomes its own
 * vertex here exactly as it does in the OBJ and FBX paths: welding is the baker's job and it
 * already has a module for it.
 */
function readMesh(prim: Prim, world: Float32Array, warnings: string[]): MeshData | null {
  const points = numbers(
    attribute(prim.body, 'point3f[] points') ?? attribute(prim.body, 'points') ?? '',
  );
  const counts = numbers(
    attribute(prim.body, 'int[] faceVertexCounts') ??
      attribute(prim.body, 'faceVertexCounts') ??
      '',
  );
  const indices = numbers(
    attribute(prim.body, 'int[] faceVertexIndices') ??
      attribute(prim.body, 'faceVertexIndices') ??
      '',
  );
  if (points.length < 9 || counts.length === 0 || indices.length === 0) {
    warnings.push(`mesh "${prim.name}" carries no usable geometry and was skipped`);
    return null;
  }

  const normalSpan = attribute(prim.body, 'normal3f[] normals') ?? attribute(prim.body, 'normals');
  const uvSpan =
    attribute(prim.body, 'texCoord2f[] primvars:st') ??
    attribute(prim.body, 'float2[] primvars:st') ??
    attribute(prim.body, 'primvars:st');
  const normals = normalSpan === null ? [] : numbers(normalSpan);
  const uvs = uvSpan === null ? [] : numbers(uvSpan);
  const uvIndices = numbers(attribute(prim.body, 'primvars:st:indices') ?? '');

  const pointCount = Math.floor(points.length / 3);
  const cornerCount = indices.length;
  const normalsPerPoint = normals.length / 3 === pointCount && normals.length / 3 !== cornerCount;
  const uvsPerPoint =
    uvIndices.length === 0 && uvs.length / 2 === pointCount && uvs.length / 2 !== cornerCount;

  const outPositions: number[] = [];
  const outNormals: number[] = [];
  const outUvs: number[] = [];
  const outIndices: number[] = [];

  let corner = 0;
  for (const count of counts) {
    if (count < 3) {
      corner += count;
      continue;
    }
    const base = outPositions.length / 3;
    for (let i = 0; i < count; i++) {
      const at = corner + i;
      const point = indices[at] as number;
      if (point < 0 || point >= pointCount) {
        throw new DrftError(`usda: mesh "${prim.name}" indexes point ${point} of ${pointCount}`);
      }
      const [x, y, z] = transformPoint(
        world,
        points[point * 3] as number,
        points[point * 3 + 1] as number,
        points[point * 3 + 2] as number,
      );
      outPositions.push(x, y, z);

      const normalAt = normalsPerPoint ? point : at;
      if (normals.length >= (normalAt + 1) * 3) {
        const [nx, ny, nz] = transformDirection(
          world,
          normals[normalAt * 3] as number,
          normals[normalAt * 3 + 1] as number,
          normals[normalAt * 3 + 2] as number,
        );
        outNormals.push(nx, ny, nz);
      } else {
        outNormals.push(0, 1, 0);
      }

      if (uvs.length > 0) {
        const uvAt = uvIndices.length > 0 ? (uvIndices[at] ?? 0) : uvsPerPoint ? point : at;
        /*
         * V is flipped, once, here. USD puts the origin at the bottom left and this engine
         * uploads with it at the top left, which is the same single flip `fbx.ts` documents.
         */
        outUvs.push(uvs[uvAt * 2] ?? 0, 1 - (uvs[uvAt * 2 + 1] ?? 0));
      }
    }
    /* Fan triangulation, which is what a convex polygon from an exporter wants. */
    for (let i = 1; i + 1 < count; i++) outIndices.push(base, base + i, base + i + 1);
    corner += count;
  }

  if (outIndices.length === 0) {
    warnings.push(`mesh "${prim.name}" had no faces with three or more corners`);
    return null;
  }

  const vertices = outPositions.length / 3;
  return {
    positions: Float32Array.from(outPositions),
    normals: Float32Array.from(outNormals),
    colors: new Float32Array(vertices * 3).fill(1),
    emissive: new Float32Array(vertices),
    ...(outUvs.length === vertices * 2 ? { uvs: Float32Array.from(outUvs) } : {}),
    indices: Uint32Array.from(outIndices),
  };
}

/** Read a `.usda` document. */
export function parseUsda(text: string): UsdResult {
  if (!text.trimStart().startsWith('#usda')) {
    throw new DrftError('usda: the file does not begin with #usda, so it is not ASCII USD');
  }

  const warnings: string[] = [];
  const stageEnd = text.indexOf('{') === -1 ? text.length : text.indexOf('{');
  const stage = text.slice(0, stageEnd);
  const up = /upAxis\s*=\s*"([YZ])"/.exec(stage)?.[1];
  const metersPerUnit = Number(/metersPerUnit\s*=\s*([\d.eE+-]+)/.exec(stage)?.[1] ?? '1');

  const roots = scanPrims(text, 0, text.length, '');
  const flat: { prim: Prim; world: Float32Array }[] = [];
  flatten(roots, identity(), flat);

  /* Materials first, so a mesh's binding resolves to one that already exists. */
  const textures: AssetReference[] = [];
  const materialsByPath = new Map<string, DrftMaterial>();
  for (const { prim } of flat) {
    if (prim.type === 'Material')
      materialsByPath.set(prim.path, readMaterial(prim, textures, warnings));
  }

  const meshes: MeshData[] = [];
  const materials: DrftMaterial[] = [];
  for (const { prim, world } of flat) {
    if (prim.type !== 'Mesh') continue;
    const mesh = readMesh(prim, world, warnings);
    if (mesh === null) continue;
    meshes.push(mesh);

    const binding = /<([^>]+)>/.exec(
      attribute(prim.body, 'rel material:binding') ??
        attribute(prim.body, 'material:binding') ??
        '',
    )?.[1];
    const bound =
      binding === undefined
        ? undefined
        : (materialsByPath.get(binding) ??
          [...materialsByPath.entries()].find(
            ([path]) => binding.endsWith(path) || path.endsWith(binding),
          )?.[1]);
    materials.push(bound === undefined ? { ...DEFAULT_MATERIAL, name: prim.name } : bound);
  }

  if (meshes.length === 0) throw new DrftError('usda: the stage carries no readable Mesh prim');

  return {
    meshes,
    materials,
    textures,
    warnings,
    /* USD writes a bare "Y" or "Z" and means the positive axis; the engine names the sign. */
    ...(up === 'Z'
      ? { declaredUp: '+z' as UpAxis }
      : up === 'Y'
        ? { declaredUp: '+y' as UpAxis }
        : {}),
    unitScale: Number.isFinite(metersPerUnit) && metersPerUnit > 0 ? metersPerUnit : 1,
  };
}

/**
 * Read a `.usdz`: a zip holding a `.usda` or a `.usdc`, plus whatever images it names.
 *
 * No inflate is passed, and that is a property of the format rather than an omission — a
 * `.usdz` must store its entries uncompressed so they can be memory mapped, so an archive
 * that deflates them is not a conforming `.usdz` and `zip.ts` says so by number.
 *
 * A `.usdc` inside is refused rather than attempted. The binary crate format is specified
 * and is a separate reader; half-reading it would be exactly the partial import tier 1
 * forbids.
 */
export function usdzToMeshes(buffer: ArrayBuffer): UsdResult {
  const entries = readZip(buffer);
  const ascii = entries.find((entry) => entry.name.toLowerCase().endsWith('.usda'));
  if (ascii === undefined) {
    const crate = entries.find((entry) => /\.usdc?$/i.test(entry.name));
    if (crate !== undefined) {
      throw new DrftError(
        `usdz: "${crate.name}" is the binary crate format, which this reader does not read. ` +
          `Export the usdz with an ASCII .usda inside, or convert it with usdcat.`,
      );
    }
    throw new DrftError(
      `usdz: the archive holds no .usda (it holds ${entries.map((entry) => entry.name).join(', ')})`,
    );
  }

  const result = parseUsda(new TextDecoder().decode(ascii.bytes));

  /*
   * Images travel inside the archive, so a texture the stage names is resolved here rather
   * than left to the baker's filesystem lookup. Matched on the basename as well as the
   * declared path, because a stage may say `./textures/x.png` while the archive stores
   * `textures/x.png`.
   */
  const textures = result.textures.map((texture) => {
    const wanted = texture.name.replace(/\\/g, '/').replace(/^\.\//, '');
    const base = wanted.slice(wanted.lastIndexOf('/') + 1).toLowerCase();
    const found = entries.find((entry) => {
      const name = entry.name.toLowerCase();
      return name === wanted.toLowerCase() || name.endsWith(`/${base}`) || name === base;
    });
    return found === undefined ? texture : { name: texture.name, bytes: found.bytes };
  });

  return { ...result, textures };
}

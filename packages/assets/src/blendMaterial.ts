/**
 * What a `.blend` material's node graph says each surface channel is: a value, or a channel of an
 * image times a value.
 *
 * **One reading, two consumers.** `blendGltf.ts` turns a `BlendSurface` into a glTF material, the
 * way Blender's glTF exporter would; a bake that composes its own images reads the same surface
 * and can pack channels glTF cannot, such as roughness and metallic drawn from two images. So the
 * graph is walked once, here, into channels, and what glTF can and cannot hold is decided later.
 *
 * **The patterns are the ones Blender itself writes**, because those are the graphs real files
 * carry: Blender's glTF importer builds exactly this wiring — an image straight into a socket, a
 * Separate Color between an image and roughness, metallic or occlusion, a Math Multiply for a
 * factor, a Normal Map node, a Mapping node for a texture transform, and a "glTF Material Output"
 * group for occlusion — and so does a person wiring a Principled BSDF by hand. Reroutes are
 * walked through. A city assembled from imported assets used nothing else in 1,809 materials.
 *
 * **What it cannot read it names**, in `approximations`, and uses the socket's own value: a
 * procedural texture, a Mix Shader, a math chain, a bump node.
 *
 * Old files mean what Blender makes of them now: a material saved before 4.2 has its blend mode
 * from `blend_method`, which is what Blender converts on opening, and one with no node tree is its
 * viewport colour, metallic and roughness.
 */

import type { BlendStruct } from './blendData.ts';
import type { Mat4 } from './blendMatrix.ts';
import { eulerMatrix, compose, invert, multiply } from './blendMatrix.ts';

/** A channel of an image, as a socket reads it. */
export interface ChannelSource {
  readonly image: BlendStruct;
  /** `rgb` for a colour socket; one channel for a scalar socket. */
  readonly channel: 'rgb' | 'r' | 'g' | 'b' | 'a';
}

/** A material's surface, channel by channel. Factors multiply the map where there is one. */
export interface BlendSurface {
  readonly name: string;
  readonly baseColor: [number, number, number];
  readonly baseColorMap: ChannelSource | null;
  readonly alpha: number;
  readonly alphaMap: ChannelSource | null;
  readonly alphaMode: 'OPAQUE' | 'BLEND' | 'MASK';
  readonly alphaCutoff: number;
  /** The colour attribute the base colour is multiplied by: a name, `''` for the render one. */
  readonly vertexColor: string | null;
  readonly metallic: number;
  readonly metallicMap: ChannelSource | null;
  readonly roughness: number;
  readonly roughnessMap: ChannelSource | null;
  readonly occlusionMap: ChannelSource | null;
  readonly normalMap: ChannelSource | null;
  readonly normalStrength: number;
  readonly emission: [number, number, number];
  readonly emissionStrength: number;
  readonly emissionMap: ChannelSource | null;
  readonly transmission: number;
  readonly doubleSided: boolean;
  /** The UV map the maps read, by name, or null for the render map. */
  readonly uvMap: string | null;
  /** A 3x3 affine transform of that map, column-major, in Blender's UV space, or null. */
  readonly uvTransform: number[] | null;
  readonly extras: Record<string, unknown> | null;
  /**
   * What glTF cannot say about this material by either route: a procedural texture, a Mix Shader,
   * a math chain. Blender's exporter loses these too, so they are warnings and not a reason to ask it.
   */
  readonly approximations: readonly string[];
}

const NODE_DO_OUTPUT = 1 << 6;
const NODE_MUTED = 1 << 9;
const NODE_LINK_MUTED = 1 << 4;
const MA_BL_CULL_BACKFACE = 1 << 2;
const MA_BM_SOLID = 0;
const MA_BM_CLIP = 3;
const RENDER_BLENDED = 1;
const SOCK_FLOAT = 0;
const SOCK_RGBA = 2;
const MA_RAMP_MULT = 2;
/* Math node operations, by the number `custom1` stores. */
const MATH_SUBTRACT = 1;
const MATH_MULTIPLY = 2;
const MATH_ROUND = 14;
const MATH_LESS_THAN = 15;
const MATH_GREATER_THAN = 16;
/* Mapping node vector types. */
const MAPPING_POINT = 0;
const MAPPING_TEXTURE = 1;

interface Link {
  readonly node: BlendStruct;
  readonly socket: string;
}

const idname = (node: BlendStruct): string => node.string('idname');

/** A node graph, indexed for following links backwards from an input. */
class Graph {
  readonly nodes: BlendStruct[];
  private readonly into = new Map<string, Link>();

  constructor(tree: BlendStruct) {
    this.nodes = tree.list('nodes');
    for (const link of tree.list('links')) {
      if ((link.int('flag') & NODE_LINK_MUTED) !== 0) continue;
      const to = link.deref('tonode');
      const toSocket = link.deref('tosock');
      const from = link.deref('fromnode');
      const fromSocket = link.deref('fromsock');
      if (to === null || toSocket === null || from === null || fromSocket === null) continue;
      this.into.set(`${to.offset}:${toSocket.string('identifier')}`, {
        node: from,
        socket: fromSocket.string('identifier'),
      });
    }
  }

  /** The link into an input, walked back through reroutes, which forward their one input. */
  private follow(link: Link | null): Link | null {
    let current = link;
    for (
      let hops = 0;
      current !== null && idname(current.node) === 'NodeReroute' && hops < 64;
      hops++
    ) {
      current = this.into.get(`${current.node.offset}:Input`) ?? null;
    }
    return current;
  }

  input(
    node: BlendStruct,
    ...identifiers: string[]
  ): { socket: BlendStruct | null; link: Link | null } {
    for (const socket of node.list('inputs')) {
      const id = socket.string('identifier');
      if (!identifiers.includes(id) && !identifiers.includes(socket.string('name'))) continue;
      return { socket, link: this.follow(this.into.get(`${node.offset}:${id}`) ?? null) };
    }
    return { socket: null, link: null };
  }

  /** The `index`-th input socket of a node, by position. */
  at(node: BlendStruct, index: number): { socket: BlendStruct | null; link: Link | null } {
    const socket = node.list('inputs')[index] ?? null;
    if (socket === null) return { socket: null, link: null };
    return {
      socket,
      link: this.follow(this.into.get(`${node.offset}:${socket.string('identifier')}`) ?? null),
    };
  }
}

function socketValue(socket: BlendStruct | null): number[] | null {
  if (socket === null) return null;
  const type = socket.int('type');
  const value = socket.deref(
    'default_value',
    type === SOCK_RGBA
      ? 'bNodeSocketValueRGBA'
      : type === SOCK_FLOAT
        ? 'bNodeSocketValueFloat'
        : 'bNodeSocketValueVector',
  );
  if (value === null) return null;
  return type === SOCK_FLOAT ? [value.float('value')] : value.floats('value');
}

const scalarOf = (input: { socket: BlendStruct | null }, fallback: number): number =>
  socketValue(input.socket)?.[0] ?? fallback;

/** The material's active output, the one Blender would render with EEVEE. */
function outputNode(graph: Graph): BlendStruct | null {
  const outputs = graph.nodes.filter((node) => idname(node) === 'ShaderNodeOutputMaterial');
  return (
    outputs.find(
      (node) => (node.int('flag') & NODE_DO_OUTPUT) !== 0 && node.int('custom1') !== 2,
    ) ??
    outputs.find((node) => node.int('custom1') !== 2) ??
    null
  );
}

/** A source traced back from a socket: an image channel times a factor, or a constant. */
interface Traced {
  map: ChannelSource | null;
  factor: number[] | null;
  attribute: string | null;
}

class Reader {
  readonly approximations: string[] = [];
  uvMap: string | null = null;
  uvTransform: number[] | null = null;
  private uvSeen = false;

  constructor(
    private readonly graph: Graph,
    private readonly name: string,
  ) {}

  note(what: string): void {
    this.approximations.push(`material "${this.name}": ${what}`);
  }

  /** A colour socket: a constant, an image, an image times a constant, or a colour attribute. */
  colour(node: BlendStruct, ids: string[], label: string): Traced {
    const { socket, link } = this.graph.input(node, ...ids);
    if (link === null) return { map: null, factor: socketValue(socket), attribute: null };
    return this.traceColour(link, label);
  }

  traceColour(link: Link, label: string): Traced {
    const kind = idname(link.node);
    if (kind === 'ShaderNodeTexImage')
      return {
        map: this.image(link.node, link.socket === 'Alpha' ? 'a' : 'rgb'),
        factor: null,
        attribute: null,
      };
    if (kind === 'ShaderNodeVertexColor' || kind === 'ShaderNodeAttribute') {
      const storage = link.node.blockOf('storage') === null ? null : link.node.deref('storage');
      const layer =
        storage?.has('layer_name') === true
          ? storage.string('layer_name')
          : storage?.has('name') === true
            ? storage.string('name')
            : '';
      return { map: null, factor: null, attribute: layer };
    }
    if (kind === 'ShaderNodeMix' || kind === 'ShaderNodeMixRGB') {
      /* The legacy node keeps its blend mode in `custom1`; its successor keeps mode and type in storage. */
      const storage = kind === 'ShaderNodeMix' ? link.node.deref('storage', 'NodeShaderMix') : null;
      const multiply =
        kind === 'ShaderNodeMixRGB'
          ? link.node.int('custom1') === MA_RAMP_MULT
          : storage !== null &&
            storage.int('data_type') === SOCK_RGBA &&
            storage.int('blend_type') === MA_RAMP_MULT;
      const fac = scalarOf(this.graph.input(link.node, 'Factor_Float', 'Fac'), 1);
      if (multiply && fac === 1) {
        const sides = [
          this.graph.input(link.node, 'A_Color', 'Color1'),
          this.graph.input(link.node, 'B_Color', 'Color2'),
        ].map((side) =>
          side.link === null
            ? { map: null, factor: socketValue(side.socket), attribute: null }
            : this.traceColour(side.link, label),
        );
        const maps = sides.filter((s) => s.map !== null);
        if (maps.length > 1)
          this.note(`its ${label} multiplies two images, and only the first is kept`);
        const factors = sides.map((s) => s.factor).filter((f): f is number[] => f !== null);
        const factor =
          factors.length === 0 ? null : factors.reduce((a, b) => a.map((v, i) => v * (b[i] ?? 1)));
        return {
          map: maps[0]?.map ?? null,
          factor,
          attribute: sides.find((s) => s.attribute !== null)?.attribute ?? null,
        };
      }
    }
    this.note(
      `its ${label} comes from ${kind}, which glTF cannot express, so the socket's own value is used`,
    );
    return { map: null, factor: null, attribute: null };
  }

  /** A scalar socket: a constant, or one channel of an image times a constant. */
  scalar(
    node: BlendStruct,
    ids: string[],
    label: string,
    fallback: number,
  ): { value: number; map: ChannelSource | null } {
    const input = this.graph.input(node, ...ids);
    if (input.link === null) return { value: scalarOf(input, fallback), map: null };
    return this.traceScalar(input.link, label, fallback);
  }

  traceScalar(
    link: Link,
    label: string,
    fallback: number,
  ): { value: number; map: ChannelSource | null } {
    const kind = idname(link.node);
    if (kind === 'ShaderNodeSeparateColor' || kind === 'ShaderNodeSeparateRGB') {
      const channel = ({ Red: 'r', R: 'r', Green: 'g', G: 'g', Blue: 'b', B: 'b' } as const)[
        link.socket as 'Red'
      ];
      const source = this.graph.input(link.node, 'Color', 'Image').link;
      if (
        channel !== undefined &&
        source !== null &&
        idname(source.node) === 'ShaderNodeTexImage'
      ) {
        return { value: 1, map: this.image(source.node, channel) };
      }
    } else if (kind === 'ShaderNodeTexImage') {
      /* A grey image straight into a scalar: its colour is read as one channel, the first. */
      return { value: 1, map: this.image(link.node, link.socket === 'Alpha' ? 'a' : 'r') };
    } else if (kind === 'ShaderNodeMath' && link.node.int('custom1') === MATH_MULTIPLY) {
      const a = this.graph.at(link.node, 0);
      const b = this.graph.at(link.node, 1);
      const constant = a.link === null ? a : b.link === null ? b : null;
      const other = constant === a ? b : a;
      if (constant !== null && other.link !== null) {
        const inner = this.traceScalar(other.link, label, fallback);
        return { value: inner.value * scalarOf(constant, 1), map: inner.map };
      }
      if (a.link === null && b.link === null)
        return { value: scalarOf(a, 1) * scalarOf(b, 1), map: null };
    }
    this.note(
      `its ${label} comes from ${kind}, which glTF cannot express, so the socket's own value is used`,
    );
    return { value: fallback, map: null };
  }

  /** An image node's picture, and the UV map and transform it is placed by. */
  image(node: BlendStruct, channel: ChannelSource['channel']): ChannelSource | null {
    const image = node.deref('id');
    if (image === null) return null;
    const placement = this.placement(this.graph.input(node, 'Vector').link, image.idName());
    if (!this.uvSeen) {
      this.uvSeen = true;
      this.uvMap = placement.map;
      this.uvTransform = placement.transform;
    } else if (
      placement.map !== this.uvMap ||
      JSON.stringify(placement.transform) !== JSON.stringify(this.uvTransform)
    ) {
      this.note(
        `image "${image.idName()}" is placed differently from the material's other images, and glTF gives a material one placement`,
      );
    }
    return { image, channel };
  }

  private placement(
    link: Link | null,
    image: string,
  ): { map: string | null; transform: number[] | null } {
    if (link === null) return { map: null, transform: null };
    const kind = idname(link.node);
    if (kind === 'ShaderNodeTexCoord' && link.socket === 'UV')
      return { map: null, transform: null };
    if (kind === 'ShaderNodeUVMap') {
      const storage = link.node.deref('storage', 'NodeShaderUVMap');
      const name = storage?.string('uv_map') ?? '';
      return { map: name === '' ? null : name, transform: null };
    }
    if (kind === 'ShaderNodeMapping') {
      const inner = this.placement(this.graph.input(link.node, 'Vector').link, image);
      const vector = (id: string, fallback: number[]): number[] => {
        const input = this.graph.input(link.node, id);
        if (input.link !== null)
          this.note(
            `image "${image}" is placed by a Mapping whose ${id} is driven by a node, which is ignored`,
          );
        return socketValue(input.socket)?.slice(0, 3) ?? fallback;
      };
      const mode = link.node.int('custom1');
      let matrix: Mat4 = compose(
        vector('Location', [0, 0, 0]),
        eulerMatrix(vector('Rotation', [0, 0, 0]), 1),
        vector('Scale', [1, 1, 1]),
      );
      if (mode === MAPPING_TEXTURE) matrix = invert(matrix);
      else if (mode !== MAPPING_POINT) {
        this.note(
          `image "${image}" is placed by a Mapping of a kind that only turns directions, which is ignored`,
        );
        return inner;
      }
      if (inner.transform !== null) matrix = multiply(matrix, from3(inner.transform));
      return {
        map: inner.map,
        transform: [
          matrix[0] as number,
          matrix[1] as number,
          0,
          matrix[4] as number,
          matrix[5] as number,
          0,
          matrix[12] as number,
          matrix[13] as number,
          1,
        ],
      };
    }
    this.note(`image "${image}" is placed by ${kind}, which is ignored`);
    return { map: null, transform: null };
  }
}

/** A 3x3 UV affine as the 4x4 it is a slice of. */
function from3(t: number[]): Mat4 {
  return [
    t[0] as number,
    t[1] as number,
    0,
    0,
    t[3] as number,
    t[4] as number,
    0,
    0,
    0,
    0,
    1,
    0,
    t[6] as number,
    t[7] as number,
    0,
    1,
  ];
}

/** Read one material's surface. */
export function readBlendSurface(material: BlendStruct, version: number): BlendSurface {
  const name = material.idName();
  const blendFlag = material.has('blend_flag') ? material.int('blend_flag') : 0;
  const surface: Mutable<BlendSurface> = {
    name,
    baseColor: [0.8, 0.8, 0.8],
    baseColorMap: null,
    alpha: 1,
    alphaMap: null,
    alphaMode: 'OPAQUE',
    alphaCutoff: 0.5,
    vertexColor: null,
    metallic: 0,
    metallicMap: null,
    roughness: 0.5,
    roughnessMap: null,
    occlusionMap: null,
    normalMap: null,
    normalStrength: 1,
    emission: [0, 0, 0],
    emissionStrength: 1,
    emissionMap: null,
    transmission: 0,
    doubleSided: (blendFlag & MA_BL_CULL_BACKFACE) === 0,
    uvMap: null,
    uvTransform: null,
    extras: customProperties(material),
    approximations: [],
  };

  const tree = material.has('nodetree') ? material.deref('nodetree') : null;
  const useNodes = !material.has('use_nodes') || material.int('use_nodes') !== 0 || version >= 500;
  if (tree === null || !useNodes) {
    surface.baseColor = [material.float('r'), material.float('g'), material.float('b')];
    surface.alpha = material.has('a') ? material.float('a') : 1;
    if (material.has('metallic')) surface.metallic = material.float('metallic');
    if (material.has('roughness')) surface.roughness = material.float('roughness');
    return surface;
  }

  const graph = new Graph(tree);
  const reader = new Reader(graph, name);
  const output = outputNode(graph);
  const surfaceLink = output === null ? null : graph.input(output, 'Surface').link;
  if (surfaceLink === null) {
    reader.note("no surface shader is connected, so it takes glTF's default");
    return { ...surface, approximations: reader.approximations };
  }
  const shader = surfaceLink.node;
  const kind = idname(shader);
  if ((shader.int('flag') & NODE_MUTED) !== 0) reader.note(`its ${kind} is muted`);

  if (kind === 'ShaderNodeBsdfPrincipled' || kind === 'ShaderNodeBsdfDiffuse') {
    const base = reader.colour(shader, ['Base Color', 'Color'], 'Base Color');
    const factor =
      base.factor ??
      (base.map !== null || base.attribute !== null ? [1, 1, 1, 1] : [0.8, 0.8, 0.8, 1]);
    surface.baseColor = [factor[0] ?? 1, factor[1] ?? 1, factor[2] ?? 1];
    surface.baseColorMap = base.map;
    surface.vertexColor = base.attribute;

    if (kind === 'ShaderNodeBsdfPrincipled') {
      const metallic = reader.scalar(shader, ['Metallic'], 'Metallic', 0);
      surface.metallic = metallic.value;
      surface.metallicMap = metallic.map;
    }
    const roughness = reader.scalar(shader, ['Roughness'], 'Roughness', 0.5);
    surface.roughness = roughness.value;
    surface.roughnessMap = roughness.map;

    const normal = graph.input(shader, 'Normal').link;
    if (normal !== null) {
      if (idname(normal.node) === 'ShaderNodeNormalMap') {
        const map = reader.colour(normal.node, ['Color'], 'Normal Map');
        surface.normalMap = map.map;
        surface.normalStrength = scalarOf(graph.input(normal.node, 'Strength'), 1);
        if (normal.node.int('custom1') !== 0)
          reader.note('its normal map is not in tangent space, which glTF requires');
      } else
        reader.note(
          `its Normal input comes from ${idname(normal.node)}, which glTF has no slot for`,
        );
    }

    const emission = reader.colour(shader, ['Emission Color', 'Emission'], 'Emission');
    const strength = graph.input(shader, 'Emission Strength');
    surface.emissionStrength = strength.socket === null ? 1 : scalarOf(strength, 1);
    if (strength.link !== null)
      reader.note('its Emission Strength is driven by a node, so its value is used');
    surface.emission = toRgb(emission.factor ?? (emission.map !== null ? [1, 1, 1] : [0, 0, 0]));
    surface.emissionMap = emission.map;

    const transmission = graph.input(shader, 'Transmission Weight', 'Transmission');
    if (transmission.link !== null)
      reader.note('its Transmission is driven by a node, so it is treated as opaque');
    else surface.transmission = scalarOf(transmission, 0);

    alphaOf(shader, graph, reader, material, version, surface);
    occlusionOf(graph, reader, output as BlendStruct, surface);
  } else if (kind === 'ShaderNodeEmission') {
    const emission = reader.colour(shader, ['Color'], 'Emission');
    surface.baseColor = [0, 0, 0];
    surface.emission = toRgb(emission.factor ?? [1, 1, 1]);
    surface.emissionMap = emission.map;
    surface.emissionStrength = scalarOf(graph.input(shader, 'Strength'), 1);
  } else {
    reader.note(`its surface is a ${kind}, which glTF cannot express, so it takes glTF's default`);
  }
  surface.uvMap = reader.uvMap;
  surface.uvTransform = reader.uvTransform;
  surface.approximations = reader.approximations;
  return surface;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const toRgb = (v: number[]): [number, number, number] => [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];

/** Occlusion from the "glTF Material Output" group Blender's importer adds, wherever it is wired. */
function occlusionOf(
  graph: Graph,
  reader: Reader,
  output: BlendStruct,
  surface: Mutable<BlendSurface>,
): void {
  void output;
  for (const node of graph.nodes) {
    if (idname(node) !== 'ShaderNodeGroup') continue;
    const tree = node.deref('id');
    const groupName = tree?.idName() ?? '';
    if (!groupName.startsWith('glTF Material Output') && !groupName.startsWith('glTF Settings'))
      continue;
    const input = graph.input(node, 'Occlusion', 'Socket_0');
    if (input.link !== null)
      surface.occlusionMap = reader.traceScalar(input.link, 'Occlusion', 1).map;
  }
}

function alphaOf(
  shader: BlendStruct,
  graph: Graph,
  reader: Reader,
  material: BlendStruct,
  version: number,
  surface: Mutable<BlendSurface>,
): void {
  const alpha = graph.input(shader, 'Alpha');
  let cutoff: number | null = null;
  let source = alpha.link;
  if (source !== null && idname(source.node) === 'ShaderNodeMath') {
    const clip = alphaClip(source.node, graph);
    if (clip !== null) {
      cutoff = clip.cutoff;
      source = clip.source;
    }
  }
  if (source === null) surface.alpha = alpha.link === null ? scalarOf(alpha, 1) : 1;
  else {
    const traced = reader.traceScalar(source, 'Alpha', 1);
    surface.alpha = traced.value;
    surface.alphaMap = traced.map;
  }
  if (version < 402) {
    /* Before 4.2 the mode was the material's own setting, and that is what Blender converts. */
    const method = material.has('blend_method') ? material.int('blend_method') : MA_BM_SOLID;
    if (method === MA_BM_SOLID) {
      surface.alpha = 1;
      surface.alphaMap = null;
      return;
    }
    if (method === MA_BM_CLIP)
      cutoff = material.has('alpha_threshold') ? material.float('alpha_threshold') : 0.5;
  }
  const varies = surface.alphaMap !== null || surface.alpha < 1;
  if (!varies && cutoff === null) return;
  const dithered =
    version >= 402 &&
    material.has('surface_render_method') &&
    material.int('surface_render_method') !== RENDER_BLENDED;
  if (cutoff !== null) {
    surface.alphaMode = 'MASK';
    surface.alphaCutoff = cutoff;
  } else if (dithered && surface.alphaMap !== null) {
    /*
     * **A dithered surface with an alpha map is a cut-out**, where Blender's glTF exporter writes
     * it as blended. EEVEE draws dithered alpha as a screen door — each pixel drawn fully or not at
     * all — so the surface is opaque wherever it shows, which an alpha test at the middle is, and a
     * blend is not: a facade whose mask cuts its gaps would be sorted, drawn over and seen through.
     * A deliberate difference from the exporter, for what the surface looks like in Blender.
     */
    surface.alphaMode = 'MASK';
    surface.alphaCutoff = 0.5;
  } else {
    surface.alphaMode = 'BLEND';
  }
}

/**
 * An alpha clip built from Math nodes, in the four shapes Blender's exporter knows: `round(x)`,
 * `x > c`, `c < x`, and `1 - (x < c)`. Its cutoff and the link to `x`, or null.
 */
function alphaClip(
  node: BlendStruct,
  graph: Graph,
): { cutoff: number; source: Link | null } | null {
  const operation = node.int('custom1');
  const a = graph.at(node, 0);
  const b = graph.at(node, 1);
  if (operation === MATH_ROUND) return { cutoff: 0.5, source: a.link };
  if (operation === MATH_GREATER_THAN && b.link === null)
    return { cutoff: scalarOf(b, 0.5), source: a.link };
  if (operation === MATH_LESS_THAN && a.link === null)
    return { cutoff: scalarOf(a, 0.5), source: b.link };
  if (
    operation === MATH_SUBTRACT &&
    a.link === null &&
    scalarOf(a, 0) === 1 &&
    b.link !== null &&
    idname(b.link.node) === 'ShaderNodeMath'
  ) {
    const inner = b.link.node;
    const op = inner.int('custom1');
    const x = graph.at(inner, 0);
    const y = graph.at(inner, 1);
    if (op === MATH_LESS_THAN && x.link !== null && y.link === null)
      return { cutoff: scalarOf(y, 0.5), source: x.link };
    if (op === MATH_GREATER_THAN && x.link === null && y.link !== null)
      return { cutoff: scalarOf(x, 0.5), source: y.link };
  }
  return null;
}

/** An ID's custom properties that are plain values, for glTF's `extras`. */
export function customProperties(id: BlendStruct): Record<string, unknown> | null {
  const header = id.sub('id');
  if (!header.has('properties')) return null;
  const group = header.deref('properties', 'IDProperty');
  if (group === null) return null;
  const out: Record<string, unknown> = {};
  for (const property of group.sub('data').list('group', 'IDProperty')) {
    const name = property.string('name');
    const type = property.int('type');
    const data = property.sub('data');
    /* IDP_STRING 0, IDP_INT 1, IDP_FLOAT 2, IDP_DOUBLE 8, IDP_BOOLEAN 10. */
    if (type === 0) out[name] = property.file.text(data.ptr('pointer'), property.scope);
    else if (type === 1) out[name] = data.int('val');
    else if (type === 10) out[name] = data.int('val') !== 0;
    else if (type === 2)
      out[name] = new DataView(new Int32Array([data.int('val')]).buffer).getFloat32(0, true);
    else if (type === 8) {
      const bits = new Int32Array([data.int('val'), data.int('val2')]);
      out[name] = new DataView(bits.buffer).getFloat64(0, true);
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

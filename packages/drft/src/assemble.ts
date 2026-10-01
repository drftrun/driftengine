/**
 * An assembly expanded into the mesh it describes: every copy's piece through its matrix, painted
 * by its surface, its texture coordinates stretched as the copy says.
 *
 * **Positions by the matrix, normals by its inverse transpose**, so a slope stretched along one
 * axis stays perpendicular to itself rather than leaning with the stretch. **A copy that mirrors
 * — a negative determinant — winds its triangles back** and flips its tangent's handedness, so its
 * faces still wind counter-clockwise seen from outside and a mirrored texture still lights the
 * right way up. Tangents follow the matrix, since a tangent is a direction along the surface.
 *
 * **A coordinate is stretched along the piece's own tangent**: u by `|uStretch ⊙ t|` for the
 * piece's unit tangent t, v the same along its bitangent, then offset. That is what lets one unit
 * box serve every box in a city: its face coordinates run 0..1, and a copy 13 m by 4 m carrying
 * stretches of size over tile repeats its facade in metres on every face. What it gives up is a
 * stretch that varies across one face — a cone's side, where the circumference shrinks up the
 * slope — which comes out as the stretch at each vertex's own tangent, and exact only where the
 * piece's coordinates are linear in its surface.
 *
 * One allocation per output array, sized by a first pass over the copies.
 */
import {
  COPY_MATRIX_FLOATS,
  COPY_UV_FLOATS,
  SURFACE,
  SURFACE_FLOATS,
  determinant,
} from './drftAssembly.ts';
import type { DrftAssembly } from './drftAssembly.ts';
import {
  ATTR_EMISSIVE_COLOR,
  ATTR_GRAIN,
  ATTR_LAYERS,
  ATTR_RELIEF,
  ATTR_ROUGHNESS,
  ATTR_SPECULAR,
  ATTR_TANGENT,
  ATTR_UVS,
  ATTR_CHANNEL,
  DrftError,
} from './drftFormat.ts';
import type { MeshData } from './meshData.ts';

/** Finds a kit piece by mesh ordinal. */
export type PieceLookup = (ordinal: number) => MeshData;

function pieceOf(piece: PieceLookup, assembly: DrftAssembly, c: number): MeshData {
  const mesh = piece(assembly.pieces[c] as number);
  const textured = (assembly.attributes & ATTR_UVS) !== 0;
  if (textured && (mesh.uvs === undefined || mesh.tangents === undefined)) {
    throw new DrftError(
      `piece ${assembly.pieces[c]} has no ${mesh.uvs === undefined ? 'texture coordinates' : 'tangents'}, and a textured assembly copies it`,
    );
  }
  if ((assembly.attributes & ATTR_TANGENT) !== 0 && mesh.tangents === undefined) {
    throw new DrftError(
      `piece ${assembly.pieces[c]} has no tangents, and the assembly carries them`,
    );
  }
  if ((assembly.attributes & ATTR_CHANNEL) !== 0 && mesh.channel === undefined) {
    throw new DrftError(`piece ${assembly.pieces[c]} has no channel, and the assembly sways`);
  }
  return mesh;
}

export function expandAssembly(assembly: DrftAssembly, piece: PieceLookup): MeshData {
  const { attributes, surfaces, surfaceOf, transforms, uv } = assembly;
  const copies = assembly.pieces.length;
  let vertices = 0;
  let indexCount = 0;
  for (let c = 0; c < copies; c++) {
    const mesh = pieceOf(piece, assembly, c);
    vertices += mesh.positions.length / 3;
    indexCount += mesh.indices.length;
  }
  const has = (bit: number): boolean => (attributes & bit) !== 0;
  const out: MeshData = {
    positions: new Float32Array(vertices * 3),
    normals: new Float32Array(vertices * 3),
    colors: new Float32Array(vertices * 3),
    emissive: new Float32Array(vertices),
    indices: new Uint32Array(indexCount),
  };
  if (has(ATTR_SPECULAR)) out.specular = new Float32Array(vertices);
  if (has(ATTR_UVS)) out.uvs = new Float32Array(vertices * 2);
  if (has(ATTR_EMISSIVE_COLOR)) out.emissiveColor = new Float32Array(vertices * 3);
  if (has(ATTR_ROUGHNESS)) out.roughness = new Float32Array(vertices);
  if (has(ATTR_GRAIN)) out.grain = new Float32Array(vertices);
  if (has(ATTR_RELIEF)) out.relief = new Float32Array(vertices);
  if (has(ATTR_TANGENT)) out.tangents = new Float32Array(vertices * 4);
  if (has(ATTR_LAYERS)) out.layers = new Float32Array(vertices);
  if (has(ATTR_CHANNEL)) out.channel = new Float32Array(vertices * 4);

  let v0 = 0;
  let i0 = 0;
  for (let c = 0; c < copies; c++) {
    const mesh = pieceOf(piece, assembly, c);
    const m = c * COPY_MATRIX_FLOATS;
    const t = transforms;
    const [a, b, cc, d, e, f, g, h, k] = [
      t[m] as number,
      t[m + 1] as number,
      t[m + 2] as number,
      t[m + 3] as number,
      t[m + 4] as number,
      t[m + 5] as number,
      t[m + 6] as number,
      t[m + 7] as number,
      t[m + 8] as number,
    ];
    const [tx, ty, tz] = [t[m + 9] as number, t[m + 10] as number, t[m + 11] as number];
    const det = determinant(t, m);
    /* The inverse transpose is the cofactor matrix over the determinant. With columns (a b cc),
       (d e f), (g h k) the matrix's rows are (a d g), (b e h), (cc f k), and nRC is the cofactor of
       row R, column C — not of C, R, which would be the plain inverse. */
    const n00 = (e * k - f * h) / det;
    const n01 = (cc * h - b * k) / det;
    const n02 = (b * f - cc * e) / det;
    const n10 = (f * g - d * k) / det;
    const n11 = (a * k - cc * g) / det;
    const n12 = (cc * d - a * f) / det;
    const n20 = (d * h - e * g) / det;
    const n21 = (b * g - a * h) / det;
    const n22 = (a * e - b * d) / det;
    const hand = det < 0 ? -1 : 1;
    const s = (surfaceOf[c] as number) * SURFACE_FLOATS;
    const u = c * COPY_UV_FLOATS;
    const count = mesh.positions.length / 3;
    const p = mesh.positions;
    const n = mesh.normals;
    const tan = mesh.tangents;
    const tex = mesh.uvs;
    for (let i = 0; i < count; i++) {
      const o = v0 + i;
      const px = p[i * 3] as number;
      const py = p[i * 3 + 1] as number;
      const pz = p[i * 3 + 2] as number;
      out.positions[o * 3] = a * px + d * py + g * pz + tx;
      out.positions[o * 3 + 1] = b * px + e * py + h * pz + ty;
      out.positions[o * 3 + 2] = cc * px + f * py + k * pz + tz;
      const nx = n[i * 3] as number;
      const ny = n[i * 3 + 1] as number;
      const nz = n[i * 3 + 2] as number;
      let wx = n00 * nx + n01 * ny + n02 * nz;
      let wy = n10 * nx + n11 * ny + n12 * nz;
      let wz = n20 * nx + n21 * ny + n22 * nz;
      const nl = Math.hypot(wx, wy, wz) || 1;
      wx /= nl;
      wy /= nl;
      wz /= nl;
      out.normals[o * 3] = wx;
      out.normals[o * 3 + 1] = wy;
      out.normals[o * 3 + 2] = wz;
      out.colors[o * 3] = surfaces[s + SURFACE.color] as number;
      out.colors[o * 3 + 1] = surfaces[s + SURFACE.color + 1] as number;
      out.colors[o * 3 + 2] = surfaces[s + SURFACE.color + 2] as number;
      out.emissive[o] = surfaces[s + SURFACE.emissive] as number;
      if (out.specular) out.specular[o] = surfaces[s + SURFACE.specular] as number;
      if (out.emissiveColor) {
        out.emissiveColor[o * 3] = surfaces[s + SURFACE.emissiveColor] as number;
        out.emissiveColor[o * 3 + 1] = surfaces[s + SURFACE.emissiveColor + 1] as number;
        out.emissiveColor[o * 3 + 2] = surfaces[s + SURFACE.emissiveColor + 2] as number;
      }
      if (out.roughness) out.roughness[o] = surfaces[s + SURFACE.roughness] as number;
      if (out.grain) out.grain[o] = surfaces[s + SURFACE.grain] as number;
      if (out.relief) out.relief[o] = surfaces[s + SURFACE.relief] as number;
      if (out.layers) out.layers[o] = surfaces[s + SURFACE.layer] as number;
      /* Sway, sky and opacity are the piece's own: shape, not paint. */
      if (out.channel && mesh.channel !== undefined) {
        for (let lane = 0; lane < 4; lane++) {
          out.channel[o * 4 + lane] = mesh.channel[i * 4 + lane] as number;
        }
      }
      if (tan !== undefined && (out.tangents !== undefined || out.uvs !== undefined)) {
        const qx = tan[i * 4] as number;
        const qy = tan[i * 4 + 1] as number;
        const qz = tan[i * 4 + 2] as number;
        const qw = tan[i * 4 + 3] as number;
        if (out.tangents) {
          let rx = a * qx + d * qy + g * qz;
          let ry = b * qx + e * qy + h * qz;
          let rz = cc * qx + f * qy + k * qz;
          const rl = Math.hypot(rx, ry, rz) || 1;
          rx /= rl;
          ry /= rl;
          rz /= rl;
          out.tangents[o * 4] = rx;
          out.tangents[o * 4 + 1] = ry;
          out.tangents[o * 4 + 2] = rz;
          out.tangents[o * 4 + 3] = qw * hand;
        }
        if (out.uvs && tex !== undefined) {
          /* The piece's own directions for u and v: its tangent, and the bitangent n × t · w. */
          const ql = Math.hypot(qx, qy, qz) || 1;
          const bx = (ny * qz - nz * qy) * qw;
          const by = (nz * qx - nx * qz) * qw;
          const bz = (nx * qy - ny * qx) * qw;
          const bl = Math.hypot(bx, by, bz) || 1;
          const su = Math.hypot(
            ((uv[u] as number) * qx) / ql,
            ((uv[u + 1] as number) * qy) / ql,
            ((uv[u + 2] as number) * qz) / ql,
          );
          const sv = Math.hypot(
            ((uv[u + 3] as number) * bx) / bl,
            ((uv[u + 4] as number) * by) / bl,
            ((uv[u + 5] as number) * bz) / bl,
          );
          out.uvs[o * 2] = (tex[i * 2] as number) * su + (uv[u + 6] as number);
          out.uvs[o * 2 + 1] = (tex[i * 2 + 1] as number) * sv + (uv[u + 7] as number);
        }
      }
    }
    const idx = mesh.indices;
    for (let j = 0; j + 2 < idx.length; j += 3) {
      out.indices[i0 + j] = v0 + (idx[j] as number);
      /* A mirrored copy winds back, or its faces turn inside out. */
      out.indices[i0 + j + 1] = v0 + (idx[hand < 0 ? j + 2 : j + 1] as number);
      out.indices[i0 + j + 2] = v0 + (idx[hand < 0 ? j + 1 : j + 2] as number);
    }
    v0 += count;
    i0 += idx.length;
  }
  return out;
}

/** Min xyz then max xyz of every copy: its piece's box through its matrix, corner by corner. */
export function assemblyBounds(
  assembly: DrftAssembly,
  piece: PieceLookup,
  out: Float32Array = new Float32Array(6),
): Float32Array {
  out.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  for (let c = 0; c < assembly.pieces.length; c++) {
    const p = piece(assembly.pieces[c] as number).positions;
    let lx = Infinity;
    let ly = Infinity;
    let lz = Infinity;
    let hx = -Infinity;
    let hy = -Infinity;
    let hz = -Infinity;
    for (let i = 0; i + 2 < p.length; i += 3) {
      lx = Math.min(lx, p[i] as number);
      ly = Math.min(ly, p[i + 1] as number);
      lz = Math.min(lz, p[i + 2] as number);
      hx = Math.max(hx, p[i] as number);
      hy = Math.max(hy, p[i + 1] as number);
      hz = Math.max(hz, p[i + 2] as number);
    }
    if (lx > hx) continue;
    const m = c * COPY_MATRIX_FLOATS;
    const t = assembly.transforms;
    for (let corner = 0; corner < 8; corner++) {
      const x = corner & 1 ? hx : lx;
      const y = corner & 2 ? hy : ly;
      const z = corner & 4 ? hz : lz;
      for (let axis = 0; axis < 3; axis++) {
        const w =
          (t[m + axis] as number) * x +
          (t[m + 3 + axis] as number) * y +
          (t[m + 6 + axis] as number) * z +
          (t[m + 9 + axis] as number);
        if (w < (out[axis] as number)) out[axis] = w;
        if (w > (out[axis + 3] as number)) out[axis + 3] = w;
      }
    }
  }
  return out;
}

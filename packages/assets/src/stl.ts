/**
 * STL, binary and ASCII.
 *
 * The simplest format in the pipeline and the least informative: triangles and a facet
 * normal, with no colour, no UVs, no hierarchy and no materials. Everything a `MeshData`
 * carries beyond position and normal has to be supplied by the caller, and this reader
 * says so rather than inventing it.
 *
 * **Shaded flat, deliberately.** An STL has one normal per *face*, so its vertices cannot
 * be shared and there is nothing to average. Welding them and smoothing would make a
 * printed part look like an organic model — a change to the artist's intent made silently
 * by a reader, which is not a reader's decision to make. A smoothing pass belongs in the
 * baker, behind a flag, where somebody chose it.
 */

import type { MeshData } from '@driftengine/drft';
import { DrftError } from '@driftengine/drft';

/** What a caller may supply, since the format carries none of it. */
export interface StlAppearance {
  readonly color?: readonly [number, number, number];
  readonly roughness?: number;
  readonly specular?: number;
}

/**
 * Binary STL is 80 bytes of header, a count, then 50 bytes per triangle. An ASCII one
 * begins with `solid` — but so do some binary files, so the length is checked as well.
 * That check is the whole of the detection and it is exact rather than a guess.
 */
function looksBinary(bytes: Uint8Array): boolean {
  if (bytes.length < 84) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangles = view.getUint32(80, true);
  return bytes.length === 84 + triangles * 50;
}

export function parseStl(buffer: ArrayBuffer, appearance: StlAppearance = {}): MeshData {
  const bytes = new Uint8Array(buffer);
  const triangles = looksBinary(bytes)
    ? readBinary(bytes)
    : readAscii(new TextDecoder().decode(bytes));
  if (triangles.length === 0) throw new DrftError('stl: no triangles');

  const count = triangles.length * 3;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const indices = new Uint32Array(count);
  const [r, g, b] = appearance.color ?? [0.8, 0.8, 0.82];

  for (let t = 0; t < triangles.length; t++) {
    const triangle = triangles[t] as Triangle;
    for (let c = 0; c < 3; c++) {
      const at = (t * 3 + c) * 3;
      positions[at] = triangle.vertices[c * 3] as number;
      positions[at + 1] = triangle.vertices[c * 3 + 1] as number;
      positions[at + 2] = triangle.vertices[c * 3 + 2] as number;
      normals[at] = triangle.normal[0];
      normals[at + 1] = triangle.normal[1];
      normals[at + 2] = triangle.normal[2];
      colors[at] = r;
      colors[at + 1] = g;
      colors[at + 2] = b;
      indices[t * 3 + c] = t * 3 + c;
    }
  }

  return {
    positions,
    normals,
    colors,
    emissive: new Float32Array(count),
    /* Only what the caller named: an unasked-for attribute is the engine's own default. */
    ...(appearance.specular === undefined
      ? {}
      : { specular: new Float32Array(count).fill(appearance.specular) }),
    ...(appearance.roughness === undefined
      ? {}
      : { roughness: new Float32Array(count).fill(appearance.roughness) }),
    indices,
  };
}

interface Triangle {
  normal: [number, number, number];
  vertices: number[];
}

/**
 * A facet normal of zero is legal and common — exporters write it to mean "work it out".
 * Computed from the winding rather than passed through, because a zero normal is not a
 * neutral value: every lighting term multiplies by it, so the part would arrive black.
 */
function withNormal(normal: [number, number, number], vertices: number[]): Triangle {
  if (Math.hypot(normal[0], normal[1], normal[2]) > 1e-8) return { normal, vertices };
  const ux = (vertices[3] as number) - (vertices[0] as number);
  const uy = (vertices[4] as number) - (vertices[1] as number);
  const uz = (vertices[5] as number) - (vertices[2] as number);
  const vx = (vertices[6] as number) - (vertices[0] as number);
  const vy = (vertices[7] as number) - (vertices[1] as number);
  const vz = (vertices[8] as number) - (vertices[2] as number);
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz) || 1;
  return { normal: [nx / length, ny / length, nz / length], vertices };
}

function readBinary(bytes: Uint8Array): Triangle[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  const triangles: Triangle[] = [];
  let at = 84;
  for (let i = 0; i < count; i++) {
    const normal: [number, number, number] = [
      view.getFloat32(at, true),
      view.getFloat32(at + 4, true),
      view.getFloat32(at + 8, true),
    ];
    const vertices: number[] = [];
    for (let v = 0; v < 9; v++) vertices.push(view.getFloat32(at + 12 + v * 4, true));
    triangles.push(withNormal(normal, vertices));
    at += 50;
  }
  return triangles;
}

function readAscii(text: string): Triangle[] {
  const triangles: Triangle[] = [];
  let normal: [number, number, number] = [0, 0, 0];
  let vertices: number[] = [];

  for (const rawLine of text.split('\n')) {
    const parts = rawLine.trim().split(/\s+/);
    if (parts[0] === 'facet' && parts[1] === 'normal') {
      normal = [Number(parts[2]), Number(parts[3]), Number(parts[4])];
      vertices = [];
    } else if (parts[0] === 'vertex') {
      vertices.push(Number(parts[1]), Number(parts[2]), Number(parts[3]));
    } else if (parts[0] === 'endfacet') {
      if (vertices.length === 9) triangles.push(withNormal(normal, vertices));
      vertices = [];
    }
  }
  return triangles;
}

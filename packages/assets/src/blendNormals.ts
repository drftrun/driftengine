/**
 * The normal Blender shades each face corner with, computed from what a `.blend` stores.
 *
 * **A `.blend` stores no shading normals unless somebody customised them**, so a reader has to
 * derive the ones Blender draws, and "a smooth normal" is not specific enough to agree with it.
 * Blender's rule, which this follows step for step:
 *
 * - Every face flat, or every edge sharp: each corner takes its face's normal.
 * - Every face smooth and no edge sharp: each corner takes its vertex's normal, the sum of the
 *   normals of every face at the vertex weighted by the angle each face makes there.
 * - Otherwise the corners around a vertex split into *fans* at every sharp edge — an edge tagged
 *   sharp, an edge beside a flat face, an edge with more or fewer than two faces, and an edge whose
 *   faces disagree about winding — and each fan takes the angle-weighted sum over its own faces.
 *
 * **Custom normals are stored relative to those fans**, two shorts per corner: an angle away from
 * the fan's normal and an angle around it from the fan's first edge. Decoding them needs the fans
 * walked in exactly Blender's order, which is why the walk below starts each fan where Blender
 * starts it and visits faces in the direction Blender turns. A vector normal stored as an
 * attribute — 4.5 on — needs none of this and is used as it stands.
 *
 * What it gives up: nothing it knows of. Its arithmetic is in doubles where Blender's is in
 * floats, which is a difference of about 1e-4 in a normal and is what the fixtures allow.
 */

import type { BlendMeshData } from './blendMesh.ts';
import { FACE, POINT } from './blendMesh.ts';

const EMPTY = -1;
const UNSET = -2;
const INVALID = -3;
/** Blender's limit beyond which two directions are too close to define a frame between them. */
const TRIGO_THRESHOLD = 1 - 1e-4;
const TAU = Math.PI * 2;

type Vec = [number, number, number];

const acos = (x: number): number => Math.acos(Math.max(-1, Math.min(1, x)));
const f32 = Math.fround;
/** Blender's approximate arc cosine for corner angles, in its single precision. */
function cornerAngle(x: number): number {
  const f = f32(Math.abs(x));
  const m = f < 1 ? f32(1 - f32(1 - f)) : 1;
  const a = f32(
    Math.sqrt(f32(1 - m)) *
      f32(1.5707963267 + m * f32(-0.213300989 + m * f32(0.077980478 + m * -0.02164095))),
  );
  return x < 0 ? f32(Math.PI - a) : a;
}
const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function normalise(v: Vec): number {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (length > 1e-35) {
    v[0] /= length;
    v[1] /= length;
    v[2] /= length;
  } else {
    v[0] = v[1] = v[2] = 0;
  }
  return length;
}

/**
 * Each face's normal, by the rule Blender uses for its size: two edges of a triangle, the two
 * diagonals of a quad, and Newell's method beyond that.
 *
 * **Not Newell's method throughout**, which is what this was until a real file disagreed: a quad
 * with two coincident corners has no area, so Newell gives it no normal, while its diagonals still
 * cross. And where even they cancel — a quad whose corners coincide in pairs — Blender calls the
 * face's normal straight up rather than zero, and averages that into its smooth neighbours. Both
 * were found on a 2.79 wheel, where one such face moved a vertex normal 0.68 from Blender's.
 */
export function faceNormals(mesh: BlendMeshData): Float64Array {
  const { positions: p, faceOffsets, cornerVerts } = mesh;
  const faces = faceOffsets.length - 1;
  const out = new Float64Array(faces * 3);
  const at = (corner: number, axis: number): number =>
    p[(cornerVerts[corner] as number) * 3 + axis] as number;
  for (let f = 0; f < faces; f++) {
    const start = faceOffsets[f] as number;
    const end = faceOffsets[f + 1] as number;
    const n: Vec = [0, 0, 0];
    if (end - start === 3 || end - start === 4) {
      /* Triangle: (v0 - v1) x (v1 - v2). Quad: (v0 - v2) x (v1 - v3). */
      const quad = end - start === 4;
      const a = [0, 1, 2].map((k) => at(start, k) - at(start + (quad ? 2 : 1), k));
      const b = [0, 1, 2].map((k) => at(start + 1, k) - at(start + (quad ? 3 : 2), k));
      n[0] = (a[1] as number) * (b[2] as number) - (a[2] as number) * (b[1] as number);
      n[1] = (a[2] as number) * (b[0] as number) - (a[0] as number) * (b[2] as number);
      n[2] = (a[0] as number) * (b[1] as number) - (a[1] as number) * (b[0] as number);
    } else {
      let prev = (cornerVerts[end - 1] as number) * 3;
      for (let c = start; c < end; c++) {
        const curr = (cornerVerts[c] as number) * 3;
        const px = p[prev] as number,
          py = p[prev + 1] as number,
          pz = p[prev + 2] as number;
        const cx = p[curr] as number,
          cy = p[curr + 1] as number,
          cz = p[curr + 2] as number;
        n[0] += (py - cy) * (pz + cz);
        n[1] += (pz - cz) * (px + cx);
        n[2] += (px - cx) * (py + cy);
        prev = curr;
      }
    }
    /* Blender's convention for a face with no area: it faces up. Its neighbours average it in. */
    if (normalise(n) === 0) n[2] = 1;
    out.set(n, f * 3);
  }
  return out;
}

function direction(mesh: BlendMeshData, from: number, to: number): Vec {
  const p = mesh.positions;
  const v: Vec = [
    (p[to * 3] as number) - (p[from * 3] as number),
    (p[to * 3 + 1] as number) - (p[from * 3 + 1] as number),
    (p[to * 3 + 2] as number) - (p[from * 3 + 2] as number),
  ];
  normalise(v);
  return v;
}

/** The angle-weighted vertex normals, what an all-smooth mesh shades with. */
export function vertexNormals(mesh: BlendMeshData, face: Float64Array): Float64Array {
  const { faceOffsets, cornerVerts, positions } = mesh;
  const verts = positions.length / 3;
  const out = new Float64Array(verts * 3);
  for (let f = 0; f < faceOffsets.length - 1; f++) {
    const start = faceOffsets[f] as number;
    const end = faceOffsets[f + 1] as number;
    for (let c = start; c < end; c++) {
      const v = cornerVerts[c] as number;
      const prev = cornerVerts[c === start ? end - 1 : c - 1] as number;
      const next = cornerVerts[c + 1 === end ? start : c + 1] as number;
      const angle = cornerAngle(dot(direction(mesh, v, prev), direction(mesh, v, next)));
      for (let k = 0; k < 3; k++)
        out[v * 3 + k] = (out[v * 3 + k] as number) + (face[f * 3 + k] as number) * angle;
    }
  }
  for (let v = 0; v < verts; v++) {
    const n: Vec = [out[v * 3] as number, out[v * 3 + 1] as number, out[v * 3 + 2] as number];
    /* Blender's convention for a vertex with no usable faces: point the normal along its position. */
    if (normalise(n) === 0) {
      n[0] = positions[v * 3] as number;
      n[1] = positions[v * 3 + 1] as number;
      n[2] = positions[v * 3 + 2] as number;
      normalise(n);
    }
    out.set(n, v * 3);
  }
  return out;
}

/** Every edge that splits a fan: tagged, beside a flat face, not two-faced, or flipped. */
function edgeLoops(mesh: BlendMeshData, sharpEdge: Uint8Array | null): Int32Array {
  const { faceOffsets, cornerVerts, cornerEdges, sharpFace } = mesh;
  const edges = mesh.edgeVerts.length / 2;
  const e2l = new Int32Array(edges * 2).fill(EMPTY);
  for (let f = 0; f < faceOffsets.length - 1; f++) {
    const flat = sharpFace !== null && sharpFace[f] === 1;
    for (let c = faceOffsets[f] as number; c < (faceOffsets[f + 1] as number); c++) {
      const e = cornerEdges[c] as number;
      if (e2l[e * 2] === EMPTY) {
        e2l[e * 2] = c;
        e2l[e * 2 + 1] = flat ? INVALID : UNSET;
      } else if (e2l[e * 2 + 1] === UNSET) {
        const first = e2l[e * 2] as number;
        if (
          flat ||
          (sharpEdge !== null && sharpEdge[e] === 1) ||
          cornerVerts[c] === cornerVerts[first]
        ) {
          e2l[e * 2 + 1] = INVALID;
        } else e2l[e * 2 + 1] = c;
      } else if (e2l[e * 2 + 1] !== INVALID) {
        e2l[e * 2 + 1] = INVALID;
      }
    }
  }
  return e2l;
}

const isSharp = (e2l: Int32Array, edge: number): boolean => {
  const second = e2l[edge * 2 + 1] as number;
  return second === UNSET || second === INVALID;
};

/** The frame a fan's custom normals are measured in. */
interface Space {
  lnor: Vec;
  ref: Vec;
  ortho: Vec;
  alpha: number;
  beta: number;
}

function defineSpace(lnor: Vec, ref: Vec, other: Vec, edges: readonly Vec[]): Space {
  const space: Space = { lnor: [...lnor], ref: [0, 0, 0], ortho: [0, 0, 0], alpha: 0, beta: 0 };
  const dRef = dot(ref, lnor);
  const dOther = dot(other, lnor);
  if (Math.abs(dRef) >= TRIGO_THRESHOLD || Math.abs(dOther) >= TRIGO_THRESHOLD) return space;
  if (edges.length > 0) {
    let alpha = 0;
    for (const e of edges) alpha += acos(dot(e, lnor));
    space.alpha = alpha / edges.length;
  } else {
    space.alpha = (acos(dRef) + acos(dOther)) / 2;
  }
  const r: Vec = [ref[0] - lnor[0] * dRef, ref[1] - lnor[1] * dRef, ref[2] - lnor[2] * dRef];
  normalise(r);
  space.ref = r;
  const o: Vec = [
    lnor[1] * r[2] - lnor[2] * r[1],
    lnor[2] * r[0] - lnor[0] * r[2],
    lnor[0] * r[1] - lnor[1] * r[0],
  ];
  normalise(o);
  space.ortho = o;
  const t: Vec = [
    other[0] - lnor[0] * dOther,
    other[1] - lnor[1] * dOther,
    other[2] - lnor[2] * dOther,
  ];
  normalise(t);
  const d = dot(r, t);
  if (d < TRIGO_THRESHOLD) {
    const beta = acos(d);
    space.beta = dot(o, t) < 0 ? TAU - beta : beta;
  } else space.beta = TAU;
  return space;
}

function decode(space: Space, a: number, b: number): Vec {
  if (a === 0 || space.alpha === 0 || space.beta === 0) return [...space.lnor];
  const alphaFac = a / 32767;
  const alpha = (alphaFac > 0 ? space.alpha : TAU - space.alpha) * alphaFac;
  const out: Vec = [
    space.lnor[0] * Math.cos(alpha),
    space.lnor[1] * Math.cos(alpha),
    space.lnor[2] * Math.cos(alpha),
  ];
  const sinAlpha = Math.sin(alpha);
  if (b === 0) {
    for (let k = 0; k < 3; k++) out[k] = (out[k] as number) + space.ref[k as 0 | 1 | 2] * sinAlpha;
    return out;
  }
  const betaFac = b / 32767;
  const beta = (betaFac > 0 ? space.beta : TAU - space.beta) * betaFac;
  for (let k = 0; k < 3; k++) {
    const i = k as 0 | 1 | 2;
    out[i] += space.ref[i] * sinAlpha * Math.cos(beta) + space.ortho[i] * sinAlpha * Math.sin(beta);
  }
  return out;
}

/**
 * The normal every corner is shaded with, three floats per corner, in the mesh's own space.
 *
 * `splitAngle` also tags as sharp every edge whose faces meet at more than it: a pre-4.1 file's
 * auto smooth by default, or the angle of a Smooth by Angle modifier, which does the same thing.
 */
export function cornerNormals(
  mesh: BlendMeshData,
  splitAngle: number | null = mesh.autoSmooth,
): Float32Array {
  const { faceOffsets, cornerVerts, cornerEdges, edgeVerts, sharpFace } = mesh;
  const corners = cornerVerts.length;
  const faces = faceOffsets.length - 1;
  const out = new Float32Array(corners * 3);
  const face = faceNormals(mesh);
  const faceOf = new Int32Array(corners);
  for (let f = 0; f < faces; f++)
    faceOf.fill(f, faceOffsets[f] as number, faceOffsets[f + 1] as number);

  if (mesh.freeNormals !== null && mesh.packedNormals === null) {
    const { domain, normals } = mesh.freeNormals;
    for (let c = 0; c < corners; c++) {
      const i =
        domain === POINT ? (cornerVerts[c] as number) : domain === FACE ? (faceOf[c] as number) : c;
      const n: Vec = [
        normals[i * 3] as number,
        normals[i * 3 + 1] as number,
        normals[i * 3 + 2] as number,
      ];
      normalise(n);
      out.set(n, c * 3);
    }
    return out;
  }

  let sharpEdge = mesh.sharpEdge;
  if (splitAngle !== null) sharpEdge = byAngle(mesh, face, splitAngle);
  const allFlat = faces > 0 && sharpFace !== null && sharpFace.every((s) => s === 1);
  const allSharp = sharpEdge !== null && sharpEdge.length > 0 && sharpEdge.every((s) => s === 1);
  const anyFlat = sharpFace !== null && sharpFace.some((s) => s === 1);
  const anySharp = sharpEdge !== null && sharpEdge.some((s) => s === 1);

  if (mesh.packedNormals === null && (allFlat || allSharp)) {
    for (let c = 0; c < corners; c++)
      out.set(face.subarray((faceOf[c] as number) * 3, (faceOf[c] as number) * 3 + 3), c * 3);
    return out;
  }
  const vertex = vertexNormals(mesh, face);
  if (mesh.packedNormals === null && !anyFlat && !anySharp) {
    for (let c = 0; c < corners; c++) {
      const v = cornerVerts[c] as number;
      out.set(vertex.subarray(v * 3, v * 3 + 3), c * 3);
    }
    return out;
  }

  const e2l = edgeLoops(mesh, sharpEdge);
  const packed = mesh.packedNormals;
  const other = (edge: number, pivot: number): number =>
    (edgeVerts[edge * 2] as number) === pivot
      ? (edgeVerts[edge * 2 + 1] as number)
      : (edgeVerts[edge * 2] as number);
  const prevCorner = (c: number): number => {
    const f = faceOf[c] as number;
    return c === faceOffsets[f] ? (faceOffsets[f + 1] as number) - 1 : c - 1;
  };
  const nextCorner = (c: number): number => {
    const f = faceOf[c] as number;
    return c + 1 === faceOffsets[f + 1] ? (faceOffsets[f] as number) : c + 1;
  };

  /* Prefilled as Blender prefills: the vertex normal where smooth, the face normal where flat. */
  for (let c = 0; c < corners; c++) {
    const f = faceOf[c] as number;
    if (sharpFace !== null && sharpFace[f] === 1) out.set(face.subarray(f * 3, f * 3 + 3), c * 3);
    else {
      const v = cornerVerts[c] as number;
      out.set(vertex.subarray(v * 3, v * 3 + 3), c * 3);
    }
  }

  /** Cross the edge `curr` names into the next face around `pivot`: Blender's fan step. */
  const step = (curr: number, pivot: number): { curr: number; vert: number } => {
    const edge = cornerEdges[curr] as number;
    const a = e2l[edge * 2] as number;
    const b = e2l[edge * 2 + 1] as number;
    const fromVert = cornerVerts[curr] as number;
    const next = a === curr ? b : a;
    const nextVert = cornerVerts[next] as number;
    if (
      (fromVert === nextVert && fromVert === pivot) ||
      (fromVert !== nextVert && fromVert !== pivot)
    ) {
      return { curr: prevCorner(next), vert: next };
    }
    const forward = nextCorner(next);
    return { curr: forward, vert: forward };
  };

  const skip = new Uint8Array(corners);
  const cyclic = (start: number, prev: number): boolean => {
    const pivot = cornerVerts[start] as number;
    if (isSharp(e2l, cornerEdges[prev] as number)) return false;
    let curr = prev;
    let vert = start;
    skip[vert] = 1;
    for (;;) {
      ({ curr, vert } = step(curr, pivot));
      if (isSharp(e2l, cornerEdges[curr] as number)) return false;
      if (skip[vert] === 1) return vert === start;
      skip[vert] = 1;
    }
  };

  const single = (c: number): void => {
    const f = faceOf[c] as number;
    const n: Vec = [face[f * 3] as number, face[f * 3 + 1] as number, face[f * 3 + 2] as number];
    if (packed !== null) {
      const v = cornerVerts[c] as number;
      const space = defineSpace(
        n,
        direction(mesh, v, cornerVerts[nextCorner(c)] as number),
        direction(mesh, v, cornerVerts[prevCorner(c)] as number),
        [],
      );
      out.set(decode(space, packed[c * 2] as number, packed[c * 2 + 1] as number), c * 3);
    } else out.set(n, c * 3);
  };

  const fan = (start: number, prev: number): void => {
    const pivot = cornerVerts[start] as number;
    const origin = cornerEdges[start] as number;
    const vecOrigin = direction(mesh, pivot, other(origin, pivot));
    let vecPrev: Vec = vecOrigin;
    let vecCurr: Vec = vecOrigin;
    const edges: Vec[] = [vecOrigin];
    const members: number[] = [];
    const lnor: Vec = [0, 0, 0];
    let curr = prev;
    let vert = start;
    for (let guard = 0; guard <= corners; guard++) {
      const edge = cornerEdges[curr] as number;
      vecCurr = direction(mesh, pivot, other(edge, pivot));
      const angle = cornerAngle(dot(vecCurr, vecPrev));
      const f = faceOf[curr] as number;
      for (let k = 0; k < 3; k++) lnor[k as 0 | 1 | 2] += (face[f * 3 + k] as number) * angle;
      members.push(vert);
      if (edge !== origin) edges.push(vecCurr);
      if (isSharp(e2l, edge) || edge === origin) break;
      vecPrev = vecCurr;
      ({ curr, vert } = step(curr, pivot));
    }
    let length = normalise(lnor);
    if (packed !== null) {
      if (length === 0) {
        const v = cornerVerts[vert] as number;
        lnor[0] = vertex[v * 3] as number;
        lnor[1] = vertex[v * 3 + 1] as number;
        lnor[2] = vertex[v * 3 + 2] as number;
        length = 1;
      }
      const space = defineSpace(lnor, vecOrigin, vecCurr, edges);
      const first = members[0] as number;
      let a = packed[first * 2] as number;
      let b = packed[first * 2 + 1] as number;
      if (members.some((m) => packed[m * 2] !== a || packed[m * 2 + 1] !== b)) {
        let sa = 0;
        let sb = 0;
        for (const m of members) {
          sa += packed[m * 2] as number;
          sb += packed[m * 2 + 1] as number;
        }
        a = Math.trunc(sa / members.length);
        b = Math.trunc(sb / members.length);
      }
      const custom = decode(space, a, b);
      lnor[0] = custom[0];
      lnor[1] = custom[1];
      lnor[2] = custom[2];
    }
    if (length !== 0) for (const m of members) out.set(lnor, m * 3);
  };

  for (let f = 0; f < faces; f++) {
    for (let c = faceOffsets[f] as number; c < (faceOffsets[f + 1] as number); c++) {
      const prev = prevCorner(c);
      const currSharp = isSharp(e2l, cornerEdges[c] as number);
      const prevSharp = isSharp(e2l, cornerEdges[prev] as number);
      if (currSharp && prevSharp) single(c);
      else if (currSharp || (!prevSharp && skip[c] === 0 && cyclic(c, prev))) fan(c, prev);
    }
  }
  return out;
}

/** What Blender's smooth-by-angle does to a pre-4.1 file with auto smooth on: tag by angle too. */
function byAngle(mesh: BlendMeshData, face: Float64Array, angle: number): Uint8Array {
  const edges = mesh.edgeVerts.length / 2;
  const out = new Uint8Array(edges);
  if (mesh.sharpEdge !== null) out.set(mesh.sharpEdge);
  const first = new Int32Array(edges).fill(-1);
  const count = new Int32Array(edges);
  const second = new Int32Array(edges).fill(-1);
  const { faceOffsets, cornerEdges } = mesh;
  for (let f = 0; f < faceOffsets.length - 1; f++) {
    for (let c = faceOffsets[f] as number; c < (faceOffsets[f + 1] as number); c++) {
      const e = cornerEdges[c] as number;
      if (count[e] === 0) first[e] = f;
      else if (count[e] === 1) second[e] = f;
      count[e] = (count[e] as number) + 1;
    }
  }
  const cos = Math.cos(angle);
  for (let e = 0; e < edges; e++) {
    if (count[e] !== 2) continue;
    const a = first[e] as number;
    const b = second[e] as number;
    const d =
      (face[a * 3] as number) * (face[b * 3] as number) +
      (face[a * 3 + 1] as number) * (face[b * 3 + 1] as number) +
      (face[a * 3 + 2] as number) * (face[b * 3 + 2] as number);
    if (d < cos) out[e] = 1;
  }
  return out;
}

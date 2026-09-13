/**
 * A chunk's blocks turned into geometry: one quad per face that borders something you can see
 * through, and nothing at all for a face that borders something you cannot.
 *
 * Each face maps to exactly one atlas tile, so there is no greedy tiling and UVs never leave
 * their cell. Per-vertex ambient occlusion is baked into the vertex colour, which the engine's
 * standard material multiplies straight into the atlas texel — `vec3 albedo = vColor;` then
 * `albedo *= texel.rgb` in `render/shaders/flat/main.ts`. That is the reference's own AO term,
 * reached without writing a shader.
 *
 * **Positions are chunk-local.** The reference bakes world coordinates because it draws every
 * chunk with one matrix; here each chunk is a `SceneNode` with its own transform, which is what
 * lets a frustum reject one without touching its geometry.
 *
 * Output is split by render mode so each batch can be drawn with the pipeline it needs.
 */
import type { MeshData } from '../../packages/core/src/index';

import type { BlockAtlas, TileRect } from './atlas';
import { Block, blockDef, lightOpaque, type RenderMode } from './blocks';
import { CHUNK_SX, CHUNK_SZ, SEA_LEVEL, WORLD_H } from './constants';
import { MAX_LIGHT } from './lightRegion';
import type { BlockSource } from './world';

/**
 * Packed light at a cell: sky in the high nibble, block light in the low one.
 *
 * Narrow on purpose, like `BlockSource`: the mesher reads light and nothing else about it, so a
 * test can satisfy this with a constant.
 */
export interface LightSource {
  getPacked(wx: number, wy: number, wz: number): number;
}

export interface ChunkMeshData {
  opaque: MeshData | null;
  cutout: MeshData | null;
  blend: MeshData | null;
}

interface FaceSpec {
  n: readonly [number, number, number];
  u: readonly [number, number, number];
  v: readonly [number, number, number];
  /** Which of the three face groups this side samples. */
  group: 'top' | 'side' | 'bottom';
}

/**
 * The six outward faces. Corners come out in `(cu, cv)` order: (0,0), (1,0), (1,1), (0,1).
 *
 * Face direction shading is the engine's, computed from the normal against the sun, so only
 * ambient occlusion is baked here.
 */
const FACES: readonly FaceSpec[] = [
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], group: 'top' },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, -1], group: 'bottom' },
  { n: [1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], group: 'side' },
  { n: [-1, 0, 0], u: [0, 0, -1], v: [0, 1, 0], group: 'side' },
  { n: [0, 0, 1], u: [-1, 0, 0], v: [0, 1, 0], group: 'side' },
  { n: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0], group: 'side' },
];

/** Occlusion 0 (most enclosed) to 3 (open sky), as a brightness multiplier. */
const AO_LUT = [0.5, 0.68, 0.84, 1.0] as const;

/**
 * What a cell with no sky light keeps.
 *
 * **Higher than it looks like it should be, and the reason is a modelling difference.** The
 * reference's shader lets sky light attenuate only the *sun* term and adds ambient on top. Here
 * the sky factor rides in the vertex colour, which the standard material multiplies into the
 * albedo — so it attenuates the ambient term too, and a cave face ends up darkened twice. A
 * floor of 0.22 made cave interiors read as holes in the picture rather than as caves.
 *
 * See `GAPS.md`: closing this properly wants a per-vertex attribute the directional term alone
 * consumes, which the format does not have.
 */
const SKY_FLOOR = 0.45;

/**
 * The reference's fixed per-face shade, by dominant normal axis.
 *
 * A top face is full, a bottom face half, the two X sides 0.8 and the two Z sides 0.7. It is an
 * artistic tint rather than lighting — it is what makes a voxel world read as blocky from any
 * angle, and without it a cube lit only by a directional sun has two faces that look identical.
 * The reference applies it to its ambient term; here it folds into the vertex colour, which is
 * the same multiplication in a different place.
 */
function faceShade(nx: number, ny: number, nz: number): number {
  if (ny > 0.5) return 1;
  if (ny < -0.5) return 0.5;
  if (Math.abs(nx) > 0.5) return 0.8;
  return 0.7;
}

/**
 * How far a water surface sits below the top of its cell, in blocks.
 *
 * The reference drops it in the vertex shader. Dropping it here is static rather than animated —
 * the ripple that rides on top of it needs a shader — but the *level* is what makes water read as
 * a liquid in a hole rather than as a solid block of blue.
 */
const FLUID_DROP = 0.12;

/** Where water stops darkening with depth, in blocks below the surface. The reference's nine. */
const WATER_DEPTH_SPAN = 9;
/** What deep water multiplies its colour by. */
const DEEP_TINT: readonly [number, number, number] = [0.35, 0.5, 0.7];

const MODES = ['opaque', 'cutout', 'blend'] as const;

class Batch {
  private readonly pos: number[] = [];
  private readonly nrm: number[] = [];
  private readonly uv: number[] = [];
  private readonly col: number[] = [];
  private readonly emi: number[] = [];
  private readonly idx: number[] = [];

  addFace(
    corners: readonly (readonly [number, number, number])[],
    rect: TileRect,
    normal: readonly [number, number, number],
    ao: readonly number[],
    skyLight: readonly number[],
    blockLightAt: readonly number[],
    /** Depth below the sea surface per vertex, 0 at the top and 1 at full darkening. */
    depth: readonly number[] | null,
  ): void {
    const base = this.pos.length / 3;
    const uvU = [rect.u0, rect.u1, rect.u1, rect.u0];
    const uvV = [rect.v1, rect.v1, rect.v0, rect.v0];
    const face = faceShade(normal[0], normal[1], normal[2]);

    for (let i = 0; i < 4; i++) {
      /*
       * Ambient occlusion and sky light are both multiplicative brightness, so they fold into one
       * grey the shader multiplies into the tile. Block light does not fold in with them: it has
       * to survive the sun going down, which is what `emissive` is for.
       */
      const shade = AO_LUT[ao[i]!]! * (SKY_FLOOR + (1 - SKY_FLOOR) * skyLight[i]!) * face;
      const corner = corners[i]!;
      this.pos.push(corner[0], corner[1], corner[2]);
      this.nrm.push(normal[0], normal[1], normal[2]);
      this.uv.push(uvU[i]!, uvV[i]!);
      if (depth === null) {
        this.col.push(shade, shade, shade);
      } else {
        /* Deep water turns a richer blue, which is what stops a sea reading as a flat blue
           sheet. Positional, so it bakes exactly as the reference computes it. */
        const t = depth[i]! * 0.8;
        this.col.push(
          shade * (1 + (DEEP_TINT[0] - 1) * t),
          shade * (1 + (DEEP_TINT[1] - 1) * t),
          shade * (1 + (DEEP_TINT[2] - 1) * t),
        );
      }
      this.emi.push(blockLightAt[i]!);
    }

    /*
     * Split the quad along its brighter diagonal. The two triangles interpolate AO
     * independently, so the wrong diagonal leaves a visible crease across flat ground.
     *
     * **Wound counter-clockwise seen from outside**, which is what the engine culls by:
     * `cullMode: 'back'` with a counter-clockwise front on WebGPU, `cullFace(BACK)` on WebGL2.
     * `FACES` lists its corners in `(cu, cv)` order, and `cross(u, v)` for those runs *against*
     * the face normal — so the corners are walked in reverse here rather than in the order they
     * were emitted. Straight through, every face in the world is back-facing.
     *
     * That was invisible on WebGL2 and total on WebGPU, because the scene target's resolve left
     * `CULL_FACE` disabled and the world was drawn double-sided from the second frame on.
     * `mesher.test.ts` measures the winding against the normals rather than trusting a picture.
     */
    if (ao[0]! + ao[2]! > ao[1]! + ao[3]!) {
      this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    } else {
      this.idx.push(base + 1, base + 3, base + 2, base + 1, base, base + 3);
    }
  }

  toMeshData(): MeshData | null {
    if (this.idx.length === 0) return null;
    const vertices = this.pos.length / 3;
    return {
      positions: new Float32Array(this.pos),
      normals: new Float32Array(this.nrm),
      colors: new Float32Array(this.col),
      /* Block light, which is what survives nightfall — and is gated on the environment's
         `nightFactor`, so it stays invisible until the day-night clock drives one. */
      emissive: new Float32Array(this.emi),
      uvs: new Float32Array(this.uv),
      indices: new Uint32Array(this.idx),
    };
  }
}

function occludes(id: number): boolean {
  return blockDef(id)?.castsAO === true;
}

/**
 * Ambient occlusion for one vertex, from the three cells that touch it on the air side.
 *
 * Two blocked sides fully enclose the corner regardless of what the diagonal holds, which is
 * why that case short-circuits.
 */
function vertexAO(side1: boolean, side2: boolean, corner: boolean): number {
  if (side1 && side2) return 0;
  return 3 - ((side1 ? 1 : 0) + (side2 ? 1 : 0) + (corner ? 1 : 0));
}

/** Whether `cur`'s face toward neighbour `nb` should be drawn at all. */
function faceVisible(cur: number, nb: number): boolean {
  if (nb === Block.AIR) return true;
  const nd = blockDef(nb);
  if (nd === undefined) return true;
  /* An opaque neighbour covers the face completely. */
  if (nd.hidesNeighborFaces) return false;
  /* The neighbour is see-through. Hide only the face shared by two cells of the same kind, or
     every ocean gets a pane of water inside it. */
  if (nb === cur) return false;
  return true;
}

export function meshChunk(
  blocks: BlockSource,
  cx: number,
  cz: number,
  atlas: BlockAtlas,
  light: LightSource,
): ChunkMeshData {
  const batches: Record<RenderMode, Batch> = {
    opaque: new Batch(),
    cutout: new Batch(),
    blend: new Batch(),
  };
  const baseX = cx * CHUNK_SX;
  const baseZ = cz * CHUNK_SZ;
  /* One set of scratch buffers for the whole chunk; see the note where they are refilled. */
  const corners: [number, number, number][] = [];
  const aos: number[] = [];
  const skies: number[] = [];
  const blks: number[] = [];
  const depths: number[] = [];

  for (let x = 0; x < CHUNK_SX; x++) {
    for (let z = 0; z < CHUNK_SZ; z++) {
      const wx = baseX + x;
      const wz = baseZ + z;

      for (let y = 0; y < WORLD_H; y++) {
        const cur = blocks.getBlock(wx, y, wz);
        if (cur === Block.AIR) continue;
        const cd = blockDef(cur);
        if (cd === undefined) continue;

        for (const f of FACES) {
          const nx = wx + f.n[0];
          const ny = y + f.n[1];
          const nz = wz + f.n[2];
          if (!faceVisible(cur, blocks.getBlock(nx, ny, nz))) continue;

          const rect = atlas.rects.get(cd.faces[f.group]) ?? atlas.fallback;
          /*
           * **Reused across faces, not allocated per face.** These were five fresh arrays and
           * four fresh tuples for every visible face — around six thousand faces in a chunk, so
           * fifty-four thousand allocations to build one, on the path `AGENTS.md` rules out. They
           * are emptied and refilled instead, which is what `Batch` already does one level up.
           */
          corners.length = 0;
          aos.length = 0;
          skies.length = 0;
          blks.length = 0;
          depths.length = 0;
          const doAO = cd.renderMode !== 'blend';
          const isFluid = cd.fluid === true;

          /* The face's minimum corner, in chunk-local space. Shifted by one on each axis where
             the normal points positive or an edge vector points negative, so `cu` and `cv` in
             {0,1} sweep the unit face from that corner. */
          const baseFx = x + (f.n[0] > 0 ? 1 : 0) + (f.u[0] < 0 ? 1 : 0) + (f.v[0] < 0 ? 1 : 0);
          const baseFy = y + (f.n[1] > 0 ? 1 : 0) + (f.u[1] < 0 ? 1 : 0) + (f.v[1] < 0 ? 1 : 0);
          const baseFz = z + (f.n[2] > 0 ? 1 : 0) + (f.u[2] < 0 ? 1 : 0) + (f.v[2] < 0 ? 1 : 0);

          for (let c = 0; c < 4; c++) {
            const cu = c === 1 || c === 2 ? 1 : 0;
            const cv = c === 2 || c === 3 ? 1 : 0;
            const vx = baseFx + cu * f.u[0] + cv * f.v[0];
            let vy = baseFy + cu * f.u[1] + cv * f.v[1];
            const vz = baseFz + cu * f.u[2] + cv * f.v[2];
            /* A fluid's surface sits below the top of its cell, so water in a hole reads as a
               liquid rather than as a solid block of blue. Only the upper rim moves: dropping
               the bottom too would open a gap under it. */
            /* Y is already world-space: a chunk spans the whole world height, so only X and Z
               are chunk-local. */
            if (isFluid && vy > y + 0.5) vy -= FLUID_DROP;
            corners.push([vx, vy, vz]);
            if (isFluid) {
              depths.push(Math.max(0, Math.min(1, (SEA_LEVEL - vy) / WATER_DEPTH_SPAN)));
            }

            /* The two side cells and the diagonal, all on the air side of the face. Shared by
               ambient occlusion and by the smooth-lighting average below. */
            const su = cu === 1 ? 1 : -1;
            const sv = cv === 1 ? 1 : -1;
            const s1x = nx + su * f.u[0];
            const s1y = ny + su * f.u[1];
            const s1z = nz + su * f.u[2];
            const s2x = nx + sv * f.v[0];
            const s2y = ny + sv * f.v[1];
            const s2z = nz + sv * f.v[2];
            const cnx = s1x + sv * f.v[0];
            const cny = s1y + sv * f.v[1];
            const cnz = s1z + sv * f.v[2];
            const b1 = blocks.getBlock(s1x, s1y, s1z);
            const b2 = blocks.getBlock(s2x, s2y, s2z);
            const bc = blocks.getBlock(cnx, cny, cnz);

            aos.push(doAO ? vertexAO(occludes(b1), occludes(b2), occludes(bc)) : 3);

            /*
             * Smooth lighting: average the air-side cells touching this vertex, skipping any that
             * are light-opaque — and skipping the diagonal when both sides are blocked, which is
             * what stops light leaking diagonally through a solid corner.
             */
            const o1 = lightOpaque(b1);
            const o2 = lightOpaque(b2);
            const oc = lightOpaque(bc);
            const here = light.getPacked(nx, ny, nz);
            let skySum = here >> 4;
            let blkSum = here & 15;
            let count = 1;
            if (!o1) {
              const p = light.getPacked(s1x, s1y, s1z);
              skySum += p >> 4;
              blkSum += p & 15;
              count++;
            }
            if (!o2) {
              const p = light.getPacked(s2x, s2y, s2z);
              skySum += p >> 4;
              blkSum += p & 15;
              count++;
            }
            if (!oc && !(o1 && o2)) {
              const p = light.getPacked(cnx, cny, cnz);
              skySum += p >> 4;
              blkSum += p & 15;
              count++;
            }
            skies.push(skySum / count / MAX_LIGHT);
            blks.push(blkSum / count / MAX_LIGHT);
          }

          batches[cd.renderMode].addFace(
            corners,
            rect,
            f.n,
            aos,
            skies,
            blks,
            isFluid ? depths : null,
          );
        }
      }
    }
  }

  const out = {} as ChunkMeshData;
  for (const mode of MODES) out[mode] = batches[mode].toMeshData();
  return out;
}

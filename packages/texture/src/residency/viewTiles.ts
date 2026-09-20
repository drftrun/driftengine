/**
 * Which tiles a view would sample, asked of a view nobody drew.
 *
 * **This is the step that makes prediction mean something for a real scene.** `predictViews` knows
 * where the camera will be; a streaming system needs the tiles that camera would sample, and every
 * other engine learns those from a feedback buffer the frame writes after it has already needed
 * them. Here there is no frame: for each instance whose bounds are inside the predicted view, the
 * projected size says which level a sampler would choose, and the instance's texture coordinates
 * say which tiles of that level it covers.
 *
 * **It is an estimate, and it is allowed to be generous and never short.** A tile named that the
 * frame does not sample is a wasted fetch. A tile the frame samples that is not named arrives late,
 * which is the defect this wave exists to remove. So every approximation below leans one way:
 *
 * - **The level comes from the sphere's nearest point**, where the surface is finest on screen, and
 *   a surface seen obliquely only ever asks for coarser levels than that.
 * - **Within `LEVEL_MARGIN` of a boundary, the finer level is named too.** An estimate an eighth of
 *   a level from a boundary is not sure which side the sampler is on.
 * - **Every coarser level is named**, because a sampler with a fine tile missing falls back to a
 *   coarse one, and a coarse tile missing too is a hole rather than a blur. The whole tail costs at
 *   most a third of the finest level's tiles.
 * - **Bilinear filtering's neighbour is inside the span**, so a span ending a fraction of a texel
 *   before a tile edge names the tile after it.
 *
 * **The level is the one `surfaceLod` computes on the device**: the log of the UV step a pixel
 * takes, in texels of the latent's longer edge, which is the one edge the device's interpreter has.
 *
 * **The budget keeps what matters most, and does bounded work doing it.** Priority is the screen
 * size a tile covers — its world edge at that level, capped at its instance's diameter, in pixels —
 * so an instance's coarse tiles come before its fine ones and a large instance's before a small
 * one's. The answer at any budget is the first entries of the answer with none. Prediction runs
 * several times a frame, so a level of sixty-five thousand tiles is never walked to name thirty-two
 * of them: an instance's levels only lose priority as they get finer, and the first tile the
 * budget refuses ends that instance.
 *
 * **The frustum is extracted here and not imported.** This package is standalone and its size
 * floor says so; the planes are Gribb and Hartmann exactly as `@driftengine/core`'s
 * `frustumFromViewProjection` takes them, and the test holds the two to the same answer on two
 * thousand spheres.
 */
import type { LatentImage } from '../decodeCpu.ts';
import { ADDRESS_MODE } from '../decodeGraph.ts';
import { hashTile } from '../tileHash.ts';

/**
 * How close to a level boundary, in levels, an estimate names the finer level as well.
 *
 * An eighth of a level is a ninth of the distance. A caller's texel density is an estimate of a
 * mesh's UV layout, and an estimate that good is the most this is asked to forgive; a wider margin
 * fetches four times a level's tiles for a quarter of all instances rather than an eighth.
 */
export const LEVEL_MARGIN = 0.125;

/**
 * One latent's tiles, level by level, by content.
 *
 * Level `k` is `max(1, width >> k)` by `max(1, height >> k)` texels, cut into tiles of `tileSize`
 * from the top-left, the last row and column short. `levels[k][ty * across + tx]` is that tile's
 * hash, where `across` is `ceil(levelWidth / tileSize)`.
 */
export interface MaterialTileGrid {
  /** Level 0's texels across. */
  readonly width: number;
  /** Level 0's texels down. */
  readonly height: number;
  /** Texels along a tile's edge, the same at every level. */
  readonly tileSize: number;
  /** One of `ADDRESS_MODE`, from the graph that samples this latent. */
  readonly addressMode: number;
  readonly levels: readonly (readonly string[])[];
}

/**
 * What `tilesForView` needs besides the view.
 *
 * **The target's size is here because the plan's signature had nowhere for it**, and a projection
 * alone has no pixels: the level a sampler chooses is texels per *pixel*.
 */
export interface InstanceTileInfo {
  readonly count: number;
  /** Four floats an instance: its world-space bounding sphere's centre and radius. */
  readonly spheres: Float32Array;
  /** Four floats an instance: the texture coordinates its surface spans, `u0, v0, u1, v1`. */
  readonly uvs: Float32Array;
  /**
   * World units one unit of texture coordinate spans on each instance's surface. Anything that is
   * not a positive number is unknown, and an unknown density names every level.
   */
  readonly worldPerUv: Float32Array;
  /** Which entry of `materials` each instance samples. */
  readonly material: Uint32Array;
  /** Per material, the latents its programs sample. */
  readonly materials: readonly (readonly MaterialTileGrid[])[];
  readonly targetWidth: number;
  readonly targetHeight: number;
}

/**
 * Cut a latent and its chain into content-addressed tiles.
 *
 * **Hashed as every tile in this package is**, by `hashTile` over the texels' own bytes row by
 * row, so a tile shared by two materials — or by a material and an overlay — is one address and
 * one fetch. Refuses a chain whose levels do not halve, because the grid could not then say which
 * texels a tile holds.
 */
export function latentTileGrid(
  image: LatentImage,
  tileSize: number,
  addressMode: number,
): MaterialTileGrid {
  if (!(Number.isInteger(tileSize) && tileSize >= 1)) {
    throw new Error(`latentTileGrid: an edge of ${String(tileSize)} texels is not a tile`);
  }
  const chain = image.mips ?? [];
  const levels: string[][] = [];
  for (let level = 0; level <= chain.length; level += 1) {
    const source = level === 0 ? image : chain[level - 1];
    const width = Math.max(1, image.width >> level);
    const height = Math.max(1, image.height >> level);
    if (source === undefined || source.width !== width || source.height !== height) {
      throw new Error(
        `latentTileGrid: level ${String(level)} is ${String(source?.width)} by ` +
          `${String(source?.height)} texels where the chain needs ${String(width)} by ${String(height)}`,
      );
    }
    if (source.data.length < width * height * image.channels) {
      throw new Error(
        `latentTileGrid: level ${String(level)} holds ${String(source.data.length)} values, ` +
          `short of ${String(width * height * image.channels)}`,
      );
    }
    levels.push(cutLevel(source.data, width, height, image.channels, tileSize));
  }
  return { width: image.width, height: image.height, tileSize, addressMode, levels };
}

function cutLevel(
  data: Float32Array,
  width: number,
  height: number,
  channels: number,
  tile: number,
): string[] {
  const hashes: string[] = [];
  for (let ty = 0; ty * tile < height; ty += 1) {
    for (let tx = 0; tx * tile < width; tx += 1) {
      const w = Math.min(tile, width - tx * tile);
      const h = Math.min(tile, height - ty * tile);
      const texels = new Float32Array(w * h * channels);
      for (let y = 0; y < h; y += 1) {
        const from = ((ty * tile + y) * width + tx * tile) * channels;
        texels.set(data.subarray(from, from + w * channels), y * w * channels);
      }
      hashes.push(hashTile(new Uint8Array(texels.buffer)));
    }
  }
  return hashes;
}

/* Scratch, grown and never shrunk, so a call allocates nothing once warm. */
const PLANES = new Float32Array(24);
const SPAN_U = new Int32Array(4);
const SPAN_V = new Int32Array(4);
const NO_GRIDS: readonly MaterialTileGrid[] = [];
/**
 * A pixel's footprint is taken no nearer than this, in clip `w`. It only matters for an instance
 * whose centre is at or behind the eye, which is on screen because the camera is inside it.
 */
const NEAREST_W = 1e-6;

/* The best `cap` candidates so far, as a heap with the worst at its root. */
const heapHash: string[] = [];
let heapPriority = new Float64Array(64);
let heapOrder = new Float64Array(64);
const heapAt = new Map<string, number>();
let heapSize = 0;
let heapCap = 0;

/**
 * Fill `out` with the tiles this view would sample, most important first, at most `budget` of
 * them. Returns how many.
 *
 * `view` and `proj` are column-major and OpenGL-convention, as every camera in this engine builds
 * them. `out` is cleared past what is written.
 */
export function tilesForView(
  view: Float32Array,
  proj: Float32Array,
  instances: InstanceTileInfo,
  out: string[],
  budget: number,
): number {
  heapSize = 0;
  heapAt.clear();
  heapCap = budget >= 1 ? Math.floor(budget) : 0;
  if (heapCap === 0) {
    out.length = 0;
    return 0;
  }
  planesOf(proj, PLANES);
  const p3 = proj[3] ?? 0;
  const p7 = proj[7] ?? 0;
  const p11 = proj[11] ?? 0;
  const p15 = proj[15] ?? 0;
  const across = Math.abs(proj[0] ?? 0) * instances.targetWidth;
  const down = Math.abs(proj[5] ?? 0) * instances.targetHeight;
  /* Pixels a world unit covers at clip w = 1, along the axis where it covers fewest. */
  const pixelsAtUnitW = Math.min(across, down) / 2;
  const wPerRadius = Math.hypot(p3, p7, p11);

  let order = 0;
  for (let i = 0; i < instances.count; i += 1) {
    const s = i * 4;
    const x = instances.spheres[s] ?? 0;
    const y = instances.spheres[s + 1] ?? 0;
    const z = instances.spheres[s + 2] ?? 0;
    const given = instances.spheres[s + 3] ?? 0;
    const radius = given > 0 ? given : 0;
    const vx = (view[0] ?? 0) * x + (view[4] ?? 0) * y + (view[8] ?? 0) * z + (view[12] ?? 0);
    const vy = (view[1] ?? 0) * x + (view[5] ?? 0) * y + (view[9] ?? 0) * z + (view[13] ?? 0);
    const vz = (view[2] ?? 0) * x + (view[6] ?? 0) * y + (view[10] ?? 0) * z + (view[14] ?? 0);
    if (!sphereInside(PLANES, vx, vy, vz, radius)) continue;

    const w = p3 * vx + p7 * vy + p11 * vz + p15;
    const nearW = w - wPerRadius * radius;
    /* Zero rather than not-a-number for a target or a matrix with no answer, so ties stay ties. */
    const footprint = pixelsAtUnitW / Math.max(w, NEAREST_W);
    const pixelsPerWorld = footprint > 0 ? footprint : 0;
    const density = instances.worldPerUv[i] ?? 0;
    /* An infinite density needs no case of its own: its level is 0 and its tiles' edges infinite. */
    const known = density > 0 && pixelsAtUnitW > 0 && nearW > 0;
    const grids = instances.materials[instances.material[i] ?? 0] ?? NO_GRIDS;

    for (const grid of grids) {
      const top = grid.levels.length - 1;
      if (top < 0 || !(grid.tileSize >= 1)) continue;
      const size = Math.max(grid.width, grid.height);
      const finest = known
        ? clamp(
            Math.floor(Math.log2((size * nearW) / (density * pixelsAtUnitW)) - LEVEL_MARGIN),
            0,
            top,
          )
        : 0;

      levels: for (let level = top; level >= finest; level -= 1) {
        const edge = known ? (grid.tileSize * 2 ** level * density) / size : Infinity;
        const priority = pixelsPerWorld * Math.min(edge, 2 * radius);
        const width = Math.max(1, grid.width >> level);
        const height = Math.max(1, grid.height >> level);
        const nu = tileSpans(instances.uvs, s, width, grid, SPAN_U);
        const nv = tileSpans(instances.uvs, s + 1, height, grid, SPAN_V);
        const row = grid.levels[level] ?? NO_HASHES;
        const tilesAcross = Math.ceil(width / grid.tileSize);
        for (let a = 0; a < nv; a += 1) {
          const lastY = SPAN_V[a * 2 + 1] as number;
          for (let ty = SPAN_V[a * 2] as number; ty <= lastY; ty += 1) {
            for (let b = 0; b < nu; b += 1) {
              const lastX = SPAN_U[b * 2 + 1] as number;
              for (let tx = SPAN_U[b * 2] as number; tx <= lastX; tx += 1) {
                /*
                 * Everything after a refused candidate in this instance's walk is refused too: the
                 * rest of this level ties it and comes later, and a finer level is worth no more.
                 */
                if (heapSize === heapCap && !beatsWorst(priority)) break levels;
                const hash = row[ty * tilesAcross + tx];
                if (hash !== undefined) offer(hash, priority, order);
                order += 1;
              }
            }
          }
        }
      }
    }
  }

  const count = heapSize;
  out.length = count;
  for (let at = count - 1; at >= 0; at -= 1) {
    out[at] = heapHash[0] as string;
    popWorst();
  }
  heapAt.clear();
  return count;
}

const NO_HASHES: readonly string[] = [];

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Left, right, bottom, top, near, far, normalised, inward — `frustumFromViewProjection`'s planes,
 * taken from the projection alone so the test below them is in view space.
 */
function planesOf(m: Float32Array, out: Float32Array): void {
  const r0x = m[0] ?? 0;
  const r0y = m[4] ?? 0;
  const r0z = m[8] ?? 0;
  const r0w = m[12] ?? 0;
  const r1x = m[1] ?? 0;
  const r1y = m[5] ?? 0;
  const r1z = m[9] ?? 0;
  const r1w = m[13] ?? 0;
  const r2x = m[2] ?? 0;
  const r2y = m[6] ?? 0;
  const r2z = m[10] ?? 0;
  const r2w = m[14] ?? 0;
  const r3x = m[3] ?? 0;
  const r3y = m[7] ?? 0;
  const r3z = m[11] ?? 0;
  const r3w = m[15] ?? 0;
  setPlane(out, 0, r3x + r0x, r3y + r0y, r3z + r0z, r3w + r0w);
  setPlane(out, 1, r3x - r0x, r3y - r0y, r3z - r0z, r3w - r0w);
  setPlane(out, 2, r3x + r1x, r3y + r1y, r3z + r1z, r3w + r1w);
  setPlane(out, 3, r3x - r1x, r3y - r1y, r3z - r1z, r3w - r1w);
  /* Near is row 4 plus row 3: the OpenGL convention every matrix here is built in. */
  setPlane(out, 4, r3x + r2x, r3y + r2y, r3z + r2z, r3w + r2w);
  setPlane(out, 5, r3x - r2x, r3y - r2y, r3z - r2z, r3w - r2w);
}

function setPlane(
  out: Float32Array,
  index: number,
  x: number,
  y: number,
  z: number,
  d: number,
): void {
  const length = Math.sqrt(x * x + y * y + z * z);
  /* A degenerate plane accepts everything, which is the direction a cull may fail in. */
  const scale = length > 1e-12 ? 1 / length : 0;
  const at = index * 4;
  out[at] = x * scale;
  out[at + 1] = y * scale;
  out[at + 2] = z * scale;
  out[at + 3] = d * scale;
}

/** Outside only when wholly beyond one plane; a sphere across an edge is on screen. */
function sphereInside(planes: Float32Array, x: number, y: number, z: number, r: number): boolean {
  for (let at = 0; at < 24; at += 4) {
    const distance =
      (planes[at] ?? 0) * x +
      (planes[at + 1] ?? 0) * y +
      (planes[at + 2] ?? 0) * z +
      (planes[at + 3] ?? 0);
    if (distance < -r) return false;
  }
  return true;
}

/**
 * The tile columns (or rows) a span of texture coordinates reaches at one level, as one or two
 * inclusive ranges in `out`. Returns how many.
 *
 * `first` indexes the span's low end in `uvs`, and `first + 2` its high end. Texels are addressed as
 * `decodeCpu` addresses them — a lattice puts coordinate 0 on the first texel's centre and 1 on the
 * last's, a centre mode puts them on the edges — and each end reaches the texel bilinear filtering
 * reads beside it. A wrapping span that crosses the seam is two ranges; one that repeats, or that
 * is not a number, is every tile, because an unknown span is not a reason to name nothing.
 */
function tileSpans(
  uvs: Float32Array,
  first: number,
  size: number,
  grid: MaterialTileGrid,
  out: Int32Array,
): number {
  const a = uvs[first] ?? 0;
  const b = uvs[first + 2] ?? 0;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const last = size - 1;
  let count: number;
  if (!(hi - lo >= 0)) {
    count = whole(last, out);
  } else {
    switch (grid.addressMode) {
      case ADDRESS_MODE.LATTICE_CLAMP: {
        const from = Math.floor(clamp(lo, 0, 1) * last);
        count = one(from, Math.min(Math.floor(clamp(hi, 0, 1) * last) + 1, last), out);
        break;
      }
      case ADDRESS_MODE.LATTICE_WRAP: {
        if (!(hi - lo < 1)) {
          count = whole(last, out);
          break;
        }
        const low = Math.floor(lo);
        const high = Math.floor(hi);
        const from = Math.floor((lo - low) * last);
        const to = Math.min(Math.floor((hi - high) * last) + 1, last);
        count = low === high ? one(from, to, out) : two(0, to, from, last, out);
        break;
      }
      case ADDRESS_MODE.CENTRE_CLAMP:
      case ADDRESS_MODE.CENTRE_WRAP: {
        const from = Math.floor(lo * size - 0.5);
        const to = Math.floor(hi * size - 0.5) + 1;
        if (grid.addressMode === ADDRESS_MODE.CENTRE_CLAMP) {
          count = one(clamp(from, 0, last), clamp(to, 0, last), out);
        } else if (!(to - from < size)) {
          count = whole(last, out);
        } else {
          const start = ((from % size) + size) % size;
          const end = start + (to - from);
          count = end <= last ? one(start, end, out) : two(0, end - size, start, last, out);
        }
        break;
      }
      default:
        count = whole(last, out);
    }
  }
  /* Texels to tiles, and two ranges that meet or overlap as tiles are one. */
  const tile = grid.tileSize;
  for (let i = 0; i < count * 2; i += 1) out[i] = Math.floor((out[i] as number) / tile);
  if (count === 2 && (out[2] as number) <= (out[1] as number) + 1) {
    out[1] = out[3] as number;
    count = 1;
  }
  return count;
}

function whole(last: number, out: Int32Array): number {
  return one(0, last, out);
}

function one(from: number, to: number, out: Int32Array): number {
  out[0] = from;
  out[1] = to;
  return 1;
}

/** Two ranges, the one starting at zero first. */
function two(from0: number, to0: number, from1: number, to1: number, out: Int32Array): number {
  out[0] = from0;
  out[1] = to0;
  out[2] = from1;
  out[3] = to1;
  return 2;
}

/*
 * The heap. `worse(i, j)` is the order it keeps: lower priority is worse, and between equals the
 * later candidate is, so the answer is the same however the ties fell in the walk.
 */
function worse(i: number, j: number): boolean {
  const pi = heapPriority[i] as number;
  const pj = heapPriority[j] as number;
  return pi < pj || (pi === pj && (heapOrder[i] as number) > (heapOrder[j] as number));
}

/**
 * Whether a candidate would displace the worst entry of a full heap.
 *
 * **A tie never does**, and not by choice: candidates are numbered in the order they are named, so
 * every entry already held was named before this one and wins the tie.
 */
function beatsWorst(priority: number): boolean {
  return priority > (heapPriority[0] as number);
}

function offer(hash: string, priority: number, order: number): void {
  const held = heapAt.get(hash);
  if (held !== undefined) {
    /* One entry a tile, carrying its best claim; a later equal claim is not a better one. */
    if (priority > (heapPriority[held] as number)) {
      heapPriority[held] = priority;
      heapOrder[held] = order;
      siftDown(held);
    }
    return;
  }
  let at: number;
  if (heapSize < heapCap) {
    at = heapSize;
    heapSize += 1;
    if (at >= heapPriority.length) grow(at + 1);
  } else {
    heapAt.delete(heapHash[0] as string);
    at = 0;
  }
  heapHash[at] = hash;
  heapPriority[at] = priority;
  heapOrder[at] = order;
  heapAt.set(hash, at);
  if (at === 0) siftDown(0);
  else siftUp(at);
}

function popWorst(): void {
  heapSize -= 1;
  if (heapSize === 0) return;
  move(heapSize, 0);
  siftDown(0);
}

function siftUp(start: number): void {
  let at = start;
  while (at > 0) {
    const parent = (at - 1) >> 1;
    if (!worse(at, parent)) return;
    swap(at, parent);
    at = parent;
  }
}

function siftDown(start: number): void {
  let at = start;
  for (;;) {
    const left = at * 2 + 1;
    if (left >= heapSize) return;
    const right = left + 1;
    const child = right < heapSize && worse(right, left) ? right : left;
    if (!worse(child, at)) return;
    swap(at, child);
    at = child;
  }
}

function swap(i: number, j: number): void {
  const hash = heapHash[i] as string;
  const priority = heapPriority[i] as number;
  const order = heapOrder[i] as number;
  move(j, i);
  heapHash[j] = hash;
  heapPriority[j] = priority;
  heapOrder[j] = order;
  heapAt.set(hash, j);
}

function move(from: number, to: number): void {
  const hash = heapHash[from] as string;
  heapHash[to] = hash;
  heapPriority[to] = heapPriority[from] as number;
  heapOrder[to] = heapOrder[from] as number;
  heapAt.set(hash, to);
}

/** The only place the heap's storage grows, doubling. */
function grow(needed: number): void {
  let length = heapPriority.length;
  while (length < needed) length *= 2;
  const priority = new Float64Array(length);
  const order = new Float64Array(length);
  priority.set(heapPriority);
  order.set(heapOrder);
  heapPriority = priority;
  heapOrder = order;
}

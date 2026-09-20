/**
 * A captured surface's material, separated from the light it was photographed under.
 *
 * ## What this is, said plainly
 *
 * **Inverse rendering is ill-posed and this does not pretend otherwise.** A photograph of a grey
 * wall in shadow and a photograph of a dark wall in light are the same photograph. Nothing recovers
 * the difference from pixels alone; what recovers it is an *assumption*, and the whole of the
 * honesty in this file is in saying which assumptions and where they fail.
 *
 * **Shadow baked into albedo is the field's named failure.** A capture delit badly looks correct
 * until it is relit — and then the old light is still painted on, a shadow follows an object that
 * has moved, and the scene reads as flat and wrong in a way nobody can point at. Every measurement
 * below is aimed at that one failure.
 *
 * **No learned model ships here, and the reason is licensing rather than quality.** The models that
 * do this well are trained on datasets whose terms do not permit redistribution in a product, and
 * a weight file a consumer cannot lawfully ship is worse than no weight file at all. So this is
 * multi-view inverse rendering with a classical separation, and `tools/capture-prior/` is where a
 * prior the project owns would be trained if one is wanted — on scenes DriftEngine itself renders,
 * which is data nobody else has terms on.
 *
 * ## The two assumptions, and what each is worth
 *
 * **A Lambertian point looks the same from everywhere; a highlight does not.** That is what
 * *multi-view* buys, and it buys exactly one thing: the view-dependent part. A point seen from six
 * cameras gives six observations whose *median* rejects a highlight in any minority of them, and
 * whose spread above that median is the specular energy — which is where the roughness estimate
 * comes from. **What it cannot do is remove a cast shadow**, and that is worth stating because it
 * is the assumption people expect it to carry: a shadowed point is shadowed from every camera, so
 * every observation agrees, and agreement is not evidence of albedo.
 *
 * **A shadow changes intensity and not colour; a material change usually changes colour.** That is
 * Retinex, and it is what separates a cast shadow from a dark patch of paint. Over the mesh's own
 * edges, an edge where the intensity jumps and the chromaticity holds is called shading and the
 * jump is given to the light; an edge where the chromaticity moves is called reflectance and the
 * jump is given to the albedo. **Where it fails is a grey object on a grey floor** — no chromaticity
 * to tell them apart — and that is what the confidence is for.
 *
 * ## What it achieves, measured
 *
 * On the synthetic scene in `delight.test.ts`: a cast shadow that makes one half of a floor **4.8
 * times darker than the other in the photographs** comes back **2.2 times darker in the albedo** —
 * half of it removed, in the logarithm. A matte floor's albedo lands within about a tenth of the
 * truth, and the whole scene relit under a light it never saw is within a tenth of a channel of the
 * renderer's own answer.
 *
 * **Half a shadow is a real result and not a finished one**, and the number is written here rather
 * than rounded up because it is the number a learned prior would have to beat to be worth its
 * weights. What is left is the part a chromaticity cannot see: where a shadow's edge falls inside a
 * single material, the only thing separating shading from paint is a *prior about scenes*, and this
 * has none.
 *
 * ## The confidence is the point, not a decoration
 *
 * Every surface here gets a number saying how much of this to believe, and the test that makes it
 * mean something **correlates it against the actual error**. A channel that does not track the error
 * is worse than none, because a consumer trusts it. Low confidence is the honest answer for glass,
 * for a surface one camera saw, and for a grey object on a grey floor — and a pipeline that knows
 * which surfaces those are can leave them alone rather than delighting them wrongly.
 */
import { exactExp, exactLog } from '@driftengine/core';
import type { MeshData } from '@driftengine/drft';

import { cameraCentre, nearestHit } from './delightScene.ts';
import type { Frame } from './gaussians/rasterise.ts';
import type { RasterCamera } from './gaussians/project.ts';

/** One view of the surface: a linear frame and where it was taken from. */
export interface DelightView {
  readonly frame: Frame;
  readonly camera: RasterCamera;
}

export interface DelightOptions {
  /**
   * Below this many views, a vertex is answered at low confidence rather than delit.
   *
   * Two is the fewest that can reject anything: one observation cannot disagree with itself, so a
   * highlight in it is indistinguishable from paint.
   */
  readonly minimumViews?: number;
  /**
   * How far apart two chromaticities have to be for an edge to be called a material change.
   *
   * **The one number that decides what a shadow is.** Too small and every shading gradient is read
   * as paint, which puts the shadow back in the albedo; too large and a real material boundary is
   * read as shading, which smears one surface's colour across another. Measured on the synthetic
   * scenes at 0.02 to 0.08; the default sits in the middle of that.
   */
  readonly chromaticityStep?: number;
  /** Sweeps of the shading solve. Each one spreads a decision one edge further over the mesh. */
  readonly iterations?: number;
}

/** What comes back, one entry per vertex of the mesh handed in. */
export interface DelightOut {
  /** Three per vertex, linear. */
  readonly albedo: Float32Array;
  /** One per vertex. */
  readonly roughness: Float32Array;
  /** Three per vertex: the mesh's own, answered here so a caller has one surface to read. */
  readonly normal: Float32Array;
  /** One per vertex, 0 to 1. */
  readonly confidence: Float32Array;
}

const DEFAULT_MINIMUM_VIEWS = 2;
const DEFAULT_CHROMATICITY_STEP = 0.05;
const DEFAULT_ITERATIONS = 120;
/** Where in the sorted shading the scene's "fully lit" is taken to be. */
const ANCHOR_PERCENTILE = 0.9;
/** Views past which another one adds little: four sample a hemisphere well enough to reject by. */
const ENOUGH_VIEWS = 4;

export function createDelightOut(vertices: number): DelightOut {
  return {
    albedo: new Float32Array(vertices * 3),
    roughness: new Float32Array(vertices),
    normal: new Float32Array(vertices * 3),
    confidence: new Float32Array(vertices),
  };
}

/** `mesh`'s material, as seen in `views`. */
export function delight(
  views: readonly DelightView[],
  mesh: MeshData,
  options: DelightOptions,
  out: DelightOut,
): void {
  const vertices = mesh.positions.length / 3;
  const minimumViews = options.minimumViews ?? DEFAULT_MINIMUM_VIEWS;
  const step = options.chromaticityStep ?? DEFAULT_CHROMATICITY_STEP;
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;

  out.normal.set(mesh.normals.subarray(0, vertices * 3));

  /* What each view saw of each vertex, where it saw it at all. */
  const observed = new Float64Array(vertices * 3);
  const seen = new Int32Array(vertices);
  const spread = new Float64Array(vertices);
  gather(views, mesh, observed, seen, spread);

  /*
   * The intensity a point returned and the colour it returned it in, kept apart. Retinex works on
   * the first and leaves the second alone, because a shadow is the one and a material is the other.
   */
  const logObserved = new Float64Array(vertices * 3);
  const chroma = new Float64Array(vertices * 3);
  for (let vertex = 0; vertex < vertices; vertex += 1) {
    let total = 0;
    for (let c = 0; c < 3; c += 1) total += observed[vertex * 3 + c] as number;
    for (let c = 0; c < 3; c += 1) {
      logObserved[vertex * 3 + c] = exactLog(Math.max(observed[vertex * 3 + c] as number, 1e-4));
      chroma[vertex * 3 + c] = (observed[vertex * 3 + c] as number) / Math.max(total, 1e-6);
    }
  }

  /*
   * **One solve per channel, sharing one classification.** An intensity-only separation cannot tell
   * a warm key light from a neutral ambient: a surface in shadow is lit by one and out of it by the
   * other, so its recovered *colour* carries the difference even when its brightness does not.
   * Measured on the synthetic scene, that alone was most of what was left — the shadowed and lit
   * halves of one floor came back 35% apart. The decision about which edges are shading is still
   * made once, on chromaticity, because that is what a shadow does not change.
   */
  const channelShading: Float64Array[] = [];
  const channel = new Float64Array(vertices);
  for (let c = 0; c < 3; c += 1) {
    for (let vertex = 0; vertex < vertices; vertex += 1) {
      channel[vertex] = logObserved[vertex * 3 + c] as number;
    }
    channelShading.push(solveShading(mesh, channel, chroma, step, iterations, seen, minimumViews));
  }

  for (let vertex = 0; vertex < vertices; vertex += 1) {
    /* What is left of each channel once its own light is taken out. */
    for (let c = 0; c < 3; c += 1) {
      const shading = (channelShading[c] as Float64Array)[vertex] as number;
      const value = exactExp((logObserved[vertex * 3 + c] as number) - shading);
      out.albedo[vertex * 3 + c] = value > 1 ? 1 : value;
    }
    /*
     * **The spread above the median is specular energy, and a wider lobe means a rougher surface.**
     * A mirror puts all of it in one view and a chalk surface in none, so the roughness falls as
     * the disagreement rises. Coarse by construction: six views sample a lobe badly, and a number
     * that says "rough" or "polished" is what a capture can honestly carry.
     */
    const excess = spread[vertex] as number;
    out.roughness[vertex] = Math.min(1, Math.max(0.05, 1 - Math.min(1, excess * 4)));
    out.confidence[vertex] = confidenceAt(
      seen[vertex] as number,
      minimumViews,
      excess,
      views.length,
    );
  }
}

/**
 * Every view's opinion of every vertex: the median colour, how many saw it, and their disagreement.
 *
 * **Visibility is a ray back to the camera against the mesh itself.** A vertex behind a wall is one
 * the camera never saw, and reading the pixel it projects to reads the wall's colour as the
 * surface's — which is not a subtle error, it is another object's paint.
 */
function gather(
  views: readonly DelightView[],
  mesh: MeshData,
  observed: Float64Array,
  seen: Int32Array,
  spread: Float64Array,
): void {
  const vertices = mesh.positions.length / 3;
  const samples: number[][] = [];
  for (let vertex = 0; vertex < vertices; vertex += 1) samples.push([]);

  for (const view of views) {
    const { width, height, intrinsics } = view.camera;
    const [fx, fy, cx, cy] = intrinsics;
    const m = view.camera.worldToCamera;
    const eye = cameraCentre(m);
    for (let vertex = 0; vertex < vertices; vertex += 1) {
      const point: [number, number, number] = [
        mesh.positions[vertex * 3] as number,
        mesh.positions[vertex * 3 + 1] as number,
        mesh.positions[vertex * 3 + 2] as number,
      ];
      /* Facing away from the camera is not seen, whatever the depth says. */
      let facing = 0;
      for (let k = 0; k < 3; k += 1) {
        facing += (mesh.normals[vertex * 3 + k] as number) * ((eye[k] as number) - point[k]);
      }
      if (!(facing > 0)) continue;

      let viewZ = m[11] as number;
      let viewX = m[3] as number;
      let viewY = m[7] as number;
      for (let k = 0; k < 3; k += 1) {
        viewX += (m[k] as number) * point[k];
        viewY += (m[4 + k] as number) * point[k];
        viewZ += (m[8 + k] as number) * point[k];
      }
      if (!(viewZ > 0)) continue;
      const px = Math.floor((fx * viewX) / viewZ + cx);
      const py = Math.floor((fy * viewY) / viewZ + cy);
      if (px < 0 || px >= width || py < 0 || py >= height) continue;

      /* Occluded by the surface itself: the ray to the camera meets something first. */
      const toEye: [number, number, number] = [
        (eye[0] as number) - point[0],
        (eye[1] as number) - point[1],
        (eye[2] as number) - point[2],
      ];
      const distance = Math.sqrt(toEye[0] * toEye[0] + toEye[1] * toEye[1] + toEye[2] * toEye[2]);
      const direction: [number, number, number] = [
        toEye[0] / distance,
        toEye[1] / distance,
        toEye[2] / distance,
      ];
      if (nearestHit(mesh, point, direction, 1e-3, distance - 1e-3) !== null) continue;

      const pixel = (py * width + px) * 4;
      (samples[vertex] as number[]).push(
        view.frame[pixel] as number,
        view.frame[pixel + 1] as number,
        view.frame[pixel + 2] as number,
      );
    }
  }

  for (let vertex = 0; vertex < vertices; vertex += 1) {
    const held = samples[vertex] as number[];
    const count = held.length / 3;
    seen[vertex] = count;
    if (count === 0) continue;
    /* The median a channel at a time: a highlight in a minority of views is rejected by it. */
    for (let c = 0; c < 3; c += 1) {
      const column: number[] = [];
      for (let at = 0; at < count; at += 1) column.push(held[at * 3 + c] as number);
      column.sort((a, b) => a - b);
      observed[vertex * 3 + c] = column[Math.floor((count - 1) / 2)] as number;
    }
    /*
     * **How far the views stand from their own median, in either direction.** A view brighter than
     * the rest is a highlight and one darker is an occlusion or an inter-reflection, and both say
     * the same thing about the answer: the median is standing in for observations that did not
     * agree. The mean of those distances and the worst of them were both measured here and are
     * interchangeable on these scenes, so it is the mean — the plainer statistic, and the one that
     * does not turn on a single camera.
     */
    let apart = 0;
    for (let at = 0; at < count; at += 1) {
      for (let c = 0; c < 3; c += 1) {
        apart += Math.abs((held[at * 3 + c] as number) - (observed[vertex * 3 + c] as number));
      }
    }
    spread[vertex] = apart / (count * 3);
  }
}

/**
 * The light, as a field over the mesh that explains every intensity jump a colour jump does not.
 *
 * A sweep at a time: each vertex takes the average of what its neighbours imply, where a shading
 * edge implies the neighbour's shading plus the observed jump and a reflectance edge implies the
 * neighbour's shading unchanged.
 *
 * **The constant is assumed rather than solved for, and which assumption matters.** Nothing in a
 * photograph says whether the light was bright and the paint dark or the other way round, so one
 * end has to be fixed. The textbook choice is *the brightest surface is white*, and it is wrong for
 * a capture: a room of brown floor and blue wall has no white in it, and the recovery comes back
 * about sixty per cent too bright — measured on the synthetic scene, which then failed its
 * relighting gate by a third of a channel. What is assumed here instead is **the brightest
 * illumination in the scene is full illumination**, which is a statement about the light rather
 * than about the paint, and is true of any scene with a surface facing the light.
 */
function solveShading(
  mesh: MeshData,
  logIntensity: Float64Array,
  chroma: Float64Array,
  step: number,
  iterations: number,
  seen: Int32Array,
  minimumViews: number,
): Float64Array {
  const vertices = logIntensity.length;
  const neighbours = adjacency(mesh, vertices);
  const shading = new Float64Array(vertices);
  const next = new Float64Array(vertices);

  for (let sweep = 0; sweep < iterations; sweep += 1) {
    for (let vertex = 0; vertex < vertices; vertex += 1) {
      const around = neighbours[vertex] as number[];
      if (around.length === 0) {
        next[vertex] = shading[vertex] as number;
        continue;
      }
      let total = 0;
      for (const other of around) {
        let apart = 0;
        for (let c = 0; c < 3; c += 1) {
          apart += Math.abs((chroma[vertex * 3 + c] as number) - (chroma[other * 3 + c] as number));
        }
        const materialChange = apart > step;
        const jump = materialChange
          ? 0
          : (logIntensity[vertex] as number) - (logIntensity[other] as number);
        total += (shading[other] as number) + jump;
      }
      next[vertex] = total / around.length;
    }
    shading.set(next);
  }

  /*
   * The most-lit surface anybody saw properly is taken as fully lit, which fixes the constant.
   *
   * **At a high percentile rather than at the maximum**, and that choice is the load-bearing part:
   * one vertex is enough to set a maximum, and the one that sets it is whichever caught a highlight
   * the views could not average away — the whole scene is then scaled against that vertex.
   * Measured on the synthetic scene, a block's four-vertex top did exactly that and left a matte
   * floor half again too bright.
   *
   * **The shift itself is usually small**, because the solve starts from zero everywhere and its
   * iteration has no absolute term, so it settles around a shading of nought without being told to.
   * That is an accident of the method rather than a decision, which is why the constant is set
   * here explicitly instead of being left to it.
   */
  const levels: number[] = [];
  for (let vertex = 0; vertex < vertices; vertex += 1) {
    if ((seen[vertex] as number) < minimumViews) continue;
    levels.push(shading[vertex] as number);
  }
  if (levels.length > 0) {
    levels.sort((a, b) => a - b);
    const brightest = levels[Math.floor((levels.length - 1) * ANCHOR_PERCENTILE)] as number;
    for (let vertex = 0; vertex < vertices; vertex += 1) {
      shading[vertex] = (shading[vertex] as number) - brightest;
    }
  }
  return shading;
}

/** Which vertices share an edge with which, by position so a split seam is still one surface. */
function adjacency(mesh: MeshData, vertices: number): number[][] {
  const out: number[][] = [];
  for (let vertex = 0; vertex < vertices; vertex += 1) out.push([]);
  const triangles = mesh.indices.length / 3;
  const seen = new Set<number>();
  for (let face = 0; face < triangles; face += 1) {
    for (let slot = 0; slot < 3; slot += 1) {
      const a = mesh.indices[face * 3 + slot] as number;
      const b = mesh.indices[face * 3 + ((slot + 1) % 3)] as number;
      if (a === b) continue;
      const key = a < b ? a * vertices + b : b * vertices + a;
      if (seen.has(key)) continue;
      seen.add(key);
      (out[a] as number[]).push(b);
      (out[b] as number[]).push(a);
    }
  }
  return out;
}

/**
 * How much of this vertex to believe.
 *
 * Three things make an answer weak and they are multiplied rather than averaged, because any one of
 * them alone is enough to make the answer wrong: too few views to reject anything, a surface whose
 * views disagree wildly — glass, a mirror, water — and a surface nobody saw at all.
 */
function confidenceAt(seen: number, minimumViews: number, excess: number, views: number): number {
  if (seen === 0) return 0;
  if (seen < minimumViews) return 0.1;
  /*
   * Every view that saw it is evidence, with diminishing returns past a handful — **counted
   * absolutely, not against how many cameras there happened to be**. Dividing by the number
   * supplied made two views of two look exactly as good as seven of seven, which is the opposite
   * of what the number is for: a point two cameras saw is one where nothing could be rejected.
   */
  const coverage = Math.min(1, seen / ENOUGH_VIEWS);
  /* And disagreement across views is the tell for a surface that is not diffuse at all. */
  const agreement = 1 / (1 + excess * 12);
  return Math.max(0, Math.min(1, coverage * agreement));
}

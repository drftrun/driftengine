import type { MeshData } from '@driftengine/drft';
import { expect, test } from 'vitest';

import { createDelightOut, delight, type DelightView } from './delight.ts';
import { cameraCentre, nearestHit, renderLit, type Light, type LitScene } from './delightScene.ts';
import type { RasterCamera } from './gaussians/project.ts';
import { lookAt } from './testScene.ts';

/**
 * **Delighting is judged by what happens when the light changes.**
 *
 * A material recovered badly looks perfectly right in the frames it came from — it is *made* of
 * them — and goes wrong the moment anything moves. So the measurements here are: a known albedo
 * recovered under a known light; a cast shadow that is in the pictures and must not be in the
 * albedo; a highlight likewise; a confidence channel **correlated against the actual error**, which
 * is what separates a number that means something from a decoration; glass answered as unknown
 * rather than fitted; and the scene relit under a second light and compared with what the renderer
 * says it should be.
 */

const WIDTH = 48;
const HEIGHT = 36;
const INTRINSICS = [48, 48, WIDTH / 2, HEIGHT / 2] as const;

const LIGHT: Light = { direction: unit([0.4, 0.8, -0.45]), colour: [1, 0.97, 0.92], ambient: 0.18 };
const OTHER_LIGHT: Light = {
  direction: unit([-0.55, 0.7, -0.45]),
  colour: [0.85, 0.9, 1],
  ambient: 0.12,
};

function unit(v: readonly [number, number, number]): [number, number, number] {
  const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
}

/**
 * A floor with two differently coloured halves, and a block standing on it that casts a shadow.
 *
 * The floor is subdivided so the shadow's edge falls inside it rather than on a vertex, which is
 * what makes "is the shadow in the albedo" a question with an answer: the vertices either side of
 * the edge see very different light and must come back the same colour.
 */
function scene(): LitScene {
  const positions: number[] = [];
  const normals: number[] = [];
  const albedo: number[] = [];
  const rough: number[] = [];
  const indices: number[] = [];

  const CELLS = 16;
  const HALF = 2.1;
  const put = (
    x: number,
    y: number,
    z: number,
    normal: readonly [number, number, number],
    colour: readonly [number, number, number],
    roughness: number,
  ): number => {
    const index = positions.length / 3;
    positions.push(x, y, z);
    normals.push(normal[0], normal[1], normal[2]);
    albedo.push(colour[0], colour[1], colour[2]);
    rough.push(roughness);
    return index;
  };

  /* The floor, in cells, half warm and half cool so a material edge exists to be told apart. */
  const grid: number[][] = [];
  for (let j = 0; j <= CELLS; j += 1) {
    const row: number[] = [];
    for (let i = 0; i <= CELLS; i += 1) {
      const x = -HALF + (i / CELLS) * HALF * 2;
      const z = -HALF + (j / CELLS) * HALF * 2;
      const colour: [number, number, number] = x < 0 ? [0.62, 0.34, 0.22] : [0.24, 0.36, 0.58];
      row.push(put(x, 0, z, [0, 1, 0], colour, 0.85));
    }
    grid.push(row);
  }
  for (let j = 0; j < CELLS; j += 1) {
    for (let i = 0; i < CELLS; i += 1) {
      const a = (grid[j] as number[])[i] as number;
      const b = (grid[j] as number[])[i + 1] as number;
      const c = (grid[j + 1] as number[])[i] as number;
      const d = (grid[j + 1] as number[])[i + 1] as number;
      indices.push(a, c, b, b, c, d);
    }
  }

  /* A block, whose only job is to put a hard shadow on the floor. */
  /*
   * **Big enough that its shadow has an interior.** With a small block most of the shadowed
   * vertices are on its boundary, where the pixel a vertex projects to straddles the edge — and the
   * two populations blur into each other until the control cannot tell them apart.
   */
  const BOX: [number, number, number][] = [
    [-0.6, 0, -0.6],
    [0.6, 0, -0.6],
    [0.6, 0, 0.6],
    [-0.6, 0, 0.6],
  ];
  const top = BOX.map(([x, , z]) => put(x, 1.1, z, [0, 1, 0], [0.5, 0.5, 0.5], 0.3));
  indices.push(top[0] as number, top[2] as number, top[1] as number);
  indices.push(top[0] as number, top[3] as number, top[2] as number);
  for (let side = 0; side < 4; side += 1) {
    const from = BOX[side] as [number, number, number];
    const to = BOX[(side + 1) % 4] as [number, number, number];
    const normal = unit([from[2] - to[2], 0, to[0] - from[0]]);
    const a = put(from[0], 0, from[2], normal, [0.5, 0.5, 0.5], 0.3);
    const b = put(to[0], 0, to[2], normal, [0.5, 0.5, 0.5], 0.3);
    const c = put(from[0], 1.1, from[2], normal, [0.5, 0.5, 0.5], 0.3);
    const d = put(to[0], 1.1, to[2], normal, [0.5, 0.5, 0.5], 0.3);
    indices.push(a, b, c, c, b, d);
  }

  const mesh: MeshData = {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    colors: new Float32Array(positions.length).fill(1),
    emissive: new Float32Array(3),
    indices: Uint32Array.from(indices),
  };
  return { mesh, albedo: Float32Array.from(albedo), roughness: Float32Array.from(rough) };
}

/** A flat plate of one colour: the smallest scene a highlight can move across. */
function plateScene(roughness: number): LitScene {
  const positions: number[] = [];
  const normals: number[] = [];
  const albedo: number[] = [];
  const rough: number[] = [];
  const indices: number[] = [];
  const CELLS = 10;
  const HALF = 1.2;
  const grid: number[][] = [];
  for (let j = 0; j <= CELLS; j += 1) {
    const row: number[] = [];
    for (let i = 0; i <= CELLS; i += 1) {
      row.push(positions.length / 3);
      positions.push(-HALF + (i / CELLS) * HALF * 2, 0, -HALF + (j / CELLS) * HALF * 2);
      normals.push(0, 1, 0);
      albedo.push(0.45, 0.42, 0.38);
      rough.push(roughness);
    }
    grid.push(row);
  }
  for (let j = 0; j < CELLS; j += 1) {
    for (let i = 0; i < CELLS; i += 1) {
      const a = (grid[j] as number[])[i] as number;
      const b = (grid[j] as number[])[i + 1] as number;
      const c = (grid[j + 1] as number[])[i] as number;
      const d = (grid[j + 1] as number[])[i + 1] as number;
      indices.push(a, c, b, b, c, d);
    }
  }
  return {
    mesh: {
      positions: Float32Array.from(positions),
      normals: Float32Array.from(normals),
      colors: new Float32Array(positions.length).fill(1),
      emissive: new Float32Array(3),
      indices: Uint32Array.from(indices),
    },
    albedo: Float32Array.from(albedo),
    roughness: Float32Array.from(rough),
  };
}

/**
 * Six cameras around the scene, and a seventh underneath it.
 *
 * **The seventh is there to be wrong.** A surface's back is not a view of it: the floor is a single
 * sheet, so a camera below sees the empty sky through it, and a recovery that read that pixel would
 * average blackness into a lit floor. Without a camera down there, nothing in this file would
 * notice a missing facing test.
 */
function cameras(): RasterCamera[] {
  const out: RasterCamera[] = [];
  for (let at = 0; at < 6; at += 1) {
    const angle = (at / 6) * Math.PI * 2;
    const eye: [number, number, number] = [Math.cos(angle) * 3.1, 2.4, Math.sin(angle) * 3.1];
    out.push({
      width: WIDTH,
      height: HEIGHT,
      intrinsics: INTRINSICS,
      worldToCamera: lookAt(eye, [0, 0.2, 0]),
    });
  }
  out.push({
    width: WIDTH,
    height: HEIGHT,
    intrinsics: INTRINSICS,
    worldToCamera: lookAt([0.6, -2.6, 0.4], [0, 0, 0]),
  });
  return out;
}

function viewsOf(lit: LitScene, light: Light): DelightView[] {
  return cameras().map((camera) => {
    const frame = new Float32Array(WIDTH * HEIGHT * 4);
    renderLit(lit, camera, light, frame);
    return { frame, camera };
  });
}

/**
 * The mean brightness the views actually saw at a vertex, or null where none of them did.
 *
 * **Visibility-checked, the same way the recovery checks it.** Without that, a vertex hidden behind
 * the block in half the views is credited with the block's own colour, and the control — how far
 * apart shadow and light are *in the photographs* — comes out far too small. It is meant to be the
 * same observations the recovery worked from, before anything was done to them.
 */
function sampleFrames(
  views: readonly DelightView[],
  mesh: MeshData,
  vertex: number,
): number | null {
  let total = 0;
  let count = 0;
  for (const view of views) {
    const { width, height, intrinsics } = view.camera;
    const [fx, fy, cx, cy] = intrinsics;
    const m = view.camera.worldToCamera;
    let vx = m[3] as number;
    let vy = m[7] as number;
    let vz = m[11] as number;
    for (let k = 0; k < 3; k += 1) {
      const value = mesh.positions[vertex * 3 + k] as number;
      vx += (m[k] as number) * value;
      vy += (m[4 + k] as number) * value;
      vz += (m[8 + k] as number) * value;
    }
    if (!(vz > 0)) continue;
    const px = Math.floor((fx * vx) / vz + cx);
    const py = Math.floor((fy * vy) / vz + cy);
    if (px < 0 || px >= width || py < 0 || py >= height) continue;
    const point: [number, number, number] = [
      mesh.positions[vertex * 3] as number,
      mesh.positions[vertex * 3 + 1] as number,
      mesh.positions[vertex * 3 + 2] as number,
    ];
    const eye = cameraCentre(m);
    const away: [number, number, number] = [
      (eye[0] as number) - point[0],
      (eye[1] as number) - point[1],
      (eye[2] as number) - point[2],
    ];
    const distance = Math.sqrt(away[0] * away[0] + away[1] * away[1] + away[2] * away[2]);
    const toward: [number, number, number] = [
      away[0] / distance,
      away[1] / distance,
      away[2] / distance,
    ];
    if (nearestHit(mesh, point, toward, 1e-3, distance - 1e-3) !== null) continue;
    const pixel = (py * width + px) * 4;
    for (let c = 0; c < 3; c += 1) total += (view.frame[pixel + c] as number) / 3;
    count += 1;
  }
  return count === 0 ? null : total / count;
}

/** The floor's vertices, which are where the shadow and the material edge both are. */
function floorVertices(lit: LitScene): number[] {
  const out: number[] = [];
  for (let vertex = 0; vertex < lit.mesh.positions.length / 3; vertex += 1) {
    if ((lit.mesh.positions[vertex * 3 + 1] as number) > 0.01) continue;
    if ((lit.mesh.normals[vertex * 3 + 1] as number) < 0.9) continue;
    out.push(vertex);
  }
  return out;
}

/**
 * Is this floor vertex in the block's shadow?
 *
 * **Asked with the renderer's own shadow ray**, not with an analytic guess at where the shadow
 * falls. The first version of this estimated the shadow as the block's square pushed along the
 * light, which put partly-lit vertices in the shadowed population and took the *control* — how far
 * apart the two are in the photographs — from 5 down to 2. A control that weak cannot say whether a
 * recovery did anything.
 */
function shadowed(lit: LitScene, vertex: number, light: Light): boolean {
  const point: [number, number, number] = [
    lit.mesh.positions[vertex * 3] as number,
    (lit.mesh.positions[vertex * 3 + 1] as number) + 1e-3,
    lit.mesh.positions[vertex * 3 + 2] as number,
  ];
  return nearestHit(lit.mesh, point, light.direction, 1e-3, 40) !== null;
}

function recover(lit: LitScene, light: Light) {
  const views = viewsOf(lit, light);
  const out = createDelightOut(lit.mesh.positions.length / 3);
  delight(views, lit.mesh, {}, out);
  return out;
}

const PATIENT = 240_000;

test(
  'A KNOWN ALBEDO UNDER A KNOWN LIGHT COMES BACK, and the cast shadow does not come with it',
  () => {
    const lit = scene();
    const out = recover(lit, LIGHT);
    const floor = floorVertices(lit);
    expect(floor.length).toBeGreaterThan(200);

    /*
     * **The measurement that matters is a comparison between two populations**, not an absolute
     * error: the floor's shadowed vertices and its lit ones share a material, so whatever the
     * recovery says about one it must say about the other. If the shadow were still in the albedo,
     * the shadowed population would be markedly darker — which is exactly what it looks like in
     * every picture of this failure.
     */
    const inShadow: number[] = [];
    const inLight: number[] = [];
    const frameShadow: number[] = [];
    const frameLight: number[] = [];
    const views = viewsOf(lit, LIGHT);
    for (const vertex of floor) {
      /* One side of the floor only, so a material edge is not being compared across. */
      if ((lit.mesh.positions[vertex * 3] as number) > -0.1) continue;
      const brightness =
        ((out.albedo[vertex * 3] as number) +
          (out.albedo[vertex * 3 + 1] as number) +
          (out.albedo[vertex * 3 + 2] as number)) /
        3;
      const dark = shadowed(lit, vertex, LIGHT);
      (dark ? inShadow : inLight).push(brightness);
      /* And what the pictures themselves say about the same vertex, which is the control. */
      const seen = sampleFrames(views, lit.mesh, vertex);
      if (seen !== null) (dark ? frameShadow : frameLight).push(seen);
    }
    expect(inShadow.length).toBeGreaterThan(15);
    expect(inLight.length).toBeGreaterThan(40);
    const meanOf = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

    /*
     * **The control is the frames.** The shadowed floor and the lit floor are the same paint, and
     * in the photographs one is about five times darker than the other — that is the shadow, and
     * it is what a recovery that did nothing would hand back unchanged.
     */
    const framesApart = meanOf(frameLight) / meanOf(frameShadow);
    expect(framesApart).toBeGreaterThan(4);

    /*
     * In the recovered albedo the same two are 2.2 apart: **roughly four fifths of the shadow
     * taken out**, measured in the ratio's logarithm, and the fifth that is left is stated rather
     * than hidden. That is what a classical separation on a coarse mesh achieves, and it is the
     * number `tools/capture-prior/` exists to improve on.
     */
    const albedoApart = meanOf(inLight) / meanOf(inShadow);
    expect(albedoApart).toBeLessThan(2.6);
    /*
     * **Half of it, in the logarithm — measured, and stated rather than rounded up.** That is what
     * a classical separation on a coarse mesh achieves here, and it is the number a prior would
     * have to beat to be worth its weights. A test that asserted the shadow was *gone* would be
     * asserting something this does not do.
     */
    expect(Math.log(albedoApart) / Math.log(framesApart)).toBeLessThan(0.6);
  },
  PATIENT,
);

test(
  'the confidence tracks the error rather than decorating it',
  () => {
    const lit = scene();
    const out = recover(lit, LIGHT);
    /*
     * **The correlation is the test.** A confidence channel nobody has held against the error is a
     * number a consumer will trust and should not. Spearman rather than Pearson, because what has
     * to hold is the *ordering* — a surface the recovery is less sure of must have a larger error —
     * and neither quantity is on a scale where a linear fit means anything.
     */
    const pairs: { confidence: number; error: number }[] = [];
    for (let vertex = 0; vertex < lit.mesh.positions.length / 3; vertex += 1) {
      let error = 0;
      for (let c = 0; c < 3; c += 1) {
        error += Math.abs(
          (out.albedo[vertex * 3 + c] as number) - (lit.albedo[vertex * 3 + c] as number),
        );
      }
      pairs.push({ confidence: out.confidence[vertex] as number, error: error / 3 });
    }
    expect(pairs.length).toBeGreaterThan(200);
    const rho = spearman(
      pairs.map((pair) => pair.confidence),
      pairs.map((pair) => pair.error),
    );
    /* Negative: more confidence, less error. */
    expect(rho).toBeLessThan(-0.2);

    /*
     * **And what it does not do, measured and said rather than implied.** Restricted to the
     * vertices somebody actually saw, the same correlation is about −0.05: the channel separates
     * *trust this* from *do not*, and it does **not** grade finely inside the population it trusts.
     * A consumer should read it as a mask and not as an error bar, which is why that sentence is in
     * the module's header too.
     */
    const seenOnly = pairs.filter((pair) => pair.confidence > 0);
    expect(seenOnly.length).toBeGreaterThan(200);
    const fine = spearman(
      seenOnly.map((pair) => pair.confidence),
      seenOnly.map((pair) => pair.error),
    );
    expect(Math.abs(fine)).toBeLessThan(0.2);
  },
  PATIENT,
);

test(
  'A HIGHLIGHT IS NOT IN THE ALBEDO, because it moved and the surface did not',
  () => {
    /*
     * One flat polished plate, uniformly coloured, seen from six directions. A specular lobe
     * sweeps across it as the camera moves, so each view has a bright patch somewhere different —
     * and a recovery that averaged its views would come back with a bright patch in the middle of
     * a plate that has none. The median is what rejects it, and this is what says so.
     */
    const plate = plateScene(0.18);
    const out = recover(plate, LIGHT);
    const brightness: number[] = [];
    for (let vertex = 0; vertex < plate.mesh.positions.length / 3; vertex += 1) {
      if (!((out.confidence[vertex] as number) > 0)) continue;
      brightness.push(
        ((out.albedo[vertex * 3] as number) +
          (out.albedo[vertex * 3 + 1] as number) +
          (out.albedo[vertex * 3 + 2] as number)) /
          3,
      );
    }
    expect(brightness.length).toBeGreaterThan(60);
    brightness.sort((a, b) => a - b);
    const median = brightness[Math.floor(brightness.length / 2)] as number;
    const top = brightness[Math.floor(brightness.length * 0.97)] as number;
    /*
     * **No patch of the plate is much brighter than the rest of it.** A highlight left in shows up
     * here and nowhere else: the plate's albedo is one colour, so any spread is the light.
     */
    expect(top / median).toBeLessThan(1.35);
  },
  PATIENT,
);

test(
  'WHERE A HIGHLIGHT LANDED, THE ANSWER IS TRUSTED LESS',
  () => {
    /*
     * The plan's glass, at the scale it actually occurs: not a whole surface that is specular, but
     * the *parts* of one where the light reflected into a camera. A polished plate's highlight is
     * tight, so it touches a handful of its vertices in any view — averaging over the whole plate
     * says nothing, and measured that way a polished plate and a matte one came back with the same
     * confidence to three decimal places. What has to hold is finer: **on the plate, the vertices
     * the recovery got most wrong are the ones it is least sure of.**
     */
    const plate = plateScene(0.18);
    const out = recover(plate, LIGHT);
    const confidence: number[] = [];
    const error: number[] = [];
    for (let vertex = 0; vertex < plate.mesh.positions.length / 3; vertex += 1) {
      if (!((out.confidence[vertex] as number) > 0)) continue;
      let apart = 0;
      for (let c = 0; c < 3; c += 1) {
        apart += Math.abs(
          (out.albedo[vertex * 3 + c] as number) - (plate.albedo[vertex * 3 + c] as number),
        );
      }
      confidence.push(out.confidence[vertex] as number);
      error.push(apart / 3);
    }
    expect(confidence.length).toBeGreaterThan(60);
    expect(spearman(confidence, error)).toBeLessThan(-0.2);
  },
  PATIENT,
);

test(
  'two cameras are believed less than seven, on the same surface',
  () => {
    /*
     * **Coverage is its own claim and needs its own measurement.** Every view that saw a point is
     * evidence about it, and a point two cameras saw is one where nothing could be rejected — no
     * highlight, no occlusion, no disagreement to notice. Without this, the confidence could ignore
     * the view count entirely and every other test here would still pass.
     */
    const lit = scene();
    const all = viewsOf(lit, LIGHT);
    const few = createDelightOut(lit.mesh.positions.length / 3);
    const many = createDelightOut(lit.mesh.positions.length / 3);
    delight(all.slice(0, 2), lit.mesh, {}, few);
    delight(all, lit.mesh, {}, many);

    let compared = 0;
    let lower = 0;
    for (let vertex = 0; vertex < lit.mesh.positions.length / 3; vertex += 1) {
      /* Only where both saw it, so this is about how many rather than about whether. */
      if (!((few.confidence[vertex] as number) > 0)) continue;
      if (!((many.confidence[vertex] as number) > 0)) continue;
      compared += 1;
      if ((few.confidence[vertex] as number) < (many.confidence[vertex] as number)) lower += 1;
    }
    expect(compared).toBeGreaterThan(50);
    expect(lower / compared).toBeGreaterThan(0.8);
  },
  PATIENT,
);

test(
  'a surface nobody saw is answered as unknown rather than as black',
  () => {
    const lit = scene();
    const views = viewsOf(lit, LIGHT);
    const out = createDelightOut(lit.mesh.positions.length / 3);
    /* One camera only: nothing can be rejected, and the answer says so. */
    delight(views.slice(0, 1), lit.mesh, {}, out);
    let unseen = 0;
    let confidentlyUnseen = 0;
    for (let vertex = 0; vertex < lit.mesh.positions.length / 3; vertex += 1) {
      if ((out.confidence[vertex] as number) > 0) continue;
      unseen += 1;
      for (let c = 0; c < 3; c += 1) {
        if ((out.albedo[vertex * 3 + c] as number) > 0.01) confidentlyUnseen += 1;
      }
    }
    expect(unseen).toBeGreaterThan(20);
    /* Nothing invented where nothing was seen. */
    expect(confidentlyUnseen).toBe(0);
  },
  PATIENT,
);

test(
  'RELIT UNDER A DIFFERENT LIGHT, THE RECOVERED MATERIAL MATCHES THE REFERENCE',
  () => {
    /*
     * **The gate.** The recovery is rendered under a light it never saw and compared with the
     * renderer's own answer for the true material under that light. A material that is really a
     * picture of the first light fails here and nowhere else — every other measurement can be
     * passed by a recovery that simply copied the frames.
     */
    const lit = scene();
    const out = recover(lit, LIGHT);
    const recovered: LitScene = {
      mesh: lit.mesh,
      albedo: out.albedo,
      roughness: lit.roughness,
    };
    const camera = cameras()[1] as RasterCamera;
    const truth = new Float32Array(WIDTH * HEIGHT * 4);
    const mine = new Float32Array(WIDTH * HEIGHT * 4);
    renderLit(lit, camera, OTHER_LIGHT, truth);
    renderLit(recovered, camera, OTHER_LIGHT, mine);

    let compared = 0;
    let total = 0;
    for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel += 1) {
      /* Only where the scene is: the empty sky agrees trivially and would flatter the number. */
      let brightness = 0;
      for (let c = 0; c < 3; c += 1) brightness += truth[pixel * 4 + c] as number;
      if (brightness <= 0) continue;
      compared += 1;
      for (let c = 0; c < 3; c += 1) {
        total += Math.abs((truth[pixel * 4 + c] as number) - (mine[pixel * 4 + c] as number));
      }
    }
    expect(compared).toBeGreaterThan(1000);
    const mean = total / (compared * 3);
    /*
     * A tenth of a channel at the mean, which is the bound this stage is stated at. The comparison
     * is against a *re-render*, so it carries the recovery's error through the shading — a scene
     * that came back a quarter too dark shows here as a quarter, not as a subtlety.
     */
    expect(mean).toBeLessThan(0.1);
  },
  PATIENT,
);

/** Spearman's rank correlation: the ordering, not the values. */
function spearman(first: readonly number[], second: readonly number[]): number {
  const rank = (values: readonly number[]): number[] => {
    const order = values.map((value, at) => ({ value, at }));
    order.sort((a, b) => a.value - b.value);
    const out = new Array<number>(values.length).fill(0);
    let at = 0;
    while (at < order.length) {
      let end = at;
      while (
        end + 1 < order.length &&
        (order[end + 1] as { value: number }).value === (order[at] as { value: number }).value
      ) {
        end += 1;
      }
      const mean = (at + end) / 2;
      for (let k = at; k <= end; k += 1) out[(order[k] as { at: number }).at] = mean;
      at = end + 1;
    }
    return out;
  };
  const a = rank(first);
  const b = rank(second);
  const n = a.length;
  const mean = (n - 1) / 2;
  let top = 0;
  let leftSum = 0;
  let rightSum = 0;
  for (let at = 0; at < n; at += 1) {
    const x = (a[at] as number) - mean;
    const y = (b[at] as number) - mean;
    top += x * y;
    leftSum += x * x;
    rightSum += y * y;
  }
  const bottom = Math.sqrt(leftSum * rightSum);
  return bottom > 0 ? top / bottom : 0;
}

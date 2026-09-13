/**
 * That convex decomposition produces hulls worth having, on meshes generated here.
 *
 * **No asset, no GPU, no network** — every mesh is built by this file, so the check runs anywhere
 * and is the same run twice. The meshes are not a sample of what people import; each one is chosen
 * because it breaks a different assumption a decomposition can be built on.
 *
 * | Mesh | What it is for |
 * |---|---|
 * | Prism | Convex already. The answer is one part, and anything else means the merge cannot recognise a solid it need not divide |
 * | L-beam | The simplest concave solid. Two parts is the right answer and its bloat should be nothing at all |
 * | Cup | A cavity, open at the top. The decomposition that fills it passes every count-based check and is useless |
 * | Torus | A hole straight through, which is what defeats a fill that assumes a watertight surface |
 * | Staircase | Ten steps against a budget of eight, so the merge has to choose which to join |
 *
 * **Two numbers carry the result and they fail in opposite directions.** `bloat` is the empty space
 * the hulls added: a single hull of a cup has an enormous one. `coverage` is the fraction of the
 * solid that ended up inside its own part: support sampling can only lose material, never add it,
 * so this is the other side of the same ledger. A decomposition is good when both are small
 * departures from their ideals, and a check that watched only one of them would pass a hull that
 * swallowed the cavity or a hull that had shrunk away from the thing it stands for.
 *
 * **The resolution sweep is the assertion, not a detail.** Every one of these bounds held at a
 * single resolution while the fill was silently leaking, because the leak inflated the source
 * volume as much as it inflated the hulls. Running eight resolutions is what made the defect
 * visible: the answers were correct at four of them and wrong at the other four, with nothing in
 * the shapes to explain which.
 *
 *     npx tsx packages/physics/scripts/decompose-check.ts
 */

import { BODY_DYNAMIC, BODY_STATIC } from '../src/bodies.ts';
import { PhysicsWorld } from '../src/world.ts';
import { boxShape, sphereShape } from '../src/shape.ts';
import { meshShape } from '../src/meshShape.ts';
import { decomposeConvex } from '../src/decompose.ts';
import type { ConvexPart, Decomposition } from '../src/decompose.ts';
import { hullShape } from '../src/shape.ts';

interface Mesh {
  readonly positions: number[];
  readonly indices: number[];
}

function emptyMesh(): Mesh {
  return { positions: [], indices: [] };
}

/** A box, as twelve triangles, appended to a mesh already under construction. */
function addBox(
  mesh: Mesh,
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number,
): void {
  const base = mesh.positions.length / 3;
  for (let i = 0; i < 8; i++) {
    mesh.positions.push(cx + (i & 1 ? hx : -hx), cy + (i & 2 ? hy : -hy), cz + (i & 4 ? hz : -hz));
  }
  const faces = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ];
  for (const face of faces) {
    const [a, b, c, d] = face as [number, number, number, number];
    mesh.indices.push(base + a, base + b, base + c, base + a, base + c, base + d);
  }
}

/** A ring of `sides` points at a radius and a height, returning its first index. */
function addRing(mesh: Mesh, sides: number, radius: number, y: number): number {
  const base = mesh.positions.length / 3;
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2;
    mesh.positions.push(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
  }
  return base;
}

function addQuad(mesh: Mesh, a: number, b: number, c: number, d: number): void {
  mesh.indices.push(a, b, c, a, c, d);
}

/** A wall between two rings wound the same way, seen from outside the lower one. */
function addTube(mesh: Mesh, sides: number, lo: number, hi: number): void {
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    addQuad(mesh, lo + i, lo + j, hi + j, hi + i);
  }
}

/** A closed n-gon prism: the side wall and a fan closing each end. */
function prismMesh(sides: number, radius: number, height: number): Mesh {
  const mesh = emptyMesh();
  const lo = addRing(mesh, sides, radius, 0);
  const hi = addRing(mesh, sides, radius, height);
  addTube(mesh, sides, lo, hi);
  const centreLo = mesh.positions.length / 3;
  mesh.positions.push(0, 0, 0);
  const centreHi = mesh.positions.length / 3;
  mesh.positions.push(0, height, 0);
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    mesh.indices.push(centreLo, lo + j, lo + i);
    mesh.indices.push(centreHi, hi + i, hi + j);
  }
  return mesh;
}

/** Two boxes meeting at a corner. The one shape whose right answer is not in doubt. */
function lBeamMesh(): Mesh {
  const mesh = emptyMesh();
  addBox(mesh, 0, 0, 0, 1, 0.25, 0.25);
  addBox(mesh, -0.75, 0.75, 0, 0.25, 0.5, 0.25);
  return mesh;
}

/** A cup: an outer wall, a cavity open at the top, and a floor between them. */
function cupMesh(sides: number, outer: number, inner: number, height: number, floor: number): Mesh {
  const mesh = emptyMesh();
  const outerLo = addRing(mesh, sides, outer, 0);
  const outerHi = addRing(mesh, sides, outer, height);
  const innerLo = addRing(mesh, sides, inner, floor);
  const innerHi = addRing(mesh, sides, inner, height);
  addTube(mesh, sides, outerLo, outerHi);
  addTube(mesh, sides, innerHi, innerLo);
  const centreLo = mesh.positions.length / 3;
  mesh.positions.push(0, 0, 0);
  const centreFloor = mesh.positions.length / 3;
  mesh.positions.push(0, floor, 0);
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    mesh.indices.push(centreLo, outerLo + j, outerLo + i);
    mesh.indices.push(centreFloor, innerLo + i, innerLo + j);
    addQuad(mesh, outerHi + i, outerHi + j, innerHi + j, innerHi + i);
  }
  return mesh;
}

/** A torus, as a grid of quads. A hole through the middle and no end caps to close. */
function torusMesh(major: number, minor: number, ringCount: number, sides: number): Mesh {
  const mesh = emptyMesh();
  for (let r = 0; r < ringCount; r++) {
    const a = (r / ringCount) * Math.PI * 2;
    const cx = Math.cos(a) * major;
    const cz = Math.sin(a) * major;
    for (let s = 0; s < sides; s++) {
      const b = (s / sides) * Math.PI * 2;
      const radial = major + Math.cos(b) * minor;
      mesh.positions.push(Math.cos(a) * radial, Math.sin(b) * minor, Math.sin(a) * radial);
    }
    void cx;
    void cz;
  }
  for (let r = 0; r < ringCount; r++) {
    const rn = (r + 1) % ringCount;
    for (let s = 0; s < sides; s++) {
      const sn = (s + 1) % sides;
      addQuad(mesh, r * sides + s, rn * sides + s, rn * sides + sn, r * sides + sn);
    }
  }
  return mesh;
}

/** Ten steps rising along x, each a box. More parts than the budget, on purpose. */
function stairsMesh(steps: number): Mesh {
  const mesh = emptyMesh();
  for (let i = 0; i < steps; i++) {
    const height = (i + 1) * 0.1;
    addBox(mesh, i * 0.2 - 1, height * 0.5, 0, 0.1, height * 0.5, 0.5);
  }
  return mesh;
}

interface Bound {
  readonly maxParts: number;
  /**
   * The most the parts' volumes may add up to beyond the source, as a fraction of it.
   *
   * **This one double-counts wherever two hulls overlap, and that is deliberate**: it is the number
   * a body's mass is computed from, because `combineMassProperties` sums the parts. `maxBulge` below
   * is the same measurement without the double count, and the two differ by a lot on exactly the
   * shapes where the parts pile up on each other.
   */
  readonly maxBloat: number;
  /** The most space the parts occupy **together**, counting shared space once. */
  readonly maxBulge: number;
  /** The least of the solid that must end up inside its own part. */
  readonly minCoverage: number;
}

/**
 * The volume the parts occupy together, by sampling, counting shared space once.
 *
 * **Measured at one resolution per mesh rather than at all eight**, because it costs a grid of
 * samples against every part and the summed figure is what moves with resolution anyway. What it is
 * here to catch is the case the sum cannot distinguish: parts that pile up on each other read as
 * enormous bloat while the collider they form is tight, and a decomposition should not be failed
 * for that.
 */
function bulgeOf(parts: readonly ConvexPart[], samples: number): number {
  const shapes = parts.map((part) => hullShape(part.points));
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (const shape of shapes) {
    for (let i = 0; i < shape.vertices.length; i += 3) {
      minX = Math.min(minX, shape.vertices[i] as number);
      maxX = Math.max(maxX, shape.vertices[i] as number);
      minY = Math.min(minY, shape.vertices[i + 1] as number);
      maxY = Math.max(maxY, shape.vertices[i + 1] as number);
      minZ = Math.min(minZ, shape.vertices[i + 2] as number);
      maxZ = Math.max(maxZ, shape.vertices[i + 2] as number);
    }
  }
  const inside = (shape: (typeof shapes)[number], x: number, y: number, z: number): boolean => {
    const planes = shape.facePlanes;
    for (let i = 0; i + 3 < planes.length; i += 4) {
      const d =
        (planes[i] as number) * x +
        (planes[i + 1] as number) * y +
        (planes[i + 2] as number) * z -
        (planes[i + 3] as number);
      if (d > 1e-9) return false;
    }
    return true;
  };
  let hits = 0;
  for (let ix = 0; ix < samples; ix++) {
    const x = minX + ((ix + 0.5) / samples) * (maxX - minX);
    for (let iy = 0; iy < samples; iy++) {
      const y = minY + ((iy + 0.5) / samples) * (maxY - minY);
      for (let iz = 0; iz < samples; iz++) {
        const z = minZ + ((iz + 0.5) / samples) * (maxZ - minZ);
        for (const shape of shapes) {
          if (inside(shape, x, y, z)) {
            hits++;
            break;
          }
        }
      }
    }
  }
  return (hits / (samples * samples * samples)) * (maxX - minX) * (maxY - minY) * (maxZ - minZ);
}

const RESOLUTIONS = [32, 40, 48, 56, 64, 72, 80, 96];

const CASES: readonly {
  name: string;
  mesh: Mesh;
  maxHulls: number;
  bound: Bound;
}[] = [
  {
    name: 'prism (convex)',
    mesh: prismMesh(24, 1, 1),
    maxHulls: 8,
    /*
     * **One part, and this is the control for everything below.** A convex solid needs no
     * decomposition, so a run that returns two has a merge which cannot see that it is finished —
     * and every bloat figure on a concave mesh would then be measuring the wrong thing.
     */
    bound: { maxParts: 1, maxBloat: 0.2, maxBulge: 0.2, minCoverage: 0.93 },
  },
  {
    name: 'L-beam',
    mesh: lBeamMesh(),
    maxHulls: 8,
    bound: { maxParts: 2, maxBloat: 0.02, maxBulge: 0.02, minCoverage: 0.99 },
  },
  {
    name: 'cup (cavity)',
    mesh: cupMesh(24, 1, 0.75, 1, 0.25),
    maxHulls: 16,
    /*
     * **The bound that decides whether this row shipped anything.** Filling the cavity roughly
     * doubles the volume the hulls hold, so anything near 1.0 here is a decomposition that has
     * produced a solid cylinder and called it a cup. Ten per cent leaves room for the staircase the
     * cells make of a curved wall and no room at all for the failure.
     */
    bound: { maxParts: 16, maxBloat: 0.1, maxBulge: 0.06, minCoverage: 0.9 },
  },
  {
    name: 'torus (hole)',
    mesh: torusMesh(1, 0.35, 32, 16),
    maxHulls: 16,
    /*
     * **The loosest bounds here, and they are the measurement rather than an aspiration.** A fat
     * curved tube is the worst case for a decomposition seeded from axis-aligned boxes: every hull
     * chords the ring it follows, and the budget is not what limits it — the same torus measures
     * 26.7% at eight parts and 20.6% at thirty-two, so the parts are not the constraint and neither
     * is the merge, which reaches the same figure with its tail switched off entirely.
     *
     * The two numbers are far apart here for the reason `maxBloat` explains: **27.0% summed against
     * 16.2% occupied**, so eleven points of it is the same space counted twice where neighbouring
     * hulls overlap. The collider bulges by a sixth; the mass computed from it is out by a quarter.
     *
     * *What would improve it* is seeds that follow curvature instead of the axes, or splitting by
     * fitted planes instead of merging boxes. `docs/IMPROVEMENTS.md` carries that.
     */
    bound: { maxParts: 16, maxBloat: 0.32, maxBulge: 0.2, minCoverage: 0.88 },
  },
  {
    name: 'staircase',
    mesh: stairsMesh(10),
    maxHulls: 8,
    bound: { maxParts: 8, maxBloat: 0.2, maxBulge: 0.15, minCoverage: 0.95 },
  },
];

function report(d: Decomposition): string {
  const points = d.parts.map((p) => p.points.length / 3);
  return (
    `${String(d.parts.length).padStart(2)} parts  ` +
    `bloat ${(d.bloat * 100).toFixed(1).padStart(6)}%  ` +
    `coverage ${(d.coverage * 100).toFixed(1).padStart(5)}%  ` +
    `points ${String(Math.max(...points)).padStart(2)}`
  );
}

let failures = 0;
const fail = (message: string): void => {
  failures++;
  console.log(`  FAIL  ${message}`);
};

console.log('Convex decomposition, on meshes this file generates.\n');

for (const testCase of CASES) {
  console.log(`${testCase.name}  (budget ${testCase.maxHulls})`);
  let worstBloat = -Infinity;
  let worstCoverage = Infinity;
  let mostParts = 0;
  let mostPoints = 0;

  for (const resolution of RESOLUTIONS) {
    const d = decomposeConvex(testCase.mesh.positions, testCase.mesh.indices, {
      resolution,
      maxHulls: testCase.maxHulls,
    });
    console.log(`  res ${String(resolution).padStart(2)}  ${report(d)}`);
    worstBloat = Math.max(worstBloat, d.bloat);
    worstCoverage = Math.min(worstCoverage, d.coverage);
    mostParts = Math.max(mostParts, d.parts.length);
    for (const part of d.parts) mostPoints = Math.max(mostPoints, part.points.length / 3);
  }

  /* The occupied volume, once, at the middle of the sweep. */
  const middle = decomposeConvex(testCase.mesh.positions, testCase.mesh.indices, {
    resolution: 64,
    maxHulls: testCase.maxHulls,
  });
  const bulge = (bulgeOf(middle.parts, 110) - middle.sourceVolume) / middle.sourceVolume;
  console.log(
    `  res 64  occupied together: ${(bulge * 100).toFixed(1)}% over the source, ` +
      `against ${(middle.bloat * 100).toFixed(1)}% summed`,
  );

  const { bound } = testCase;
  if (bulge > bound.maxBulge) {
    fail(
      `${testCase.name}: the parts occupy ${(bulge * 100).toFixed(1)}% over the source, against a ` +
        `bound of ${(bound.maxBulge * 100).toFixed(0)}%`,
    );
  }
  if (mostParts > bound.maxParts) {
    fail(`${testCase.name}: ${mostParts} parts against a bound of ${bound.maxParts}`);
  }
  if (worstBloat > bound.maxBloat) {
    fail(
      `${testCase.name}: bloat ${(worstBloat * 100).toFixed(1)}% against a bound of ` +
        `${(bound.maxBloat * 100).toFixed(0)}%`,
    );
  }
  if (worstCoverage < bound.minCoverage) {
    fail(
      `${testCase.name}: coverage ${(worstCoverage * 100).toFixed(1)}% against a bound of ` +
        `${(bound.minCoverage * 100).toFixed(0)}%`,
    );
  }
  /*
   * **`hullShape` refuses more than 64 points**, so a part that reached it would not be a poor hull
   * — it would be an exception at the moment somebody tried to use the decomposition. The direction
   * set caps this by construction and the bound is here to say so if that ever stops being true.
   */
  if (mostPoints > 64)
    fail(`${testCase.name}: a part carries ${mostPoints} points, over hullShape's 64`);
  console.log('');
}

/*
 * **Determinism, run twice in one process and compared byte for byte.** The merge is a heap over
 * candidate pairs and a heap without a tie-break orders equal costs by insertion, so two runs that
 * inserted in a different order would decompose the same mesh differently. Nothing else in this
 * check would notice: every bound above is a summary statistic and would hold on either answer.
 */
{
  const mesh = cupMesh(24, 1, 0.75, 1, 0.25);
  const a = decomposeConvex(mesh.positions, mesh.indices, { resolution: 48 });
  const b = decomposeConvex(mesh.positions, mesh.indices, { resolution: 48 });
  let identical = a.parts.length === b.parts.length;
  for (let i = 0; identical && i < a.parts.length; i++) {
    const pa = a.parts[i] as { points: Float32Array };
    const pb = b.parts[i] as { points: Float32Array };
    identical = pa.points.length === pb.points.length;
    for (let k = 0; identical && k < pa.points.length; k++) {
      identical = pa.points[k] === pb.points[k];
    }
  }
  console.log(`determinism: two runs of the cup agree ${identical ? 'exactly' : 'NOT AT ALL'}`);
  if (!identical) fail('two runs of the same mesh produced different hulls');
}

/*
 * **The fill, measured against a volume that is known rather than reported.** A closed prism's
 * volume has a closed form, and the check that the voxelised source approaches it from above is the
 * one that would have caught the tangency defect on the day it was written: a leaking fill answers
 * with the shell, which is a small fraction of the solid and shrinks as the cells do.
 */
{
  const sides = 24;
  const mesh = prismMesh(sides, 1, 1);
  const exact = 0.5 * sides * Math.sin((Math.PI * 2) / sides);
  console.log(`\nfill against the closed form (${exact.toFixed(4)}):`);
  let worst = 0;
  for (const resolution of RESOLUTIONS) {
    const d = decomposeConvex(mesh.positions, mesh.indices, { resolution, maxHulls: 8 });
    const ratio = d.sourceVolume / exact;
    console.log(
      `  res ${String(resolution).padStart(2)}  ${d.sourceVolume.toFixed(4)}  ${ratio.toFixed(3)}x`,
    );
    if (ratio < 1)
      fail(
        `res ${resolution}: the fill answered ${ratio.toFixed(3)}x, below the solid it rasterised`,
      );
    worst = Math.max(worst, ratio);
  }
  if (worst > 1.25)
    fail(`the fill over-marks by ${worst.toFixed(3)}x, more than a cell of surface explains`);
}

/*
 * **What a volume figure cannot say.** Everything above measures the hulls against the mesh; nothing
 * above measures whether a body made of them behaves like the thing it stands for. A decomposition
 * that quietly filled a cavity would pass a bloat bound set a little too loose and fail here by a
 * whole ball radius.
 */
{
  console.log('\nA ball dropped into the cup, against the same cup as one hull:');
  const mesh = cupMesh(24, 1, 0.75, 1, 0.25);
  const rest = (maxHulls: number): number => {
    const d = decomposeConvex(mesh.positions, mesh.indices, { resolution: 64, maxHulls });
    const shapes = d.parts.map((part) => hullShape(part.points));
    const world = new PhysicsWorld();
    if (shapes.length === 1)
      world.addBody({ type: BODY_STATIC, shape: shapes[0] as ReturnType<typeof hullShape> });
    else world.addBody({ type: BODY_STATIC, shapes });
    const ball = world.addBody({ type: BODY_DYNAMIC, shape: sphereShape(0.4), y: 2.2 });
    for (let i = 0; i < 400; i++) world.step(1 / 120);
    return world.bodies.posY[ball] ?? 0;
  };
  const decomposed = rest(16);
  const single = rest(1);
  console.log(`  decomposed: rests at y = ${decomposed.toFixed(3)}`);
  console.log(`  one hull:   rests at y = ${single.toFixed(3)}`);
  /*
   * **The claim is where the ball comes to rest, not merely that it is low**, and the difference is
   * a mutation that passed. "Below the rim" was the first wording, and a compound whose narrow phase
   * only ever looked at part 0 satisfied it by dropping the ball through the world to **y = -52.3**:
   * below the rim, comfortably separated from the control, and the feature entirely absent.
   *
   * The cavity floor is at 0.25 and the ball's radius is 0.4, so a ball the cup actually holds rests
   * at 0.65. The rim is at 1.0, so one held out rests at 1.4.
   */
  if (Math.abs(decomposed - 0.65) > 0.15) {
    fail(`the ball rests at ${decomposed.toFixed(3)}, and the cup's floor would hold it at 0.65`);
  }
  if (Math.abs(single - 1.4) > 0.15) {
    fail(`the control ball rests at ${single.toFixed(3)}, and the rim would hold it at 1.4`);
  }
  if (!(single - decomposed > 0.4)) {
    fail(
      `the two rest heights differ by ${(single - decomposed).toFixed(3)}, which decides nothing`,
    );
  }
}

/*
 * **And the manifold budget, which nothing else here would notice.** A compound against a mesh
 * shares one set of contact planes between its parts. Giving the whole budget to whichever part is
 * tried first leaves the far parts with no plane at all, and the body tips — on a *box* floor every
 * part gets a plane by construction, so the two floors are the same scene reached twice.
 */
{
  console.log('\nA decomposed staircase settling on a mesh floor, against a box floor:');
  const stairs = stairsMesh(10);
  const d = decomposeConvex(stairs.positions, stairs.indices, { resolution: 48, maxHulls: 8 });
  const shapes = d.parts.map((part) => hullShape(part.points));
  const settle = (onMesh: boolean): { y: number; tilt: number } => {
    const world = new PhysicsWorld();
    if (onMesh) {
      const floor: number[] = [];
      const index: number[] = [];
      for (let i = 0; i < 4; i++) {
        floor.push(i & 1 ? 6 : -6, 0, i & 2 ? 6 : -6);
      }
      index.push(0, 2, 1, 1, 2, 3);
      world.addBody({
        type: BODY_STATIC,
        shape: meshShape(new Float32Array(floor), new Uint32Array(index)),
      });
    } else {
      world.addBody({ type: BODY_STATIC, shape: boxShape(6, 0.5, 6), y: -0.5 });
    }
    const body = world.addBody({ type: BODY_DYNAMIC, shapes, y: 1.5 });
    for (let i = 0; i < 600; i++) world.step(1 / 120);
    const qx = world.bodies.rotX[body] ?? 0;
    const qz = world.bodies.rotZ[body] ?? 0;
    return { y: world.bodies.posY[body] ?? 0, tilt: Math.sqrt(qx * qx + qz * qz) };
  };
  const onMesh = settle(true);
  const onBox = settle(false);
  console.log(`  mesh floor: y = ${onMesh.y.toFixed(4)}  tilt = ${onMesh.tilt.toFixed(4)}`);
  console.log(`  box floor:  y = ${onBox.y.toFixed(4)}  tilt = ${onBox.tilt.toFixed(4)}`);
  /* The solver's own slop is 5 mm, so that is what "the same" means here. */
  if (Math.abs(onMesh.y - onBox.y) > 0.005) {
    fail(
      `the staircase settles ${Math.abs(onMesh.y - onBox.y).toFixed(4)} apart on the two floors, ` +
        'so parts are being crowded out of the manifold budget',
    );
  }
  if (Math.abs(onMesh.tilt - onBox.tilt) > 0.02) {
    fail(
      `the staircase tilts differently on the two floors: ${onMesh.tilt.toFixed(4)} against ${onBox.tilt.toFixed(4)}`,
    );
  }
}

console.log(failures === 0 ? '\nAll bounds held.' : `\n${failures} bound(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

import { describe, expect, it } from 'vitest';
import { BODY_DYNAMIC, BODY_STATIC } from './bodies.ts';
import { ClothBody, makeClothGrid } from './cloth.ts';
import type { ClothOptions } from './cloth.ts';
import { boxShape, sphereShape } from './shape.ts';
import { PhysicsWorld } from './world.ts';

const DT = 1 / 60;

function sheet(columns = 8, rows = 8, spacing = 0.15, options: ClothOptions = {}): ClothBody {
  const grid = makeClothGrid(columns, rows, spacing);
  return new ClothBody(grid.positions, grid.links, grid.bendLinks, options);
}

/** Pin the whole first row, so the sheet hangs from a rail. */
function hang(cloth: ClothBody, columns: number): ClothBody {
  for (let c = 0; c < columns; c++) cloth.pin(c);
  return cloth;
}

const run = (c: ClothBody, world: PhysicsWorld | null, n: number): void => {
  for (let i = 0; i < n; i++) c.step(world, DT);
};

/** How far a particle sits below the origin. */
const depth = (c: ClothBody, i: number): number => -(c.position[i * 3 + 1] ?? 0);

/** The longest edge, against its rest length, as a ratio. */
function worstStretch(cloth: ClothBody, columns: number, rows: number, spacing: number): number {
  let worst = 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c + 1 < columns; c++) {
      const a = r * columns + c;
      const b = a + 1;
      const dx = (cloth.position[b * 3] ?? 0) - (cloth.position[a * 3] ?? 0);
      const dy = (cloth.position[b * 3 + 1] ?? 0) - (cloth.position[a * 3 + 1] ?? 0);
      const dz = (cloth.position[b * 3 + 2] ?? 0) - (cloth.position[a * 3 + 2] ?? 0);
      worst = Math.max(worst, Math.sqrt(dx * dx + dy * dy + dz * dz) / spacing);
    }
  }
  return worst;
}

describe('a hanging sheet', () => {
  it('hangs rather than falling', () => {
    const cloth = hang(sheet(), 8);
    run(cloth, null, 300);
    // The pinned row has not moved, and the far corner is below it but not in free fall.
    expect(cloth.position[1]).toBeCloseTo(0, 6);
    expect(depth(cloth, 63)).toBeGreaterThan(0.5);
    expect(depth(cloth, 63)).toBeLessThan(1.5);
  });

  it('falls when nothing is pinned', () => {
    const cloth = sheet();
    run(cloth, null, 60);
    expect(depth(cloth, 0)).toBeGreaterThan(4);
  });

  it('keeps its edges near their rest length', () => {
    const cloth = hang(sheet(), 8);
    run(cloth, null, 300);
    expect(worstStretch(cloth, 8, 8, 0.15)).toBeLessThan(1.15);
  });

  it('stretches more when told to be stretchier', () => {
    const stretchOf = (stretchCompliance: number): number => {
      const cloth = hang(sheet(8, 8, 0.15, { stretchCompliance }), 8);
      run(cloth, null, 300);
      return worstStretch(cloth, 8, 8, 0.15);
    };
    /*
     * The range has to clear `h² · w` — about 5.6e-4 at sixty hertz for two unit masses — or the
     * compliance term is small beside the mass term and eight iterations close the constraint
     * anyway. 1e-3 against 0 came out at 1.0023 against 1.0000, which is a real difference and far
     * too small to assert against.
     */
    expect(stretchOf(0.05)).toBeGreaterThan(stretchOf(0) + 0.05);
  });

  it('pins a particle exactly where it was', () => {
    const cloth = hang(sheet(), 8);
    const before = cloth.position[3 * 3 + 1] ?? 0;
    run(cloth, null, 200);
    expect(cloth.position[3 * 3 + 1]).toBe(before);
    expect(cloth.velocity[3 * 3 + 1]).toBe(0);
  });

  /**
   * The property compliance is chosen for, and the reason it is compliance rather than a stiffness
   * constant: a raw position-based solver's stiffness is a function of the iteration count, so
   * tuning it tunes the solver instead of the cloth.
   */
  it('reaches the same shape at eight iterations and at sixteen', () => {
    const shapeAt = (iterations: number): number => {
      const cloth = hang(sheet(8, 8, 0.15, { iterations }), 8);
      run(cloth, null, 400);
      return depth(cloth, 63);
    };
    expect(Math.abs(shapeAt(8) - shapeAt(16))).toBeLessThan(0.05);
  });

  it('never produces a NaN over ten seconds', () => {
    const cloth = hang(sheet(10, 10, 0.12), 10);
    run(cloth, null, 600);
    for (let i = 0; i < cloth.count * 3; i++) {
      expect(Number.isFinite(cloth.position[i] ?? NaN)).toBe(true);
    }
  });
});

describe('bending', () => {
  /**
   * Bending resists **bowing**, not orientation, and the difference matters to whoever tunes it.
   *
   * A skip-one distance constraint is satisfied whenever three particles are collinear — and a flat
   * sheet and a sheet hanging straight down are *both* straight. So a cantilever pinned along one
   * edge falls to vertical whatever the bend compliance is: measured, a stiff sheet and a floppy
   * one both settled at exactly x = 0. The first version of this test measured that and read it as
   * a failure of the compliance rather than of the constraint's reach.
   *
   * What it does resist is a strip forced to bow. Pinned at both ends with slack, a stiff strip
   * bows 12.5 millimetres less than a floppy one over the same span.
   */
  it('resists bowing more when told to', () => {
    const bow = (bendCompliance: number): number => {
      const grid = makeClothGrid(13, 2, 0.1);
      const cloth = new ClothBody(grid.positions, grid.links, grid.bendLinks, {
        bendCompliance,
        iterations: 16,
        damping: 8,
      });
      for (const i of [0, 13]) cloth.pin(i);
      // Pull the far end back, so the strip has slack and must bow somewhere.
      for (const i of [12, 25]) {
        cloth.position[i * 3] = 0.7;
        cloth.pin(i);
      }
      run(cloth, null, 600);
      return cloth.position[6 * 3 + 1] ?? 0;
    };
    expect(bow(1e-8)).toBeGreaterThan(bow(1e6) + 0.008);
  });

  it('does not hold a cantilever out, and that is the constraint rather than the tuning', () => {
    const cloth = sheet(9, 3, 0.15, { bendCompliance: 1e-8, iterations: 12, damping: 8 });
    cloth.pin(0);
    cloth.pin(9);
    cloth.pin(18);
    run(cloth, null, 600);
    // Straight down: three collinear particles satisfy a skip-one constraint at any angle.
    expect(Math.abs(cloth.position[8 * 3] ?? 0)).toBeLessThan(0.05);
  });
});

describe('cloth against the world', () => {
  it('drapes over a sphere rather than through it', () => {
    const world = new PhysicsWorld({ gravityY: 0 });
    world.addBody({ type: BODY_STATIC, shape: sphereShape(0.5), x: 0.5, y: -0.9, z: 0.5 });
    const cloth = sheet(10, 10, 0.12, { iterations: 12 });
    run(cloth, world, 300);
    // No particle may be inside the sphere.
    for (let i = 0; i < cloth.count; i++) {
      const dx = (cloth.position[i * 3] ?? 0) - 0.5;
      const dy = (cloth.position[i * 3 + 1] ?? 0) + 0.9;
      const dz = (cloth.position[i * 3 + 2] ?? 0) - 0.5;
      expect(Math.sqrt(dx * dx + dy * dy + dz * dz)).toBeGreaterThan(0.49);
    }
  });

  it('rests on a floor rather than passing through it', () => {
    const world = new PhysicsWorld({ gravityY: 0 });
    world.addBody({ type: BODY_STATIC, shape: boxShape(20, 1, 20), y: -2 });
    const cloth = sheet(8, 8, 0.15);
    run(cloth, world, 400);
    for (let i = 0; i < cloth.count; i++) {
      expect(cloth.position[i * 3 + 1] ?? 0).toBeGreaterThan(-1.05);
    }
  });

  it('leaves the bodies it touches alone, because the coupling is one way', () => {
    const world = new PhysicsWorld({ gravityY: 0 });
    const floor = world.addBody({ type: BODY_STATIC, shape: boxShape(20, 1, 20), y: -2 });
    const cloth = sheet(8, 8, 0.15);
    run(cloth, world, 200);
    expect(world.bodies.posY[floor]).toBe(-2);
    expect(world.bodies.velY[floor]).toBe(0);
  });

  it('falls freely with no world given', () => {
    const cloth = sheet();
    run(cloth, null, 120);
    expect(depth(cloth, 0)).toBeGreaterThan(15);
  });
});

describe('the grid builder', () => {
  it('lays particles out on a grid', () => {
    const grid = makeClothGrid(3, 2, 0.5);
    expect(grid.positions.length / 3).toBe(6);
    expect(grid.positions[3]).toBeCloseTo(0.5, 6);
    expect(grid.positions[3 * 3 + 2]).toBeCloseTo(0.5, 6);
  });

  it('links neighbours and shears, so a sheet cannot fold flat', () => {
    const grid = makeClothGrid(2, 2, 1);
    // Two along x, two along z, and both diagonals of the single quad.
    expect(grid.links.length / 2).toBe(6);
  });

  it('bends across a particle rather than along a diagonal', () => {
    const grid = makeClothGrid(3, 1, 1);
    expect(grid.bendLinks.length / 2).toBe(1);
    expect([...grid.bendLinks]).toEqual([0, 2]);
  });
});

/**
 * Two-way coupling: a sheet that lands on a body pushes it.
 *
 * **The world has no gravity and the sheet does**, which is the control rather than a
 * simplification. A plank resting on a floor is being held up by a contact constraint that is
 * itself settling, so a test watching it move would be watching the solver; a plank floating in a
 * world with no gravity moves for exactly one reason, and its velocity at the end is the impulse
 * the sheet gave it and nothing else. `ClothBody` carries its own gravity for this to be possible.
 *
 * The other control is `coupling: 0` against no sheet at all, which must agree **exactly**: that is
 * the one-way behaviour every consumer had before this existed.
 */
describe('two-way coupling', () => {
  /** A sheet dropped onto a floating plank, and what the plank was doing at the end. */
  function drop(coupling: number | null, ticks = 90): { vy: number; spin: number } {
    const world = new PhysicsWorld({ gravityY: 0, allowSleep: false });
    /* Long and light, so a push at one end is a tilt as well as a shove. */
    const plank = world.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(1.2, 0.05, 0.3),
      y: 0,
      density: 200,
    });

    let cloth: ClothBody | null = null;
    if (coupling !== null) {
      const grid = makeClothGrid(6, 6, 0.08);
      /* Over one end only, which is what makes a tilt mean something. */
      for (let i = 0; i < grid.positions.length; i += 3) {
        grid.positions[i] = (grid.positions[i] ?? 0) + 0.6;
        grid.positions[i + 1] = 0.35;
        grid.positions[i + 2] = (grid.positions[i + 2] ?? 0) - 0.2;
      }
      cloth = new ClothBody(grid.positions, grid.links, grid.bendLinks, {
        thickness: 0.02,
        coupling,
        /* A hundred grams a particle, so thirty-six of them are 3.6 kg against a 14 kg plank —
           heavy enough to measure and light enough that the one-tick delay does not ring. */
        particleMass: 0.1,
      });
    }
    for (let i = 0; i < ticks; i++) {
      world.step(DT);
      cloth?.step(world, DT);
    }
    return { vy: world.bodies.velY[plank] ?? 0, spin: world.bodies.angZ[plank] ?? 0 };
  }

  it('changes nothing at zero, against the same world with no sheet in it', () => {
    const without = drop(null);
    const oneWay = drop(0);
    /* Identical, not merely close: a body that cannot feel the sheet has read nothing it wrote. */
    expect(oneWay.vy).toBe(without.vy);
    expect(oneWay.spin).toBe(without.spin);
  });

  it('pushes the body along the sheet and turns it about the point of contact', () => {
    const coupled = drop(1);
    /* Down, because that is the way the sheet was falling. */
    expect(coupled.vy, 'pushed').toBeLessThan(-0.01);
    /*
     * And turning, which is the half that proves the impulse is applied **at the contact point**
     * rather than through the centre of mass. An impulse through the centre produces no rotation
     * at all — the trap `PhysicsWorld.applyImpulse` names in its own comment — so a coupling that
     * got the point wrong would shove the plank and never tip it.
     */
    expect(Math.abs(coupled.spin), 'and turned').toBeGreaterThan(0.01);
  });

  it('scales with the dial, so a consumer can turn it down rather than off', () => {
    const half = drop(0.5);
    const full = drop(1);
    expect(half.vy, 'half pushes').toBeLessThan(-0.005);
    expect(full.vy, 'and full pushes harder').toBeLessThan(half.vy);
  });
});

/**
 * Self-collision: a sheet that stops passing through itself.
 *
 * **The measurement is the closest unlinked pair**, not a picture. A sheet folded over itself has
 * two layers, and whether they interpenetrate is exactly the question "how close did two particles
 * that no link joins get" — which is a number the same scene answers with the feature on and off.
 *
 * The pairs a link joins are excluded because they are exempt by design: a stretch link's rest
 * length is the spacing, so a self-collision distance anywhere near it would have every neighbour
 * fighting its own link and the sheet would inflate rather than drape.
 */
describe('self-collision', () => {
  const COLUMNS = 10;
  const ROWS = 10;
  const SPACING = 0.1;

  /**
   * Which pairs `makeClothGrid` joins, rebuilt here rather than read off the body.
   *
   * A test that asked the implementation which pairs to exempt would exempt whatever it got wrong,
   * which is the one thing this measurement must not do.
   */
  function linkedPairs(): Set<number> {
    const linked = new Set<number>();
    const at = (c: number, r: number): number => r * COLUMNS + c;
    const join = (a: number, b: number): void => {
      linked.add(a * 10000 + b);
      linked.add(b * 10000 + a);
    };
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLUMNS; c++) {
        const i = at(c, r);
        if (c + 1 < COLUMNS) join(i, at(c + 1, r));
        if (r + 1 < ROWS) join(i, at(c, r + 1));
        if (c + 1 < COLUMNS && r + 1 < ROWS) join(i, at(c + 1, r + 1));
        if (c + 1 < COLUMNS && r + 1 < ROWS) join(at(c + 1, r), at(c, r + 1));
        if (c + 2 < COLUMNS) join(i, at(c + 2, r));
        if (r + 2 < ROWS) join(i, at(c, r + 2));
      }
    }
    return linked;
  }

  /** The smallest distance between any two particles that no constraint joins. */
  function closestUnlinked(cloth: ClothBody): number {
    const linked = linkedPairs();
    let closest = Infinity;
    for (let a = 0; a < cloth.count; a++) {
      for (let b = a + 1; b < cloth.count; b++) {
        if (linked.has(a * 10000 + b)) continue;
        const dx = (cloth.position[b * 3] ?? 0) - (cloth.position[a * 3] ?? 0);
        const dy = (cloth.position[b * 3 + 1] ?? 0) - (cloth.position[a * 3 + 1] ?? 0);
        const dz = (cloth.position[b * 3 + 2] ?? 0) - (cloth.position[a * 3 + 2] ?? 0);
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < closest) closest = d;
      }
    }
    return closest;
  }

  /**
   * A sheet pinned along both side edges, with the far edge walked in until it has to buckle.
   *
   * **Driven rather than dropped**, which is what makes it a control: a sheet released under
   * gravity folds differently every time its parameters move, and this one is squeezed to the same
   * place by the same schedule whatever `selfDistance` says. A small sine kink in the initial
   * layout gives the buckle a direction, so the fold is not a coin toss between two mirror images.
   *
   * The edges stop at 15 cm apart, comfortably outside every distance tested: two pinned particles
   * have no inverse mass between them and cannot be separated, so a squeeze tighter than the
   * self-collision distance would make the pinned columns the closest pair and measure nothing.
   */
  function fold(selfDistance: number): ClothBody {
    const grid = makeClothGrid(COLUMNS, ROWS, SPACING);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLUMNS; c++) {
        grid.positions[(r * COLUMNS + c) * 3 + 1] = Math.sin((c / (COLUMNS - 1)) * Math.PI) * 0.02;
      }
    }
    const cloth = new ClothBody(grid.positions, grid.links, grid.bendLinks, {
      selfDistance,
      /* No gravity: the squeeze is the only thing acting, so the fold is repeatable. */
      gravityX: 0,
      gravityY: 0,
      gravityZ: 0,
      damping: 4,
      /* Slack in the bend, so the sheet folds tightly rather than bowing into an arc. */
      bendCompliance: 1e-1,
    });
    const last = COLUMNS - 1;
    for (let r = 0; r < ROWS; r++) {
      cloth.pin(r * COLUMNS);
      cloth.pin(r * COLUMNS + last);
    }
    const span = (COLUMNS - 1) * SPACING;
    for (let i = 0; i < 700; i++) {
      const t = Math.min(1, i / 300);
      const x = span * (1 - t) + 0.15 * t;
      for (let r = 0; r < ROWS; r++) cloth.position[(r * COLUMNS + last) * 3] = x;
      cloth.step(null, DT);
    }
    return cloth;
  }

  it('is off by default, so no existing sheet moves', () => {
    const plain = sheet(4, 4, 0.1);
    const before = Float32Array.from(plain.position);
    plain.step(null, DT);
    const withOption = sheet(4, 4, 0.1, { selfDistance: 0 });
    withOption.step(null, DT);
    expect(Array.from(withOption.position)).toEqual(Array.from(plain.position));
    expect(Array.from(plain.position)).not.toEqual(Array.from(before));
  });

  /**
   * **The numbers this exists for**, measured on the squeeze above.
   *
   * With no self-collision the closest unlinked pair comes to **58 mm**, well inside the sheet's
   * own 100 mm spacing — the two layers of the fold lying through each other. With it on, the
   * closest pair is at or above the distance asked for at every setting tried: 66 mm at 60, 88 at
   * 80, 91 at 90. Asserted as "never inside what was asked for" rather than as those figures,
   * because the third decimal of a fold's settling is exactly the kind of number `AGENTS.md` says
   * not to pin.
   */
  it('keeps unlinked particles at the distance asked for, in a sheet folded over itself', () => {
    expect(closestUnlinked(fold(0)), 'without it the layers pass through').toBeLessThan(
      SPACING * 0.7,
    );
    for (const distance of [0.06, 0.08, 0.09]) {
      expect(
        closestUnlinked(fold(distance)),
        `at ${distance} the layers stay apart`,
      ).toBeGreaterThanOrEqual(distance);
    }
  });

  /**
   * Linked particles are exempt, or the sheet inflates instead of draping.
   *
   * The distance is set **above the spacing and below the diagonal**, so every orthogonal
   * neighbour is inside the radius and every unlinked pair is outside it. Without the exemption
   * the sheet would blow up by a fifth; with it, nothing moves at all.
   */
  it('leaves linked neighbours at their rest length rather than pushing them apart', () => {
    const grid = makeClothGrid(6, 6, SPACING);
    const cloth = new ClothBody(grid.positions, grid.links, grid.bendLinks, {
      selfDistance: SPACING * 1.2,
      gravityX: 0,
      gravityY: 0,
      gravityZ: 0,
    });
    for (let i = 0; i < 60; i++) cloth.step(null, DT);
    const dx = (cloth.position[3] ?? 0) - (cloth.position[0] ?? 0);
    const dy = (cloth.position[4] ?? 0) - (cloth.position[1] ?? 0);
    const dz = (cloth.position[5] ?? 0) - (cloth.position[2] ?? 0);
    expect(Math.sqrt(dx * dx + dy * dy + dz * dz), 'still one spacing apart').toBeCloseTo(
      SPACING,
      4,
    );
  });
});

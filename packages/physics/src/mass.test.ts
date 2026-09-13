import { describe, expect, it } from 'vitest';
import { createMassProperties, shapeMassProperties } from './mass.ts';
import { boxShape, capsuleShape, hullShape, sphereShape } from './shape.ts';

/**
 * Every expectation here is a closed form written out by hand, never a second call to the code
 * under test. A solid box of half-extents (a, b, c) and mass m has I_xx = m(b² + c²)/3 about its
 * centre; a solid sphere of radius r has I = 2mr²/5.
 */
describe('mass properties', () => {
  it('gives a unit cube its volume', () => {
    const out = shapeMassProperties(boxShape(0.5, 0.5, 0.5), 1, createMassProperties());
    expect(out.volume).toBeCloseTo(1, 6);
  });

  it('gives a box of half-extents 1, 2, 3 its volume', () => {
    const out = shapeMassProperties(boxShape(1, 2, 3), 1, createMassProperties());
    expect(out.volume).toBeCloseTo(48, 5);
  });

  it('scales mass with density', () => {
    const one = shapeMassProperties(boxShape(1, 1, 1), 1, createMassProperties());
    const seven = shapeMassProperties(boxShape(1, 1, 1), 7, createMassProperties());
    expect(seven.ixx / one.ixx).toBeCloseTo(7, 6);
  });

  it('centres a symmetric box on the origin', () => {
    const out = shapeMassProperties(boxShape(1, 2, 3), 1, createMassProperties());
    expect(out.comX).toBeCloseTo(0, 6);
    expect(out.comY).toBeCloseTo(0, 6);
    expect(out.comZ).toBeCloseTo(0, 6);
  });

  it("matches the box's closed-form inertia", () => {
    // Half-extents 1, 2, 3 -> volume 48, mass 48 at density 1.
    // I_xx = m(b² + c²)/3 = 48(4 + 9)/3 = 208
    // I_yy = m(a² + c²)/3 = 48(1 + 9)/3 = 160
    // I_zz = m(a² + b²)/3 = 48(1 + 4)/3 = 80
    const out = shapeMassProperties(boxShape(1, 2, 3), 1, createMassProperties());
    expect(out.ixx).toBeCloseTo(208, 3);
    expect(out.iyy).toBeCloseTo(160, 3);
    expect(out.izz).toBeCloseTo(80, 3);
  });

  it('leaves a box its diagonal tensor', () => {
    const out = shapeMassProperties(boxShape(1, 2, 3), 1, createMassProperties());
    expect(out.ixy).toBeCloseTo(0, 5);
    expect(out.ixz).toBeCloseTo(0, 5);
    expect(out.iyz).toBeCloseTo(0, 5);
  });

  it("matches the sphere's closed form, which has no faces to decompose", () => {
    // r = 2 -> V = 4πr³/3 = 33.510321…, m = V, I = 2mr²/5 = 53.616516…
    const out = shapeMassProperties(sphereShape(2), 1, createMassProperties());
    expect(out.volume).toBeCloseTo(33.510321, 4);
    expect(out.ixx).toBeCloseTo(53.616516, 3);
    expect(out.ixx).toBeCloseTo(out.iyy, 6);
    expect(out.iyy).toBeCloseTo(out.izz, 6);
  });

  it('finds the centre of mass of an off-centre box', () => {
    const corners: number[] = [];
    for (let i = 0; i < 8; i++) {
      corners.push(10 + (i & 1 ? 1 : -1), i & 2 ? 1 : -1, i & 4 ? 1 : -1);
    }
    const out = shapeMassProperties(hullShape(corners), 1, createMassProperties());
    expect(out.comX).toBeCloseTo(10, 4);
    expect(out.comY).toBeCloseTo(0, 4);
    expect(out.comZ).toBeCloseTo(0, 4);
  });

  it('gives an off-centre box the same inertia as a centred one', () => {
    // The parallel-axis shift must remove the offset entirely: a 2x2x2 box has
    // I = m(b² + c²)/3 = 8(1 + 1)/3 = 5.333… wherever it sits.
    const corners: number[] = [];
    for (let i = 0; i < 8; i++) {
      corners.push(10 + (i & 1 ? 1 : -1), i & 2 ? 1 : -1, i & 4 ? 1 : -1);
    }
    const out = shapeMassProperties(hullShape(corners), 1, createMassProperties());
    expect(out.ixx).toBeCloseTo(16 / 3, 3);
    expect(out.iyy).toBeCloseTo(16 / 3, 3);
    expect(out.izz).toBeCloseTo(16 / 3, 3);
  });

  it('gives a tetrahedron one sixth the volume of its box', () => {
    const out = shapeMassProperties(
      hullShape([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
      1,
      createMassProperties(),
    );
    expect(out.volume).toBeCloseTo(1 / 6, 6);
  });

  it('allocates nothing, filling the target the caller owns', () => {
    const out = createMassProperties();
    expect(shapeMassProperties(boxShape(1, 1, 1), 1, out)).toBe(out);
  });
});

/**
 * A capsule is a cylinder of length 2h capped by two hemispheres of radius r.
 *
 * At density 1, cylinder mass mC = 2πr²h and each cap mass mH = 2πr³/3. About the long axis y,
 * every part contributes its own axial term: I_yy = mC·r²/2 + 2·mH·(2r²/5). Perpendicular, the
 * cylinder gives mC·(3r² + 4h²)/12 and each hemisphere gives mH·(2r²/5) shifted by the parallel
 * axis, whose distance terms come to mH·(h² + 3hr/4).
 */
describe('capsule mass properties', () => {
  const r = 0.5;
  const h = 1;
  const mC = 2 * Math.PI * r * r * h;
  const mH = (2 * Math.PI * r * r * r) / 3;

  it('gives a capsule its volume, cylinder plus one whole sphere', () => {
    const out = shapeMassProperties(capsuleShape(r, h), 1, createMassProperties());
    expect(out.volume).toBeCloseTo(mC + 2 * mH, 6);
  });

  it("matches the capsule's closed form about its long axis", () => {
    const iyy = (mC * r * r) / 2 + 2 * mH * ((2 * r * r) / 5);
    const out = shapeMassProperties(capsuleShape(r, h), 1, createMassProperties());
    expect(out.iyy).toBeCloseTo(iyy, 6);
  });

  it('matches the closed form perpendicular to it, which is where a sphere is wrong', () => {
    const ixx =
      (mC * (3 * r * r + 4 * h * h)) / 12 + 2 * mH * ((2 * r * r) / 5 + h * h + (3 * h * r) / 4);
    const out = shapeMassProperties(capsuleShape(r, h), 1, createMassProperties());
    expect(out.ixx).toBeCloseTo(ixx, 6);
    expect(out.izz).toBeCloseTo(ixx, 6);
  });

  it('is not a sphere: a long capsule resists roll far less than tumble', () => {
    const out = shapeMassProperties(capsuleShape(0.2, 2), 1, createMassProperties());
    expect(out.ixx / out.iyy).toBeGreaterThan(10);
  });

  it('degenerates to the sphere it is at zero half-height', () => {
    const out = shapeMassProperties(capsuleShape(2, 0), 1, createMassProperties());
    expect(out.ixx).toBeCloseTo(53.616516, 3);
    expect(out.iyy).toBeCloseTo(out.ixx, 6);
  });
});

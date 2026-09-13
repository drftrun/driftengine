import { describe, expect, it } from 'vitest';
import { BODY_DYNAMIC, BODY_STATIC } from './bodies.ts';
import { boxShape } from './shape.ts';
import { Vehicle, defaultTyreCurve, sampleTyreCurve } from './vehicle.ts';
import type { VehicleInput, VehicleOptions } from './vehicle.ts';
import type { GroundProbe } from './controller.ts';
import { PhysicsWorld } from './world.ts';

const DT = 1 / 60;
const COAST: VehicleInput = { throttle: 0, brake: 0, steer: 0 };

const WHEELS = [
  { x: -0.8, y: -0.3, z: 1.2, steers: true },
  { x: 0.8, y: -0.3, z: 1.2, steers: true },
  { x: -0.8, y: -0.3, z: -1.2, driven: true },
  { x: 0.8, y: -0.3, z: -1.2, driven: true },
];

function build(
  options: Partial<VehicleOptions> = {},
  y = 1.2,
): {
  world: PhysicsWorld;
  car: Vehicle;
  chassis: number;
} {
  const world = new PhysicsWorld({ allowSleep: false });
  world.addBody({ type: BODY_STATIC, shape: boxShape(200, 1, 200), y: -1, friction: 0.9 });
  const chassis = world.addBody({
    type: BODY_DYNAMIC,
    shape: boxShape(1, 0.4, 2),
    y,
    density: 180,
    layer: 1,
    mask: 1,
  });
  const car = new Vehicle(chassis, { wheels: WHEELS, ...options });
  return { world, car, chassis };
}

function drive(
  w: PhysicsWorld,
  car: Vehicle,
  ticks: number,
  input: Partial<VehicleInput> = {},
): void {
  const full: VehicleInput = { ...COAST, ...input };
  for (let i = 0; i < ticks; i++) {
    car.update(w, DT, full);
    w.step(DT);
  }
}

describe('the tyre curve', () => {
  it('reads zero at zero slip', () => {
    expect(sampleTyreCurve(defaultTyreCurve(1), 0)).toBeCloseTo(0, 6);
  });

  it('interpolates between two points', () => {
    const curve = { slip: new Float32Array([0, 1]), force: new Float32Array([0, 2]) };
    expect(sampleTyreCurve(curve, 0.25)).toBeCloseTo(0.5, 6);
  });

  it('holds its last value past the end', () => {
    const curve = { slip: new Float32Array([0, 1]), force: new Float32Array([0, 2]) };
    expect(sampleTyreCurve(curve, 50)).toBeCloseTo(2, 6);
  });

  it('rises to a peak and falls away, which is what a tyre does', () => {
    const curve = defaultTyreCurve(1);
    expect(sampleTyreCurve(curve, 0.2)).toBeGreaterThan(sampleTyreCurve(curve, 0.05));
    expect(sampleTyreCurve(curve, 1.5)).toBeLessThan(sampleTyreCurve(curve, 0.2));
  });
});

describe('suspension', () => {
  it('holds the chassis up off the ground', () => {
    const { world, car, chassis } = build();
    drive(world, car, 240);
    expect(world.bodies.posY[chassis] ?? 0).toBeGreaterThan(0.5);
  });

  it('reports every wheel grounded at rest', () => {
    const { world, car } = build();
    drive(world, car, 240);
    for (let i = 0; i < 4; i++) expect(car.grounded[i]).toBe(1);
  });

  it('reports a wheel over a hole as ungrounded', () => {
    const world = new PhysicsWorld({ allowSleep: false });
    // Two strips with a gap, so one side of the car has nothing under it.
    world.addBody({ type: BODY_STATIC, shape: boxShape(200, 1, 1), y: -1, z: 1.2 });
    const chassis = world.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(1, 0.4, 2),
      y: 1.2,
      density: 180,
    });
    const car = new Vehicle(chassis, { wheels: WHEELS });
    drive(world, car, 30);
    expect(car.grounded[2]).toBe(0);
  });

  it('rests higher on a stiffer spring', () => {
    const height = (stiffness: number): number => {
      const { world, car, chassis } = build({
        wheels: WHEELS.map((w) => ({ ...w, stiffness })),
      });
      drive(world, car, 300);
      return world.bodies.posY[chassis] ?? 0;
    };
    expect(height(80000)).toBeGreaterThan(height(20000) + 0.02);
  });

  it('compresses under the chassis it carries', () => {
    const { world, car } = build();
    drive(world, car, 240);
    for (let i = 0; i < 4; i++) expect(car.compression[i]).toBeGreaterThan(0);
  });
});

describe('driving', () => {
  it('goes forward under throttle', () => {
    const { world, car, chassis } = build();
    drive(world, car, 120);
    const before = world.bodies.posZ[chassis] ?? 0;
    drive(world, car, 240, { throttle: 1 });
    expect(world.bodies.posZ[chassis] ?? 0).toBeGreaterThan(before + 2);
  });

  it('goes nowhere with no throttle', () => {
    const { world, car, chassis } = build();
    drive(world, car, 120);
    const before = world.bodies.posZ[chassis] ?? 0;
    drive(world, car, 240);
    expect(Math.abs((world.bodies.posZ[chassis] ?? 0) - before)).toBeLessThan(0.3);
  });

  it('stops under brake', () => {
    const { world, car, chassis } = build();
    drive(world, car, 120);
    drive(world, car, 180, { throttle: 1 });
    const moving = world.bodies.velZ[chassis] ?? 0;
    expect(moving).toBeGreaterThan(1);
    drive(world, car, 180, { brake: 1 });
    expect(Math.abs(world.bodies.velZ[chassis] ?? 0)).toBeLessThan(moving * 0.4);
  });

  it('turns when steered', () => {
    const { world, car, chassis } = build();
    drive(world, car, 120);
    drive(world, car, 240, { throttle: 1, steer: 1 });
    expect(Math.abs(world.bodies.posX[chassis] ?? 0)).toBeGreaterThan(0.5);
  });

  /**
   * Dead straight, and the bound is tight because the loose one hid a real defect.
   *
   * Applying each wheel's impulse as it was computed let every wheel see a velocity the previous
   * one had already changed, and the asymmetry accumulated into a yaw: 0.64 metres of drift after
   * 39 travelled, and **5.49 after 155**. Gathering every wheel's impulse before applying any takes
   * that to 0.001 over the same distance. A bound of half a metre passed both.
   */
  it('goes straight when not steered', () => {
    const { world, car, chassis } = build();
    drive(world, car, 120);
    drive(world, car, 240, { throttle: 1 });
    expect(world.bodies.posZ[chassis] ?? 0).toBeGreaterThan(5);
    expect(Math.abs(world.bodies.posX[chassis] ?? 0)).toBeLessThan(0.05);
  });

  it('reverses under negative throttle', () => {
    const { world, car, chassis } = build();
    drive(world, car, 120);
    const before = world.bodies.posZ[chassis] ?? 0;
    drive(world, car, 240, { throttle: -1 });
    expect(world.bodies.posZ[chassis] ?? 0).toBeLessThan(before - 1);
  });
});

describe('grip', () => {
  /** The curve is the whole point of the table: a slippery one lets the car slide. */
  it('slides further on a low-grip curve than a high-grip one', () => {
    const drift = (peak: number): number => {
      const { world, car, chassis } = build({ lateral: defaultTyreCurve(peak) });
      drive(world, car, 120);
      world.bodies.velX[chassis] = 8;
      drive(world, car, 90);
      return Math.abs(world.bodies.posX[chassis] ?? 0);
    };
    expect(drift(0.05)).toBeGreaterThan(drift(3) + 0.5);
  });

  it('applies nothing through a wheel in the air', () => {
    const world = new PhysicsWorld({ gravityY: 0, allowSleep: false });
    const chassis = world.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(1, 0.4, 2),
      y: 50,
      density: 180,
    });
    const car = new Vehicle(chassis, { wheels: WHEELS });
    drive(world, car, 60, { throttle: 1, steer: 1 });
    expect(Math.abs(world.bodies.velZ[chassis] ?? 0)).toBeLessThan(1e-6);
    for (let i = 0; i < 4; i++) expect(car.grounded[i]).toBe(0);
  });
});

describe('the vehicle as a whole', () => {
  it('never produces a NaN', () => {
    const { world, car, chassis } = build();
    for (let i = 0; i < 600; i++) {
      car.update(world, DT, {
        throttle: Math.cos(i * 0.1),
        brake: i % 90 < 10 ? 1 : 0,
        steer: Math.sin(i * 0.07),
      });
      world.step(DT);
    }
    expect(Number.isFinite(world.bodies.posY[chassis] ?? NaN)).toBe(true);
    expect(Number.isFinite(world.bodies.rotW[chassis] ?? NaN)).toBe(true);
  });

  it('stays upright over a long drive', () => {
    const { world, car, chassis } = build();
    drive(world, car, 600, { throttle: 0.6 });
    // The chassis's own up, still pointing up.
    const qx = world.bodies.rotX[chassis] ?? 0;
    const qz = world.bodies.rotZ[chassis] ?? 0;
    const qw = world.bodies.rotW[chassis] ?? 1;
    const upY = 1 - 2 * (qx * qx + qz * qz);
    expect(upY).toBeGreaterThan(0.8);
  });
});

describe('a car on an analytic surface', () => {
  /** A flat floor at a height, with no body anywhere. Structural, like the controller's seam. */
  function floorAt(y: number, normalX = 0, normalY = 1, normalZ = 0): GroundProbe {
    return {
      sample(_x, _z, out) {
        out.y = y;
        out.normalX = normalX;
        out.normalY = normalY;
        out.normalZ = normalZ;
        return true;
      },
    };
  }

  /** No static box: the surface is the only ground there is. */
  function onSurface(
    ground: GroundProbe | undefined,
    extra: Partial<VehicleOptions> = {},
  ): { world: PhysicsWorld; car: Vehicle; chassis: number } {
    const world = new PhysicsWorld({ allowSleep: false });
    const chassis = world.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(1, 0.4, 2),
      y: 1.2,
      density: 180,
      layer: 1,
      mask: 1,
    });
    return { world, car: new Vehicle(chassis, { wheels: WHEELS, ground, ...extra }), chassis };
  }

  it('falls through a world of surfaces when it has no probe', () => {
    /* The baseline: wheels raycast bodies, and there are none. */
    const { world, car, chassis } = onSurface(undefined);
    drive(world, car, 60);
    expect(world.bodies.posY[chassis] ?? 0).toBeLessThan(-1);
  });

  it('rests on a surface where no body exists', () => {
    /*
     * The whole point, and the third copy of the floor a consumer reported writing: a character
     * stood on the surface and a car fell through it, so the world's ground was two things kept in
     * step by hand.
     *
     * The wheels sit 0.3 m under the chassis centre with a 0.3 m radius by default, so a car
     * resting on a floor at y = 0 carries its centre near 0.6 and the suspension holds it a little
     * above that. Asserted as a band because where exactly it settles is the spring's business.
     */
    const { world, car, chassis } = onSurface(floorAt(0));
    drive(world, car, 120);
    const y = world.bodies.posY[chassis] ?? 0;
    expect(y, 'held up').toBeGreaterThan(0.4);
    expect(y, 'and not pushed away').toBeLessThan(1.3);
    for (let i = 0; i < 4; i++) expect(car.grounded[i], `wheel ${i}`).toBe(1);
  });

  it('takes the surface normal, so a bank pushes the car sideways', () => {
    /*
     * **With the lateral tyre curve set to zero**, and that is the test rather than a convenience:
     * the load is applied along the surface normal, so a normal tilted by 0.3 rad has a sideways
     * component of `sin 0.3` of it, and the only thing in the vehicle that opposes a sideways force
     * is the tyre. Leave a real tyre on and nothing measurable happens — a car parked across a
     * seventeen-degree bank holds, exactly as it should, and the first version of this test asserted
     * a slide and got 1.8 mm in two seconds.
     *
     * Take the grip away and what is left is the normal alone. Which is the question: on a flat
     * normal the same car goes nowhere, because there is no sideways component to push it.
     */
    const slick = { slip: new Float32Array([0, 1]), force: new Float32Array([0, 0]) };
    const bank = 0.3;

    const flat = onSurface(floorAt(0), { lateral: slick });
    drive(flat.world, flat.car, 120);
    expect(
      Math.abs(flat.world.bodies.posX[flat.chassis] ?? 0),
      'flat: nothing to push it',
    ).toBeLessThan(0.01);

    const banked = onSurface(floorAt(0, Math.sin(bank), Math.cos(bank), 0), { lateral: slick });
    drive(banked.world, banked.car, 120);
    expect(
      banked.world.bodies.posX[banked.chassis] ?? 0,
      'banked: pushed along the tilt',
    ).toBeGreaterThan(0.1);
  });

  it('prefers a body to a surface where both are under the wheel', () => {
    /* The ruling the controller carries in the same words: a body is a thing that is there, and a
       surface is a description of where the ground is. The body here is a metre above the surface,
       so if the surface won the car would sink through it. */
    const world = new PhysicsWorld({ allowSleep: false });
    world.addBody({ type: BODY_STATIC, shape: boxShape(200, 1, 200), y: 0, friction: 0.9 });
    const chassis = world.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(1, 0.4, 2),
      y: 2.2,
      density: 180,
      layer: 1,
      mask: 1,
    });
    const car = new Vehicle(chassis, { wheels: WHEELS, ground: floorAt(-10) });
    drive(world, car, 120);
    expect(
      world.bodies.posY[chassis] ?? 0,
      'on the box top at y = 1, not down at the surface',
    ).toBeGreaterThan(1.2);
  });
});

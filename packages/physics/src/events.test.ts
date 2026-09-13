import { describe, expect, it } from 'vitest';
import { BODY_DYNAMIC, BODY_STATIC } from './bodies.ts';
import { EVENT_ENTER, EVENT_EXIT, EVENT_STAY } from './events.ts';
import { boxShape, sphereShape } from './shape.ts';
import { PhysicsWorld } from './world.ts';

const DT = 1 / 60;

/** Every event of a tick, as readable triples. */
function events(world: PhysicsWorld): string[] {
  const out: string[] = [];
  const name = ['enter', 'stay', 'exit'];
  for (let i = 0; i < world.events.count; i++) {
    out.push(
      `${name[world.events.data[i * 3] ?? 0]}:${world.events.data[i * 3 + 1]}-${world.events.data[i * 3 + 2]}`,
    );
  }
  return out;
}

/** A sensor volume with a ball falling through it, and the floor beneath. */
function trigger(): { world: PhysicsWorld; sensor: number; ball: number } {
  const world = new PhysicsWorld({ allowSleep: false });
  world.addBody({ type: BODY_STATIC, shape: boxShape(20, 1, 20), y: -1 });
  const sensor = world.addBody({
    type: BODY_STATIC,
    shape: boxShape(2, 1, 2),
    y: 3,
    sensor: true,
  });
  const ball = world.addBody({ type: BODY_DYNAMIC, shape: sphereShape(0.4), y: 8, density: 400 });
  return { world, sensor, ball };
}

describe('sensors', () => {
  it('raises enter once when a body arrives', () => {
    const { world } = trigger();
    let enters = 0;
    for (let t = 0; t < 200; t++) {
      world.step(DT);
      enters += events(world).filter((e) => e.startsWith('enter:1-2')).length;
    }
    expect(enters).toBe(1);
  });

  it('raises stay while the body is inside', () => {
    const { world } = trigger();
    let stays = 0;
    for (let t = 0; t < 200; t++) {
      world.step(DT);
      stays += events(world).filter((e) => e.startsWith('stay:1-2')).length;
    }
    expect(stays).toBeGreaterThan(3);
  });

  it('raises exit once when it leaves', () => {
    const { world } = trigger();
    let exits = 0;
    for (let t = 0; t < 200; t++) {
      world.step(DT);
      exits += events(world).filter((e) => e.startsWith('exit:1-2')).length;
    }
    expect(exits).toBe(1);
  });

  /** The whole point: a sensor notices and never pushes. */
  it('does not stop the body it notices', () => {
    const { world, ball } = trigger();
    for (let t = 0; t < 300; t++) world.step(DT);
    // It fell all the way to the floor, through the sensor.
    expect(world.bodies.posY[ball] ?? 0).toBeLessThan(0.5);
  });

  it('applies no impulse at all while overlapping', () => {
    const world = new PhysicsWorld({ gravityY: 0, allowSleep: false });
    world.addBody({ type: BODY_STATIC, shape: boxShape(2, 2, 2), sensor: true });
    const ball = world.addBody({ type: BODY_DYNAMIC, shape: sphereShape(0.4), density: 400 });
    for (let t = 0; t < 60; t++) world.step(DT);
    expect(world.bodies.velX[ball]).toBe(0);
    expect(world.bodies.velY[ball]).toBe(0);
    expect(world.bodies.velZ[ball]).toBe(0);
  });

  it('respects the layer mask like anything else', () => {
    const world = new PhysicsWorld({ gravityY: 0, allowSleep: false });
    world.addBody({ type: BODY_STATIC, shape: boxShape(2, 2, 2), sensor: true, layer: 1, mask: 1 });
    world.addBody({ type: BODY_DYNAMIC, shape: sphereShape(0.4), density: 400, layer: 2, mask: 2 });
    world.step(DT);
    expect(events(world)).toEqual([]);
  });

  it('still solves ordinary contacts in the same world', () => {
    const { world } = trigger();
    for (let t = 0; t < 300; t++) world.step(DT);
    // The ball rests on the floor rather than passing through it.
    expect(world.bodies.posY[2] ?? 0).toBeGreaterThan(0.35);
  });
});

describe('the event buffer', () => {
  it('reports ordinary contacts too, not only sensors', () => {
    const world = new PhysicsWorld({ allowSleep: false });
    world.addBody({ type: BODY_STATIC, shape: boxShape(20, 1, 20), y: -1 });
    world.addBody({ type: BODY_DYNAMIC, shape: sphereShape(0.4), y: 4, density: 400 });
    let sawEnter = false;
    for (let t = 0; t < 200; t++) {
      world.step(DT);
      if (events(world).some((e) => e === 'enter:0-1')) sawEnter = true;
    }
    expect(sawEnter).toBe(true);
  });

  it('is empty in a world where nothing touches', () => {
    const world = new PhysicsWorld({ gravityY: 0 });
    world.addBody({ type: BODY_DYNAMIC, shape: sphereShape(0.4), density: 400 });
    world.addBody({ type: BODY_DYNAMIC, shape: sphereShape(0.4), x: 50, density: 400 });
    world.step(DT);
    expect(events(world)).toEqual([]);
  });

  it('orders events by pair key', () => {
    const world = new PhysicsWorld({ allowSleep: false });
    world.addBody({ type: BODY_STATIC, shape: boxShape(20, 1, 20), y: -1 });
    for (let i = 0; i < 4; i++) {
      world.addBody({
        type: BODY_DYNAMIC,
        shape: sphereShape(0.4),
        x: i * 3,
        y: 0.4,
        density: 400,
      });
    }
    world.step(DT);
    const pairs = events(world).map((e) => e.split(':')[1] ?? '');
    expect(pairs).toEqual([...pairs].sort());
  });

  it('starts each tick from nothing', () => {
    const { world } = trigger();
    for (let t = 0; t < 400; t++) world.step(DT);
    const last = world.events.count;
    world.step(DT);
    // A settled world raises only stays, not a growing pile.
    expect(world.events.count).toBeLessThanOrEqual(last + 1);
  });

  it('forgets its pairs when a body is removed', () => {
    const { world, ball } = trigger();
    for (let t = 0; t < 200; t++) world.step(DT);
    world.removeBody(ball);
    world.step(DT);
    // No exit for a pair whose indices no longer mean what they did.
    expect(events(world).filter((e) => e.startsWith('exit'))).toEqual([]);
  });
});

---
title: Particles
description: Sparks, smoke and floating motes from a pool and a batch, deterministic emission, particles placed by your own plan, and flocks of birds.
packages: ['@driftengine/core']
---

# Particles

A particle effect is two things: a pool that simulates the particles, where each one is, how old and
how big, and a batch that draws them with a particle material. The example's fire uses three pairs,
one each for sparks, smoke and motes.

<!-- run: particles -->

## The pool

```ts sample=particles/main.ts#pools
/** Each pool is the simulation: where its particles are, how old, how big and what colour. */
const sparks = new ParticlePool({
  capacity: 600,
  lifeSec: 1.4,
  sizeStart: 0.05,
  sizeEnd: 0.01,
  colorStart: [4, 2.2, 0.8],
  colorEnd: [1.4, 0.3, 0.05],
  gravity: 4,
  drag: 0.6,
  rise: 0,
});
const smoke = new ParticlePool({
  capacity: 300,
  lifeSec: 6,
  sizeStart: 0.5,
  sizeEnd: 2.4,
  colorStart: [0.18, 0.17, 0.17],
  colorEnd: [0.3, 0.3, 0.32],
  gravity: 0,
  drag: 0.4,
  rise: 0.7,
  alphaStart: 0.3,
  alphaEnd: 0,
});
const motes = new ParticlePool({
  capacity: 200,
  lifeSec: 8,
  sizeStart: 0.04,
  sizeEnd: 0.04,
  colorStart: [1.6, 1.4, 0.8],
  colorEnd: [0.6, 0.5, 0.3],
  gravity: 0,
  drag: 0.2,
  rise: 0.05,
  alphaStart: 1,
  alphaEnd: 0,
});
```

A `ParticlePool` holds up to `capacity` particles. Each lives `lifeSec` seconds and moves from its
start size, colour and opacity to its end ones over that life. A size is a half-width, metres from
the centre to an edge, so a particle of size 0.5 is a metre across. `gravity` pulls it down, `drag`
slows it per second, and `rise` pushes it up steadily, which is what makes smoke behave like smoke.
Leave `alphaStart` and `alphaEnd` out and a particle stays opaque and fades by colour, which suits
additive sparks; give them, and it fades for real, which smoke needs.

Colours are linear and may go past one: a spark at four times white is what bloom finds.

## Emitting

```ts sample=particles/main.ts#simulate
simulate(dt) {
  tick += 1;
  time += dt;
  /* A few sparks every tick, a puff of smoke every other one, and a mote now and then. */
  for (let i = 0; i < 4; i += 1) {
    const seed = tick * 8 + i;
    const a = hashToUnit(seed) * Math.PI * 2;
    const out = hashToUnit(seed + 1) * 1.2;
    sparks.emit(
      0,
      0.3,
      0,
      Math.cos(a) * out,
      2.5 + hashToUnit(seed + 2) * 3,
      Math.sin(a) * out,
      seed,
    );
  }
  if (tick % 2 === 0) {
    const seed = tick;
    smoke.emit(
      (hashToUnit(seed) - 0.5) * 0.4,
      0.6,
      (hashToUnit(seed + 5) - 0.5) * 0.4,
      0.15,
      0.6,
      0,
      seed,
    );
  }
  if (tick % 12 === 0) {
    const seed = tick;
    const a = hashToUnit(seed) * Math.PI * 2;
    const r = 1.5 + hashToUnit(seed + 3) * 3;
    motes.emit(
      Math.cos(a) * r,
      0.3 + hashToUnit(seed + 4) * 2,
      Math.sin(a) * r,
      0,
      0.05,
      0,
      seed,
    );
  }
  sparks.update(dt);
  smoke.update(dt);
  motes.update(dt);
},
```

`emit(x, y, z, vx, vy, vz, seed, sizeScale, lifeScale)` adds a particle with a position and a
velocity. The seed drives its variation, its spin and the noise its material animates by, in place
of `Math.random`, so emitting from the fixed step with the tick as the seed makes the same fire
every run, which a replay needs. When the pool is full, the oldest particle is reused.

`update(dt)` advances every particle and rebuilds the data the batch draws. Call it from the
simulation step, as here, or from the render step for an effect that is pure decoration.

## Drawing

```ts sample=particles/main.ts#batches
/** Each batch is how its pool is drawn: which material, how it blends, which way it faces. */
const sparkBatch = renderer.createParticles(600, {
  material: 'spark',
  blend: 'additive',
  stretchSec: 0.05,
  coreGain: 2,
});
const smokeBatch = renderer.createParticles(300, {
  material: 'smoke',
  blend: 'alpha',
  erosion: 0.6,
});
const moteBatch = renderer.createParticles(200, { material: 'mote', blend: 'additive' });
```

`createParticles(capacity, options)` makes a batch, and its `material` names how a particle looks:

- `'spark'`: a hot point stretched along its velocity by `stretchSec` seconds of travel, with
  `coreGain` saying how far past white its core may go. A spark is a streak, because it moved while
  the eye was looking.
- `'smoke'`: a soft puff eroded by noise, `erosion` from 0 to 1.
- `'mote'`: an unlit point exactly its own colour. It ignores fog unless `fog: true`.

`blend` is `'additive'` for what emits light and `'alpha'` for what covers it. `facing` is
`'camera'`, the default, for one quad facing the viewer, or `'cross'` for two blades fixed in the
world. Several batches of one material can share its compiled program with `reuse`, so four kinds of
smoke cost one shader.

```ts sample=particles/main.ts#draw
/* After the opaque scene: what covers first, then what adds light. */
renderer.drawParticles(smokeBatch, smoke.particles, camera, env, time);
renderer.drawParticles(sparkBatch, sparks.particles, camera, env, time);
renderer.drawParticles(moteBatch, motes.particles, camera, env, time);
```

`drawParticles(batch, pool.particles, camera, env, time)` draws a pool after the opaque scene. Draw
what covers before what adds light. Sparks and smoke are fogged with the rest of the world.

## Particles from your own plan

```ts sample=snippets/particles.ts#planned
/**
 * A ring of embers placed by a plan, not simulated: positions are a function of time, so a clip
 * exported frame by frame draws exactly what the preview drew.
 */
export function drawRing(
  renderer: RendererApi,
  batch: ParticleHandle,
  data: ParticleInstances,
  camera: Camera,
  env: Environment,
  time: number,
): void {
  const count = data.positions.length / 3;
  for (let i = 0; i < count; i += 1) {
    const a = (i / count) * Math.PI * 2 + time * 0.5;
    const at = i * 3;
    data.positions[at] = Math.cos(a) * 3;
    data.positions[at + 1] = 1 + Math.sin(time + i) * 0.2;
    data.positions[at + 2] = Math.sin(a) * 3;
    data.velocities[at] = -Math.sin(a);
    data.velocities[at + 1] = 0;
    data.velocities[at + 2] = Math.cos(a);
    data.colors[at] = 3;
    data.colors[at + 1] = 1.4;
    data.colors[at + 2] = 0.4;
    data.sizes[i] = 0.05;
    data.alphas[i] = 1;
  }
  data.count = count;
  renderer.drawParticles(batch, data, camera, env, time);
}
```

A pool is a simulation, and some effects are not: a ring of embers orbiting a mage, streamers around
a star, anything whose position is a function of time. Fill a `ParticleInstances` yourself, its
positions, velocities, sizes, colours and opacities, set `count`, and draw it. Nothing integrates the
velocity; it is only the direction a spark is stretched along. Because nothing is simulated, the
same time draws the same frame however the frames were spaced, which is what an exported clip needs.

## Birds

```ts sample=snippets/particles.ts#flock
/** Birds circling a point, every one's path a function of its index and the clock. */
export function birds(renderer: RendererApi): (camera: Camera, time: number) => void {
  const flock = renderer.createFlock(40);
  const circling: FlockParams = {
    center: [0, 0, 0],
    radius: 30,
    height: 25,
    count: 40,
    speed: 9,
    scale: 0.4,
  };
  const dark: Vec3 = [0.1, 0.1, 0.12];
  return (camera, time) => renderer.drawFlock(flock, camera, time, circling, dark);
}
```

`createFlock(count)` and `drawFlock(flock, camera, time, params, tint, windX, windZ)` draw birds
circling a centre at a radius and height, flapping as they go. Each bird's path is a function of its
index and the clock, so a flock costs no simulation. `scale` is half the wingspan in metres.

Other effects with chapters of their own: plumes of fire and smoke in
[Light in the air](light-in-the-air.md), rain and lightning in [Fog and weather](fog-and-weather.md).

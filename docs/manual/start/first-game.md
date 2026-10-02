---
title: Your first game
description: A complete 3D game in one file. An arena with physics, a character, crates to push, orbs to gather against the clock, sound, shadows and a HUD.
packages: ['@driftengine/core', '@driftengine/audio']
areas: ['physics', 'audio']
---

# Your first game

This chapter builds a complete game: walk an arena, push crates out of the way, jump up a platform,
and gather eight orbs before sixty seconds run out. It has physics, a character controller, shadows,
a synthesised sound, a HUD, pause and restart, and it plays with a keyboard, a gamepad or a touch
screen.

<!-- run: first-game -->

Move with WASD, the arrow keys, the left stick or a thumb on the left of a touch screen. Jump with
Space, the bottom face button or a hold on the right of the screen. P pauses, and R starts a new
round once one has ended.

The whole program is one file, `examples/first-game/main.ts`. Each section here is one region of
it, in the order the file runs.

## The rules

```ts sample=first-game/main.ts#rules
/** Half the arena's width, in metres. */
const ARENA = 12;
const ORB_COUNT = 8;
const ROUND_SECONDS = 60;
/** The same seed lays out the same rounds, in the same order, on every machine. */
const SEED = 2026;
```

Constants first, so tuning the game means editing one block. The seed matters more than it looks:
everything random in the game draws from a generator made from it, which is what lets a round be
replayed.

## A renderer with shadows

```ts sample=first-game/main.ts#renderer
const canvas = document.querySelector<HTMLCanvasElement>('#stage');
if (canvas === null) throw new Error('the page must carry <canvas id="stage">');

const { renderer, backend } = await createRenderer(canvas, {
  maxDevicePixelRatio: 1.75,
  directionalShadows: true,
});

const readout = document.querySelector('#backend');
if (readout !== null) readout.textContent = backend;

renderer.resize();
addEventListener('resize', () => renderer.resize());
```

The same call as [Hello world](hello-world.md), with `directionalShadows` turned on. That option
allocates the sun's shadow map; the game still has to draw into it each frame, which happens at the
end of this chapter.

## Light that makes orbs glow

```ts sample=first-game/main.ts#environment
const SKY: Vec3 = [0.56, 0.68, 0.84];

const ENV = createEnvironment({
  directionalDir: [0.35, 0.8, 0.45],
  directionalColor: [1, 0.95, 0.86],
  ambient: [0.34, 0.38, 0.46],
  ambientGround: [0.14, 0.12, 0.1],
  // The emissive master switch. At 0 nothing glows, whatever emissiveGain says.
  nightFactor: 1,
  emissiveGain: 1.6,
  fogColor: SKY,
  fogDensity: 0.01,
  fogHeightFalloff: 0.06,
  fogBaseY: 0,
});
```

Fog takes the sky's colour, so the far wall fades into the sky instead of into grey. `nightFactor`
is 1 because it is the switch that lets emissive surfaces glow, and the orbs are emissive.

## The level

```ts sample=first-game/main.ts#level
const world = new PhysicsWorld({ substeps: 4 });
const level = new MeshBuilder();
const footprints: { x: number; z: number; hx: number; hz: number }[] = [];

/** One box, in the picture and in the physics from the same numbers, so the two cannot disagree. */
function solid(
  x: number,
  y: number,
  z: number,
  hx: number,
  hy: number,
  hz: number,
  color: Vec3,
): void {
  level.addBox([x, y, z], [hx, hy, hz], color);
  world.addBody({ type: BODY_STATIC, shape: boxShape(hx, hy, hz), x, y, z, friction: 0.8 });
  footprints.push({ x, z, hx, hz });
}

const GRASS: Vec3 = [0.4, 0.5, 0.36];
const WALL: Vec3 = [0.62, 0.6, 0.56];
const STONE: Vec3 = [0.5, 0.52, 0.58];

solid(0, -0.5, 0, ARENA, 0.5, ARENA, GRASS);
for (const side of [-1, 1]) {
  solid(side * (ARENA + 0.5), 0.75, 0, 0.5, 0.75, ARENA + 1, WALL);
  solid(0, 0.75, side * (ARENA + 0.5), ARENA, 0.75, 0.5, WALL);
}
// Two tiers, each low enough to jump onto, with an orb waiting on top.
solid(-6, 0.4, -6, 2.6, 0.4, 2.6, STONE);
solid(-6, 1.2, -6, 1.4, 0.4, 1.4, STONE);
solid(6, 1.5, -5, 0.6, 1.5, 0.6, STONE);
solid(5, 1.5, 6, 0.6, 1.5, 0.6, STONE);

const levelMesh = renderer.createMesh(level.build());
const PLATFORM_TOP = 1.6;
```

Every solid thing in the level is one call to `solid`, which adds a box to the picture and the same
box to the physics world. Keeping both in one function is the simplest way to make sure the walls
you see are the walls you hit.

`PhysicsWorld` is the engine's own rigid-body solver, and it is deterministic: the same inputs give
the same result, which is what replays and rollback networking rely on. `BODY_STATIC` bodies never move. `boxShape` takes
**half** extents, like `MeshBuilder.addBox`. `substeps` is a quality dial: more substeps resolve
contacts more accurately for more time per step, and the behaviour stays the same.

All the boxes go into one `MeshBuilder`, so the whole level is a single mesh and a single draw.

## Crates

```ts sample=first-game/main.ts#crates
const CRATE = 0.5;
const crateMesh = renderer.createMesh(
  new MeshBuilder().addBox([0, 0, 0], [CRATE, CRATE, CRATE], [0.74, 0.52, 0.3]).build(),
);

const crates: number[] = [];
for (const [x, z] of [
  [2, -1],
  [3.1, -1.2],
  [2.5, 0.1],
  [-3, 5],
]) {
  crates.push(
    world.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(CRATE, CRATE, CRATE),
      x,
      y: CRATE,
      z,
      friction: 0.6,
    }),
  );
}

/** Position and rotation per crate, before and after the last step, for drawing between them. */
const crateBefore = new Float32Array(crates.length * 7);
const crateAfter = new Float32Array(crates.length * 7);

function recordCrates(out: Float32Array): void {
  const b = world.bodies;
  for (let i = 0; i < crates.length; i += 1) {
    const body = crates[i];
    const o = i * 7;
    out[o] = b.posX[body];
    out[o + 1] = b.posY[body];
    out[o + 2] = b.posZ[body];
    out[o + 3] = b.rotX[body];
    out[o + 4] = b.rotY[body];
    out[o + 5] = b.rotZ[body];
    out[o + 6] = b.rotW[body];
  }
}
```

Crates are `BODY_DYNAMIC`: gravity, contacts and friction move them. The world keeps body state in
flat typed arrays, `posX`, `rotW` and so on, indexed by the number `addBody` returned, which is
cheap to read every step.

The game records every crate's position and rotation before and after each step. Like every moving
thing, a crate is drawn between the two at `alpha`.

## The player

```ts sample=first-game/main.ts#player
const player = new CharacterController({ maxSpeed: 7, jumpSpeed: 7, pushStrength: 2 });
const START: Vec3 = [0, 1.2, 7];

const playerMesh = renderer.createMesh(
  new MeshBuilder()
    .addCapsule([0, 0, 0], player.radius, player.halfHeight, [0.92, 0.88, 0.82])
    .build(),
);

/** Where the player was before the last step, for the same reason the crates keep one. */
const playerBefore = { x: 0, y: 0, z: 0 };
```

`CharacterController` is a capsule moved by the controller, not by forces. It slides along walls,
steps up anything lower than `stepHeight`, stands on slopes up to `slopeCos`, buffers a jump pressed
just before landing and still allows one just after walking off an edge. `pushStrength` is how hard
it shoves dynamic bodies it walks into, which is all it takes to push a crate.

The capsule's mesh is built from the controller's own `radius` and `halfHeight`, so the picture and
the collision shape match.

## Orbs

```ts sample=first-game/main.ts#orbs
interface Orb {
  x: number;
  y: number;
  z: number;
  taken: boolean;
}

const random = mulberry32(SEED);
const orbs: Orb[] = [];
const orbMesh = renderer.createMesh(
  new MeshBuilder().addSphere([0, 0, 0], 0.32, [1, 0.78, 0.36], 1).build(),
);

function blocked(x: number, z: number): boolean {
  return footprints.some(
    (f) => f.hx < ARENA && Math.abs(x - f.x) < f.hx + 0.8 && Math.abs(z - f.z) < f.hz + 0.8,
  );
}

/** Lay out a round. Called between rounds, never per frame, so building the list is fine here. */
function scatter(): void {
  orbs.length = 0;
  while (orbs.length < ORB_COUNT - 1) {
    const x = (random() * 2 - 1) * (ARENA - 1.5);
    const z = (random() * 2 - 1) * (ARENA - 1.5);
    if (!blocked(x, z)) orbs.push({ x, y: 0.9, z, taken: false });
  }
  orbs.push({ x: -6, y: PLATFORM_TOP + 0.9, z: -6, taken: false });
}
```

`mulberry32(SEED)` is a seeded random generator. Seven orbs are scattered where nothing stands, and
the eighth always waits on top of the platform, so every round asks for one climb.

The fourth argument to `addSphere` is the emissive strength: these orbs glow.

## Input

```ts sample=first-game/main.ts#input
const input = new InputSource(canvas, ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

const actions = new ActionMap(input, {
  move: {
    stick: 'left',
    up: ['KeyW', 'ArrowUp'],
    down: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
  },
  jump: { keys: ['Space'], buttons: ['faceDown'] },
  restart: { keys: ['KeyR', 'Enter'], buttons: ['start'] },
  pause: { keys: ['KeyP', 'Escape'], buttons: ['select'] },
});

/** A thumb stick on the left of a touch screen, and a tap or hold on the right. */
const touch = new TouchControls(input);
const move = { x: 0, y: 0 };
```

[Moving things](moving-things.md) explains the three layers. The game binds `move` to a stick and four
key directions, and `jump`, `restart` and `pause` to keys and buttons.

## Sound

```ts sample=first-game/main.ts#sound
const sound = await AudioGraph.create({ stemCount: 0 });
sound?.registry.register('orb', {
  urls: [],
  synth: (ctx) => toneBuffer(ctx, 0.2, 660, 1320, 3),
});
if (sound !== null) void sound.registry.load(sound.context);

// A browser starts audio only after a gesture, so the first press anywhere wakes it.
addEventListener('pointerdown', () => sound?.wake());
addEventListener('keydown', () => sound?.wake());

function chime(): void {
  sound?.play(sound.registry.get('orb'), 0.45);
}
```

`@driftengine/audio` gives every sound a named slot. A slot lists files to try and a function that
synthesises a stand-in when none of them loads. This one lists no files, so the chime is always the
stand-in: a sine sweep from 660 to 1320 Hz. Drop an `orb.opus` into the game's assets and add it to
`urls`, and the real sound replaces it with no other change.

Browsers only start audio after the player touches something, so the first key or tap wakes the
graph. `AudioGraph.create` returns `null` only when the browser has no audio at all, and every use
of `sound` here is written to cope with that.

## A round

```ts sample=first-game/main.ts#round
type Phase = 'playing' | 'won' | 'lost';
let phase: Phase = 'playing';
let remaining = ROUND_SECONDS;
let gathered = 0;
let paused = false;

function newRound(): void {
  scatter();
  gathered = 0;
  remaining = ROUND_SECONDS;
  phase = 'playing';
  player.teleport(START[0], START[1], START[2]);
  playerBefore.x = player.x;
  playerBefore.y = player.y;
  playerBefore.z = player.z;
}
```

`newRound` resets the score and the clock, lays out new orbs and puts the player back at the start.
It also resets `playerBefore`, so the first frame of a round doesn't draw the player sliding back
from wherever the last round ended.

## The step

```ts sample=first-game/main.ts#simulate
function simulate(dt: number): void {
  if (phase !== 'playing') {
    if (actions.consumePress('restart') || touch.consumePrimaryPress()) newRound();
    return;
  }

  // Keys and the pad follow the stick convention, where up is negative. The touch stick reports
  // up as positive, so it is flipped here, once.
  actions.vector('move', move);
  if (touch.moveX !== 0 || touch.moveY !== 0) {
    move.x = touch.moveX;
    move.y = -touch.moveY;
  }

  playerBefore.x = player.x;
  playerBefore.y = player.y;
  playerBefore.z = player.z;
  player.move(world, dt, {
    moveX: move.x * player.maxSpeed,
    moveZ: move.y * player.maxSpeed,
    jump: actions.down('jump') || touch.primaryHeld,
  });

  recordCrates(crateBefore);
  world.step(dt);
  recordCrates(crateAfter);

  for (let i = 0; i < orbs.length; i += 1) {
    const orb = orbs[i];
    if (orb.taken) continue;
    const dx = orb.x - player.x;
    const dy = orb.y - player.y;
    const dz = orb.z - player.z;
    if (dx * dx + dy * dy + dz * dz < 1) {
      orb.taken = true;
      gathered += 1;
      chime();
    }
  }

  if (player.y < -10) player.teleport(START[0], START[1], START[2]);

  remaining -= dt;
  if (gathered === orbs.length) phase = 'won';
  else if (remaining <= 0) {
    remaining = 0;
    phase = 'lost';
  }
}
```

The order is the whole design:

1. Read input into a direction.
2. Move the player against the world.
3. Step the world, so crates the player pushed respond, recording crates before and after.
4. Collect any orb close enough.
5. Count the clock down and decide whether the round is over.

Everything here reads state, the step's input and the seeded generator. Nothing reads the time of
day, so a recording of the inputs replays the round exactly.

## The camera

```ts sample=first-game/main.ts#camera
const camera = new Camera();
camera.fovYDeg = 55;
const eye = { x: START[0], y: START[1] + 6, z: START[2] + 9 };

/** Ease toward a spot behind and above the player. Presentation only, so it runs on frame time. */
function follow(x: number, y: number, z: number, frameDt: number): void {
  eye.x = damp(eye.x, x, 5, frameDt);
  eye.y = damp(eye.y, y + 6, 5, frameDt);
  eye.z = damp(eye.z, z + 9, 5, frameDt);
  camera.position[0] = eye.x;
  camera.position[1] = eye.y;
  camera.position[2] = eye.z;
  camera.lookAt(x, y + 0.6, z);
  camera.updateMatrices(renderer.cssHeight > 0 ? renderer.cssWidth / renderer.cssHeight : 1);
}
```

The camera eases toward a spot behind and above the player. The easing runs on `frameDt` in the
frame, because it's presentation: it doesn't change the game, only how it's seen.

## Placing everything for the frame

```ts sample=first-game/main.ts#transforms
/** One node per thing that moves, built once, so a frame writes matrices and allocates nothing. */
const still = new SceneNode();
still.updateWorld();
const playerNode = new SceneNode();
const crateNodes = crates.map(() => new SceneNode());
const orbNodes = Array.from({ length: ORB_COUNT }, () => new SceneNode());
let clock = 0;

function placeEverything(alpha: number): void {
  playerNode.setPosition(
    lerp(playerBefore.x, player.x, alpha),
    lerp(playerBefore.y, player.y, alpha),
    lerp(playerBefore.z, player.z, alpha),
  );
  playerNode.updateWorld();

  for (let i = 0; i < crates.length; i += 1) placeCrate(crateNodes[i], i, alpha);

  for (let i = 0; i < orbs.length; i += 1) {
    const orb = orbs[i];
    orbNodes[i].setPosition(orb.x, orb.y + Math.sin(clock * 2.4 + i) * 0.12, orb.z);
    orbNodes[i].setRotationAxisAngle(0, 1, 0, clock * 1.5 + i);
    orbNodes[i].updateWorld();
  }
}

/** Position by lerp and rotation by normalised lerp. A step turns a crate very little, so that is enough. */
function placeCrate(node: SceneNode, i: number, alpha: number): void {
  const a = crateBefore;
  const b = crateAfter;
  const o = i * 7;
  // q and -q are the same rotation; flip one so the blend goes the short way round.
  const dot = a[o + 3] * b[o + 3] + a[o + 4] * b[o + 4] + a[o + 5] * b[o + 5] + a[o + 6] * b[o + 6];
  const sign = dot < 0 ? -1 : 1;
  const r = node.rotation;
  for (let k = 0; k < 4; k += 1) r[k] = lerp(a[o + 3 + k] * sign, b[o + 3 + k], alpha);
  const length = Math.hypot(r[0], r[1], r[2], r[3]);
  for (let k = 0; k < 4; k += 1) r[k] /= length;
  node.position[0] = lerp(a[o], b[o], alpha);
  node.position[1] = lerp(a[o + 1], b[o + 1], alpha);
  node.position[2] = lerp(a[o + 2], b[o + 2], alpha);
  node.markMoved();
  node.updateWorld();
}
```

Each moving thing gets its own `SceneNode`, made once at load. Each frame writes their positions
between the last two steps and updates their world matrices, and nothing is allocated.

Rotations are quaternions. Blending two of them component by component and normalising, the
normalised lerp, is accurate for the small turn a crate makes in one step. The sign check makes the
blend go the short way round, because a quaternion and its negative are the same rotation.

## Shadows and the frame

```ts sample=first-game/main.ts#casters
/**
 * Everything in the world, said once. The shadow pass and the colour pass both draw from this,
 * so nothing can cast a shadow without being seen, or be seen without casting one.
 */
const casters: ShadowCasters = (sink) => {
  sink.mesh(levelMesh, still.worldMatrix);
  sink.mesh(playerMesh, playerNode.worldMatrix);
  for (let i = 0; i < crateNodes.length; i += 1) sink.mesh(crateMesh, crateNodes[i].worldMatrix);
  for (let i = 0; i < orbs.length; i += 1) {
    if (!orbs[i].taken) sink.mesh(orbMesh, orbNodes[i].worldMatrix);
  }
};

const lightMatrix = new Float32Array(16);
ENV.lightViewProj = lightMatrix;
ENV.shadowStrength = 0.8;
```

`casters` is one function that names everything in the world. The shadow pass calls it to draw depth
from the sun, and the colour pass calls it to draw the picture, so nothing can be visible without
casting a shadow, or cast one without being visible.

```ts sample=first-game/main.ts#render
function render(alpha: number, frameDt: number): void {
  // Input is sampled here, at the edge of the simulation: a step reads what this left behind.
  touch.tick(performance.now());
  // Read here, not in simulate: while paused, simulate is not called at all.
  if (actions.consumePress('pause')) paused = !paused;
  if (!paused) clock += frameDt;
  placeEverything(alpha);
  const at = playerNode.position;
  follow(at[0], at[1], at[2], frameDt);

  // The shadow map covers 16 metres around the player, which is everything the camera sees.
  ENV.shadowDepthSpan = computeLightMatrix(
    ENV.directionalDir,
    at[0],
    at[1],
    at[2],
    16,
    renderer.shadowMapSize,
    lightMatrix,
  );
  renderer.beginShadowPass(lightMatrix, 'static');
  renderer.drawShadowCasters(casters);
  renderer.endShadowPass();

  renderer.beginFrame(SKY);
  renderer.bindMeshPass(camera, ENV);
  renderer.drawSceneCasters(casters);
  drawHud();
  renderer.endFrame();
}
```

`computeLightMatrix` aims the sun's shadow map at the 16 metres around the player, which is all the
camera ever shows, so the map's resolution is spent where you're looking. It returns the depth span
the shading needs, and the environment carries both to the mesh pass.

The frame then runs the shadow pass, opens the colour frame, binds the camera and environment, draws
the casters, draws the HUD and ends.

## The HUD

```ts sample=first-game/main.ts#hud
const hud = renderer.createText();
let hudStyle: typeof DEFAULT_TEXT_STYLE = {
  ...DEFAULT_TEXT_STYLE,
  color: [1, 0.98, 0.92],
  glow: 0.7,
};
/** What the text last said, so a new string is built only when a number on it changes. */
const shown = { gathered: -1, seconds: -1, phase: '', paused: false };

function drawHud(): void {
  const seconds = Math.ceil(remaining);
  if (
    gathered !== shown.gathered ||
    seconds !== shown.seconds ||
    phase !== shown.phase ||
    paused !== shown.paused
  ) {
    shown.gathered = gathered;
    shown.seconds = seconds;
    shown.phase = phase;
    shown.paused = paused;
    renderer.setText(
      hud,
      paused
        ? 'PAUSED. PRESS P TO CARRY ON'
        : phase === 'won'
          ? 'ALL GATHERED. PRESS R OR TAP TO PLAY AGAIN'
          : phase === 'lost'
            ? 'OUT OF TIME. PRESS R OR TAP TO PLAY AGAIN'
            : `ORBS ${gathered}/${orbs.length}   TIME ${seconds}`,
    );
  }

  const width = renderer.cssWidth;
  const height = renderer.cssHeight;
  // The style is rebuilt only when a resize moves the cell size.
  const cell = Math.max(2, Math.round(Math.min(width, height) / 220));
  if (cell !== hudStyle.cellSize) hudStyle = { ...hudStyle, cellSize: cell };
  renderer.drawText(
    hud,
    width,
    height,
    Math.round(width / 2 - renderer.textWidth(hud, cell) / 2),
    Math.round(height * 0.08) + cell * 7,
    hudStyle,
    0,
  );
}
```

The built-in pixel font needs no asset. A text handle is laid out once per string, so the HUD builds
a new string only when a number on it changes, and the style object is rebuilt only when a resize
changes the size of a cell.

## Starting it

```ts sample=first-game/main.ts#loop
newRound();
startLoop({ simulate, render, shouldSimulate: () => !paused });
```

A round, then the loop, with pause wired to `shouldSimulate`.

## Where to take it

The game is small on purpose, and every part of it has somewhere to grow:

- Replace the boxes with a model from Blender or glTF, and the capsule with a skinned, animated
  character.
- Swap the follow camera for the third-person rig, which keeps the lens out of walls.
- Turn on bloom, so the orbs glow past their edges.
- Record the inputs for each tick and play a round back, which the fixed step already makes exact.

Next, [A 2D game](a-2d-game.md) shows that the same engine draws a flat game with no special mode,
and [Shipping to the web](shipping-to-the-web.md) turns either into something you can put online.

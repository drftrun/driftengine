/**
 * A long gallery lit by seven hundred candles, of which the frame shades the nearest sixteen.
 *
 * DriftLight sums every candle once into a volume of light, occluded by the gallery's own walls,
 * and the shader reads that volume wherever the frame's exact choice does not reach. Switch it off
 * in the strip and everything past the nearest candles goes dark; the partition halfway down shows
 * that summed light does not pass through stone.
 */
import { bakeObjectSdf } from '@driftengine/assets';
import {
  DEFAULT_POINT_LIGHT_VIEW_RANGE,
  MeshBuilder,
  SceneNode,
  createEnvironment,
  createPointLightBuffer,
  selectPointLights,
} from '@driftengine/core';
import type { GlobalFieldInstance, PointLightSource, Vec3 } from '@driftengine/core';
import { controls, flag, openStage } from '../common/stage';

const stage = await openStage({ outputTransform: 'aces', outputExposure: 1.4, sceneSamples: 4 });
const { renderer, camera } = stage;

controls([
  {
    key: 'driftlight',
    label: 'DriftLight',
    value: flag('driftlight', 'on'),
    options: [
      { text: 'on', value: 'on' },
      { text: 'off', value: 'off' },
    ],
    /* The field stays baked; its scale is how much of the summed light reaches the frame. */
    change: (value) => {
      field.scale = value === 'on' ? 1 : 0;
    },
  },
]);

const LENGTH = 20;
const WIDTH = 3;
const HEIGHT = 4;
const PARTITION = 4;
const DOOR = 0.6;

/** The gallery as slabs: floor, ceiling, four walls, and a partition with a doorway. */
const slabs: { centre: Vec3; half: Vec3 }[] = [
  { centre: [0, -0.1, 0], half: [LENGTH, 0.1, WIDTH] },
  { centre: [0, HEIGHT + 0.1, 0], half: [LENGTH, 0.1, WIDTH] },
  { centre: [0, HEIGHT / 2, -WIDTH - 0.1], half: [LENGTH, HEIGHT / 2, 0.1] },
  { centre: [0, HEIGHT / 2, WIDTH + 0.1], half: [LENGTH, HEIGHT / 2, 0.1] },
  {
    centre: [PARTITION, HEIGHT / 2, -(WIDTH + DOOR) / 2],
    half: [0.1, HEIGHT / 2, (WIDTH - DOOR) / 2],
  },
  {
    centre: [PARTITION, HEIGHT / 2, (WIDTH + DOOR) / 2],
    half: [0.1, HEIGHT / 2, (WIDTH - DOOR) / 2],
  },
  { centre: [PARTITION, 3.25, 0], half: [0.1, 0.75, DOOR] },
  { centre: [-LENGTH - 0.1, HEIGHT / 2, 0], half: [0.1, HEIGHT / 2, WIDTH] },
  { centre: [LENGTH + 0.1, HEIGHT / 2, 0], half: [0.1, HEIGHT / 2, WIDTH] },
];

// #region candles
/** Three rows of candles along each wall, thirty centimetres apart. None of them casts. */
const candles: PointLightSource[] = [];
for (const side of [-1, 1])
  for (const y of [1, 1.6, 2.2])
    for (let x = -LENGTH + 2; x <= LENGTH - 2; x += 0.3)
      candles.push({
        x,
        y,
        z: side * (WIDTH - 0.4),
        r: 0.5,
        g: 0.27,
        b: 0.08,
        radius: 1.2,
        flicker: 0,
        shadowNear: 0.05,
        sourceRadius: 0.005,
        castsShadow: false,
      });
// #endregion

const stone = new MeshBuilder();
for (const slab of slabs) stone.addBox(slab.centre, slab.half, [0.62, 0.58, 0.52]);
const gallery = renderer.createMesh(stone.build());
const wax = new MeshBuilder();
for (const c of candles)
  wax.addBox([c.x, c.y - 0.08, c.z], [0.012, 0.07, 0.012], [0.93, 0.86, 0.72], 0.6);
const stands = renderer.createMesh(wax.build());

// #region field
/** Each slab baked into a distance field, which is what stops summed light passing through it. */
const walls: GlobalFieldInstance[] = slabs.map((slab) => ({
  source: bakeObjectSdf(new MeshBuilder().addBox(slab.centre, slab.half, [1, 1, 1]).build(), 96),
  transform: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
}));

const field = renderer.createLightField(candles, { fields: walls });
field.scale = flag('driftlight', 'on') === 'on' ? 1 : 0;
// #endregion

const env = createEnvironment({
  directionalColor: [0, 0, 0],
  ambient: [0.004, 0.004, 0.005],
  ambientGround: [0.002, 0.002, 0.002],
  nightFactor: 1,
});
const chosen = createPointLightBuffer(renderer.shadedLights);
const still = new SceneNode();
still.updateWorld();
camera.fovYDeg = 62;
camera.near = 0.1;
let time = 0;
let shadedAt = 0;

stage.run({
  simulate(dt) {
    time += dt;
  },
  render() {
    /* Up and down the near half, always facing the partition. */
    const walk = -8 - Math.cos(time * 0.06) * 9;
    camera.position[0] = walk;
    camera.position[1] = 1.6;
    camera.position[2] = Math.sin(time * 0.2) * 0.6;
    camera.lookAt(walk + 8, 1.7, 0);

    // #region frame
    /* Bricks until four milliseconds of this frame are spent, so the walk stays smooth on a slow
       machine too; once the field is whole it fades in over half a second. */
    const until = performance.now() + 4;
    while (!field.ready && performance.now() < until) field.bake(4);

    const [x, y, z] = camera.position;
    selectPointLights(candles, x, y, z, chosen, time, DEFAULT_POINT_LIGHT_VIEW_RANGE);
    env.lightCount = chosen.count;
    env.lightPositions = chosen.positions;
    env.lightColors = chosen.colors;
    env.lightRadii = chosen.radii;
    env.lightSourceRadii = chosen.sourceRadii;
    env.lightWeights = chosen.weights;
    /* Where the exact choice is complete, so the shader knows where the field takes over. */
    field.follow(chosen.complete, x, y, z, time - shadedAt);
    shadedAt = time;
    // #endregion

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(gallery, still.worldMatrix);
    renderer.drawMesh(stands, still.worldMatrix);
    renderer.endFrame();
  },
});

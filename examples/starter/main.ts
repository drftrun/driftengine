/**
 * The smallest thing that is still a game: a lit cube on a ground plane, turning on a fixed
 * timestep, drawn through whichever backend the browser actually handed over.
 *
 * Everything here is reached through the public barrel, because that barrel is the whole of
 * what a consumer receives. A starter that reached past it would be demonstrating privileged
 * access rather than the engine.
 */
import {
  Camera,
  MeshBuilder,
  SceneNode,
  createEnvironment,
  createRenderer,
  startLoop,
} from '@driftengine/core';

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
if (canvas === null) throw new Error('the page must carry <canvas id="stage">');

/*
 * Asynchronous because it has to be: asking for a WebGPU adapter returns a promise, and there
 * is no synchronous way to learn whether a usable device exists. The fall back to WebGL2 is
 * automatic and silent, so `reason` is the only thing that says which of the three counts
 * fired — print it, because the first question asked about any picture is what drew it.
 */
const { renderer, backend, reason } = await createRenderer(canvas, {
  maxDevicePixelRatio: 1.75,
  directionalShadows: true,
});

const readout = document.querySelector('#backend');
if (readout !== null) readout.textContent = `${backend} — ${reason}`;

renderer.resize();
addEventListener('resize', () => renderer.resize());

/** Light, air and ground bounce. Chosen once, because these are allocation-sized decisions. */
const ENV = createEnvironment({
  directionalDir: [0.4, 0.7, 0.35],
  directionalColor: [1, 0.96, 0.88],
  ambient: [0.2, 0.22, 0.28],
  ambientGround: [0.08, 0.08, 0.1],
  emissiveGain: 0,
  nightFactor: 0,
  fogColor: [0.16, 0.18, 0.24],
  fogDensity: 0.004,
  fogHeightFalloff: 0.03,
  fogBaseY: 0,
});

/*
 * Colour is vertex data here, which is what lets a whole world be flat-shaded draw calls.
 * `addBox` takes a centre and *half* extents, so this ground is 24 units across and the cube
 * is two units on a side.
 */
const shapes = new MeshBuilder();
shapes.addBox([0, 1, 0], [1, 1, 1], [0.85, 0.45, 0.25]);
const cube = renderer.createMesh(shapes.build());

const slab = new MeshBuilder();
slab.addBox([0, -0.25, 0], [12, 0.25, 12], [0.3, 0.32, 0.36]);
const ground = renderer.createMesh(slab.build());

const spinner = new SceneNode();
spinner.setPosition(0, 1, 0);
const stillness = new SceneNode();
stillness.updateWorld();

const camera = new Camera();
camera.position[0] = 6;
camera.position[1] = 4.5;
camera.position[2] = 8;
camera.lookAt(0, 1, 0);

/*
 * Two angles rather than one, because that is what `alpha` is for. The simulation advances in
 * fixed steps and the display does not, so a frame almost never lands on a step boundary:
 * drawing `spin` directly judders at any refresh rate that is not a multiple of the step.
 * Interpolating between the last two states is the whole reason the loop hands `alpha` over.
 */
let spin = 0;
let previousSpin = 0;

startLoop({
  simulate(dt) {
    previousSpin = spin;
    spin += dt * 0.8;
  },
  render(alpha) {
    spinner.setRotationAxisAngle(0, 1, 0, previousSpin + (spin - previousSpin) * alpha);
    spinner.updateWorld();

    camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

    renderer.beginFrame([0.05, 0.06, 0.09]);
    renderer.bindMeshPass(camera, ENV);
    renderer.drawMesh(ground, stillness.worldMatrix);
    renderer.drawMesh(cube, spinner.worldMatrix);
    renderer.endFrame();
  },
});

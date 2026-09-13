/**
 * The 2D layer: screen-space panels and text, drawn over a 3D scene.
 *
 * There is no separate 2D renderer. An interface here is panels and a bitmap font drawn in
 * *pixel* coordinates over the finished scene, which is why `drawText` takes a viewport and a
 * baseline rather than a world matrix. The font is built in — `createText()` takes no
 * arguments and fetches nothing, so a heads-up display costs no assets at all.
 *
 * **Both calls go before `endFrame`, and that is not a style preference.** WebGL2 runs its
 * commands eagerly against the canvas, so a draw issued after the resolve still lands on top.
 * WebGPU records into an encoder that `endFrame` has already submitted: the same call finds no
 * open pass, draws nothing, and reports no error. The switch below lets you watch that happen
 * — on WebGL2 the overlay survives, on WebGPU it vanishes.
 */
import { DEFAULT_TEXT_STYLE, MeshBuilder, SceneNode } from '@driftengine/core';
import { DAYLIGHT, controls, flag, openStage } from '../common/stage';

const after = flag('after', '0') === '1';

const stage = await openStage({ directionalShadows: true });

controls([
  {
    label: 'overlay drawn',
    options: [
      { text: 'before endFrame', query: 'after=0' },
      { text: 'after endFrame', query: 'after=1' },
    ],
  },
]);

const solids = new MeshBuilder();
solids.addBox([0, -0.25, 0], [9, 0.25, 9], [0.32, 0.34, 0.4]);
solids.addBox([-1.6, 1, 0], [1, 1, 1], [0.66, 0.5, 0.42]);
solids.addBox([1.7, 0.75, -0.6], [0.75, 0.75, 0.75], [0.5, 0.56, 0.66]);
const scene = stage.renderer.createMesh(solids.build());

const still = new SceneNode();
still.updateWorld();

/** Two handles, laid out once and re-laid only when the string changes. */
const title = stage.renderer.createText();
const detail = stage.renderer.createText();
stage.renderer.setText(title, 'DRIFTENGINE');

stage.camera.position[0] = 5.5;
stage.camera.position[1] = 3.4;
stage.camera.position[2] = 6.5;
stage.camera.lookAt(0, 1, 0);

let seconds = 0;

stage.run({
  simulate(dt) {
    seconds += dt;
  },
  render() {
    stage.renderer.beginFrame([0.05, 0.06, 0.09]);
    stage.renderer.bindMeshPass(stage.camera, DAYLIGHT);
    stage.renderer.drawMesh(scene, still.worldMatrix);

    if (after) stage.renderer.endFrame();

    const width = stage.renderer.cssWidth;
    const height = stage.renderer.cssHeight;
    const cell = Math.max(2, Math.round(Math.min(width, height) / 220));
    const left = Math.round(width * 0.08);
    const baseline = Math.round(height * 0.5);

    /* A backing plate first, then the glyphs over it — an outline would be four more panels. */
    stage.renderer.fillPanel(
      { left: left - cell * 3, top: baseline - cell * 10, width: cell * 72, height: cell * 22 },
      [0.04, 0.05, 0.08],
      0.66,
    );

    stage.renderer.bindMeshPass(stage.camera, DAYLIGHT);
    stage.renderer.drawText(
      title,
      width,
      height,
      left,
      baseline,
      {
        ...DEFAULT_TEXT_STYLE,
        cellSize: cell,
        color: [1, 0.85, 0.35],
        glow: 1,
        alpha: 1,
        reveal: 1,
      },
      seconds,
    );

    stage.renderer.setText(detail, `${Math.round(seconds)}s elapsed`);
    stage.renderer.drawText(
      detail,
      width,
      height,
      left,
      baseline + cell * 10,
      {
        ...DEFAULT_TEXT_STYLE,
        cellSize: Math.max(1, cell - 1),
        color: [0.7, 0.75, 0.85],
        glow: 0,
        alpha: 0.9,
        reveal: 1,
      },
      seconds,
    );

    if (!after) stage.renderer.endFrame();
  },
});

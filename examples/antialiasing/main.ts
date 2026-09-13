/**
 * Antialiasing, on the edges where it is actually visible.
 *
 * `sceneSamples` is multisampling on the scene pass: 1 is off, 4 is the usual on. It is a
 * construction-time option because the sample count decides how the attachments are
 * allocated, so switching here rebuilds the renderer by reloading.
 *
 * The scene is deliberately made of *near-vertical* edges rather than a cube's clean ones. A
 * 45-degree edge aliases into a tidy staircase that reads almost as a texture; an edge a few
 * degrees off vertical produces long runs of one pixel then a jump, which is the case that
 * looks broken without multisampling and fixed with it. Lean in — the difference is a pixel
 * wide, and a comparison you have to zoom into is still a real one.
 */
import { MeshBuilder, SceneNode } from '@driftengine/core';
import { DAYLIGHT, controls, flagNumber, openStage } from '../common/stage';

const samples = flagNumber('samples', 1);

const stage = await openStage({ sceneSamples: samples, directionalShadows: true });

controls([
  {
    label: 'sceneSamples',
    options: [
      { text: '1 (off)', query: 'samples=1' },
      { text: '4', query: 'samples=4' },
    ],
  },
]);

/** A picket fence, each post leaning a little differently, so no two edges alias alike. */
const posts = new MeshBuilder();
posts.addBox([0, -0.25, 0], [9, 0.25, 9], [0.32, 0.34, 0.38]);
const scene = stage.renderer.createMesh(posts.build());

const postMesh = new MeshBuilder();
postMesh.addBox([0, 1.6, 0], [0.09, 1.6, 0.09], [0.82, 0.84, 0.88]);
const post = stage.renderer.createMesh(postMesh.build());

/*
 * Built once, held, and never rebuilt in the frame loop. A `SceneNode` per post is the cheap
 * way to keep sixteen world matrices that do not change: computing them once here is sixteen
 * matrix multiplies for the whole run rather than sixteen every frame.
 */
const fence: SceneNode[] = [];
for (let i = 0; i < 16; i += 1) {
  const node = new SceneNode();
  node.setPosition(-6 + i * 0.8, 0, -1.5 + (i % 3) * 0.9);
  node.setRotationAxisAngle(0, 0, 1, (i - 8) * 0.012);
  node.updateWorld();
  fence.push(node);
}

const still = new SceneNode();
still.updateWorld();

stage.camera.position[0] = 0.6;
stage.camera.position[1] = 3.1;
stage.camera.position[2] = 12;
stage.camera.lookAt(0, 1.5, 0);

stage.run({
  render() {
    stage.renderer.beginFrame([0.06, 0.07, 0.1]);
    stage.renderer.bindMeshPass(stage.camera, DAYLIGHT);
    stage.renderer.drawMesh(scene, still.worldMatrix);
    for (const node of fence) stage.renderer.drawMesh(post, node.worldMatrix);
    stage.renderer.endFrame();
  },
});

/**
 * A model on a turntable: one of the samples, or any file dropped on the page.
 *
 * A model file is read in a worker, which hands back a `.drft` container, and the container is
 * streamed onto the screen by `DrftLoader`: an outline first where the model is big enough to want
 * one, then the parts fading in a few a frame, then the finished model merged down to a draw per
 * material. A baked `.drft` fetched from a server takes the same path from its first byte; reading
 * a source format at load is for a file a person brings, and a bake is for a file you ship. A
 * container made here is also larger than the baker's, since it neither quantises its vertices nor
 * finds the meshes a model repeats: a 154 MB glTF scene comes to 197 MB here and bakes to 80 MB.
 *
 * The loader draws what it loaded, casts its shadows and fits the sun to it, each by the rules a
 * container needs, so nothing below reads a part's fields.
 */
import { DrftLoader, extensionOf, readerFor } from '@driftengine/assets';
import type { DrftFit } from '@driftengine/assets';
import { MeshBuilder, computeLightMatrix, createEnvironment, srgbColor } from '@driftengine/core';
import type { ShadowCasters } from '@driftengine/core';
import { createReadout } from '../common/readout';
import { controls, flag, openStage } from '../common/stage';
import type { ConvertReply, ConvertRequest } from './convert';

/** The background, picked by eye and so stated through `srgbColor`: the renderer grades a clear. */
const CLEAR = srgbColor(0.2, 0.22, 0.26);

const stage = await openStage({
  directionalShadows: true,
  outputTransform: 'aces',
  sceneSamples: 4,
});
const { renderer, camera } = stage;

// #region load
/** Every model is fitted to the turntable: this wide, this tall, standing on it. */
const FIT: DrftFit = { footprint: 1.8, height: 1.6, baseY: 0.1 };
const worker = new Worker(new URL('./convert.ts', import.meta.url), { type: 'module' });
let loader: DrftLoader | null = null;
/** The loader whose pipelines have been compiled, so each is prepared once. */
let prepared: DrftLoader | null = null;

/** Send a file's bytes to the worker, and stream the container it answers with. */
function open(request: ConvertRequest): void {
  status = { label: request.name, line: 'READING' };
  worker.postMessage(request, [request.bytes]);
}
worker.onmessage = (event: MessageEvent<ConvertReply>) => {
  const reply = event.data;
  if (!reply.ok) {
    status = { label: status.label, line: reply.reason };
    return;
  }
  loader?.dispose();
  loader = new DrftLoader(renderer, { uploadsPerFrame: 4 });
  status = {
    label: status.label,
    line: `${reply.meshes} ${reply.meshes === 1 ? 'MESH' : 'MESHES'} CONVERTED IN ${reply.ms.toFixed(0)} MS`,
  };
  /* The loader streams from a response; a container from a worker is wrapped in one. */
  void loader.consume(new Response(reply.drft), FIT);
};
// #endregion

let status = { label: '', line: '' };

// #region samples
/** Three formats: glTF with its pictures inside it, OBJ with a material beside it, and STL. */
const SAMPLES: Record<string, string> = {
  lantern: 'lantern.glb',
  vase: 'vase.obj',
  gear: 'gear.stl',
};
/* Beside this page: a bundler rewrites `new URL(..., import.meta.url)` for a file, not a folder. */
const folder = new URL('assets/', location.href).href;
async function sample(label: string): Promise<void> {
  const name = SAMPLES[label] ?? 'lantern.glb';
  const response = await fetch(new URL(name, folder));
  open({ name, bytes: await response.arrayBuffer(), folder });
}
/* Any model dropped on the page, and the files dropped with it, such as its `.mtl` or textures. */
addEventListener('dragover', (event) => event.preventDefault());
addEventListener('drop', (event) => {
  event.preventDefault();
  const files = [...(event.dataTransfer?.files ?? [])];
  const model = files.find((file) => readerFor(extensionOf(file.name)) !== undefined);
  if (model === undefined) return;
  void Promise.all(files.map(async (file) => [file.name, await file.arrayBuffer()] as const)).then(
    (read) => {
      const dropped = Object.fromEntries(read);
      const bytes = dropped[model.name] as ArrayBuffer;
      delete dropped[model.name];
      open({ name: model.name, bytes, dropped });
    },
  );
});
// #endregion

const chosen = flag('model', 'lantern');
controls([
  {
    key: 'model',
    label: 'sample',
    value: chosen,
    options: Object.keys(SAMPLES).map((s) => ({ text: s, value: s })),
    change: (value) => void sample(value),
  },
]);
void sample(chosen);

const plinth = renderer.createMesh(
  new MeshBuilder()
    .addCylinder([0, 0.05, 0], 1.3, 0.05, 'y', [0.3, 0.3, 0.32], 0, 48)
    .addBox([0, -0.05, 0], [20, 0.05, 20], [0.16, 0.17, 0.19])
    .build(),
);
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const env = createEnvironment({
  directionalDir: [0.45, 0.8, 0.4],
  directionalColor: [1.6, 1.55, 1.45],
  ambient: [0.36, 0.38, 0.45],
  ambientGround: [0.12, 0.12, 0.13],
  /* Emissive is gated on how much of night there is, so a lantern's flame needs a little of it. */
  nightFactor: 0.5,
  emissiveGain: 1.5,
});
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;
env.shadowStrength = 0.7;
/* Around the turntable until a model says how large it is: see `shadowFit` below. */
env.shadowDepthSpan = computeLightMatrix(
  env.directionalDir,
  0,
  0.8,
  0,
  2.5,
  renderer.shadowMapSize,
  lightMatrix,
);
/** What stands in the sun: the plinth, and every part of the model but a decal. Made once. */
const casters: ShadowCasters = (sink) => {
  sink.mesh(plinth, IDENTITY);
  loader?.casters(sink);
};
const readout = createReadout(renderer, 3);
let time = 0;

stage.run({
  simulate(dt) {
    time += dt;
    loader?.update(dt);
    // #region prepare
    /* Once the finished model is in, every pipeline its parts draw with is compiled off the frame,
       so no later frame waits on one. A game would hold its loading screen until this resolves. */
    if (loader !== null && loader !== prepared && loader.progress.phase === 'ready') {
      prepared = loader;
      void loader.prepare();
    }
    // #endregion
  },
  render() {
    camera.fovYDeg = 40;
    camera.position[0] = Math.sin(time * 0.25) * 4.2;
    camera.position[1] = 2.2;
    camera.position[2] = Math.cos(time * 0.25) * 4.2;
    camera.lookAt(0, 0.8, 0);
    // #region shadow
    /* The sun's map around the model as it was fitted, once its file has said how large it is. */
    const span = loader?.shadowFit(env.directionalDir, renderer.shadowMapSize, lightMatrix) ?? null;
    if (span !== null) env.shadowDepthSpan = span;
    renderer.beginShadowPass(lightMatrix, 'static');
    renderer.drawShadowCasters(casters);
    renderer.endShadowPass();
    // #endregion
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(plinth, IDENTITY);
    // #region draw
    /* Every part in its whole material: its copies through one instanced draw, a blended part
       translucent and writing no depth, glass as glass, each with its own reflectivity. */
    loader?.draw();
    // #endregion
    const progress = loader?.progress;
    /* A refusal can be long, so the first line carries what fits and the second the rest. */
    const said = `${status.label}: ${status.line}`.toUpperCase();
    const cut = said.length > 64 ? said.lastIndexOf(' ', 64) : said.length;
    readout.set(0, said.slice(0, cut));
    readout.set(
      1,
      said.length > cut
        ? said.slice(cut + 1)
        : progress === undefined
          ? ''
          : `${progress.phase.toUpperCase()}  ${progress.partsDone}/${progress.partsTotal} PARTS  ${progress.imagesDone}/${progress.imagesTotal} IMAGES`,
    );
    readout.set(2, 'DROP A .GLB .GLTF .OBJ .STL .USDZ .3MF .FBX OR .BLEND ON THE PAGE');
    readout.draw(time);
    renderer.endFrame();
  },
});

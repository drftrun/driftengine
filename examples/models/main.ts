/**
 * A model on a turntable: one of the samples, or any file dropped on the page.
 *
 * A model file is read in a worker, which hands back a `.drft` container, and the container is
 * streamed onto the screen by `DrftLoader`: an outline first where the model is big enough to want
 * one, then the parts fading in a few a frame, then the finished model merged down to a draw per
 * material. A baked `.drft` fetched from a server takes the same path from its first byte; reading
 * a source format at load is for a file a person brings, and a bake is for a file you ship.
 */
import { DrftLoader, extensionOf, readerFor } from '@driftengine/assets';
import type { DrftFit } from '@driftengine/assets';
import { MeshBuilder, computeLightMatrix, createEnvironment } from '@driftengine/core';
import { createReadout } from '../common/readout';
import { controls, flag, openStage } from '../common/stage';
import type { ConvertReply, ConvertRequest } from './convert';

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
env.shadowDepthSpan = computeLightMatrix(
  env.directionalDir,
  0,
  0.8,
  0,
  2.5,
  renderer.shadowMapSize,
  lightMatrix,
);
const readout = createReadout(renderer, 3);
let time = 0;

stage.run({
  simulate(dt) {
    time += dt;
    loader?.update(dt);
  },
  render() {
    camera.fovYDeg = 40;
    camera.position[0] = Math.sin(time * 0.25) * 4.2;
    camera.position[1] = 2.2;
    camera.position[2] = Math.cos(time * 0.25) * 4.2;
    camera.lookAt(0, 0.8, 0);
    const parts = loader?.parts ?? [];
    renderer.beginShadowPass(lightMatrix, 'static');
    renderer.drawShadowCasters((sink) => {
      sink.mesh(plinth, IDENTITY);
      for (const part of parts) sink.mesh(part.mesh, IDENTITY);
    });
    renderer.endShadowPass();
    renderer.beginFrame([0.2, 0.22, 0.26]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(plinth, IDENTITY);
    // #region draw
    /* Each part with the images its material names: colour, the packed occlusion, roughness and
       metal map, normals and emission, each -1 where the file had none. */
    const textures = loader?.textures ?? null;
    const image = (index: number) => (index >= 0 ? (textures?.at(index) ?? null) : null);
    for (const part of parts) {
      renderer.setMaterial({
        albedo: image(part.albedo),
        orm: image(part.orm),
        normal: image(part.normal),
        emissive: image(part.emissive),
        roughnessScale: part.roughnessScale,
        metallicScale: part.metallicScale,
        occlusionStrength: part.occlusionStrength,
      });
      if (part.opacity >= 1) renderer.drawMesh(part.mesh, IDENTITY);
      else renderer.drawTranslucentMesh(part.mesh, IDENTITY, part.opacity);
    }
    renderer.setMaterial(null);
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

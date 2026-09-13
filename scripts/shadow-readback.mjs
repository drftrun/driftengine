/*
 * Read a directional shadow map back off a live renderer, on either backend, from any page.
 *
 *   node scripts/shadow-readback.mjs --url='http://localhost:5174/?day=7' \
 *     --renderer='window.renderer' --backend=webgpu --out=/tmp/map.bin
 *
 * **The instrument the parity ledger recommended three times, generalised out of the consumer it
 * was first written in.** A shadow map is the one thing a screenshot cannot show and the one thing
 * every "why is there a shadow there" question is actually about, and it is *camera independent* —
 * so two backends can be compared on a page whose camera is not reproducible, which a frame diff
 * cannot do.
 *
 * **Indexed by texture coordinate, never by memory order.** The two APIs disagree about which row
 * of a framebuffer a clip-space Y lands in, so a comparison of two readbacks laid out in memory
 * order compares a convention rather than a picture. Both maps here are re-rendered through a
 * fullscreen quad whose fragment at output row `r` samples `v = (r + 0.5) / size`, which is the
 * question the lit pass actually asks of the map.
 *
 * The renderer is reached by an expression the caller supplies, because every consuming
 * application publishes its own differently and none of that is this engine's business.
 */
import { writeFileSync } from 'node:fs';

import { launch, requireHardwareGpu } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const found = args.find((entry) => entry.startsWith(`--${name}=`));
  return found === undefined ? fallback : found.slice(name.length + 3);
};

const URL_ = flag('url', 'http://localhost:5174/');
const RENDERER_PATH = flag('renderer', 'window.renderer');
const BACKEND = flag('backend', 'webgpu');
const LAYER = flag('layer', 'static');
const OUT = flag('out', `/tmp/shadow-${BACKEND}.bin`);
const SETTLE = Number(flag('settle', 4000));

/** Depth into three bytes, so a 24-bit value survives an 8-bit colour target. */
const PACK = `
  float d = clamp(texture(uMap, vUv).r, 0.0, 1.0);
  float v = d * 16777215.0;
  float b0 = floor(v / 65536.0);
  float b1 = floor((v - b0 * 65536.0) / 256.0);
  float b2 = floor(v - b0 * 65536.0 - b1 * 256.0);
  fragColor = vec4(b0 / 255.0, b1 / 255.0, b2 / 255.0, 1.0);
`;

const READ_WEBGL2 = (layer) => `(() => {
  const r = RENDERER;
  const gl = r.gl;
  const map = ${JSON.stringify(layer)} === 'static' ? r.shadowMap : ${JSON.stringify(layer)} === 'dynamic' ? r.dynamicShadowMap : r.peeledShadowMap;
  if (!map) return { error: 'no shadow map on this renderer' };
  const size = map.size;

  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, \`#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}\`));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, \`#version 300 es
precision highp float;
uniform highp sampler2D uMap;
in vec2 vUv;
out vec4 fragColor;
void main() {${PACK}}\`));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));

  const color = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, color);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, size, size);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) return { error: 'framebuffer 0x' + status.toString(16) };

  const wasCulling = gl.isEnabled(gl.CULL_FACE);
  const wasBlending = gl.isEnabled(gl.BLEND);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.BLEND);
  gl.viewport(0, 0, size, size);
  gl.useProgram(program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, map.texture);
  gl.uniform1i(gl.getUniformLocation(program, 'uMap'), 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  const bytes = new Uint8Array(size * size * 4);
  gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, bytes);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteTexture(color);
  gl.deleteProgram(program);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.useProgram(null);
  if (wasCulling) gl.enable(gl.CULL_FACE);
  if (wasBlending) gl.enable(gl.BLEND);
  /* The renderer sets its own viewport at the head of every pass; this puts the default back
     for anything that reads it before then. */
  gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);

  const out = new Uint16Array(size * size);
  for (let i = 0; i < out.length; i++) {
    const d = (bytes[i * 4] * 65536 + bytes[i * 4 + 1] * 256 + bytes[i * 4 + 2]) / 16777215;
    out[i] = Math.round(d * 65535);
  }
  globalThis.__shadowDump = new Uint8Array(out.buffer);
  const error = gl.getError();
  return { size, bytes: globalThis.__shadowDump.length, glError: error === 0 ? null : error };
})()`;

const READ_WEBGPU = (layer) => `(async () => {
  const r = RENDERER;
  const device = r.surface.device;
  const texture = ${JSON.stringify(layer)} === 'static' ? r.shadowMap : ${JSON.stringify(layer)} === 'dynamic' ? r.dynamicMap : r.peelMap;
  if (!texture) return { error: 'no shadow map on this renderer' };
  const size = texture.width;

  const module = device.createShaderModule({ code: \`
@group(0) @binding(0) var srcTexture: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;

struct VOut { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex fn vs(@builtin(vertex_index) index: u32) -> VOut {
  var out: VOut;
  let p = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  out.position = vec4<f32>(p * 2.0 - vec2<f32>(1.0, 1.0), 0.0, 1.0);
  // Framebuffer row 0 is clip y = +1 here, and it has to mean v = 0 as it does on the other
  // backend, so the coordinate is flipped against the position rather than the position
  // being flipped against the screen.
  out.uv = vec2<f32>(p.x, 1.0 - p.y);
  return out;
}

@fragment fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let d = clamp(textureSampleLevel(srcTexture, srcSampler, uv, 0.0).r, 0.0, 1.0);
  let v = d * 16777215.0;
  let b0 = floor(v / 65536.0);
  let b1 = floor((v - b0 * 65536.0) / 256.0);
  let b2 = floor(v - b0 * 65536.0 - b1 * 256.0);
  return vec4<f32>(b0 / 255.0, b1 / 255.0, b2 / 255.0, 1.0);
}\` });

  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 2, texture: { sampleType: 'unfilterable-float' } },
      { binding: 1, visibility: 2, sampler: { type: 'non-filtering' } },
    ],
  });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
  });
  const group = device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: texture.createView() },
      { binding: 1, resource: device.createSampler({}) },
    ],
  });

  const target = device.createTexture({
    size: [size, size],
    format: 'rgba8unorm',
    usage: 0x10 | 0x1, // RENDER_ATTACHMENT | COPY_SRC
  });
  const staging = device.createBuffer({ size: size * size * 4, usage: 0x1 | 0x8 }); // MAP_READ | COPY_DST

  device.pushErrorScope('validation');
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.draw(3);
  pass.end();
  encoder.copyTextureToBuffer({ texture: target }, { buffer: staging, bytesPerRow: size * 4 }, [size, size]);
  device.queue.submit([encoder.finish()]);
  const validation = await device.popErrorScope();

  await staging.mapAsync(0x1); // MapMode.READ
  const bytes = new Uint8Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  target.destroy();

  const out = new Uint16Array(size * size);
  for (let i = 0; i < out.length; i++) {
    const d = (bytes[i * 4] * 65536 + bytes[i * 4 + 1] * 256 + bytes[i * 4 + 2]) / 16777215;
    out[i] = Math.round(d * 65535);
  }
  globalThis.__shadowDump = new Uint8Array(out.buffer);
  return { size, bytes: globalThis.__shadowDump.length, validation: validation === null ? null : validation.message };
})()`;

const CHUNK = 1 << 19;
const CHUNKER = `globalThis.__shadowChunk = (index) => {
  const data = globalThis.__shadowDump;
  const start = index * ${CHUNK};
  const end = Math.min(data.length, start + ${CHUNK});
  let text = '';
  for (let at = start; at < end; at += 8192) {
    text += String.fromCharCode.apply(null, data.subarray(at, Math.min(end, at + 8192)));
  }
  return btoa(text);
}`;

const browser = await launch();
const client = await connect(browser.port);
await requireHardwareGpu(client);
const address = new URL(URL_);
address.searchParams.set('backend', BACKEND);
const page = await client.page(address.href, 1280, 720);
/* Guarded, because the path walks objects that do not exist yet: a bare `a.b.c !== undefined`
   *throws* while `a` is undefined, and a throwing poll expression aborts the wait rather than
   returning false. */
await page.settled(
  `(() => { try { return ${RENDERER_PATH} !== undefined; } catch { return false; } })()`,
  { settleMs: SETTLE },
);
await page.frames(30);

const reported = await page.eval(`${RENDERER_PATH}.constructor.name`);
console.log(`renderer ${reported}`);
const read = (BACKEND === 'webgpu' ? READ_WEBGPU : READ_WEBGL2)(LAYER).replaceAll(
  'RENDERER',
  RENDERER_PATH,
);
const head = await page.eval(read);
if (head.error !== undefined && head.error !== null) throw new Error(`${BACKEND}: ${head.error}`);
await page.eval(CHUNKER);
const parts = [];
for (let index = 0; index * CHUNK < head.bytes; index++) {
  parts.push(Buffer.from(await page.eval(`globalThis.__shadowChunk(${index})`), 'base64'));
}
const bytes = Buffer.concat(parts);
if (bytes.length !== head.bytes) throw new Error(`${bytes.length} of ${head.bytes} bytes`);
writeFileSync(OUT, bytes);
console.log(`${BACKEND}: ${head.size}x${head.size}, wrote ${OUT}`);
for (const line of page.logs.filter((l) => /error|exception/i.test(l)).slice(0, 5)) {
  console.log(`  ! ${line.slice(0, 160)}`);
}
await page.close();
client.close();
await browser.close();

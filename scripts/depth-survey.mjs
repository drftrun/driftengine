/**
 * What depth precision this machine can actually offer, on both backends.
 *
 * **Written before the reversed-Z conversion rather than after it**, because one fact decides the
 * shape of that work and nothing in this repository knew it: whether WebGL2 here exposes
 * `EXT_clip_control`. WebGPU's clip space is already `[0, 1]`, so reversed-Z there is a projection
 * row, a compare direction and a clear value. **WebGL2's is `[-1, 1]`**, and without clip control
 * the flip can still be folded into the projection but the float exponent lands its precision in
 * the middle of the range instead of at the near plane, which is most of the point.
 *
 * It also reports the depth formats each backend will render to, since a reversed-Z buffer that is
 * not float buys far less than one that is.
 *
 *     (setsid npx vite demo/dev --port 5203 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 8
 *     node scripts/depth-survey.mjs --base=http://localhost:5203
 *
 * Not a `*.test.mjs`: it needs a dev server and a real GPU, the same reason `probe-check.mjs` is
 * run by hand.
 *
 * **It is a survey and asserts nothing, which is why it is not named `*-check.mjs`.** Every other
 * script under that name states a claim about this engine and exits non-zero when the claim fails.
 * This one states facts about the *machine* — what `EXT_clip_control` and `depth32float` this
 * adapter offers — and there is no engine behaviour to hold to account for them. Naming it a check
 * put a script that cannot fail inside this repository's own count of the guards that check every
 * row against a real GPU, which weakens the argument it was being counted toward.
 */
import { launch, requireHardwareGpu } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const found = args.find((entry) => entry.startsWith(`--${name}=`));
  return found === undefined ? fallback : found.slice(name.length + 3);
};
const BASE = flag('base', 'http://localhost:5203');

const browser = await launch();
const client = await connect(browser.port);
console.log(await requireHardwareGpu(client));
const page = await client.page(`${BASE}/backend-probe.html`, 640, 480);
await page.settled('true', { settleMs: 100 });

const report = await page.eval(`(async () => {
  const out = { webgl2: {}, webgpu: {} };

  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  if (gl === null) {
    out.webgl2.available = false;
  } else {
    const ext = gl.getSupportedExtensions() ?? [];
    out.webgl2.available = true;
    out.webgl2.clipControl = ext.includes('EXT_clip_control');
    out.webgl2.depthClamp = ext.includes('EXT_depth_clamp');
    out.webgl2.colorBufferFloat = ext.includes('EXT_color_buffer_float');
    /* DEPTH_COMPONENT32F is core in WebGL2 (ES 3.0), so this asks the driver rather than a list. */
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT32F, 16, 16);
    out.webgl2.depth32f = gl.getError() === gl.NO_ERROR;
    out.webgl2.renderer = gl.getParameter(
      gl.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER,
    );
  }

  if (navigator.gpu === undefined) {
    out.webgpu.available = false;
  } else {
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter === null) {
      out.webgpu.available = false;
    } else {
      const device = await adapter.requestDevice();
      out.webgpu.available = true;
      out.webgpu.features = [...adapter.features].filter((f) => f.includes('depth') || f.includes('float'));
      /* depth32float is a core WebGPU format; this proves the device will actually make one. */
      try {
        device.createTexture({
          size: [16, 16],
          format: 'depth32float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        out.webgpu.depth32float = true;
      } catch (e) {
        out.webgpu.depth32float = false;
        out.webgpu.depthError = String(e).slice(0, 120);
      }
      out.webgpu.adapter = adapter.info?.architecture ?? 'unknown';
    }
  }
  return JSON.stringify(out);
})()`);

const depth = JSON.parse(report);
console.log('\nWebGL2');
console.log(`  renderer          ${depth.webgl2.renderer ?? 'n/a'}`);
console.log(
  `  EXT_clip_control  ${depth.webgl2.clipControl}   <- decides whether reversed-Z is worth it here`,
);
console.log(`  DEPTH_COMPONENT32F ${depth.webgl2.depth32f}`);
console.log('\nWebGPU');
console.log(`  adapter           ${depth.webgpu.adapter ?? 'n/a'}`);
console.log(`  depth32float      ${depth.webgpu.depth32float}`);
console.log(
  `  depth features    ${(depth.webgpu.features ?? []).join(', ') || '(none beyond core)'}`,
);

await browser.close();

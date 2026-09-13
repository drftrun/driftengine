/**
 * Count what a frame moves, rather than how long it took.
 *
 *     npm run demo                                          # in one terminal
 *     node scripts/frame-audit.mjs                          # this repo's harness, phone viewport
 *     node scripts/frame-audit.mjs --scene=2 --desktop
 *     node scripts/frame-audit.mjs --url=https://example.com/your-game/
 *
 * **This exists because a clock cannot answer the question a tiler asks.** A desktop GPU has
 * hundreds of gigabytes a second of bandwidth and hides attachment traffic completely; a
 * tile-based mobile GPU has a tenth of it and is bound by nothing else. So a frame that measures
 * 2 ms here can be 60 ms on a phone, and no timing run on this machine will ever say why.
 *
 * What transfers is the *shape* of the frame — how many passes, which attachments are stored and
 * loaded, and how many bytes that is — and every one of those is identical on every device. This
 * reads them off the real WebGPU command stream by wrapping `beginRenderPass`, `createTexture`
 * and `submit` before the page's own scripts run, so nothing is inferred from the source.
 *
 * The figures that started the 1.1.0 work, taken this way on the consumer at a phone
 * viewport (824x1830, four samples): **388.7 MB of attachment traffic a frame across 20 passes**,
 * of which 161 MB went to textures created with `RENDER_ATTACHMENT` usage and no
 * `TEXTURE_BINDING` — bytes no shader on either backend is able to read.
 *
 * WebGPU only. On WebGL2 the same accounting would need the GL calls wrapped instead, and the
 * defect this was built to find has a different name there (`invalidateFramebuffer`).
 */
import { launch, rendererName } from '../packages/core/scripts/browser.mjs';
import { connect, sleep } from '../packages/core/scripts/cdp.mjs';

const FLAGS = [
  '--use-angle=vulkan',
  '--enable-features=Vulkan',
  /* Headless Chrome offers no WebGPU adapter without these, and reports the absence as an
     ordinary fallback to WebGL2 — so the audit would quietly measure the wrong backend. */
  '--enable-unsafe-webgpu',
  '--ignore-gpu-blocklist',
  '--use-webgpu-adapter=vulkan',
];

/**
 * Wrapped before any page script runs, because a scene builds its renderer during module
 * evaluation and a hook installed afterwards would miss every resource it made.
 */
const PROBE = `
(() => {
  const bytesFor = { rgba8unorm: 4, bgra8unorm: 4, rgba16float: 8, r16float: 2, rg16float: 4,
    r8unorm: 1, rgba32float: 16, depth32float: 4, depth24plus: 4, 'depth24plus-stencil8': 4,
    depth16unorm: 2, r32float: 4, rg11b10ufloat: 4 };
  const stats = { frames: 0, passes: 0, submits: 0, storeMB: 0, loadMB: 0, unreadMB: 0,
    msaaStored: 0, msaaDiscarded: 0, depthStored: 0, depthDiscarded: 0,
    labels: Object.create(null), attachments: Object.create(null) };
  const sizeOf = new WeakMap();
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };

  if ('GPUDevice' in window) {
    const make = GPUDevice.prototype.createTexture;
    GPUDevice.prototype.createTexture = function (d) {
      const t = make.call(this, d);
      const s = d.size ?? {};
      const w = s.width ?? s[0] ?? 1, h = s.height ?? s[1] ?? 1;
      const samples = d.sampleCount ?? 1;
      const bytes = w * h * (bytesFor[d.format] ?? 4) * samples;
      /* A texture with no TEXTURE_BINDING can never be sampled, so anything written to it and
         not resolved is bandwidth spent on bytes nothing is able to read. 0x4 is the flag. */
      const readable = ((d.usage ?? 0) & 0x4) !== 0;
      const view = t.createView.bind(t);
      t.createView = (o) => {
        const v = view(o);
        sizeOf.set(v, { bytes, label: d.label ?? '?', readable });
        return v;
      };
      return t;
    };
  }

  const account = (view, op) => {
    const info = sizeOf.get(view);
    if (info === undefined) return;
    const mb = info.bytes / 1048576;
    if (op === 'store') {
      stats.storeMB += mb;
      if (!info.readable) stats.unreadMB += mb;
      bump(stats.attachments, 'store:' + info.label);
    } else if (op === 'load') {
      stats.loadMB += mb;
      bump(stats.attachments, 'load:' + info.label);
    }
  };

  if ('GPUCommandEncoder' in window) {
    const begin = GPUCommandEncoder.prototype.beginRenderPass;
    GPUCommandEncoder.prototype.beginRenderPass = function (d) {
      stats.passes++;
      bump(stats.labels, d?.label ?? '(unlabelled)');
      for (const a of d?.colorAttachments ?? []) {
        if (!a) continue;
        account(a.view, a.storeOp);
        if (a.loadOp === 'load') account(a.view, 'load');
        if (a.resolveTarget) a.storeOp === 'store' ? stats.msaaStored++ : stats.msaaDiscarded++;
      }
      const z = d?.depthStencilAttachment;
      if (z) {
        account(z.view, z.depthStoreOp);
        if (z.depthLoadOp === 'load') account(z.view, 'load');
        z.depthStoreOp === 'store' ? stats.depthStored++ : stats.depthDiscarded++;
      }
      return begin.call(this, d);
    };
  }
  if ('GPUQueue' in window) {
    const submit = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function (b) { stats.submits++; return submit.call(this, b); };
  }

  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => { stats.frames++; return cb(t); });

  window.__frameAudit = stats;
  window.__frameAuditReset = () => {
    for (const k of Object.keys(stats)) {
      if (typeof stats[k] === 'number') stats[k] = 0; else stats[k] = Object.create(null);
    }
  };
})();
`;

function flag(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

async function main() {
  const desktop = process.argv.includes('--desktop');
  const url = flag(
    'url',
    `http://localhost:${flag('port', '5173')}/?scene=${flag('scene', '0')}&backend=webgpu`,
  );
  const seconds = Number(flag('seconds', '5'));

  const browser = await launch({ flags: FLAGS });
  try {
    const client = await connect(browser.port);
    const page = await client.page();
    await page.call('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
    /*
     * A phone by default, because that is the frame worth auditing: `--desktop` is the control.
     * Touch emulation as well as the metrics, since `(pointer: coarse)` is what a consumer reads
     * to decide it is on a handheld, and metrics alone do not set it.
     */
    if (!desktop) {
      await page.call('Emulation.setDeviceMetricsOverride', {
        width: 412,
        height: 915,
        deviceScaleFactor: 3.5,
        mobile: true,
      });
      await page.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }
    await page.call('Page.navigate', { url });
    await page.settled('document.querySelector("canvas") !== null', { settleMs: 8000 });

    console.log(`renderer: ${await rendererName(client)}`);
    await page.eval('window.__frameAuditReset()');
    await sleep(seconds * 1000);
    const s = await page.eval('JSON.parse(JSON.stringify(window.__frameAudit))');
    const canvas = await page.eval(
      'JSON.stringify({ w: document.querySelector("canvas").width, h: document.querySelector("canvas").height })',
    );
    const { w, h } = JSON.parse(canvas);

    if (s.frames === 0) throw new Error('no frames were drawn; is the scene running?');
    const per = (n) => n / s.frames;
    const traffic = per(s.storeMB) + per(s.loadMB);

    console.log(`${url}`);
    console.log(`  drawing buffer   ${w}x${h}  (${((w * h) / 1e6).toFixed(2)} MP)`);
    console.log(
      `  passes / frame   ${per(s.passes).toFixed(2)}   submits ${per(s.submits).toFixed(2)}`,
    );
    console.log(`  stored / frame   ${per(s.storeMB).toFixed(1)} MB`);
    console.log(`  loaded / frame   ${per(s.loadMB).toFixed(1)} MB`);
    console.log(
      `  TOTAL  / frame   ${traffic.toFixed(1)} MB   (${((traffic * 60) / 1024).toFixed(2)} GB/s at 60 fps)`,
    );
    console.log(
      `  of which unreadable ${per(s.unreadMB).toFixed(1)} MB — written to textures no shader can sample`,
    );
    console.log(
      `  multisample      ${per(s.msaaStored).toFixed(2)} stored / ${per(s.msaaDiscarded).toFixed(2)} discarded`,
    );
    console.log(
      `  depth            ${per(s.depthStored).toFixed(2)} stored / ${per(s.depthDiscarded).toFixed(2)} discarded`,
    );
    console.log('  passes:');
    for (const [label, n] of Object.entries(s.labels).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${label} x${per(n).toFixed(2)}`);
    }
    console.log('  busiest attachments:');
    for (const [what, n] of Object.entries(s.attachments)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)) {
      console.log(`    ${what} x${per(n).toFixed(2)}`);
    }
    /*
     * Named rather than left for a reader to spot. Both are invisible on this machine by
     * construction — see `docs/RENDERING.md` — so a number is the only way they surface here.
     */
    if (s.msaaStored > 0)
      console.log('\n  ! a resolved multisample attachment is being stored; see RENDERING.md');
    if (per(s.unreadMB) > 1)
      console.log('  ! bytes are going to textures nothing can read; see RENDERING.md');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(String(error?.message ?? error));
  process.exit(1);
});

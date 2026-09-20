/**
 * Does every hand-written WGSL module compile, without a device?
 *
 * **The generated shaders have a gate and the hand-written ones had none.** `wgsl.test.mjs` runs
 * the GLSL-to-WGSL pipeline and `naga` validates what it produces; the GPU-driven pipeline, the
 * global illumination field and the network evaluator are written in WGSL directly — WebGL2 has no
 * compute stage to generate them from — and until this file the only thing that compiled them was a
 * device. Wiring the second pipeline found two reserved keywords in shaders committed and never
 * compiled, which is the defect this exists to catch before anybody opens a browser.
 *
 * **Every exported string with an entry point is validated as a whole module**, found by scanning
 * the directories rather than listed, so a new pass is covered the day it is exported. Fragments
 * meant to be included into something else carry no entry point and are covered by the modules
 * that include them. The network evaluator is a function of its precision, so both instantiations
 * are named here; the inference kernels are functions of their shapes, so each operator is named at
 * one request reaching its branches, and the test refuses an operator no request names.
 *
 * `naga` is the validator `wgsl.test.mjs` already requires (`cargo install naga-cli --locked`); a
 * machine without it skips, as that suite does. It is not the browser's compiler, so a module it
 * accepts can still be refused by a device — `gpu-parity.mjs`, `gi-parity.mjs` and
 * `inference-parity.mjs` are the checks that compile on one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { hasNaga } from './wgsl/compile.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SKIP = hasNaga() ? false : 'naga is not installed (cargo install naga-cli --locked)';
const DIRECTORIES = [
  'packages/core/src/render/shaders/gpudriven',
  'packages/core/src/render/shaders/gi',
  'packages/core/src/render/shaders/recon',
];

/** Every whole module the directories export, as `[label, source]`. */
async function modules() {
  const found = [];
  for (const directory of DIRECTORIES) {
    const files = readdirSync(path.join(ROOT, directory)).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
    );
    for (const file of files) {
      const exported = await import(path.join(ROOT, directory, file));
      for (const [name, value] of Object.entries(exported)) {
        if (typeof value === 'string' && /@(compute|vertex|fragment)\b/.test(value)) {
          found.push([`${file} ${name}`, value]);
        }
      }
    }
  }
  const { networkParityWgsl } = await import(
    path.join(ROOT, 'packages/core/src/render/shaders/network.wgsl.ts')
  );
  found.push(['network.wgsl.ts f32', networkParityWgsl('f32')]);
  found.push(['network.wgsl.ts f16', networkParityWgsl('f16')]);
  /* The fixed form is a function of the shape too: a deep one, and one with no hidden layer. */
  const { networkFixedParityWgsl } = await import(
    path.join(ROOT, 'packages/core/src/render/shaders/network.wgsl.ts')
  );
  for (const scalar of ['f32', 'f16']) {
    found.push([
      `network.wgsl.ts fixed 11-8-8-3 ${scalar}`,
      networkFixedParityWgsl(scalar, { inputs: 11, hidden: [8, 8], outputs: 3 }),
    ]);
    found.push([
      `network.wgsl.ts fixed 2-2 ${scalar}`,
      networkFixedParityWgsl(scalar, { inputs: 2, hidden: [], outputs: 2 }),
    ]);
  }
  /* The resolve is a function of which accessors surround one core, so both modules are named. */
  const { reconResolveParityWgsl, reconResolveWgsl } = await import(
    path.join(ROOT, 'packages/core/src/render/shaders/recon/resolve.wgsl.ts')
  );
  found.push(['recon/resolve.wgsl.ts parity', reconResolveParityWgsl()]);
  found.push(['recon/resolve.wgsl.ts production', reconResolveWgsl()]);
  /* The probe trace is a function of which accessors surround one core, as the resolve is. */
  const { probeTraceParityWgsl } = await import(
    path.join(ROOT, 'packages/core/src/render/shaders/gi/probeTrace.wgsl.ts')
  );
  found.push(['gi/probeTrace.wgsl.ts parity', probeTraceParityWgsl()]);
  /* And the bake, for the same reason: four entry points over bindings a module supplies. */
  const { probeBakeParityWgsl } = await import(
    path.join(ROOT, 'packages/core/src/render/shaders/gi/probeBake.wgsl.ts')
  );
  found.push(['gi/probeBake.wgsl.ts parity', probeBakeParityWgsl()]);
  /* The inference kernels are a function of their shapes, so each operator is named at one. */
  const { DEVICE_KERNELS } = await import(
    path.join(ROOT, 'packages/core/src/render/inference/kernels.ts')
  );
  for (const [op, request] of KERNEL_REQUESTS) {
    const generate = DEVICE_KERNELS.get(op);
    assert.ok(generate, `no kernel for ${op}`);
    found.push([`inference ${op} ${request.inputTypes.join('-')}`, generate(request).code]);
  }
  return found;
}

const f32 = (count) => Array.from({ length: count }, () => 'f32');
/** One request per operator at shapes that reach its branches, and the half-precision reads. */
const KERNEL_REQUESTS = [
  [
    'linear',
    {
      inputShapes: [[5, 20], [7, 20], [7]],
      outputShape: [5, 7],
      attributes: {},
      inputTypes: f32(3),
    },
  ],
  [
    'linear',
    {
      inputShapes: [[5, 20], [7, 20], [7]],
      outputShape: [5, 7],
      attributes: {},
      inputTypes: ['f32', 'f16', 'f16'],
    },
  ],
  [
    'linear',
    {
      inputShapes: [
        [5, 20],
        [7, 20],
      ],
      outputShape: [5, 7],
      attributes: {},
      inputTypes: f32(2),
    },
  ],
  ['relu', { inputShapes: [[9]], outputShape: [9], attributes: {}, inputTypes: f32(1) }],
  ['gelu', { inputShapes: [[9]], outputShape: [9], attributes: {}, inputTypes: f32(1) }],
  [
    'add',
    { inputShapes: [[4, 3], [3]], outputShape: [4, 3], attributes: {}, inputTypes: ['f32', 'f16'] },
  ],
  [
    'mul',
    {
      inputShapes: [
        [4, 3],
        [4, 3],
      ],
      outputShape: [4, 3],
      attributes: {},
      inputTypes: f32(2),
    },
  ],
  [
    'layerNorm',
    {
      inputShapes: [[3, 70], [70], [70]],
      outputShape: [3, 70],
      attributes: { epsilon: 1e-5 },
      inputTypes: ['f32', 'f16', 'f16'],
    },
  ],
  [
    'softmax',
    { inputShapes: [[2, 3, 70]], outputShape: [2, 3, 70], attributes: {}, inputTypes: f32(1) },
  ],
  [
    'attention',
    {
      inputShapes: [
        [6, 8],
        [6, 8],
        [6, 8],
      ],
      outputShape: [6, 8],
      attributes: { heads: 2 },
      inputTypes: f32(3),
    },
  ],
  [
    'attention',
    {
      inputShapes: [
        [4, 7, 8],
        [4, 9, 8],
        [4, 9, 8],
        [2, 7, 9],
      ],
      outputShape: [4, 7, 8],
      attributes: { heads: 2 },
      inputTypes: ['f32', 'f32', 'f32', 'f16'],
    },
  ],
  [
    'attention',
    {
      inputShapes: [
        [2, 3, 128],
        [2, 1030, 128],
        [2, 1030, 128],
        [2, 3, 1030],
      ],
      outputShape: [2, 3, 128],
      attributes: { heads: 2 },
      inputTypes: ['f32', 'f32', 'f32', 'f16'],
    },
  ],
  [
    'conv2d',
    {
      inputShapes: [[3, 9, 9], [4, 3, 3, 3], [4]],
      outputShape: [4, 5, 5],
      attributes: { stride: 2, padding: 1 },
      inputTypes: ['f32', 'f16', 'f16'],
    },
  ],
  [
    'conv2d',
    {
      inputShapes: [[6, 9, 9], [6, 1, 3, 3], [6]],
      outputShape: [6, 5, 5],
      attributes: { stride: 2, padding: 1, groups: 6 },
      inputTypes: ['f32', 'f16', 'f16'],
    },
  ],
  [
    'convTranspose2d',
    {
      inputShapes: [[3, 4, 4], [3, 2, 4, 4], [2]],
      outputShape: [2, 8, 8],
      attributes: { stride: 2, padding: 1 },
      inputTypes: f32(3),
    },
  ],
  [
    'patchEmbed',
    {
      inputShapes: [[3, 8, 8], [5, 3, 4, 4], [5]],
      outputShape: [4, 5],
      attributes: { patch: 4 },
      inputTypes: f32(3),
    },
  ],
  [
    'resize',
    {
      inputShapes: [[2, 4, 5]],
      outputShape: [2, 7, 3],
      attributes: { mode: 'bilinear', alignCorners: false },
      inputTypes: f32(1),
    },
  ],
  [
    'resize',
    {
      inputShapes: [[2, 4, 5]],
      outputShape: [2, 7, 3],
      attributes: { mode: 'bicubic', alignCorners: true },
      inputTypes: f32(1),
    },
  ],
  [
    'resize',
    {
      inputShapes: [[2, 5, 5]],
      outputShape: [2, 5, 3],
      attributes: { mode: 'bicubic', alignCorners: false, stepHeight: 0.98, stepWidth: 1.6 },
      inputTypes: f32(1),
    },
  ],
  [
    'permute',
    {
      inputShapes: [[2, 3, 4]],
      outputShape: [4, 2, 3],
      attributes: { order: [2, 0, 1] },
      inputTypes: f32(1),
    },
  ],
  [
    'reshape',
    {
      inputShapes: [[2, 6]],
      outputShape: [3, 4],
      attributes: { shape: [3, 4] },
      inputTypes: f32(1),
    },
  ],
  [
    'concat',
    {
      inputShapes: [
        [2, 1, 3],
        [2, 2, 3],
        [2, 1, 3],
      ],
      outputShape: [2, 4, 3],
      attributes: { axis: 1 },
      inputTypes: f32(3),
    },
  ],
  [
    'slice',
    {
      inputShapes: [[2, 5, 3]],
      outputShape: [2, 2, 3],
      attributes: { axis: 1, start: 2, end: 4 },
      inputTypes: f32(1),
    },
  ],
  [
    'resize',
    {
      inputShapes: [[3, 5, 7]],
      outputShape: [3, 10, 14],
      attributes: { height: 10, width: 14, mode: 'nearest' },
      inputTypes: ['f16'],
    },
  ],
  [
    'maxPool2d',
    {
      inputShapes: [[3, 9, 10]],
      outputShape: [3, 4, 5],
      attributes: { kernel: 2 },
      inputTypes: f32(1),
    },
  ],
  ['sigmoid', { inputShapes: [[4, 9]], outputShape: [4, 9], attributes: {}, inputTypes: f32(1) }],
  [
    'attention',
    {
      inputShapes: [
        [3, 80, 192],
        [3, 130, 192],
        [3, 130, 192],
        [2, 80, 130],
      ],
      outputShape: [3, 80, 192],
      attributes: { heads: 2 },
      inputTypes: ['f32', 'f32', 'f32', 'f16'],
    },
  ],
  [
    'pad',
    {
      inputShapes: [[5, 3, 4]],
      outputShape: [7, 7, 4],
      attributes: { after: [2, 4, 0] },
      inputTypes: ['f16'],
    },
  ],
  [
    'gather',
    {
      inputShapes: [[300, 40], [12]],
      outputShape: [12, 40],
      attributes: {},
      inputTypes: ['f16', 'f32'],
    },
  ],
];

/** `naga`'s verdict on one module: null when it validates, its complaint when it does not. */
function validate(label, source, directory) {
  const file = path.join(directory, `${label.replace(/[^A-Za-z0-9]+/g, '-')}.wgsl`);
  writeFileSync(file, source);
  try {
    execFileSync('naga', [file], { stdio: 'pipe' });
    return null;
  } catch (error) {
    return String(error.stderr ?? error.message);
  }
}

test('every hand-written WGSL module validates', { skip: SKIP }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wgsl-hand-'));
  try {
    const found = await modules();
    /* The scan found the modules it is about: twenty-three entry points and the two networks. */
    assert.ok(found.length >= 25, `only ${found.length} modules were found`);
    /* And every inference kernel is named at least once, so a new operator is covered the day it lands. */
    const { DEVICE_KERNELS } = await import(
      path.join(ROOT, 'packages/core/src/render/inference/kernels.ts')
    );
    const named = new Set(KERNEL_REQUESTS.map(([op]) => op));
    assert.deepEqual(
      [...DEVICE_KERNELS.keys()].filter((op) => !named.has(op)),
      [],
    );
    const refused = [];
    for (const [label, source] of found) {
      const complaint = validate(label, source, directory);
      if (complaint !== null)
        refused.push(`${label}: ${complaint.split('\n').slice(0, 6).join(' ')}`);
    }
    assert.deepEqual(refused, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('and the validator refuses a module that would not compile', { skip: SKIP }, () => {
  /*
   * **The check has to be shown to be able to fail.** A validator that was never run, or a path
   * that pointed at nothing, answers every module with silence — and silence is what "validates"
   * looks like here. `target` is one of the reserved words the second pipeline once shipped.
   */
  const directory = mkdtempSync(path.join(tmpdir(), 'wgsl-hand-'));
  try {
    const complaint = validate(
      'reserved',
      '@compute @workgroup_size(1) fn main() { let target = 1u; _ = target; }',
      directory,
    );
    assert.notEqual(complaint, null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

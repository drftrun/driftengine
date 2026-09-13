/**
 * Does the acceptance probe accept this machine, and what does it cost to ask?
 *
 * **This page exists because a refusal has no picture.** Every published scene runs on a device
 * that works, so a probe that never refuses anything is green everywhere and proves nothing —
 * `AGENTS.md`: *"An effect no scene turns on is not ported. It is written, and that is a different
 * word."* So the probe is driven deliberately here, twice: once with nothing to compile, and once
 * with every generated WGSL module the engine ships.
 *
 * The two timings are the measurement that decides whether compiling the real shader set should be
 * the default for `createRenderer`, and `scripts/probe-check.mjs` reads them off the globals below.
 *
 *     /backend-probe.html    on a WebGPU browser, reports two timings and two verdicts
 *
 * A machine with no `navigator.gpu` is not a failure of this page. It publishes a refusal with a
 * reason, which is the same shape a refused device produces, and the check script reports it as a
 * skip rather than as a pass.
 */
import {
  createRenderer,
  describeGpu,
  isWeakGpuFamily,
  probeDevice,
} from '../../packages/core/src/index';

/*
 * `import.meta.glob` is Vite's, and typing it would mean pulling `vite/client` into a repository
 * with no bundler dependency — so the one overload used here is declared, minimally, the way
 * `packages/core/src/build/shaderComments.test.ts` declares the raw one. It also has to be
 * *called* as `import.meta.glob(...)` spelled out, because Vite replaces the call by matching it
 * in the syntax tree.
 */
declare global {
  interface ImportMeta {
    glob(pattern: string, options: { eager: true }): Record<string, Record<string, unknown>>;
  }
}

/**
 * Every generated WGSL module the engine ships, as source.
 *
 * Globbed rather than listed so a shader added later is compiled here without anybody
 * remembering to add it — and the count is *printed*, because a glob that reaches nothing is a
 * page that measures nothing and passes.
 */
const shaders: string[] = Object.values(
  import.meta.glob('../../packages/core/src/render/shaders/generated/*.wgsl.ts', { eager: true }),
).flatMap((module) =>
  Object.values(module).filter((value): value is string => typeof value === 'string'),
);

interface ProbeCost {
  readonly count: number;
  readonly drawMs: number;
  readonly allMs: number;
}

declare global {
  /* eslint-disable no-var */
  var __probeCost: ProbeCost | undefined;
  var __probeVerdict: { ok: boolean; reason: string; backend: string } | undefined;
  /**
   * What this machine says it is, asked twice: once before a renderer and once from one.
   *
   * **They are allowed to differ, and the early one is the better answer when they do.**
   * `describeGpu` reads the unmasked WebGL2 string, which carries a model number;
   * `CreatedRenderer.rendererName` is whatever the backend that actually built calls the part, and
   * on WebGPU that is an architecture bucket by specification. Measured here: the early answer is
   * `ANGLE (AMD, Vulkan ... RX 9070 XT ...)` and a WebGPU renderer says `amd rdna-4`. The pair is
   * published rather than compared for equality because equality is the wrong assertion — on an
   * Adreno 710 the early string clamps and the late one cannot, which is the feature.
   *
   * What is worth watching is `verdictAgrees`: the two disagreeing about *weak* means a consumer
   * choosing from `describeGpu` and a renderer clamping itself would make opposite decisions on
   * the same machine, and that is a thing to know about rather than to discover in a report.
   */
  var __gpuIdentity:
    | {
        early: string;
        earlyWeak: boolean;
        source: string;
        late: string;
        lateWeak: boolean;
        backend: string;
        sameString: boolean;
        verdictAgrees: boolean;
      }
    | undefined;
  /* eslint-enable no-var */
}

/**
 * Ask both ways, on a canvas of this page's own.
 *
 * Detached deliberately: a real renderer takes the canvas it is given, and this page has a report
 * to draw on the one the document owns.
 */
async function identify(): Promise<void> {
  const early = await describeGpu();
  const created = await createRenderer(document.createElement('canvas'), {}, { splash: false });
  const late = created.rendererName;
  globalThis.__gpuIdentity = {
    early: early.rendererName,
    earlyWeak: early.weak,
    source: early.source,
    late,
    lateWeak: isWeakGpuFamily(late),
    backend: created.backend,
    sameString: early.rendererName === late,
    verdictAgrees: early.weak === isWeakGpuFamily(late),
  };
}

await identify();

const out = document.getElementById('out');
function report(lines: readonly string[]): void {
  if (out !== null) out.textContent = lines.join('\n');
}

/** The identity, in one line, because a bug report is what this string is for. */
function gpuLine(): string {
  const id = globalThis.__gpuIdentity;
  if (id === undefined) return 'gpu: not asked';
  const verdict = id.earlyWeak ? 'weak family' : 'not a known-weak family';
  return (
    `gpu: "${id.early}" (${id.source}, ${verdict})` +
    (id.sameString
      ? ` — the ${id.backend} renderer says the same`
      : ` — the ${id.backend} renderer says "${id.late}"` +
        (id.verdictAgrees ? ', same verdict' : ', DIFFERENT verdict'))
  );
}

const gpu = navigator.gpu as GPU | undefined;
if (gpu === undefined) {
  globalThis.__probeVerdict = { ok: false, reason: 'no navigator.gpu here', backend: 'webgl2' };
  report([
    `shaders found: ${shaders.length}`,
    gpuLine(),
    'no navigator.gpu here — this page needs a WebGPU browser',
  ]);
} else {
  const adapter = await gpu.requestAdapter();
  const device = adapter === null ? null : await adapter.requestDevice();
  if (device === null || device === undefined) {
    globalThis.__probeVerdict = {
      ok: false,
      reason: 'no adapter or device offered',
      backend: 'webgl2',
    };
    report([`shaders found: ${shaders.length}`, 'no adapter or device offered']);
  } else {
    /*
     * Read from the clock rather than a frame counter: nothing here draws to the screen, and the
     * question is wall-clock cost at boot. This page is not the engine and holds no loop, so the
     * `Date.now()` rule that governs `src/` does not reach it.
     */
    const t0 = performance.now();
    const drawOnly = await probeDevice(device, []);
    const t1 = performance.now();
    const withAll = await probeDevice(device, shaders);
    const t2 = performance.now();

    globalThis.__probeCost = { count: shaders.length, drawMs: t1 - t0, allMs: t2 - t1 };
    globalThis.__probeVerdict = { ok: withAll.ok, reason: withAll.reason, backend: 'webgpu' };
    report([
      `shaders found: ${shaders.length}`,
      gpuLine(),
      `draw-and-read only:  ${(t1 - t0).toFixed(1)} ms — ${drawOnly.ok ? 'accepted' : drawOnly.reason}`,
      `with every shader:   ${(t2 - t1).toFixed(1)} ms — ${withAll.ok ? 'accepted' : withAll.reason}`,
    ]);
  }
}

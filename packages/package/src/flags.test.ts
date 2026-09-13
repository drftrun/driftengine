import { describe, expect, it } from 'vitest';

import { WEBGPU_INTEROP_ELECTRON, planFlags } from './flags.ts';
import type { PackageManifest } from './manifest.ts';

const base: PackageManifest = {
  id: 'dev.example.title',
  name: 'Title',
  entry: 'dist/index.html',
  window: { width: 1280, height: 720, mode: 'windowed', resizable: true },
  backend: { webgpu: 'prefer', allowSoftwareRenderer: false },
  features: { clipExport: false, gamepad: true },
  targets: ['linux-x64'],
  steam: { appId: null },
  splash: { show: true, minMs: 1400 },
  publisher: 'example',
  icon: null,
};

const names = (plan: { switches: readonly (readonly [string, string])[] }): string[] =>
  plan.switches.map(([name]) => name);

describe('planFlags', () => {
  /*
   * Electron does not enable WebGPU on Linux although Chrome does, so a build that says nothing
   * gets no WebGPU there at all. The switch is the *interop* feature and not the Vulkan one —
   * see the comment on the refusal below, which used to be here.
   */
  it('turns WebGPU on for Linux through the interop feature', () => {
    const plan = planFlags(base, 'linux-x64');
    expect(plan.switches.find(([name]) => name === 'enable-features')?.[1]).toBe(
      'ForceEnableWebGpuInterop',
    );
    expect(plan.refusal).toBeNull();
  });

  /*
   * **The flag that is deliberately absent.** `--use-angle=vulkan --enable-features=Vulkan` also
   * yields WebGPU and is what this used to pass. Measured on an RX 9070 XT under Wayland, that
   * pair encodes canvas frames as all-zero YUV — a green clip — with nothing reporting it:
   * `VideoEncoder.error` never fires and the muxer finalises normally. The interop feature gives
   * WebGPU without touching ANGLE's backend, and the encode survives.
   */
  it('never forces ANGLE onto Vulkan, which is what encodes green', () => {
    const plan = planFlags(base, 'linux-x64');
    expect(names(plan)).not.toContain('use-angle');
    expect(plan.switches.some(([, value]) => /\bVulkan\b/.test(value))).toBe(false);
  });

  it('adds no WebGPU switches on Windows, where it is already on', () => {
    expect(names(planFlags(base, 'win-x64'))).not.toContain('enable-features');
  });

  /*
   * **A build may ask for both, and this is what changed.** The two used to be refused together on
   * Linux because the only WebGPU switch known to work was the one that broke encoding. There is a
   * configuration where both hold, so refusing would now be refusing a build that works.
   */
  it('allows WebGPU and clip export together on Linux', () => {
    const plan = planFlags({ ...base, features: { clipExport: true, gamepad: true } }, 'linux-x64');
    expect(plan.refusal).toBeNull();
    expect(plan.switches.find(([name]) => name === 'enable-features')?.[1]).toBe(
      'ForceEnableWebGpuInterop',
    );
  });

  it('adds no WebGPU switch on Linux once WebGPU is declined', () => {
    const plan = planFlags(
      {
        ...base,
        backend: { webgpu: 'off', allowSoftwareRenderer: false },
        features: { clipExport: true, gamepad: true },
      },
      'linux-x64',
    );
    expect(plan.refusal).toBeNull();
    expect(names(plan)).not.toContain('enable-features');
  });

  /*
   * The SwiftShader trap, from the engine's own harness: plain headless Chromium selects a
   * software rasteriser and says nothing about it. A shipped game must never do that silently.
   */
  it('never allows a software renderer unless the manifest asked for one', () => {
    expect(names(planFlags(base, 'win-x64'))).toContain('disable-software-rasterizer');
  });
});

/**
 * **A switch is only asked for on a runtime it has been seen to work on.**
 *
 * Chromium ignores an unknown name in `--enable-features` without a word, so a switch written for
 * one Chromium and applied to another is inert and silent — and a build that therefore ships WebGL2
 * is indistinguishable, from inside the product, from a machine whose driver had no adapter to
 * offer. Reported from outside exactly that way, from a build whose install had resolved Electron
 * 33: `strings` finds no `ForceEnableWebGpuInterop` in that binary at all.
 *
 * Measured here on the version this package declares: Electron 43.4.1, Chromium 150.0.7871.224, an
 * RX 9070 XT. `requestAdapter` answers null with no switches and hands back an `amd`/`rdna-4`
 * adapter with the interop feature, so the switch is doing the work rather than riding along.
 */
describe('planFlags against the runtime it will be applied to', () => {
  const OLD = WEBGPU_INTEROP_ELECTRON - 1;
  const clipExporting = { ...base, features: { clipExport: true, gamepad: true } };
  const feature = (plan: {
    switches: readonly (readonly [string, string])[];
  }): string | undefined => plan.switches.find(([name]) => name === 'enable-features')?.[1];

  it('asks for the interop feature on the version it was verified against', () => {
    expect(feature(planFlags(base, 'linux-x64', WEBGPU_INTEROP_ELECTRON))).toBe(
      'ForceEnableWebGpuInterop',
    );
    expect(feature(planFlags(base, 'linux-x64', WEBGPU_INTEROP_ELECTRON + 4))).toBe(
      'ForceEnableWebGpuInterop',
    );
  });

  it('never asks an older runtime for a feature that runtime may not have', () => {
    for (const manifest of [base, clipExporting]) {
      const plan = planFlags(manifest, 'linux-x64', OLD);
      expect(feature(plan) ?? '').not.toBe('ForceEnableWebGpuInterop');
    }
  });

  /*
   * Vulkan exists in every Chromium this could run against and also yields WebGPU. What it costs is
   * video encoding under Wayland — measured as all-zero YUV, a green clip, with nothing reporting
   * it — which a build that exports clips cannot pay and a build that does not export them is not
   * paying at all.
   */
  /*
   * **Both switches, because neither works alone.** Measured on Electron 33.4.11: `Vulkan` on its
   * own answers a null adapter, `enable-unsafe-webgpu` on its own answers a null adapter, and the
   * pair produces an adapter, a device and a pixel read back. A first version of this asked for
   * `Vulkan` alone and would have shipped a switch that does nothing.
   */
  /*
   * **And no second-best route, which is a decision rather than an omission.** There is one that
   * works: measured on Electron 33.4.11 on this machine, `--enable-unsafe-webgpu` and
   * `--enable-features=Vulkan` together produce an adapter, a device and a pixel read back, where
   * neither alone produces anything. It is not offered, because this package declares the Electron
   * it is written against — so an older one is an install to fix — and because that route encodes
   * canvas frames as all-zero YUV under Wayland, a green clip that nothing reports.
   */
  it('never asks for the Vulkan route, on any runtime or manifest', () => {
    for (const manifest of [base, clipExporting]) {
      for (const major of [OLD, WEBGPU_INTEROP_ELECTRON, null]) {
        const plan = planFlags(manifest, 'linux-x64', major);
        expect(names(plan)).not.toContain('enable-unsafe-webgpu');
        expect(plan.switches.some(([, value]) => /\bVulkan\b/.test(value))).toBe(false);
      }
    }
  });

  /** Silence is the failure being fixed, so a declined switch is stated rather than merely absent. */
  it('says so when it declines to ask for WebGPU at all', () => {
    for (const manifest of [base, clipExporting]) {
      const plan = planFlags(manifest, 'linux-x64', OLD);
      expect(plan.refusal).toBeNull();
      expect(plan.switches.some(([name]) => name === 'enable-features')).toBe(false);
      expect(plan.notes).toHaveLength(1);
      expect(plan.notes[0]).toMatch(/no WebGPU on Linux/);
      expect(plan.notes[0]).toMatch(new RegExp(String(OLD)));
    }
  });

  /** And a manifest that said WebGPU was not optional is refused rather than quietly downgraded. */
  it('refuses a build that requires WebGPU on a runtime that cannot deliver it', () => {
    const plan = planFlags(
      { ...clipExporting, backend: { webgpu: 'require', allowSoftwareRenderer: false } },
      'linux-x64',
      OLD,
    );
    expect(plan.refusal).not.toBeNull();
    expect(plan.refusal).toMatch(new RegExp(`Electron ${OLD}`));
    expect(plan.refusal).toMatch(new RegExp(String(WEBGPU_INTEROP_ELECTRON)));
    /* The remedy named is the install, not a workaround this package declines to ship. */
    expect(plan.refusal).toMatch(/declares Electron/);
  });

  it('says nothing at all about a runtime when WebGPU was declined by the manifest', () => {
    const plan = planFlags(
      { ...base, backend: { webgpu: 'off', allowSoftwareRenderer: false } },
      'linux-x64',
      OLD,
    );
    expect(plan.notes).toEqual([]);
    expect(names(plan)).not.toContain('enable-features');
  });

  /** A phone has no command line, so nothing above applies and nothing is printed about it. */
  it('leaves a mobile target alone whatever the runtime is', () => {
    for (const target of ['android', 'ios'] as const) {
      const plan = planFlags(base, target, OLD);
      expect(plan.switches).toEqual([]);
      expect(plan.notes).toEqual([]);
      expect(plan.refusal).toBeNull();
    }
  });
});

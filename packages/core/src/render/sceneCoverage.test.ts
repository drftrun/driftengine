/**
 * The scene's alpha is the surface's share of each pixel, and the composite darkens only that share
 * with ambient occlusion (`sceneCoverage.ts`). These hold the three places that can lose it: a
 * blended pipeline that raises the share, a temporal pass that replaces it, and the composite.
 *
 * **The scan is the point.** Every blend in the renderer and in the two packages that draw blended
 * work into the scene is read here, so a pass added later with the premultiplied `over` alpha every
 * pass used to carry fails by name rather than darkening its translucency by the corners behind it.
 */
import { expect, test } from 'vitest';

import { RUSH_FRAG } from './shaders/rush.ts';
import { reconResolveWgsl } from './shaders/recon/resolve.wgsl.ts';
import { TEMPORAL_RESOLVE_FRAG } from './shaders/temporalResolve.ts';

/* `import.meta.glob` is declared in `build/shaderComments.test.ts`, which says why. */
const SOURCES = Object.entries({
  ...import.meta.glob('./**/*.ts', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob('../../../ui2d/src/*.ts', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob('../../../splats/src/*.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
}).filter(([id]) => !id.endsWith('.test.ts'));

/** The three shares as `src/dst` pairs, the only alpha a blend into the scene may carry. */
const SHARES = new Set(['zero/one-minus-src-alpha', 'zero/src-alpha', 'zero/one']);

/*
 * The blends that are not into the scene, each with what they write into instead. Counted rather
 * than listed, so a second blend appearing in one of these files is read like any other.
 */
const ELSEWHERE_WEBGPU: Record<string, number> = {
  /*
   * The order-independent accumulation, which the composite then transmits. Its revealage target
   * multiplies by `1 - a`, which is the covering shape, so it is not counted here.
   */
  './backend/webgpu/flatPass.ts': 1,
  /* Its own accumulation (the revealage as above), its resolve, and its blit: the exception. */
  './backend/webgpu/gpuDrivenPass.ts': 3,
  /* The reflection's own target, and the bloom pyramid. */
  './backend/webgpu/postPass.ts': 2,
  /* The glass tint maps a shadow lookup reads. */
  './backend/webgpu/glassTintPass.ts': 1,
};
const ELSEWHERE_WEBGL2: Record<string, number> = {
  /* The three shares themselves. */
  './sceneCoverage.ts': 3,
  /* The order-independent accumulation and revealage. */
  './oitPass.ts': 2,
  /* The bloom pyramid. */
  './bloomPass.ts': 1,
  /* The reflection's own target; its resolve keeps the share. */
  './ssrPass.ts': 1,
  /* The glass tint maps. */
  './sunGlassTint.ts': 1,
  './pointGlassTint.ts': 1,
};

/** Lines of code, not of prose: a comment may name a blend call without making one. */
function codeOf(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    })
    .join('\n');
}

test('EVERY BLENDED DRAW INTO THE SCENE STATES WHAT IT DOES TO THE SURFACE SHARE', () => {
  const outside: Record<string, number> = {};
  const unshared: string[] = [];
  for (const [id, source] of SOURCES) {
    for (const match of codeOf(source).matchAll(/alpha:\s*\{([^}]*)\}/g)) {
      const body = match[1] ?? '';
      const src = /srcFactor:\s*'([^']+)'/.exec(body)?.[1];
      const dst = /dstFactor:\s*'([^']+)'/.exec(body)?.[1];
      if (SHARES.has(`${String(src)}/${String(dst)}`)) continue;
      outside[id] = (outside[id] ?? 0) + 1;
      if (ELSEWHERE_WEBGPU[id] === undefined)
        unshared.push(`${id}: alpha ${String(src)}/${String(dst)}`);
    }
  }
  expect(unshared, 'a WebGPU blend whose alpha is not one of SCENE_ALPHA_*').toEqual([]);
  expect(outside).toEqual(ELSEWHERE_WEBGPU);
});

test('AND ON WEBGL2 ONLY THE SHARES SET A BLEND, OUTSIDE THE TARGETS THAT ARE NOT THE SCENE', () => {
  /* `blendFunc` gives alpha the colour's factors, which is the `over` that raised the share. */
  const raw: Record<string, number> = {};
  for (const [id, source] of SOURCES) {
    const count = [...codeOf(source).matchAll(/\.blendFunc(Separate)?\(/g)].length;
    if (count > 0) raw[id] = count;
  }
  expect(raw).toEqual(ELSEWHERE_WEBGL2);
});

test('THE COMPOSITE DARKENS ONLY THE SURFACE SHARE OF A PIXEL', () => {
  const source = RUSH_FRAG.replace(/\s+/g, ' ');
  expect(source).toContain('float share = clamp(sampled.a, 0.0, 1.0);');
  expect(source).toContain('textureLod(uAo, vUv + uAoOffset, 0.0).r, uAoStrength * share)');
});

/*
 * A temporal resolve replaces the scene with what it resolved, and a reconstruction composites a
 * picture of its own: either writing an alpha of 1 hands the composite a frame with nothing in
 * front of anything, which was the defect.
 */
test('THE SHARE SURVIVES THE TEMPORAL RESOLVE AND THE RECONSTRUCTION', () => {
  const taa = TEMPORAL_RESOLVE_FRAG.replace(/\s+/g, ' ');
  const writes = [...taa.matchAll(/fragColor = vec4\(([^;]*)\);/g)].map((m) => m[1] ?? '');
  expect(writes.length).toBeGreaterThan(0);
  for (const write of writes) expect(write).toMatch(/, share$/);
  expect(taa).toContain('float share = sampled.a;');

  const recon = reconResolveWgsl().replace(/\s+/g, ' ');
  expect(recon).toContain('let share = reconSceneShare(i32(id.x), y);');
  expect(recon).toContain('vec4<f32>(value, share)');
  expect(recon).not.toContain('vec4<f32>(value, 1.0)');
});

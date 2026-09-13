/**
 * One shader, from the GLSL this engine is authored in to WGSL.
 *
 * Separate from `wgsl.ts` so that the generator and the tests run the *same* pipeline. A
 * test with its own copy of these steps can pass while the generator does something else,
 * which for a freshness guard is worse than having no test at all.
 *
 * Both tools are dev-only and neither is ever imported by `src/`:
 *   - glslang, as `@webgpu/glslang`, a devDependency
 *   - naga, on PATH, from `cargo install naga-cli --locked`
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { transform } from './transform.mjs';

const require = createRequire(import.meta.url);

let glslang = null;

/**
 * Load glslang without ever awaiting the module object itself.
 *
 * Emscripten gives its Module a `then` method, which makes it a thenable: `await` on it, or
 * resolving a promise with it, re-enters that method and never settles. The failure is a
 * hang with no output and no error, which looks like nothing at all.
 *
 * **This returns nothing on purpose, and that is load-bearing rather than style.** An
 * earlier version returned the module, which put the thenable straight back into a promise
 * for every caller to `await` and reintroduced the same hang one level up. The module stays
 * behind this file's own binding and is never handed across a promise boundary.
 */
export async function loadGlslang() {
  if (glslang !== null) return;
  const factory = require('@webgpu/glslang');
  const boxed = await new Promise((resolve) => {
    factory().then((module) => resolve({ module }));
  });
  glslang = boxed.module;
}

/** Whether naga is present, so a suite can skip rather than fail on a fresh machine. */
export function hasNaga() {
  try {
    execFileSync('naga', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * GLSL ES 3.00 in, WGSL out, with the transformed source kept on any failure.
 *
 * The transformed GLSL is what the compiler actually saw, and it is not what anybody wrote,
 * so an error message that does not say where to read it is an error message that cannot be
 * acted on.
 */
export async function compileToWgsl(glsl, stage, label = 'shader') {
  await loadGlslang();
  const { source, bindings } = transform(glsl, stage);
  const scratch = mkdtempSync(path.join(tmpdir(), 'wgsl-'));
  try {
    let spirv;
    try {
      spirv = glslang.compileGLSL(source, stage, false);
    } catch (error) {
      const kept = path.join(tmpdir(), `${label}.glsl`);
      writeFileSync(kept, source);
      throw new Error(
        `${label}: glslang refused the transformed GLSL. ${String(error?.message ?? error)}. ` +
          `The transformed source is at ${kept}`,
      );
    }

    const spv = path.join(scratch, 's.spv');
    const out = path.join(scratch, 's.wgsl');
    writeFileSync(spv, Buffer.from(spirv.buffer, spirv.byteOffset, spirv.byteLength));
    try {
      execFileSync('naga', ['--input-kind', 'spv', spv, out], { stdio: 'pipe' });
    } catch (error) {
      const stderr = String(error?.stderr ?? '')
        .split('\n')
        .filter((line) => !line.includes('RelaxedPrecision'))
        .join(' ')
        .trim();
      throw new Error(`${label}: naga refused the SPIR-V. ${stderr}`);
    }
    return { wgsl: readFileSync(out, 'utf8'), bindings };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

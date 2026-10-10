/**
 * The build a copied starter needs: Vite, and DriftScript's plugin, which compiles each `.drs`
 * import against what the engine provides.
 *
 * Inside this repository the examples' own config does the same job, so this file only matters once
 * the folder is copied into a project of its own.
 */
import { fileURLToPath } from 'node:url';
import { driftScript } from 'driftscript/vite';
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  plugins: [
    driftScript({
      /* The engine's capabilities, as data: every `drift/*` function, its types and its effects. */
      capabilities: fileURLToPath(import.meta.resolve('@driftengine/script/capabilities.json')),
      /* The engine modules a script in this game may import. Add one here when a script needs it;
         an import of a module not named is refused when the file compiles, naming the module. */
      manifest: { name: 'my-game', provides: ['drift/random', 'drift/scene', 'drift/input'] },
      /* `vite build` compiles for shipping: the editor's metadata stays out of the bundle. */
      mode: command === 'build' ? 'production' : 'development',
    }),
  ],
  build: {
    target: 'es2022',
    /* Just above the engine's WebGPU renderer, one module of about 2,100 kB minified that loads only
       where WebGPU does. Vite warns past 500 kB by default; anything larger than the renderer still
       warns. */
    chunkSizeWarningLimit: 2200,
  },
}));

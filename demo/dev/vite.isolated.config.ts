import base from './vite.config.ts';

/* Declared here rather than pulled in with `@types/node`: this config is under `demo/`, where the
   engine's tsconfig sets `"types": []` so that a stray `Buffer` cannot reach a consumer's bundle.
   Its own note says a file there declares what it needs, and one environment variable is all this
   needs. */
declare const process: { env: Record<string, string | undefined> };

/**
 * The demo harness with cross-origin isolation on, and nothing else changed.
 *
 * **A second config rather than headers on the shared one.** `Cross-Origin-Embedder-Policy` stops
 * every cross-origin resource that does not opt into CORP from loading, which is precisely the price
 * `workerPool.ts` refuses to make a consumer pay by default — and making the demo server pay it
 * would change the environment every other check script runs in, for the benefit of one.
 *
 * `DRIFT_COEP` picks which value to try, because which of the two actually grants isolation in a
 * given browser is the measurement `scripts/physics-pool-check.mjs` exists to take rather than a
 * fact worth asserting from memory:
 *
 *     DRIFT_COEP=require-corp   npx vite demo/dev --config demo/dev/vite.isolated.config.ts --port 5211
 *     DRIFT_COEP=credentialless npx vite demo/dev --config demo/dev/vite.isolated.config.ts --port 5211
 */
export default {
  ...base,
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': process.env.DRIFT_COEP ?? 'require-corp',
    },
  },
};

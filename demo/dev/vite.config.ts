import { driftScript } from 'driftscript/vite';

/**
 * The demo harness's bundler configuration, which exists for exactly one reason.
 *
 * `npm run demo` was `npx vite demo/dev` with no configuration at all, and that was right while
 * every file it served was TypeScript. A `.drs` file is not JavaScript until the DriftScript
 * transform has run, so the harness needs to know about the transform — and this is the first
 * place in the repository where the engine is consumed the way a consumer consumes it, which is
 * what makes it the right place to prove the plugin works.
 *
 * **No manifest is configured**, so nothing links and nothing is refused. That is deliberate for a
 * harness: the demo pages exist to look at behaviour, and a target manifest is a decision a real
 * consumer makes about what its build ships. `driftscript`'s own suite covers the
 * refusal path, and a consumer that wants it passes `{ manifest }`.
 *
 * Everything else stays default. A configuration that grew options would be a configuration the
 * demo harness depends on, and `scripts/shots.mjs` drives this server expecting the plain one.
 */
export default {
  plugins: [driftScript()],
};

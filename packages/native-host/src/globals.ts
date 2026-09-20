/**
 * The globals the engine reads, installed by the host before any engine code runs.
 *
 * **Every one is a place the engine reaches outside itself**, and the list is short on purpose:
 * `AGENTS.md` forbids a direct platform call, `scripts/platform.test.mjs` holds that for the
 * engine's packages, and what is left is the browser's own WebGPU entry point, which the backend
 * reads as `navigator.gpu` because that is what WebGPU is in a page. A gap Task 3 finds is added
 * here with the scene that found it, so this file is the host's list of what the engine assumed.
 */

/**
 * `navigator.gpu`. Node has a `navigator` of its own (with `hardwareConcurrency`, which the engine's
 * thread pools read), so the property goes onto it rather than replacing it.
 */
export function installGpu(gpu: GPU): void {
  const scope = globalThis as { navigator?: object };
  if (scope.navigator === undefined) {
    Object.defineProperty(globalThis, 'navigator', { value: { gpu }, configurable: true });
    return;
  }
  Object.defineProperty(scope.navigator, 'gpu', { value: gpu, configurable: true });
}

/**
 * `location`, with only the query a scene reads its options from.
 *
 * **Demo code, not engine code, reads it**: the voxel sandbox, the showroom, the day clock and the
 * city each take their options from the page's address (`?radius=`, `?exposure=`, `?at=`), which
 * is how the dev harness and a capture hold a scene still. The engine's own read, in
 * `createRenderer`, is already optional. A host passes the same query a browser capture would, so
 * the two draw the same scene.
 */
export function installLocation(search: string): void {
  const query = search === '' || search.startsWith('?') ? search : `?${search}`;
  Object.defineProperty(globalThis, 'location', {
    value: { search: query, href: `native://host/${query}`, pathname: '/' },
    configurable: true,
  });
}

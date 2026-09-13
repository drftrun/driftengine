/*
 * What TypeScript knows about the two asset imports this directory makes.
 *
 * `?url` is Vite's: the module resolves to the served path of the file rather than to its contents,
 * which is what lets `sog.ts` fetch a committed binary fixture without a copy of it living beside
 * the page. A JSON import is ordinary ESM and would resolve on its own with `resolveJsonModule`,
 * but the engine's `tsconfig.json` does not enable it and turning it on for one demo would change
 * how every package's imports resolve.
 *
 * Declared here rather than in `packages/*` because nothing under `src/` may import an asset: the
 * shipped source has no bundler, which `AGENTS.md` states and `cleanroom` proves.
 */
declare module '*?url' {
  const url: string;
  export default url;
}

declare module '*.json' {
  const contents: unknown;
  export default contents;
}

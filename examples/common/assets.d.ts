/**
 * Vite resolves an imported asset to a served URL. TypeScript needs telling that it does.
 *
 * Declared here rather than pulling in `vite/client`, which would hand every module in this
 * directory Vite's ambient globals — and the tsconfig's `"types": []` exists precisely to stop
 * that kind of thing leaking into code a consumer bundles.
 */
declare module '*.svg' {
  const url: string;
  export default url;
}

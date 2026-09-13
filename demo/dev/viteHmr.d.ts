/**
 * The sliver of Vite's HMR API the harness uses, declared once rather than pulled in.
 *
 * The engine has no build tooling and no reason to acquire a dependency on one for four type
 * names, which is the argument `demo/dev/main.ts` made when it declared these inline. It is
 * declared **here** now because a second file needed them: `import.meta.hot` is a *property*, and
 * TypeScript merges duplicate properties only when their types are identical — so two files
 * declaring slightly different shapes is an error rather than a merge. (`import.meta.glob` gets
 * away with being declared twice because it is a *method*, and methods merge as overloads. That
 * asymmetry is why this file exists and those declarations stay where they are.)
 *
 * **The call site's shape matters as much as the type.** Vite finds accepted dependencies by
 * scanning source for a literal `import.meta.hot.accept(` — static analysis, not runtime
 * registration. Reading the handle into a local and calling `hot?.accept(…)` runs correctly and is
 * invisible to that scan, so the module looks as though it accepts nothing and an edit falls back
 * to a full page reload. That is not hypothetical; it is what `demo/dev/driftscript.ts` did first.
 */
declare global {
  interface ImportMeta {
    readonly hot?: {
      /** Self-accept: this module handles its own replacement. */
      accept(): void;
      /** Accept a dependency's replacement, receiving its new namespace. */
      accept(dependency: string, callback: (next: unknown) => void): void;
      dispose(callback: (data: Record<string, unknown>) => void): void;
      readonly data: Record<string, unknown>;
    };
  }
}

export {};

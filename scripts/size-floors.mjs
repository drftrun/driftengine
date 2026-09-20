/**
 * The measured floors, as data two readers share.
 *
 * `size-gate.test.mjs` asserts a bundle still matches one of these. `packages.test.mjs` asserts each
 * package README quotes the right one — because every README in this repository quoted a number
 * that had drifted, each under a sentence claiming it was "a fact about the build rather than a
 * claim in a document". Core said 369.8 KB against a real 524.3; drft said 2.7 against 4.4.
 *
 * They live here rather than in the gate so there is one definition. A README quoting a second copy
 * is what produced the drift, and moving the copy into a test would only move it.
 */
/**
 * Gzipped bytes for each entry point, measured on the commit that introduced this file.
 *
 * A change that moves one of these is not necessarily wrong. It must be deliberate: update
 * the floor in the same commit and say in the message what grew and why.
 */
/*
 * **Every core entry moved on 2026-09-03, and only some of it is refraction's.**
 *
 * The floors were 15.4 KB behind reality when refraction measured them. About 6.1 KB of that is
 * the per-vertex channel from 3.42.0, which shipped without touching this file: it stayed inside
 * the 3% tolerance, so the gate passed and nothing said the instrument had drifted. Refraction is
 * the other 9.3 KB.
 *
 * That is the failure mode this file's own header warns about one level up — a floor that passes
 * at the true number and at every stale one below it — and it is why the number a document quotes
 * has to be measured against `main` rather than read off a floor. Refraction's own figure is a
 * before-and-after of `core-only` across the branch, not a subtraction from these.
 */
/**
 * **Every floor re-measured 2026-09-03, and every one of them was stale.**
 *
 * The drift ranged from 3 bytes to 3,194 and not one entry tripped the 3% gate, which is the
 * failure mode this file's header already describes: *a tolerance gate passes at the true number
 * and at every stale one below it.* What it costs is not the gate, it is the eight package READMEs
 * and eight root-table rows that quote these numbers under a sentence claiming to be a fact about
 * the build. Seven of them were reading low. `@driftengine/terrain` said **0.8 KB** and measures
 * **1.4** — and `ROADMAP.md` has said 1.4 since the day terrain shipped, so the roadmap was right
 * and this file was wrong for a week.
 *
 * **The drift was attributed by A/B rather than apportioned**, because Track J's own additions were
 * the obvious suspect and were almost entirely innocent:
 *
 * - `core-only` measures 645,522 against a floor of 645,523. The loop's tick argument, the savable
 *   generator and `math/exact.ts` cost a consumer of core **nothing**.
 * - `core-and-audio` is **byte-identical raw** with and without `math/exact.ts` exported from core's
 *   barrel, so the ~530 bytes every `core-and-*` fixture drifted predate this branch.
 * - `core-and-script` grew 3,194, of which **435 is `exactAcos`** reaching the terrain binding,
 *   measured by removing that one import and re-bundling. The other 2,759 predate the branch, and
 *   the likeliest source is `bindings/editor.ts` arriving in 3.45.0 with forty-three capabilities
 *   and no re-measurement.
 * - `chemistry-only` +11, `physics-only` +7 and `editor-only` +7 are this branch's: `x ** 3` became
 *   `x * x * x` and `2 ** 26` became a literal, which is more characters for the same arithmetic.
 */
/**
 * **Every core entry re-measured 2026-09-09, and every one of them had drifted between 2.7% and
 * 3.0% without tripping the gate.**
 *
 * Which is the failure this file's header describes, arriving for the third time: a 3% tolerance
 * passes at the true number and at every stale one below it, so a floor left alone drifts until one
 * commit of a few hundred bytes tips it over and gets blamed for the whole distance. The commit
 * that hit it here added 172 gzipped bytes to `core-and-script` — a deadline around the WebGPU
 * device request — against 21,007 bytes of accumulated drift it had nothing to do with.
 *
 * **Where the 18.6 KB of `core-only` went**, from the bundle's own metafile against the files added
 * since the last sweep: 46,805 raw bytes in the output come from modules that did not exist on
 * 2026-09-03. The global medium is 36,402 of that — `shaders/globalMedium.ts` and its generated
 * WGSL are 30,619 between them, which is one shader carried twice because the committed WGSL is
 * generated from the GLSL and both ship — and the probe grid is 6,987. The rest is the vertex
 * channel and the environment probe array.
 *
 * `physics-only` moved 226 bytes, which is the worker-count clamp from 3.57.1.
 *
 * **The same sweep's own commit then moved every core entry by 149 to 231 bytes**, which is the
 * deadline around the WebGPU branch and the two stage markers that say where a stalled boot stopped.
 * Recorded exactly rather than left inside the tolerance, because a floor that is only approximately
 * right is the instrument this file exists to keep honest.
 */
/**
 * **Every floor re-measured 2026-09-18, and every one of them was stale again.**
 *
 * The occasion was the renderer gaining a distance field of its own, which tripped the 3% gate on
 * every core entry. The gate was right to fire and mostly not about this change:
 *
 * | | `core-only` |
 * | --- | --- |
 * | Floor as recorded | 690,637 |
 * | `main` at `9851372a`, measured | **709,771** — 19,134 bytes of accumulated drift, 2.77% |
 * | This branch | **715,117** — 5,346 bytes of it this change, 0.75% |
 *
 * **2.77% had accumulated without one commit tripping the gate**, which is the failure mode this
 * file's header describes and the third time it has been recorded here: *a tolerance gate passes
 * at the true number and at every stale one below it.* Every core entry had drifted by 19.1 to
 * 19.3 KB, and the small packages by 79 to 123 bytes.
 *
 * **What this change costs is 5.3 KB on every core entry and nothing anywhere else**, and the
 * uniformity is the evidence for what it is: `createRenderer` now reaches `FieldComposer`, so
 * `COMPOSE_FIELD_WGSL` and `SAMPLE_FIELD_WGSL` are in every bundle that builds a renderer rather
 * than only in one that imported `GiFieldPass`. `physics-only`, `editor-only`, `chemistry-*` and
 * the rest moved by nothing at all, which is what says the cost is the renderer's and not a
 * change in how anything is bundled.
 *
 * **It is paid whether or not `quality.indirectLight` is on**, and that is a real cost rather than
 * a rounding: a shader's source is a string constant, and a bundler keeps it because the module is
 * reachable. Making it conditional means a dynamic import, which is a frame of latency and a
 * code-splitting requirement placed on every consumer's bundler — a worse trade than 5.3 KB for a
 * renderer that can light a scene with no baked lighting.
 */
export const FLOORS = {
  /*
   * Raised 2026-08-22 by MATL's four texture indices: three more `setInt32`, three more guarded
   * reads, and a loop checking all four against the texture count where it used to check one.
   * 2,685 to 2,800, which is 4.3% of a reader small enough that a hundred bytes shows.
   *
   * **Raised again 2026-08-25 by `SPLT`, to 3,293 — the largest single step this entry point has
   * taken, at 17.6%.** Three things, and the split is worth recording because the shape is not
   * what it looks like:
   *
   * - **`coarseFirst.ts` is most of it.** A Morton quantisation, a bit-spreading function, a
   *   comparison sort and a bit-reversal walk are about a hundred lines of arithmetic that gzip
   *   cannot dedupe against anything, because nothing else in this package looks like it.
   * - The writer's blocking and the reader's join are the ordinary half: a header, a loop, and a
   *   second loop that concatenates.
   * - The chunk constant and its `KNOWN_CHUNKS` entry are free, which is the point of the design
   *   in `CHUNK_SPLT`: the record is opaque, so nothing here learns a texel layout.
   *
   * **What it buys, measured on `demo/dev/splatstream.html`:** the first of sixteen blocks is 662
   * splats out of 24 KB of a 332 KB file, and it draws the whole room rather than a corner of it.
   * Half a kilobyte of reader against a capture that opens in a fourteenth of its bytes.
   *
   * **What would make it wrong** is a consumer that reads `.drft` and never draws a splat paying
   * for this. It does — the package is one entry point — and the fix if anybody minds is a
   * separate export path for the ordering, which is not worth doing before somebody does.
   */
  /*
   * **Raised 2026-08-25 to 3,399 by skinning's two `MeshData` attributes**, +106 and 3.2% — over
   * the tolerance on its own, which is what a reader small enough that a hundred bytes shows looks
   * like. Almost none of it is the two optional fields, which are types and cost nothing at
   * runtime: it is three new `check` calls and the both-or-neither guard in `validateMeshData`,
   * one of which — `tangents` — closes a hole that had been open since 2026-08-22 rather than
   * serving this row at all.
   */
  /*
   * **Raised 2026-08-25 to 4,229 by 1.6's three chunks**, +830 and 24.4% — the largest single step
   * this entry point has taken, past the 17.6% `SPLT` cost that held the record for a day.
   *
   * The split is three codecs rather than one large one, and none of them is arithmetic: `NODE`,
   * `SKIN` and `ANIM` are each a header, a strided walk and a length-prefixed name block, so what
   * gzip sees is three near-identical shapes it can only partly dedupe against each other.
   * `ANIM` is the largest of them because a track's keys are two arrays of a computed length,
   * which is a second walk inside the first.
   *
   * **A quarter is a lot for a reader this small, and it is what the row buys**: a rig survives a
   * bake, which is the difference between skinning being demonstrable and being usable. What would
   * make it wrong is a consumer importing `@driftengine/drft` alone to read geometry and paying
   * for animation it never asks about — the answer then is a second entry point, not a smaller
   * codec.
   */
  /*
   * **Raised again 2026-08-25 to 4,364 by morph targets**, +135 and 3.2%. Almost all of it is the
   * validation: `morphTargets` and `morphTargetCount` are types and cost nothing, where the check
   * around them is the one attribute whose length is not a fixed multiple of the vertex count and
   * so cannot go through `check`.
   */
  /*
   * **Raised again 2026-08-25 to 4,535 by `MORP`**, 1.7's morph chunk. A fourth codec on the
   * shape the three before it set — a header, a strided walk, a float array — plus the pairing
   * pass in the reader that attaches deltas to the mesh their payload names.
   *
   * This entry point has grown from 3,293 to 4,535 in one session, +38%, and every step
   * of it is a chunk that lets a rig survive a bake. The paragraph in ARCHITECTURE.md §2a says the
   * same; if a consumer ever imports this package to read geometry alone and objects to paying for
   * animation, the answer is a second entry point rather than a smaller codec.
   */
  /*
   * **Raised 2026-08-26 to 4,731 by `SUBS`**, 1.8's chunk, +196 and 4.3%. A count, a strided walk
   * over length-prefixed names, and a `TextEncoder`/`TextDecoder` pair — the fifth codec on the
   * shape the four before it set, and the only one whose payload is text rather than numbers, which
   * is where most of the difference is.
   *
   * **What it buys is that an artist labels the oak in Blender and the log burns like oak**, with no
   * code between the two. `§16` of the chemistry design is the argument. What would make it wrong is
   * a consumer reading `.drft` for geometry alone and paying for a chemistry label they never read —
   * and the answer then is the same one this entry point's other notes give: a second entry point,
   * not a smaller codec.
   *
   * **Corrected 2026-09-02 from 4,731, and not by the change that commit made**: nothing under
   * `packages/drft` was touched. See the note on `physics-only`, which was stale in the same way
   * and for as long.
   *
   * **Raised 2026-09-03 to 5,146 by `COLL`**, 1.12's chunk, +299 and 6.2%. A count pair, a start
   * table read and checked whole before a single point is handed out, and one `Float32Array` view
   * the hulls are `subarray`s of. The validation is most of it and is the reason the number is not
   * smaller: a start table that runs backwards would otherwise produce a hull of a length nobody
   * wrote, which is arbitrary geometry rather than an error, so every entry is checked against its
   * neighbour and against the declared total before any of it is used.
   *
   * **What it buys is that an imported model arrives with its collision.** `readModel.ts` declined
   * to put a vehicle's hull inside the model's own file because the format had no answer to whether
   * a hull is triangle soup or a set of convex hulls; `drft bake --collider hull` has one now, and
   * the decomposition that fills it runs at bake time and ships nothing.
   *
   * **`physics-only` did not move, and that took a correction to be true.** `MAX_BODY_PARTS` was
   * declared in `decompose.ts`, and importing that one integer from the runtime put the whole
   * voxeliser, flood fill and merge into every bundle touching physics — 44,617 bytes against a
   * floor of 43,932. The constant moved to `compoundContact.ts`, where a fact about how many shapes
   * a body may hold belongs anyway, and the figure came back inside its band. **A named import of a
   * `const` is enough to defeat tree shaking across a module boundary**, which is the kind of thing
   * only an A/B finds.
   */
  /*
   * **Raised 2026-09-16 to 5,528 by `SDFV`**, and the step is worth splitting because only two
   * thirds of it is the chunk.
   *
   * - **84 bytes of it predate this branch.** Clean `main` measures 5,230 against a floor of
   *   5,146, which is 1.6% and never tripped the 3% gate — the failure this file's header
   *   describes, arriving for the fourth time: *a tolerance gate passes at the true number and at
   *   every stale one below it.* Nobody is to blame for the 84 and it is recorded rather than
   *   folded into the chunk's figure.
   * - **268 bytes is the `SDFV` reader**, measured by deleting the one line in `drftRead.ts` that
   *   dispatches to it and re-bundling: 5,251 against 5,519.
   * - **Of that 268, 87 is the four error messages.** Unique English prose is what gzip can do
   *   least with, and this reader refuses four distinct shapes — a count larger than its table, a
   *   field larger than its chunk, a dimension of zero, and a sample count past the cap. Shortening
   *   them buys back a sixth of the chunk's cost and spends the thing every other refusal in this
   *   package pays for: a message that names the arithmetic. Not taken.
   * - **The remaining 21** is the FourCC, its `KNOWN_CHUNKS` entry and the `fields` field on the
   *   asset, which is what `CHUNK_SPLT`'s design note predicted a new chunk should cost when the
   *   record is opaque.
   *
   * **What would make it wrong** is a consumer that reads `.drft` and never traces indirect light
   * paying for this. It does, because the package is one entry point — the same answer `SPLT` gave,
   * and the same fix if anybody minds: a separate export path, not worth doing before somebody asks.
   */
  /*
   * **`NNET`, 2026-09-17: +528 bytes**, from 5,528 to 6,056 — the reader wired into `readDrft`, its
   * seven refusals and the role check. Same answer as `SDFV` above about who pays for it.
   */
  /*
   * **`NGRF`, 2026-09-19: +854 bytes**, from 6,056 to 6,910 — the graph chunk's writer and reader,
   * wired into `writeDrft` and `readDrft`. Larger than `NNET`'s because a graph's structure is
   * checked field by field on the way in — every input, node, attribute and tensor entry is JSON a
   * file could have made anything of — and each refusal names what it refused. Same answer again
   * about who pays: one entry point, and a separate export path is the fix when somebody minds.
   */
  /*
   * **`DTEX`, 2026-09-20: +745 bytes**, from 6,910 to 7,655 — the chunk wired into `writeDrft` and
   * `readDrft`, and with it the payload's own writer and reader, which had existed unreferenced
   * since the chunk was defined. The reader is most of it: a tile table, a result register and a
   * latent grid are three things a file could have made anything of, and each is refused by name.
   * Same answer as `SDFV`, `NNET` and `NGRF` about who pays — one entry point, and a separate
   * export path is the fix when somebody minds.
   */
  /*
   * **`NAVM` and `ENTS`, 2026-09-20: +684 bytes**, from 7,655 to 8,339 — both chunks wired into
   * `writeDrft` and `readDrft`. `NAVM` is the larger half and the reason is its index tables: a
   * polygon naming a vertex that is not there is the one defect in this pair that costs the
   * consumer rather than the file, so both tables are walked on the way out *and* on the way in.
   * `ENTS` is mostly a refusal per thing a file could have made anything of. Same answer as every
   * chunk before it about who pays: one entry point, and a separate export path is the fix when
   * somebody minds.
   */
  'drft-only': 8339,
  /*
   * Raised 2026-08-22 by the normal map, and again the same day by the ORM map. Both splits are
   * measured rather than assumed.
   *
   * The normal map cost **+13,509** bytes gzipped on `core-only`, of which the tangent-frame chunk
   * was **578**: it is concatenated identically into all sixteen permutations and gzip dedupes it
   * almost entirely. The rest was its block in `main.ts`, translated by naga into every one of
   * those sixteen — a `texture`, a mat3 and a `mix` come out as a few hundred lines of SSA apiece.
   *
   * **The ORM map cost +6,761, which is half of that, where the note above predicted the same
   * shape again.** The prediction was wrong in the useful direction and the reason is worth
   * keeping: the cost is the *arithmetic* naga translates sixteen times, not the number of things
   * declared. ORM declares three uniforms to the normal map's two and reads one more channel, but
   * its block is a texture fetch and three scalar ops, where the normal map's is a texture fetch,
   * a derived cotangent frame, a mat3 multiply and a mix of two normalised vectors. Declarations
   * are nearly free; a matrix is not.
   *
   * The raw generated WGSL went 766 KB to 856 KB, which is +12% against the bundle's +1.8%. The
   * gap is gzip deduplicating sixteen near-identical copies, and it is why the raw figure is not
   * the one to gate on.
   *
   * **The metal/dielectric split then cost a further +3,622**, on the same reasoning: four mixes,
   * a max and a multiply, sixteen times over. Raised here although it is under the tolerance,
   * because three sub-threshold steps in one day add to one that is not, and a floor that moves
   * with each of them is the only way the eventual failure names a culprit.
   *
   * **Occlusion then cost +669**, which is one multiply sixteen times and is the smallest of the
   * three by an order of magnitude. It is the clearest statement of the rule the ORM figure above
   * arrived at: what this file measures is arithmetic translated sixteen times.
   *
   * All of it is the price of gating on a uniform rather than a fifth permutation flag, and all of
   * it is that choice's cheaper side: a flag takes the exhaustive sweep to thirty-two shaders.
   */
  /*
   * **A further +2,423** for the probe-derived ambient and the widened reflection gate: one cube
   * fetch and a mix inside the eight probe variants, and one more term in a condition. **And
   * +3,299** for the Fresnel on the direct highlight: two pow(1 - x, 5) and two mixes, sixteen
   * times over.
   */
  /*
   * **Raised 2026-08-24 by clustered lighting: +36,838 on `core-only`, 9.2%.** The largest single
   * step this file has recorded, and the biggest feature: a froxel lookup, four `uintBitsToFloat`
   * unpackings, a matrix multiply, a logarithm and a second source for every per-light value,
   * translated into all sixteen permutations.
   *
   * **The number that matters here is the one that was not paid.** Clustering was built first as a
   * fifth permutation flag, which is what `ARCHITECTURE.md` §1 prescribes for a feature inside the
   * lit pass. Measured, that cost **+196,910 bytes gzipped — 49% — on every consumer including
   * those who never enable it**, with the generated WGSL going 914 KB to 1,906 KB raw. Gzip does
   * not rescue it: deflate's window is 32 KB and a permutation is larger, so sixteen near-identical
   * copies do not dedupe into one.
   *
   * **The note above already knew this**, and it is worth saying that the second discovery cost a
   * regeneration rather than a session: the ORM entries chose "gating on a uniform rather than a
   * fifth permutation flag" and called a flag's exhaustive sweep to thirty-two shaders the
   * expensive side. That was reasoning; this is the same conclusion with a number on it, and the
   * number is 5.3 times the feature's own cost.
   *
   * `ARCHITECTURE.md` carries what this means for the mechanism, which is that its cost is zero on
   * the path a driver compiles and 2^n on the path a consumer downloads.
   */
  /*
   * **Raised 2026-08-24 to 450,796, after finding the floor had been wrong for four releases.**
   * `npm run test:scripts` runs this file and had been red since emissive maps landed; the gate
   * did its job and nothing read it, which is worth recording beside the number.
   *
   * Attributed by bundling each commit in an isolated worktree, because the fixture imports
   * `@driftengine/core` by name and the workspace symlink resolves that to the *working tree* —
   * so measuring an old commit without its own `node_modules` measures today's source and returns
   * the same figure for every commit, which is what the first attempt did.
   *
   * | what landed | gzipped | step |
   * |---|---:|---:|
   * | clustered lighting, where this floor was last set | 437,565 | — |
   * | emissive maps | 440,604 | +3,039 |
   * | the flat pass evaluating nine irradiance coefficients | 444,678 | +4,061 |
   * | both backends projecting a probe into those coefficients | 446,883 | +2,205 |
   * | the convex-collision corrections | 449,834 | +2,917 |
   * | the WebGPU acceptance probe | 450,796 | +963 |
   *
   * Two of those are the shape the entries above predict: a shader term costs what naga
   * translates sixteen times, and the irradiance evaluation is nine multiply-adds with no texture
   * fetch, so it is cheaper per line than the normal map's matrix and dearer than ORM's three
   * scalar ops. The collision step is ordinary TypeScript and is the one that would not have been
   * predicted from the shaders at all.
   */
  /*
   * **Moved 2026-08-24 by the minifier rather than by the engine.** esbuild went 0.25.10 to
   * 0.28.2 — the version vite 8 asks for as a peer, which every install was warning about — and
   * the same source came out **156 bytes larger gzipped**, 0.03%. Recorded because it is the kind
   * of drift that would otherwise be attributed to whatever feature landed next: a floor is a
   * measurement of two things, and only one of them is ours.
   */
  /**
   * **Raised 2026-08-25 by the environment prefilter, and the split is worth keeping.**
   *
   * All four fixtures moved by 3.1 to 3.2%, which is one commit's worth of drift and outside the
   * tolerance rather than inside it. Where it went, measured rather than apportioned:
   *
   * | | gzipped |
   * |---|---|
   * | `envBrdfApprox` appearing in all sixteen flat permutations | 6,215 |
   * | `prefilter.wgsl.ts`, a new standalone program | 2,576 |
   * | `prefilterEnvMap`, `equirectToCube`, `prefilterPass`, `environmentTexels` and the renderers | ~5,400 |
   *
   * **The first row is the number to remember.** `envBrdfApprox` is about thirty lines and it costs
   * 6,215 bytes gzipped, because it is emitted sixteen times and a permutation is larger than
   * deflate's 32 KB window so the copies do not dedupe. That is the 2^n cost `ARCHITECTURE.md` §1
   * measured at 196,910 bytes for a fifth flag, seen in miniature and from the other direction:
   * adding *shared* shader code is paid for once per permutation, not once.
   *
   * **What that means for the next decision** — area lights, which are a candidate for a fifth flag
   * — is that the flag would double this corpus and every function in it, not only the new term.
   */
  /**
   * **Raised again 2026-08-25, by spot lights and IES profiles, and the split is the same lesson.**
   *
   * All four fixtures moved by about 14,236 bytes gzipped, and 10,517 of that is the generated
   * flat shader — the cone term and the photometric lookup emitted into all sixteen permutations.
   * The rest is the readers, the atlas packer and the two backends' bindings.
   *
   * **That is the second time in one session that a small addition to the lit pass cost five
   * figures.** `envBrdfApprox` was thirty lines and cost 6,215; the cone plus the profile lookup is
   * perhaps fifty and costs 10,517. The rule is not "shader code is expensive" — it is that
   * anything *shared* by the permutations is paid for sixteen times, because a permutation is
   * larger than deflate's 32 KB window and the copies do not dedupe.
   *
   * **What that means for area lights**, which are the remaining candidate for a fifth flag: a flag
   * doubles the corpus, so it would pay for every function already in it a second time — the
   * 196,910 bytes `ARCHITECTURE.md` §1 measured, not the size of the LTC code.
   */
  /**
   * **Raised a third time 2026-08-25, by area lights, and this one is 9.4%.**
   *
   * The three measurements this session are the useful thing, because together they say what a
   * line of shared lit-pass code actually costs:
   *
   * | added | lines | gzipped |
   * |---|---|---|
   * | `envBrdfApprox` | ~30 | 6,215 |
   * | the spot cone and the IES lookup | ~50 | 10,517 |
   * | the area-light form factor and its specular | ~90 | 44,984 |
   *
   * It is **superlinear**, and the reason is worth knowing: the form factor is four normalisations,
   * four cross products and four inverse cosines, which the translator expands into a great many
   * temporaries — so the cost tracks generated *operands* rather than authored lines, and a term
   * with heavy arithmetic is far more expensive than a term with heavy branching.
   *
   * **It is still the cheaper of the two options, and that is the whole argument for not permuting
   * it.** A fifth flag doubles the corpus, and the corpus is what every consumer bundles whether or
   * not they enable anything — `ARCHITECTURE.md` §1 measured that at 196,910 bytes. So compiled in
   * unconditionally the area-light term costs 44,984 to everyone, and permuted it would cost
   * 196,910 to everyone. Four and a half times worse, for a feature that would then also need its
   * own variant plumbing.
   *
   * **What would make this wrong** is a consumer for whom 45 KB is the difference — a game holding
   * to the 10 MB payload budget with little room left. The answer then is not a permutation, which
   * is worse; it is a second lit-pass program without the term, chosen at `createRenderer`.
   */
  /*
   * **Raised 2026-08-25 to 531,546 by skinning's half of core**, +7,144 and 1.36% — *inside* the
   * tolerance, and raised deliberately for the reason the entry below already states: three
   * sub-threshold steps add to one that is not, and a floor left behind fails on whatever lands
   * next and names it as the culprit.
   *
   * The split is worth recording because the headline figure is not the whole of it. The generated
   * WGSL grew **1,118 bytes gzipped** for the second vertex variant — two 4.4 KB strings that
   * mostly dedupe inside deflate's 32 KB window, against the 246,925 one more *fragment* flag
   * costs, which is the number `ARCHITECTURE.md` §1's rule is written about. The other six
   * thousand are ordinary source: the GLSL skinning prelude, which ships as text and does not
   * minify; `skinPalette.ts`; and a palette-texture binder per backend.
   *
   * So the permutation is 16% of what skinning cost core, and the rule that would have forbidden
   * it was pricing the wrong stage.
   */
  /*
   * **Raised 2026-08-25 to 536,888 by Track A's half of core**, +5,342 on the skinning figure
   * below. The vertex stage's two permutation flags are 2,792 of it — 1,118 for skinning and
   * 1,674 for morph — and the rest is the two GLSL preludes, which ship as text and do not minify,
   * the palette and delta modules, and a binder per backend for each.
   *
   * Both flags together cost about 1% of what one more *fragment* flag would. That is the whole
   * argument of §1 above, measured twice from the other side of it.
   */
  /*
   * **Raised 2026-08-26 to 539,548 by the web splash badge**, +2,660 and 0.50% — inside the
   * tolerance, and raised anyway for the reason the two entries below already give: sub-threshold
   * steps accumulate, and a floor left behind fails on whatever lands next and names it.
   *
   * **The mark is almost all of it.** `ui/splash.ts` inlines the vertical lockup as SVG markup —
   * fifteen path elements of outlined curves, which gzip to about 2.1 KB and dedupe against
   * nothing, because no other string in core looks like a bezier. The decision functions, the
   * scoped stylesheet and the mount are a few hundred bytes between them.
   *
   * **Why core pays rather than a package.** The badge is on by default, and a default only
   * reaches a consumer that has already installed the thing carrying it. A game that declines it
   * still ships the mark, which is the honest cost of the decision and is why the option exists —
   * see `CreateRendererOptions.splash`. **What would make it wrong** is a consumer counting bytes
   * against a payload budget who also never boots into a game; that is exactly the three sites and
   * the editing tool in this repository, and every one of them passes `splash: false`.
   */
  /*
   * **Raised 2026-08-27 to 553,470 by the asymmetric IES lookup**, +13,922 and 2.6% — and every
   * core-derived entry point below moves with it, because all of them carry the flat shader.
   *
   * Almost all of it is the *generated WGSL*, which grew 42,846 raw bytes across the sixteen
   * fragment permutations: an azimuth from the light's reference axis, a `uLightIesAxis` uniform
   * array, and the fifth froxel texel unpacked in the clustered arm. The rest is the CPU packer.
   *
   * **The first version cost 18,315 and was replaced**, which is the number worth keeping. It took
   * two explicit fetches and a `mix` to blend the two horizontal planes either side of the sample,
   * because a fractional row would wrap into the *next profile*. Padding each profile with a wrap
   * row that repeats its first plane makes a fractional row correct, so the shader does one fetch
   * and the texture's own linear filter does the blend — 4,393 gzipped bytes cheaper, and one
   * fewer sample per light per fragment on every scene that uses a profile at all.
   *
   * **What would make this wrong** is a consumer who ships no photometric profile paying 2.6% for
   * one. They do, and the honest fix if anybody minds is the permutation flag `ARCHITECTURE.md`
   * §1 prices — which for the fragment corpus is 196,910 bytes, fourteen times this.
   */
  /*
   * **Raised again 2026-08-27 to 566,250 by spot-light cookies**, +12,780 and 2.3%, and again every
   * core-derived entry point moves with it because all of them carry the flat shader.
   *
   * The shape is the same as the row above it: a projection and a fetch written into the sixteen
   * fragment permutations, plus a `uLightCookie` uniform array and one more froxel slot. It cost
   * about what the asymmetric photometric lookup cost, which is the useful comparison — these two
   * are the price of a lit-pass feature compiled in rather than permuted, and `ARCHITECTURE.md` §1
   * prices the alternative at 196,910 for one more fragment flag.
   *
   * **Both share their frame**, which is why the second was cheaper than the first would have been
   * alone: the cookie's projection and the photometric azimuth read the same `uLightIesAxis` and
   * build the same tangent basis, behind one branch, because both are asking a fixture which way
   * is up.
   */
  /*
   * **Raised 2026-08-28 to 598,142 by area-light shadows, +24,549 and 4.3%** — every `core-*` floor
   * with it, since they are core plus one package and the step is core's.
   *
   * **7,343 of it was already there and the tolerance was hiding it.** The floor said 566,250 and
   * the commit before this one measured 573,593: +1.3%, inside the 3% band, so the gate stayed green
   * while the number in the file stopped being the measured one. That is the drift this file's own
   * header describes, arriving by accumulation rather than by anybody's edit — so the floors are set
   * to what was measured rather than to the old number plus this change.
   *
   * **The other 24,549 is the shadow, and almost none of it is the decision.** The split, in raw
   * bytes before gzip: `flat.wgsl.ts` +114,278, the GLSL it is generated from +12,863 across
   * `pointShadow.ts`, `main.ts` and `preamble.ts`, and `areaShadowSet.ts` about 14 KB of scheduling.
   * The generated WGSL is nine tenths of it because a shader ships twice — authored in GLSL and
   * transpiled — and `areaShadow` is compiled into the eight permutations that carry point shadows.
   * Gzip recovers most of that: eight near-identical copies of one function is exactly what it is
   * good at, which is why 114,278 raw becomes a fraction of that compressed.
   *
   * **Each fixture had drifted by its own amount, which is why the per-package *deltas* moved too.**
   * They are `size(core + package) - size(core)` and this change touches only core, so nothing here
   * should have moved them — the steps in the package READMEs, up to 3.6 KB on `script`, are that
   * fixture's own accumulated drift arriving at the same time as core's. Each README now quotes what
   * its fixture measures rather than what it measured whenever its floor was last written.
   *
   * **What it buys** is the row priced at `L`: a rectangle occludes, with a penumbra
   * the shape of the emitter — measured at a shadow edge 0.178 m wide along a three-metre strip
   * against 0.044 m across it. **What would bring it back down** is one shared tap loop instead of
   * two, which `docs/IMPROVEMENTS.md` prices and declines: the shared form changes the rounding order
   * of every tap on the *point* path, and eight published scenes currently gate at zero pixels.
   */
  /*
   * **Raised 2026-09-02 by order-independent transparency**, every core entry point by about
   * 19.8 KB — 3.3% on `core-only`, 598,142 to 617,909.
   *
   * **The larger half is the flat shader**, which gained one uniform and one branch at its output:
   * the weighted, premultiplied form the accumulation pass wants. That is generated into every one
   * of the sixteen fragment permutations and the five vertex ones, so eighteen kilobytes of WGSL
   * source before compression, and it does not dedupe far because each variant differs around it.
   *
   * **The smaller half is three modules**: `orderIndependent.ts` (the weight and the resolve
   * arithmetic), `translucentQueue.ts` (the recorded set, needed because the two buffers are two
   * blend states over the same geometry) and `oitPass.ts` with its resolve shader.
   *
   * **What it is not is the alternative.** Writing both buffers from one pass needs a second
   * fragment output, which is another `flatFrag` axis — `scripts/wgsl.ts` measures one at about
   * 247 KB gzipped, more than twelve times this, and paid by every consumer whether or not they
   * ever switch the effect on. This is what that decision cost instead, and it is why the
   * weighting is a uniform branch and the geometry is submitted twice.
   *
   * A consumer who never sets `orderIndependent` still carries these bytes; what they do not carry
   * is the permutation. That trade is the whole reason the number moved this way rather than that.
   */
  /*
   * **Raised 2026-09-02 by drawn decals**, every core entry point by about 4 KB — 0.66% on
   * `core-only`, 617,909 to 621,959.
   *
   * **Four modules and one shader, and none of it touches the flat shader.** `decalProjector.ts`
   * is the box and its two matrices and the scissor bound its eight corners give; `decalQueue.ts`
   * is the recorded set, needed because a mark is decided from the depth the frame has drawn and
   * therefore cannot be drawn where it is submitted; `decalPass.ts` and the WebGPU pass are the
   * two backends' halves; `decalProject.ts` is one fullscreen fragment shader.
   *
   * **Compare it with the row before**, which is the number worth carrying: order-independent
   * transparency cost 19.8 KB because it added a uniform and a branch to `flatFrag`, and that is
   * generated into all sixteen fragment permutations and five vertex ones. This adds a shader of
   * its own instead, so it is generated once. A capability in a new pass is about a fifth of the
   * price of the same capability as a branch inside the shader every draw already uses.
   *
   * A consumer who never places a mark still carries these bytes. Nothing else is affected: no
   * existing shader changed, so no permutation grew.
   */
  /*
   * **Raised 2026-09-02 by screen-space reflection**, every core entry point by about 7.5 KB —
   * 1.23% on `core-only`, 621,959 to 629,614.
   *
   * **Two shaders and a module, and again nothing touches the flat shader.** The trace is the
   * larger half: a ray march with a bracketed refinement, two reconstructions and three fades is a
   * hundred lines of arithmetic that gzip cannot dedupe against anything, because nothing else here
   * looks like it. The resolve is one fetch. `screenSpaceReflection.ts` carries the same march in
   * TypeScript — where it is tested — the box, the queue and the fades, and `ssrPass.ts` is the
   * WebGL2 half.
   *
   * **The three rows of this track, in order, are the argument for where a capability goes**:
   * order-independent transparency cost 19.8 KB because it added a uniform and a branch to
   * `flatFrag`, which is generated into sixteen fragment permutations and five vertex ones; drawn
   * decals cost 4 KB as a shader of their own; this costs 7.5 KB the same way, and it is a
   * considerably larger shader. A capability in a new pass is priced by its own size. A capability
   * inside the shader every draw already uses is priced by the permutation count.
   *
   * A consumer who never declares a reflective surface still carries these bytes. Nothing else is
   * affected: no existing shader changed, so no permutation grew.
   */
  /*
   * **Corrected 2026-09-03 to 645,523, and none of the 505 bytes is the gizmo's.**
   *
   * The gizmo row measured this file's own warning again. Refraction re-measured the floors nine
   * days ago and found them 15.4 KB behind; this is the same instrument drifting again by 0.078%,
   * which the 3% tolerance passes without a word. The difference this time is that the drift was
   * looked for rather than stumbled on.
   *
   * **The A/B, because a number that agrees with a hypothesis is not evidence for it.** `core-only`
   * bundled against this branch is 645,522 bytes; against `e07ae55`, with `intersect.ts` and
   * `index.ts` checked out from it, 645,523. One byte apart, in the direction that says the gizmo
   * costs a consumer of core nothing at all — which the bundle confirms directly: `GIZMO`,
   * `dragAxes` and `ringSegments` appear nowhere in it. `core-only` imports `createRenderer` and
   * a bundler shakes the rest of the barrel out, which is what makes an editor tool affordable to
   * ship in core beside `DebugLines`.
   */
  /*
   * **Raised 2026-09-03 to 667,293 by the environment probe grid**, +21,495 and 3.33% — and every
   * core-derived entry point below moves with it, because all of them carry the flat shader.
   *
   * **The generated WGSL is 16,502 of it**, which is 77% and is the shape this file already
   * records for a lit-pass feature: a shader ships twice, authored in GLSL and generated into
   * WGSL, and the generated half is where a chunk written once is paid for sixteen times.
   *
   * Two chunks moved into the fragment corpus. The probe grid's own is 5,418 bytes of GLSL in the
   * eight `ENVIRONMENT_PROBE` permutations, which is the feature. The octahedral chunk is 917 and
   * appears in eight *more* permutations than it did, because it turned out to have been inside
   * `#if POINT_SHADOWS` all along — `LOBES_GLSL` opens a conditional that `DIRECTIONALSHADOW_GLSL`
   * closes, and everything between them was inside it. The comment above it claimed otherwise and
   * nothing noticed, because its only caller was in the same arm.
   *
   * **What it bought, against what it cost.** The row it closes wanted a second sampler and there
   * is one texture unit left of WebGL2's guaranteed sixteen; folding both the reflection and the
   * diffuse ambient into one array binding costs no unit at all and leaves that one free. It also
   * deleted `irradianceSh.ts` and `probeReadback.ts` outright, so the CPU side is smaller than it
   * was — the 21,495 is the shader growing past that saving, not on top of it.
   *
   * **What would make it wrong** is a consumer who never bakes a probe paying 3.3% for one. They
   * do, and the honest alternative is the permutation flag `ARCHITECTURE.md` §1 prices at 196,910
   * for the fragment corpus, nine times this.
   */
  /**
   * **Every core entry re-measured 2026-09-17, when the forward flush learned a second scheduler.**
   *
   * `quality.identifierGraph` schedules a flush through `frame/flushGraph.ts`, and the renderer
   * reaches it whether or not the flag is on, so `scheduleGraph`, `lifetime.ts` and the mask
   * recorder now ship with core: **`core-only` +1,456 bytes gzipped**, 689,174 on `main` to
   * 690,630, and every `core-and-*` entry +1,402 to +1,520 the same way.
   *
   * **The floors were already 3,131 behind `main`**, inside the tolerance. Measured the same way,
   * the commit that set 686,043 reads 688,156 — so about 2,100 of it was never there — then the
   * ascendancy waves added 987 before the texture plan and the texture plan 31. Recorded exactly
   * here, on the same reasoning as the 2026-09-09 sweep above: a floor left inside the tolerance
   * fails on whatever lands next and names it as the culprit.
   *
   * **And again the same day, by six to eight bytes an entry**, when the second pipeline's instance
   * cull became a stage of its frame: the stage list core keeps gained one name. The cull itself is
   * in the opt-in pass and costs a consumer who does not construct one nothing. Recorded exactly,
   * for the reason above.
   *
   * **Raised 2026-09-21 by the point-shadow filter's pair resolve — and only 9,056 of the 23,382
   * is that change.** Measured the same way on the tree before it, `core-only` reads **729,276**
   * against a floor of 715,117: 14,159 bytes, 1.98%, had accumulated unrecorded and were sitting
   * inside the tolerance waiting for whatever landed next to be blamed for them. That is the third
   * time this file has caught itself doing exactly what its own header warns about, so it is
   * written down rather than folded in. The remaining 167 arrived with the glyph-cell rounding
   * that landed between the two measurements.
   *
   * **What the 9,056 is.** Almost all of it is generated WGSL rather than anything a reader typed:
   * the resolve is fifteen statements of GLSL and naga expands them into each of the sixteen
   * lighting permutations, which is +29,270 raw and +5,122 gzipped in `flat.wgsl.ts` alone. The
   * rest is the GLSL those permutations are assembled from — comments included, because a shader
   * source is a string and its comments ship. The tap table itself is *smaller*: it was twelve
   * `vec3` and is twelve `vec2`.
   *
   * **What would make it wrong** is the same thing that would make the fix wrong: if the sixteen
   * permutations were ever collapsed, this would collapse with them.
   */
  'core-only': 738499,
  /**
   * **The gizmo, 2026-09-03: 4,642 bytes over core, which is 4.53 KB gzipped.**
   *
   * Cheap for what it is, and the reason is where it sits rather than restraint. It is arithmetic —
   * three ray intersections, thirteen handles, five drag solvers and the line geometry for all of
   * them — and it touches no shader, so it adds no permutation to the sixteen `flatFrag` already
   * has at 283.4 KB. Compare the row above it: order-independent transparency cost 19.8 KB for a
   * uniform and a branch inside that shader.
   *
   * Nothing else moved: `core-only` is unchanged to the byte, so a game that never imports a gizmo
   * pays nothing for one existing.
   */
  'core-and-gizmo': 743349,
  /*
   * Both carry the same drift as `core-only` — they are that bundle plus a package — and both sat
   * at 2.9% of their old floors, which is inside the tolerance and one commit from outside it. A
   * floor left there fails on whatever lands next and names it as the culprit, so they move in the
   * same commit for the same reasons, measured the same way.
   */
  /**
   * **Moved 2026-08-24, from 455,874, when the mix became a bus tree.** `AudioGraph` is built on
   * `MixConsole` now and forwards to it, so importing the graph pulls the tree in: **+1,441 bytes
   * gzipped, 0.32%**. That is the whole of the console, the bus, the three inserts and the two
   * return stages.
   */
  'core-and-audio': 744736,
  /*
   * **`@driftengine/splats`, measured 2026-08-25 on the commit that published it.** Core alone is
   * 524,402 and this is 536,676, so the whole package — two readers, the packing, the counting
   * sort and its worker, the shader for both backends, the pass, the budget, the cull and the
   * streaming capture — is **about 12 KB gzipped**.
   *
   * Small for what it is, and the reason is the design rather than luck: the pass owns no vertex
   * buffer and no vertex array, so there is no geometry code; the sort ships as one function
   * stringified into a worker rather than as a second implementation; and the shader is authored
   * once in GLSL and generated to WGSL, so the two backends are one source. The growth assertion
   * below covers it, which is the assertion that matters — if importing splats did not grow the
   * bundle, core would be dragging them in and both numbers would measure the same thing.
   */
  /*
   * **The animation package is 5,779 bytes gzipped over core**, for a skeleton and its palette, a
   * clip sampler, blending and additive layers, blend trees, a state machine, two-bone IK,
   * retargeting and the node driver. Small for what it is, and the reason is the design: everything
   * in it is arithmetic over typed arrays with no GPU code at all, and the half that *is* GPU —
   * two attributes, a data texture and a vertex permutation — lives in core because `RendererApi`
   * is a surface a package cannot extend.
   */
  'core-and-animation': 744797,
  /*
   * **The four floors below moved with core rather than on their own account, 2026-08-25.** Each
   * is that bundle plus a package, so core's +5,342 for Track A is in every one of them — and each
   * had drifted to about 2.3%, inside the tolerance and one commit from outside it. Left alone
   * they would have failed on whatever landed next and named it as the culprit, which is the
   * accumulation this file warns about two entries up.
   */
  /*
   * What a consumer pays to make this engine scriptable: core plus the bindings, and **not** the
   * compiler, which a production bundle never reaches. The gap against `core-only` is the whole
   * cost of the feature — 9,760 bytes gzipped, which is registry entries, implementation maps and
   * the host glue. There is no new engine code in it; a binding is a description and a lookup.
   */
  /*
   * **Raised 2026-09-02 by the `drift/terrain` binding**, 655,763 to 656,308 — 545 bytes for eight
   * capabilities, an opaque type and the implementations behind them.
   *
   * A script surface is nearly free here and it is worth saying why, because the instinct is that
   * binding a package into a language costs what the package costs. It does not: the capabilities
   * are descriptions, the implementations are one-line forwards, and `@driftengine/terrain` itself
   * is already in this bundle only because the fixture imports the barrel that re-exports it.
   */
  /*
   * **Raised 2026-09-03 to 660,823 by `drift/ui` and `drift/2d`**, +4,506 and 0.69% — inside the 3%
   * tolerance, and moved anyway because the growth is deliberate and this file is where deliberate
   * growth is recorded.
   *
   * **Most of it is not the bindings.** `engineRegistry()` imports every binding and each binding
   * imports the package it describes, so this fixture is core plus *every package a script can
   * reach*: binding `@driftengine/ui2d` put the whole 2D layer into it. That is the honest shape of
   * a script host and not a defect — a consumer that links scripts links what scripts can call —
   * but it is why 26.1 KB became 30.5 for thirty capabilities that are themselves object
   * literals.
   */
  'core-and-script': 776274,
  /*
   * **`@driftengine/texture`, measured on the commit that published it.** Standalone, like
   * `drft-only` and `entities-only`: the package imports no renderer, so this is the whole of what
   * a consumer pays for declared channel semantics, variance-preserving normal mips, content
   * addressing, the shared network evaluator, the decode graph and its reference interpreter, the
   * material array and the progressive ordering.
   *
   * **The decode graph is data rather than shader permutations, and that choice is what this
   * number is small because of.** ARCHITECTURE.md prices the alternative: one extra permutation
   * flag cost 196,910 gzipped bytes across the WGSL corpus, on every consumer, enabled or not.
   * Per material rather than per feature, that arithmetic does not survive contact with a project.
   *
   * **1,966 of this is code and 79 is the licence banner.** A `/*!` comment is preserved by
   * minifiers on purpose, so every package here carries the same 79 bytes and the gate measures
   * them. Worth knowing before somebody reads a 4% jump as a regression: adding the banner *was*
   * the jump, on the commit that added it.
   *
   * **Raised 2026-09-17 to 2,186 by texel-centre addressing** — 141 bytes for two address modes,
   * the constant table that names all four, and the validator's refusal of a fifth. The GPU-driven
   * pipeline samples surface textures the way every GPU sampler does, and the reference had to
   * learn that convention before the device could be compared against it.
   *
   * **And again the same day to 2,305 by mip levels** — 119 bytes for trilinear sampling across a
   * latent's chain, so the device's `textureSampleLevel` has a reference at every level, not only
   * level 0.
   */
  /*
   * **Added 2026-09-20 so the root README's cost column can be filled for every package that has
   * a browser payload at all.** Two packages had shipped with no fixture and therefore no measured
   * size, which is the one thing `AGENTS.md` says a new package owes and the one nothing checked.
   */
  'ai-only': 1778,
  'media-only': 11524,
  'texture-only': 2305,
  /*
   * **Raised 2026-09-16 to 7,101 by hole support in `buildContours`**, and the step splits three
   * ways.
   *
   * - **12 bytes of it predate this branch.** Clean `main` measures 6,348 against a floor of 6,336,
   *   which is 0.2% and nowhere near the 3% gate — the drift this file's header describes, small
   *   this time and recorded anyway.
   * - **The rest is the bridge**: a signed-area test to find the outer loop, a closest-pair search
   *   with a crossing check, the splice itself, and an anchored Douglas–Peucker so simplification
   *   cannot pull a bridge apart. About 700 gzipped bytes of arithmetic that gzip has nothing to
   *   dedupe it against, which is `SPLT`'s Morton sort arriving in a different package.
   * - **What it buys is a mesh that stops claiming ground it does not have.** The old behaviour
   *   took a region's longest boundary loop and dropped the rest, so a room with a pillar came out
   *   as a rectangle *over* the pillar — measured at area 40 where the region is 32, on a
   *   ten-by-four map. An agent walked through the column, and through whatever else the watershed
   *   had carved out of the middle.
   *
   * **What would make it wrong** is a consumer that builds navigation meshes and never has a hole
   * in one paying for this. They do, and the fix if anybody minds is the same one `SPLT` names: a
   * separate export path, not worth doing before somebody asks.
   *
   * **Raised to 8,401 on 2026-09-20, by the portal graph: +1,298 bytes.** The search is over
   * portals now rather than polygon centres, which is what makes a path the shortest way round
   * instead of about a tenth longer — and most of the cost is not the graph, it is *finding* the
   * portals: two polygon edges are a way through where they overlap, not where they share two
   * vertices, so the builder buckets every edge by the exact line it lies on and intersects the
   * pairs inside each bucket. A kilobyte and a quarter for a tenth off every path an agent walks,
   * and the same answer as above about who pays: a separate export path when somebody minds.
   */
  'nav-only': 8401,
  /*
   * **The whole argument of Wave 5B Task 7, as a number.** The inspector, the console, the
   * profiler and the network panel, plus the command stack that makes their edits undoable — the
   * panels a game can carry into a shipping build. It has a floor because it is a package: a game
   * that never imports it pays nothing, which is not a claim about tree-shaking but a fact about
   * a module nobody imports, and every other floor here staying put is the evidence.
   *
   * **3,394 bytes, of which 79 is the licence banner.** Four panels, a selection, an undo stack and
   * the panel contract, measured 2026-09-15 on the commit that published the package.
   *
   * **5,105 from 4.1.0, and 1,710 of the rise is `createToolsOverlay`.** The panels shipped with
   * nothing to mount them, so the thing that puts them on screen on a key — the column geometry,
   * the event routing and the painter walk — is now in the package rather than written again by
   * every consumer that wants an in-game inspector.
   *
   * **The fixture did not name it, and for one commit this number was a lie.** `tools-only.ts`
   * imported the four panels and the undo stack, so the overlay was tree-shaken out of the
   * measurement and the gate stayed green at 3,395 over a package that had grown by half. A size
   * fixture measures what it imports, which is the same trap as a scope nobody re-reads: adding
   * public surface means adding it to the fixture, or the floor guards the old package forever.
   *
   * **5,391 from 4.1.1**, of which 286 is the two adapters: an entity world as something the
   * inspector can read, and a lockstep session as something the network panel can. Both are the
   * same forwarding every consumer with a world or a session was about to write, and both are
   * typed structurally, so the package still depends on nothing new. Named in the fixture in the
   * same commit, which is the whole point of the paragraph above it.
   */
  'tools-only': 5391,
  /*
   * **`@driftengine/capture` as it first ships: one model's definition.** Depth Anything 3's
   * backbone, head and camera decoder as functions of their weights, the rotary and positional
   * tables they compute from shapes, and the seeded miniature its tests share with the upstream's
   * code. It pulls in `@driftengine/texture`'s graph builder, validation and operator shape rules,
   * and `mulberry32`. **5,451 bytes**, measured 2026-09-19 on the commit that created the package —
   * 873 of them core's reproducible `sin`, `cos` and `exp`, which the tables and the decoding use
   * because `packages/capture` is inside the determinism gate: a capture reproduces, and `Math.sin`
   * is not the same bits on every engine. **6,520 with Depth Anything V2 Small beside it**, the
   * lighter fallback: 1,069 bytes for a second backbone and neck, written from Transformers' layout.
   * **11,072 with MobileSAM**, measured 2026-09-19 by taking exports out of the fixture: 1,778
   * bytes for TinyViT, its window attention and the folded batch norm; 1,972 for the two-way
   * decoder, the prompt's Fourier tokens on the host and the masks brought to the image; and 802 for
   * the miniature that names every tensor of the three. **23,789 with SAM 2.1**, measured the same
   * day the same way: 11,774 for Hiera, SAM 2's decoder, the memory encoder and attention, their
   * position tables and the tracker that runs a video through them, and 943 for its miniature.
   * **26,821 with OWLv2**, measured the same day the same way: 2,047 for its two graphs, the box
   * prior and the host's join into logits and boxes, 591 for CLIP's tokenizer, and 415 for its
   * miniature. **29,141 with the frames a capture runs on**, measured 2026-09-20 the same way:
   * 354 for the seam and the choosing of frames by motion, 1,816 for the four preparations and the
   * two resizes under them, and 323 for the depth estimate over a clip. **30,870 with the
   * decompositions**, measured the same day: 1,729 for Jacobi's singular values and eigenvectors,
   * Cholesky, Levenberg–Marquardt and the Schur complement over points, which is what a bundle
   * adjuster is built from. **35,240 with two views**, measured 2026-09-20 the same way: 963 for
   * the analytic scenes a fixture is rendered from, 1,043 for corners, their turned descriptions
   * and the matching, and 2,408 for the pose between two views and the points behind it.
   * **38,796 with the camera path**, measured the same day: 3,556 for the tracks, the two starts,
   * the frames placed by what they see and the bundle adjustment over the Schur complement.
   * **44,132 with the Gaussians**, measured 2026-09-20 the same way: 5,336 for the reference
   * rasteriser and its analytic gradients, the degree-1 band evaluated as the splat shader
   * evaluates it, the structural similarity a fit is judged by, and the fit itself — Adam over six
   * families, the densification and the pruning. It is the largest single step this package has
   * taken and it is the one that produces what a player sees.
   * **48,189 with the surface**, measured 2026-09-20 the same way: 4,057 for a cloud's depth, the
   * truncated signed distance many views of it fuse into, the marching of that volume into a mesh
   * facing outwards, and the quadric-error decimation that brings the mesh to a budget — which is
   * what a game stands on, where the cloud only draws.
   * **55,331 with the handover to physics and navigation**, measured 2026-09-20 the same way:
   * 7,142, and **almost none of it is this package's own code** — cleaning a mesh for collision is
   * a hundred lines. What it is, is `@driftengine/physics`' convex decomposition arriving as a
   * peer, which a game fitting a prop pays for and one fitting only a room does not. It is the
   * first entry in this list where the number is mostly somebody else's.
   * **57,113 with the delighting**, measured 2026-09-20 the same way: 1,782 for the multi-view
   * gather, the Retinex separation over the mesh's own edges, the confidence, and the lit fixture
   * the whole thing is measured against. Small for what it does, because what it does is a few
   * hundred lines of classical method — the size of the *problem* is in the header, not in the code.
   * **58,690 with the regions**, measured 2026-09-20 the same way: 1,577 for the segmentation the
   * geometry answers with when no model is loaded, the prompt lattice, the lifting of masks onto
   * the mesh by vote, the join between a detector's boxes and a segmenter's masks, and the
   * proposals. A *proposal* is cheap on purpose — what it costs a consumer is a list of component
   * names, not a scene.
   * **66,373 with the assembly**, measured 2026-09-20 the same way: **7,683 bytes, and almost none
   * of it is this module** — `captureFile` is forty lines over `writeDrft`, and what arrives with
   * it is `@driftengine/drft`'s whole writer, which a consumer that only *reads* captures never
   * pays for. It is the second entry in this list where the number is mostly somebody else's, and
   * the same answer applies: one entry point, and a separate export path is the fix when somebody
   * minds.
   */
  'capture-only': 66373,
  'core-and-splats': 755540,
  /*
   * **Measured 2026-09-02, on the commit that published `@driftengine/terrain`.** Core alone is
   * 629,614 and this is the first number beside it, so the difference is the whole package: a
   * heightfield, its two queries, the patch builder with its seam matching, and the material
   * blend: **1,425 bytes, 1.4 KB.**
   *
   * The materials were the last 144 bytes of that, which is what a weight map costs when it is
   * *read* rather than sampled: the blend happens where the patch is built, so there is no
   * texture, no binding and no branch in a shader. Track D priced the alternative at 19.8 KB.
   *
   * **It is about a kilobyte, and that is the shape of the package rather than a small feature.**
   * Nothing here touches a shader or a backend — what comes back is `MeshData`, drawn by the pass
   * that already exists — so there is no pipeline, no bind group and no generated WGSL in it. The
   * three rows of Track D priced a capability by where it went; this one is the floor of that
   * scale, which is what a package of arithmetic costs.
   */
  'core-and-terrain': 739911,
  /**
   * **The 2D layer: 8.7 KB gzipped over core**, and it sits where Track D's price table says it
   * should.
   *
   * That table measured a capability by *where it went*: a uniform and a branch in `flatFrag` cost
   * 19.8 KB across sixteen fragment permutations, a shader of its own cost 4 KB for drawn decals
   * and 7.5 KB for screen-space reflection, and a package of pure arithmetic cost 1.4 KB for
   * terrain. This is a shader of its own on both backends plus the batch that feeds it, and it
   * lands between the two shader rows.
   *
   * **Raised 2026-09-03 from 636,832 by the retained interface tree**, +1,730 for a two-pass
   * layout engine, a hit test, a focus order and a pointer router. None of it touches the GPU: it
   * is arithmetic over an object graph, which is why it is a fifth of what the sprite pass costs.
   *
   * **8.7 rather than the 8.5 a fresh pair of measurements gives**, and the gap is core's rather
   * than this package's: `core-only`'s floor is 288 bytes behind what core measures today, because
   * 3.39.0 grew it by 0.05% and stayed inside the 3% tolerance. Every "over core" figure this file
   * feeds `packages.test.mjs` reads that much high for the same reason. Correcting it is a sweep
   * across seven package READMEs and belongs in its own commit; `docs/IMPROVEMENTS.md` carries it.
   *
   * **What a consumer of core pays for it is nothing**, which is the whole reason it is a package.
   * The sprite program is authored here and generated into WGSL here; core does not import it, and
   * the alternative — a `drawSprite` verb beside `fillPanel` — would have put a sampler and a
   * branch into the one shader every draw already uses.
   */
  'core-and-ui2d': 747470,
  'core-and-assets': 751527,
  /**
   * **What placing a sound in the world costs, published rather than hidden.**
   *
   * This fixture exists because the spatial layer is deliberately *not* reachable from
   * `MixConsole`: a `spatial()` method would be a static reference no bundler can shake, and every
   * consumer of the mix would carry an HRTF panner it never uses. Standalone factories keep the
   * promise this file makes, and the two numbers beside each other are the evidence: the listener,
   * the panner source and occlusion are **+1,479 bytes gzipped** over `core-and-audio`, and a
   * consumer that never imports them pays none of it.
   */
  'core-audio-spatial': 746887,
  /**
   * **The entity model with no engine at all: 632 bytes gzipped.**
   *
   * The number is what its independence is worth, and it is here rather than in prose because
   * `boundaries.test.mjs` asserts the import graph while this asserts the consequence. A consumer
   * who wants entities and no renderer pays 632 bytes.
   *
   * It is also how you can tell that tree-shaking reached only `driftscript`'s schema mechanism and
   * did not drag the whole language runtime along with it: that runtime is 3,284 bytes gzipped on
   * its own, and `migrate` alone is 406. A figure that jumped to four thousand would mean the
   * barrel had acquired a side effect the bundler could not drop.
   */
  /**
   * **The collision kernel with no engine at all.**
   *
   * The number is what the package's independence is worth, and it is the baseline every later
   * plan in Track B measures against: the solver, the joints and the queries all land here, and
   * each one's cost is this figure's growth rather than an estimate.
   *
   * **`core-only` is the other half of the claim and it must not move.** Ten source files left
   * core and every symbol in them is still re-exported, so a fall would mean the barrel had
   * stopped exporting something and a rise would mean the extraction dragged something in. What
   * has to stay true as Track B continues is that the *dynamics* never becomes reachable from
   * `createRenderer`, which is a growth in `core-only` and nothing else.
   */
  /*
   * **Raised 2026-08-26 to 5,832 by face planes and ordered face loops**, +549 and 10.4%.
   *
   * Almost all of it is `buildFaces` and `orderAroundNormal`: a dedupe by direction *and* offset,
   * a point-on-plane pass, an in-plane basis and a comparison sort. `boxShape`'s six planes and
   * twenty-four indices are two literal tables and cost almost nothing, which is the same shape as
   * every other entry in this file — declarations are nearly free, arithmetic is not.
   *
   * **What it buys** is the two things a solver cannot be built without: the reference face's
   * ordered loop that Sutherland-Hodgman clips against, and the tetrahedral decomposition an exact
   * inertia tensor is. One build-time addition, two consumers.
   */
  /*
   * **Raised 2026-08-26 to 17,872 by the whole of the dynamics**, +12,040 and 206% — and the step
   * is that large because the fixture changed as well as the package. It reached only the swept
   * kinematic path before; it now builds a `PhysicsWorld`, adds two bodies and steps it, so it
   * pulls in the tree, the pair sort, all three manifold cases, the constraint arrays, the solve,
   * the islands and the executor.
   *
   * **That is the number to compare later plans against**, and it is the point of measuring here
   * rather than estimating: joints, queries, the character controller, ragdolls, vehicles and cloth
   * each land in this package, and each one's cost is this figure's growth.
   *
   * **12 KB for a rigid body solver is small, and the reason is the same one the animation package
   * gives**: everything in it is arithmetic over typed arrays with no GPU code and no shader text,
   * and shader text is what makes core half a megabyte.
   */
  /*
   * **Raised again 2026-08-26 to 22,113 by six joint types**, +4,241 and 23.7%.
   *
   * They reach the fixture through `PhysicsWorld`, which holds a joint set whether or not a
   * consumer makes one, so this is what joints cost everybody who steps a world. About seven
   * hundred bytes per type, which is what "each type's rows unrolled rather than one configurable
   * 6-DOF joint" comes to — the alternative would be smaller here and dearer in the tick, which is
   * the trade the file states at its own definition.
   */
  /*
   * **Raised again 2026-08-26 to 23,717 by ray, shape and overlap queries**, +1,604 and 7.3% — and
   * they reach the fixture through `PhysicsWorld`, which exposes them as methods. Small for what
   * they are, because the slab test is arithmetic and the sweep reuses the manifold code the
   * solver already pulled in: only the ray-against-a-round-shape march is genuinely new.
   */
  /*
   * **Raised again 2026-08-26 to 27,019 by the character controller and ragdolls**, +3,302 and
   * 13.9% — and the fixture grew with the package deliberately, so this figure is now *the whole
   * of it* rather than the part a minimal world reaches.
   *
   * **They tree-shake for a consumer who does not use them**, which is why the fixture had to be
   * extended for them to appear here at all: `PhysicsWorld` never mentions either, so a game that
   * only steps bodies pays none of this. The figure is what the package costs, not what every
   * consumer of it costs, and the README says standalone for that reason.
   *
   * 3.3 KB for a sweep-slide-project controller with step-up, slope classification, coyote time and
   * a jump buffer, plus a ragdoll builder, is small because both are arithmetic over the queries and
   * the solver that were already here.
   */
  /*
   * **Raised again 2026-08-26 to 30,356 by the vehicle and the cloth**, +3,337 and 12.4%, with the
   * fixture extended to reach both. That completes Track B's row, and the package's whole arc is
   * worth reading in one place: 5,832 for shapes and the swept kinematic sweep, 17,872 with the
   * rigid-body solver, 22,113 with six joint types, 23,717 with queries, 27,019 with the character
   * controller and ragdolls, and 30,356 with vehicles and cloth.
   *
   * **Thirty kilobytes for the whole of it**, and the reason is the one the animation package's row
   * already gives: none of it is shader text, which is what makes core half a megabyte. Every piece
   * of this is arithmetic over typed arrays.
   */
  /*
   * **Raised 2026-08-27 to 31,747 by the seventh joint type**, +1,391 and 4.6%. Almost all of it is
   * `solveSixDof`: two loops of three rows each, with the free, limited and locked arms written out
   * rather than branched into a shared row, and a rotation matrix built from A's quaternion. Three
   * arrays on `JointSet` and their growth are the small half.
   *
   * **The one type costs 6% of a package holding seven**, which is what an unrolled solver looks
   * like when the thing it unrolls is a configuration rather than a shape: six of the seven share
   * `solvePoint`, `lockAboutTwoAxes` and `motorAndLimit` and gzip deduplicates the rest, where this
   * one shares only the arithmetic helpers. **What would make it wrong** is a consumer importing
   * `@driftengine/physics` for a character controller and paying for a joint type it never names —
   * and the answer then is the same as everywhere else here, a second entry point rather than a
   * smaller solver.
   */
  /*
   * **Raised 2026-08-27 to 37,239 by the cylinder primitive**, +5,492 and 17.3% — the largest step
   * this entry point has taken, and the honest way to read it is that a cylinder is a *second shape
   * representation* rather than a fourth constructor.
   *
   * Where it goes: `cylinderContact.ts` is about two thirds of it, and none of that code shares an
   * instruction with `manifold.ts`. A polytope pair is a separating-axis test over axes the shapes
   * already carry; a cylinder has a curved side that carries none, so the axis list is built
   * against the *other* shape — its faces, its edges crossed with the cylinder's axis, and two
   * directions per vertex — and the touching feature is then a cap disc, a side line or a rim
   * point, each clipped differently. `cylinder.ts`, `mass.ts`'s closed form, the ray quadratic and
   * the disc-aware bounds are the remaining third between them.
   *
   * **It buys the number `prismRoll.test.ts` had been recording as a wall.** The workaround was an
   * n-gon prism, a 64-point hull caps it at thirty-two sides, and a thirty-two-sided wheel of
   * radius 1 rolling at 6 m/s bobbed 16 mm that no side count could reduce. The cylinder bobs under
   * two. **What would make this wrong** is a consumer importing the package for a character
   * controller and paying five kilobytes for a shape they never build — and the answer is the same
   * second entry point every row here reaches for, not a smaller cylinder.
   */
  /*
   * **Raised 2026-08-27 to 40,438 by the static concave mesh collider and the two cloth rows**,
   * +3,199 and 8.6%. The mesh is most of it and the split is worth recording, because the shape of
   * the cost is the reuse the design was built around: `meshContact.ts` writes one triangle into a
   * scratch `ConvexShape` and hands it to `collideShapes`, so the separating-axis test, the
   * clipping, the round paths and the cylinder's own module are all exact against a mesh **without
   * a byte of new narrow phase**. What is here instead is the build — planes, an edge
   * classification and a `DynamicTree` fill — the candidate query, the interior-edge filter, and a
   * Möller-Trumbore ray.
   *
   * Two-way cloth coupling is nine lines and self-collision is the CSR adjacency build, the cell
   * hash and the pair sweep; both are off by default at runtime and neither is tree-shakeable,
   * since `ClothBody.step` names them.
   *
   * **What would make it wrong** is the same thing every row here names: a consumer importing the
   * package for a character controller and paying three kilobytes for a mesh collider they never
   * build. The answer is a second entry point, not a smaller narrow phase.
   *
   * **Raised 2026-08-29 to 42,057 by a `ColliderSet` that can change after it is built**, +1,619
   * and 4.0%. `add`, `remove`, `absorb`, `bytes` and the free list behind them, plus the growth
   * helper and the slot bookkeeping. **None of it is tree-shakeable** and that is not an oversight:
   * they are methods on a class every consumer of this package constructs, so a game that builds
   * its world once still carries them.
   *
   * **What it buys the consumer who pays it** is on record. A world that streams was rebuilding a
   * set at every region crossing, at about 2.1 µs a box — 41 ms at fifteen thousand colliders,
   * two and a half frames, every few seconds while somebody is driving. The alternative was one
   * set per region, which measured a 7.5x multiplier on every collision query in the game.
   * Measured by `npm run check:streaming`, a crossing on one mutable set costs 0.090 ms and its
   * queries are 1.25 to 1.31 times a freshly built set's.
   *
   * **What would make this one wrong** is a consumer who never streams, and the answer is the same
   * as the row above: a second entry point, not a smaller class.
   */
  /*
   * **Corrected 2026-09-02 and not by the change that commit made.** `physics-only` read 42,057
   * against a real 42,398 and `entities-only` 632 against 633, on a tree whose only edits are
   * under `packages/core`, `demo` and `scripts` — so neither package was touched and the drift
   * predates them. It sat inside the 3% band, which is where a stale number hides: nothing fails,
   * and the next commit to move one of these is told it is 3.4% off and blamed for all of it.
   * `drft-only` above was corrected in the same pass and for the same reason.
   */
  /*
   * **Raised 2026-09-03 by the heightfield collider**, 42,398 to 43,347 — 949 bytes for a shape
   * that carries no geometry, plus the branches in the contact and ray paths that take a triangle's
   * corners from a field instead of an index buffer.
   *
   * **What it buys is on the other side of the ledger and is much larger.** A 129-square field as a
   * mesh collider is more than five times the bytes of its heights in positions and indices alone,
   * before the tree over them; as a heightfield it is the heights. The 949 bytes are paid once by
   * every consumer of the package and the megabytes are saved by every consumer with terrain in it.
   *
   * It is not a second narrow phase, which is what keeps the number this small: `meshContact.ts`
   * still owns every contact rule and a field only changes where triangles come from.
   */
  /*
   * **Raised 2026-09-05 to 45,858, and only 726 of that is the worker pool's branch.**
   *
   * `main` at `d46768f6` measures **45,132** against this floor's 43,932: 2.7% of drift that
   * accumulated since the 2026-09-03 re-measurement and never tripped the 3% gate. That is the
   * failure this file's own header describes, hit again, and it is the second time `physics-only`
   * has been the entry it happened to.
   *
   * The branch's own 726 was attributed by A/B against `main` rather than subtracted from the
   * floor: the dial block `islandSolve.ts` reads instead of closing over `this`, the `parallelism`
   * record, `dispose`, `clampWorkers`, and the sentence a consumer gets for asking for workers
   * without passing a pool.
   *
   * **The pool itself is not in this figure and must never be.** It cost 2,629 bytes gzipped while
   * `PhysicsWorld` imported `createIslandPool` directly; the factory is named at the call site now,
   * and `size-gate.test.mjs` bundling this fixture is what keeps it out. A future edit that puts an
   * `instanceof WorkerPoolExecutor` back in `world.ts` will show up here as about 2.6 KB.
   */
  /*
   * **10,768 bytes, and most of it is the camera rather than the session.** The fixture imports
   * `@driftengine/core` for the `Camera` it supplies views to, because the smallest thing that can
   * *use* XR is the number a consumer deciding whether to add the import wants, and a package
   * measured with its own dependency removed would flatter itself.
   *
   * What a game that never enters a session pays is nothing at all: `@driftengine/xr` is a package
   * and `physics-only` and `core-only` are unmoved by it existing.
   */
  'xr-only': 10849,
  'physics-only': 46168,
  /**
   * **821 bytes, 2026-09-03, up from 633 when the rewind snapshot landed.**
   *
   * 188 bytes for `World.saveInto`/`loadFrom`, the allocator's and the store's halves of them, and
   * the two slot constructors. It is the price of a world that can be *put back*, paid by every
   * consumer of the package, and it buys the property Track J's whole apparatus rests on: an
   * entity handle means the same entity after a restore.
   *
   * The alternative was a snapshot living in `@driftengine/network`, which cannot work: the state
   * is behind `private` fields, and a class that hands out its internals so a neighbour can copy
   * them has published them to everyone.
   *
   * **Re-measured at 900 bytes on 2026-09-13: +79 for the licence banner.** Every barrel now opens
   * with a bang-form comment naming Apache-2.0, and that form survives minification by design —
   * it is what carries attribution into a consumer's shipped bundle rather than losing it at their
   * bundler. On a package this small the notice is 8.8% of the whole, which is the honest price of
   * the guarantee and not a regression to chase: the identical bytes are invisible against core.
   */
  'entities-only': 900,
  /**
   * **The networking package, 2026-09-03: 1,742 bytes gzipped, 5,181 raw, standing alone.**
   *
   * **The raw figure is the one that matters here.** Five kilobytes against core's 2.79 MB says
   * what the manifest claims: no renderer is in the module graph, so an authoritative host can run
   * this. `boundaries.test.mjs` already makes that argument about physics, and this is the second
   * package it applies to.
   *
   * A rewind ring, an input log and a snapshotter seam are arithmetic over typed arrays, which is
   * why the number is closer to `@driftengine/terrain`'s 1.4 KB than to the editor's 10.3 KB.
   *
   * **Re-measured at 2,331 bytes once the whole track landed**, from 1,742 when it held only the
   * rewind core. The 589 bytes are the wire format, three transports, both session drivers, the
   * fixed-point type and the conformance fixture — which is what it costs to make a package that
   * rewinds into one that networks. Still under a third of the editor's, because none of it draws.
   *
   * **Re-measured at 2,412 bytes on 2026-09-13: +81 for the licence banner**, the same line every
   * barrel now opens with. 3.5% here against 8.8% on `entities-only` for identical bytes, which is
   * the reason this gate is a percentage over measured floors rather than a byte ceiling: the cost
   * of a fixed-size notice is a property of how small the package is, not of the notice.
   */
  'network-only': 2412,
  /**
   * **The scene editor, 2026-09-03: 10,523 bytes, which is 10.28 KB gzipped, standing alone.**
   *
   * A standalone fixture and not a `core-and-*` one, which is the measurement worth recording: the
   * package imports `Gizmo` as a value and everything else from core as a type, so a bundle of it is
   * 31.8 KB raw against core's 2.79 MB — the renderer is not in it. `createRenderer`,
   * `WebGL2RenderingContext` and every shader string are absent from the output, checked rather than
   * assumed. An editor panel costs a game that opens one about ten kilobytes and costs a game that
   * does not exactly nothing.
   *
   * Most of it is arithmetic and reflection: a tree flatten, a schema walk, a snapshot round trip
   * and a `UiNode` builder. Nothing here touches a shader, so it adds no permutation to the sixteen
   * `flatFrag` already carries at 283.4 KB.
   */
  'editor-only': 10653,
  /*
   * **Measured 2026-08-26 on the commit that created the package**, Track P's CH-0: fifteen
   * elements and their atomic weights, the species registry, the species-by-element matrix,
   * mass-fraction compositions, the conservation reduction, and the sixty-eight-species standard
   * table.
   *
   * **Most of it is the table**, which is the thing to watch. Sixty-eight object literals of
   * formulas and four numbers each is a repetitive corpus and gzip is good at those — 9,202 raw to
   * 2,807 — but it is still the largest single item here, and it is the one a consumer might
   * reasonably want to shake out. The fixture reaches it deliberately for that reason: the day it
   * needs its own entry point, this number is where that shows.
   *
   * The baseline for the rest of Track P. Parcels, the reaction network, the atmosphere field and
   * the transport all land in this package, so each later phase's cost is this figure's growth
   * rather than an estimate.
   */
  /*
   * **Raised 2026-08-26 to 4,836 by CH-1**, +2,029 and 72% — the largest proportional step this
   * entry point will ever take, because it is the second thing in an empty package.
   *
   * What it buys is the state variable: an enthalpy curve per substance whose flat regions are the
   * phase changes, the two binary searches that invert it, a substance registry that builds a curve
   * once and shares it across every parcel made from it, `boilingPoint` against pressure, and the
   * parcel store itself. None of it is a table — the standard species set is still the largest
   * single item here — so this is 2 KB of actual arithmetic and bookkeeping.
   */
  /*
   * **Raised again 2026-08-26 to 6,166 by CH-2's depth stack**, +1,330 and 27.5%: the shell
   * geometry for three shapes, the one-dimensional conduction with its harmonic mean and sub-step
   * estimate, and the shell accessors on the store. The parcel enthalpy column also became strided
   * by `MAX_SHELLS`, which costs runtime memory and not a byte of payload.
   */
  /*
   * **Raised again 2026-08-26 to 9,180 by CH-3's reaction network**, +3,014 and 48.9%: the reaction
   * types and registry with its element-balance check and Hess's-law derivation, the rate
   * tabulation, the substep-and-clamp solver, and the per-shell composition storage on the store.
   *
   * The rate *tables* are not in this figure and never will be — a table is built at registration
   * from an `A` and an `Ea`, so it costs runtime memory (8 KB per reaction at 1,024 knots) and not
   * a byte of payload. That is the whole reason tabulating was affordable.
   */
  /*
   * **Raised again 2026-08-26 to 12,542 by CH-4's atmosphere**, +3,362 and 36.6%: the sparse chunk
   * store and its addressing, the ambient far field, the derived reads a game acts on, the
   * conservative flux transport with buoyancy and connectivity, and the shared reaction localiser.
   *
   * The gas-phase combustion adds almost nothing, because it is **not a second solver** — a cell is
   * handed to the same `reactShell` a shell is. That reuse is worth more than the bytes: two
   * implementations would be two things to keep in step, and the second would be found wrong on
   * the day a reaction behaved differently in the air than in the wood beside it.
   */
  /*
   * **Raised again 2026-08-26 to 14,325 by CH-5's transport**, +1,783 and 14.2%: radiation with its
   * view factors and source ranges, the convective coefficient, the contact set, and the world that
   * runs §13's tick and moves gas between a parcel and the air.
   *
   * The smallest step since CH-0, and the reason is that most of it is arithmetic over things that
   * already existed. Contact conduction is the harmonic mean the shells already use; the gas
   * exchange is a relaxation toward a concentration the field already reports.
   */
  /*
   * **Lowered 2026-08-26 to 14,094 by CH-6's opening reversal**, −231 — the first time this entry
   * point has gone *down*, and worth the note for why.
   *
   * It added reaction gates, a phase-change helper and an enthalpy term in the solver's sub-step
   * estimate. It deleted the whole of `enthalpy.ts`: a 256-knot curve per substance, its builder
   * walking segments and plateaus, and two binary searches to invert it. Replacing a table with the
   * closed form `ΔT = (−A + √(A² + 2Bh)) / B` is smaller as well as more correct, which is not the
   * usual direction for a fix.
   */
  /*
   * **Raised 2026-08-26 to 15,264 by CH-6's criteria**, +1,170 and 8.3%: the five ignition
   * criteria, the four extinction ones, the smoulder test, `ignitionProgress`, and the event buffer
   * with its twenty-one kinds.
   *
   * Small for what it buys, and the reason is that most of it is comparisons. Ignition is five
   * numbers against five thresholds; what made it hard was deciding *which* five and at what
   * resolution to read them, and neither of those costs bytes.
   */
  /*
   * **Raised again 2026-08-26 to 15,508 by the diffusion kinetics kind**, +244: an Arrhenius rate
   * capped by a transport ceiling, combined as a series resistance the way a shell boundary already
   * combines two conductivities. What it buys is out of proportion to what it costs — char that
   * glows for an hour rather than vanishing in a minute, and an ember that brightens when you blow
   * on it.
   */
  /*
   * **Raised again 2026-08-26 to 15,627 by CH-7's `installLibrary`**, +119 — the seam a substance
   * family is installed through, and the only part of CH-7 that lands in the root entry point at
   * all. Everything else it built is behind `library/*`, which is the whole design of the phase.
   */
  /*
   * **Raised again 2026-08-26 to 16,555 by CH-8's readings**, +928 and 5.9%. Not the binding — that
   * lands in `@driftengine/script` and costs this entry point nothing — but the quantities the
   * binding needed and this package did not have: a moisture content on a dry basis, a heat release
   * rate tracked across the reaction step, a phase over a mixture, a char depth, a structural
   * integrity, `wet`/`dry`/`mix`, and on the field a relative humidity with its own tabulated
   * saturation curve.
   *
   * Every one is a real quantity rather than a passthrough, which is why they are here: `host.ts`
   * says a binding is a lookup, and a lookup that computed a dry-basis moisture would be the engine
   * growing a function in the wrong package.
   */
  /*
   * **Raised again 2026-08-26 to 16,809 by CH-9's readings**, +254 — the appearance model on a
   * substance, `volumeShareOf` and `appearanceOf` on a parcel, and `aerosolAt`, `riseAt` and a soot
   * species on the field. `present/` itself is a separate entry point below and costs this one
   * nothing, which is the whole reason it is one.
   */
  /*
   * **Raised again 2026-08-27 to 18,099 by CH-10**, +1,005 and 5.9%: the four level-of-detail tiers
   * with their conserving fold, sleeping with its wake triggers and its round-robin scan, the
   * cadence accrual, and `fingerprintChemistry`.
   *
   * The fold is most of it and it is arithmetic rather than declarations — a proportional
   * redistribution over shells in fractional coordinates, plus a per-shell-count conduction geometry
   * precomputed at registration so `Math.cbrt` stays off the tick. What it buys is that a thousand
   * cold stones cost a bounded scan and that two runs of a world are *asserted* to agree rather than
   * believed to.
   */
  /*
   * **Raised again 2026-08-27 to 18,186 by condensed tar**, +87 and half a percent — and almost none
   * of it is the capability. Twenty-five bytes are the reaction gate learning to taper at its upper
   * end as well as its lower, and the rest is `aerosolAt` summing the liquid-phase species a field
   * carries instead of reading one slot. The species, the dew point and the two reactions are all in
   * `library/organic`, which is where a consumer who does not burn wood declines to pay for them.
   */
  /*
   * **Raised again 2026-08-27 to 18,416, +230**, by the field walking its chunks in **key order**
   * rather than in creation order: a parallel key array, a sorted index list with a binary-search
   * insert, and a sweep in rounds so a chunk created mid-sweep is still swept once and at its
   * canonical position.
   *
   * A quarter of a kilobyte for a determinism fix, and it is the whole reason `fingerprintChemistry`
   * exists: two logs in different chunks, spawned the other way round, left 1,202 cells differing in
   * their last bit after sixty ticks, because every `+=` into the shared deltas landed in a
   * different sequence. None of it reaches the library fixtures, which do not touch the field —
   * every one of the seven measured identical across this change, which is those fixtures saying
   * what they are for.
   */
  'chemistry-only': 18517,

  /*
   * **`present/`, added 2026-08-26 by CH-9, at 19,163 — 2,354 over the model alone.**
   *
   * What it buys is the whole of `§17`: Planck's law tabulated into a glow, the plume correlation
   * into a flame height, the soot-to-aerosol ratio into a smoke colour, char into an albedo, surface
   * water into a roughness, mass into a scale, three audio scalars, and `installChemistry` with its
   * exact matching and its report of what it could not match.
   *
   * **Its own entry point because it is the first thing a consumer without a renderer declines.**
   * A headless server simulating fire wants none of it, and the number here is what that consumer
   * saves. Nothing in it names a core type, so the split costs nothing to maintain.
   */
  'chemistry-present': 20901,

  /*
   * **CH-7's eight fixtures, and they exist to make one sentence a number.**
   *
   * `§2` applies the payload rule to *data*: "a consumer who defines three substances of their own
   * imports none of the libraries and pays for none of them". That is a claim, and a claim about
   * payload that nobody measures becomes wrong the same way a document does.
   *
   * So `chemistry-library-none` **is** that consumer — three hand-written substances and one
   * reaction — and each family fixture does identical work with a family installed instead. The
   * difference is what a family costs, measured rather than estimated:
   *
   * | Family | Cost over `none` | What is in it |
   * |---|---|---|
   * | metal | 637 | 4 reactions, 5 substances, no new species |
   * | mineral | 707 | 2 reactions, 6 substances |
   * | polymer | 736 | 6 reactions, 6 substances |
   * | biological | 853 | 4 cardinal reactions, 4 substances |
   * | fuel | 898 | 12 reactions, 5 substances, **6 new species** |
   * | food | 1,022 | 7 reactions, 7 substances, 1 new species |
   * | organic | 1,153 | 9 reactions, 6 substances, 2 new species |
   *
   * **Re-measured 2026-08-27 after condensed tar**, and it is the clearest reading this table has
   * given. Six of the seven rose by 20 to 25 bytes — the gate taper and the aerosol sum, which every
   * fixture reaches through the solver — and **organic rose by 114**, to 1,279, because the species,
   * the dew point and the condensation pair are its and only its. A consumer burning polystyrene
   * pays twenty bytes for a mechanism they do not use; a consumer burning oak pays for wood smoke.
   * That is the split working, measured on the first capability added since the table was built.
   *
   * | Family | Cost over `none` |
   * |---|---|
   * | metal | 625 |
   * | mineral | 703 |
   * | polymer | 734 |
   * | biological | 845 |
   * | fuel | 926 |
   * | food | 1,062 |
   * | organic | 1,279 |
   *
   * **Re-measured 2026-08-27 after CH-10.** Every row rose by about 1,000 bytes — tiers, sleeping and
   * the fingerprint, which these fixtures reach through the parcel store — and the *differences* held
   * again: organic is 1,165 against 1,156. Two re-measurements now where the baseline moved and the
   * family costs did not, which is what a table of differences is for.
   *
   * **Re-measured 2026-08-26 after CH-9**, and the differences moved for the first time: organic is
   * now 1,156 against 958, because a family now carries an appearance for every substance in it —
   * three colours and a soot yield apiece. That is a real cost of a real capability and it lands
   * where it should, on the families rather than on the model.
   *
   * **Re-measured 2026-08-26 after CH-8.** Every row rose by about 790 bytes — the readings the
   * `drift/chemistry` binding needed, which these fixtures reach through the parcel store — and the
   * *differences* barely moved: organic went from 953 to 958. That is the number this table is
   * about, and it holding steady while the baseline moved is the table working.
   *
   * **Six hundred bytes to a kilobyte and a bit per family**, and the seven together would be about
   * six. That is the number the split was worth: a consumer who wants a campfire imports `organic`
   * and pays 1,153 bytes rather than 6 KB for thirty-three substances they will never spawn.
   *
   * These fixtures deliberately do **not** reach the atmosphere field, the world or radiation, which
   * is why they sit below `chemistry-only` rather than above it. They measure a substance family and
   * the model surface it needs, not the whole engine — and comparing them to each other is what they
   * are for.
   */
  'chemistry-library-none': 11733,
  'chemistry-library-organic': 13018,
  'chemistry-library-food': 12798,
  'chemistry-library-fuel': 12663,
  'chemistry-library-polymer': 12471,
  'chemistry-library-mineral': 12440,
  'chemistry-library-metal': 12361,
  'chemistry-library-biological': 12581,
};

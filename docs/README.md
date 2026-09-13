# The documents, and the rules that keep them true

One job each. If two files would answer the same question, one of them is wrong.

| Document                             | Its one job                                                                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [`CAPABILITIES.md`](CAPABILITIES.md) | What the engine does and does not do. **The single map.** Anything else listing gaps is either older than this or is a plan for closing one. |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The package split, the boundaries, and the rules every package obeys. Describes a target the tree has not reached, and says so.              |
| [`ROADMAP.md`](ROADMAP.md)           | The order of work and the reasoning for that order, with stop conditions.                                                                    |
| [`FORMAT.md`](FORMAT.md)             | The `.drft` container specification.                                                                                                         |
| [`HANDBOOK.md`](HANDBOOK.md)         | Using it: commands, flags, and what to do when an import comes out wrong.                                                                    |
| [`RENDERING.md`](RENDERING.md)       | How the picture is made, and for each effect the version that looked plausible and was wrong.                                                |
| [`IMPROVEMENTS.md`](IMPROVEMENTS.md) | Findings that are measured and not yet taken, so none is rediscovered a third time.                                                          |
| [`PORTING.md`](PORTING.md)           | Upgrading a consumer across a major release.                                                                                                 |
| [`SHIPPING.md`](SHIPPING.md)         | Turning a consumer's web build into an installed application: the order, the three files it adds, and what it has to own for itself.         |

---

## The rule that makes this set different from the one it replaced

**A claim that can drift must be asserted somewhere that fails.**

The previous set fell a major version behind without anything noticing, because every claim in it
was prose. A document quoted a line count and was 556 short within a week. A document called a
sampler budget an absolute gate months after one backend stopped having it. A rule about proper
nouns was enforced by memory and was broken in thirty-four places.

So `scripts/docs.test.mjs` runs on every push and holds five things:

1. **Every document named anywhere in the repository exists** — as a link, or as a bare mention in
   a source comment, which is how `src/asset/*.ts` cites the format.
2. **Every capability `CAPABILITIES.md` calls absent is still absent.** Each row names a sentinel
   symbol. The commit that builds spot lights is the commit that must correct the map, because the
   suite is red until it does.
3. **The renderer line counts the map quotes are the real ones.**
4. **`README.md` names no gap the map does not**, so the public list and the internal one cannot
   drift apart.
5. **No proper noun from a game's world appears outside `private/`.**

`npm run docs:check` runs them alone. `npm run plans:index` regenerates the plan listing.

## The three filing rules

**Archived files are frozen.** They get one header on the way in — what they were, what replaced
them, what remains true, what is wrong — and are never edited again. The link checker exempts them
for that reason: a reference inside a file nobody may edit cannot be repaired.

**Nothing is deleted before it is mined.** A measurement that cost an investigation moves to a
living document before its original is archived. The 2026-08-20 restructure expected four such
findings and carried out six.

**A document says when it describes something that does not exist.** `ARCHITECTURE.md` opens by
saying the repository is still one package. A document quietly describing a structure the tree does
not have is the failure all of the above exists to prevent.

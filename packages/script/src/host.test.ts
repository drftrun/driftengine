import { describe, expect, it } from 'vitest';

import { NavSearch, buildNavGraph } from '@driftengine/core';
import { compileDriftScript, singleFileHost } from 'driftscript/compiler';
import { createRegistry, defineTarget, loadModule, providesModule } from 'driftscript';
import {
  ENGINE_MODULES,
  bindModule,
  engineImplementations,
  engineRegistry,
  engineTarget,
} from './host.ts';

/**
 * Everything this engine binds, checked as a set rather than one capability at a time.
 *
 * The per-module tests assert behaviour. These assert the *properties every binding must have* —
 * which is what stops the eleventh one, added in a hurry when a track lands, from being the one
 * that describes a capability nothing implements or claims determinism it does not have.
 */
const registry = engineRegistry();
const target = engineTarget();
/*
 * Built with every service supplied, because a module whose service is absent is correctly absent
 * from the map — which would make the completeness checks below pass by having less to check.
 */
const implementations = engineImplementations({
  ai: { agents: { get: () => undefined } },
  audio: { graph: {} as never, registry: {} as never },
  clocks: { fixedDelta: () => 0, frameDelta: () => 0, wallDelta: () => 0, elapsed: () => 0 },
  entities: { components: new Map(), prefabs: new Map() },
  /* Enough of a world for the map to be built; nothing here is called. */
  chemistry: {
    world: {} as never,
    parcels: {} as never,
    air: {} as never,
    substances: {} as never,
    species: {} as never,
  },
  /* A real graph rather than a cast, because a `NavSearch` sizes its scratch from one and there is
     no cheaper way to have a valid map than the two smallest nodes there can be. */
  navigation: (() => {
    const graph = buildNavGraph([0, 0, 0, 1, 0, 0], [{ from: 0, to: 1 }]);
    return { graph, search: new NavSearch(graph) };
  })(),
  behavior: { context: () => undefined },
  /* Outside a session, which is the ordinary state and the one every capability has an answer for. */
  xr: {
    support: null,
    headPosition: null,
    controller: () => null,
    hand: () => null,
  },
});

describe('every binding, as a set', () => {
  it('describes a capability for every module the target provides', () => {
    for (const module of ENGINE_MODULES) {
      expect(registry.forModule(module).length, `${module} provides nothing`).toBeGreaterThan(0);
    }
  });

  it('provides an implementation for every capability it describes', () => {
    /* The registry *names* an implementation rather than holding one — R2 — so nothing mechanically
       ties a definition to the function it describes. This is that tie, over the whole set. */
    for (const capability of registry.all()) {
      if (capability.module.startsWith('std/')) continue;
      const module = implementations[capability.module] as Record<string, unknown> | undefined;
      expect(module, `${capability.module} has no implementation map`).toBeDefined();
      expect(
        module?.[capability.name],
        `${capability.module}.${capability.name} is described but not implemented`,
      ).toBeTypeOf('function');
    }
  });

  it('implements nothing it does not describe', () => {
    /* The other direction, which is the one that rots: a function left in an implementation map
       after its definition was removed is dead code a script cannot reach and nobody deletes. */
    for (const [module, functions] of Object.entries(implementations)) {
      if (module.startsWith('std/')) continue;
      for (const name of Object.keys(functions as Record<string, unknown>)) {
        expect(
          registry.get(module, name),
          `${module}.${name} is implemented but not described`,
        ).toBeDefined();
      }
    }
  });

  it('gives every capability a signature that matches its parameters', () => {
    for (const capability of registry.all()) {
      for (const param of capability.params) {
        expect(
          capability.signature,
          `${capability.module}.${capability.name} omits ${param.name} from its signature`,
        ).toContain(param.name);
      }
      expect(capability.signature).toContain(capability.returns);
    }
  });

  it('gives every capability a sentence of documentation, which hover shows', () => {
    for (const capability of registry.all()) {
      expect(
        capability.doc.length,
        `${capability.module}.${capability.name} has no documentation`,
      ).toBeGreaterThan(10);
    }
  });

  it('names a type for every parameter and return, so a call can be checked', () => {
    /*
     * **`float` joined this list when the language reached 1.5.0**, and it is a different kind of
     * name from the twelve beside it: it is not a width but a *promise about one*, meaning `f32` or
     * `f64`, the same one throughout a call, fixed by the first argument that has a width. Every
     * `std/math` and `std/time` signature is written that way now, so `math.clamp(v, 0, 1)` works
     * whether `v` is single or double precision.
     *
     * **`Entity` joined it at 1.6.0**, and unlike `float` it is a type the language always had and
     * could not *name* in a capability signature until then — which is why every entity parameter
     * and every handle a `drift/ecs` capability returns said `f64` with a paragraph beside it
     * explaining that the width was the point. It is not an alias: a handle is assignable *to* an
     * `f64` and not from one, so a number a script computed cannot arrive where a handle is wanted.
     *
     * This test is where the pin's seam shows, which is what `AGENTS.md` says it is for: the
     * language grew a type name and the assertion went red on the next install rather than a
     * script author meeting it.
     */
    const known = new Set([
      'void',
      'bool',
      'String',
      'Entity',
      'i8',
      'i16',
      'i32',
      'i64',
      'u8',
      'u16',
      'u32',
      'u64',
      'f32',
      'f64',
      'float',
      ...registry.types().map((t) => t.name),
    ]);
    for (const capability of registry.all()) {
      for (const named of [...capability.params.map((p) => p.type), capability.returns]) {
        const base = named.endsWith('?') ? named.slice(0, -1) : named;
        expect(known.has(base), `${capability.module}.${capability.name} names \`${base}\``).toBe(
          true,
        );
      }
    }
  });

  it('claims determinism only where nothing leaves the simulation boundary', () => {
    /* `defineCapability` already refuses a lie at registration, so this asserts the *set* has none
       — which is the thing a new binding added in a hurry gets wrong. */
    const outside = new Set([
      'audio.write',
      'scene.write',
      'animation.write',
      'clock.read',
      'host',
      'ai',
    ]);
    for (const capability of registry.all()) {
      if (!capability.deterministic) continue;
      for (const effect of capability.effects) {
        expect(
          outside.has(effect),
          `${capability.module}.${capability.name} is deterministic and has ${effect}`,
        ).toBe(false);
      }
    }
  });

  it('marks every clock a script can read with `clock.read`, including the fixed one', () => {
    /*
     * The inverse of the test above, and it catches what that one cannot: a fifth clock added to
     * `drift/time` with its effects left at `pure`. That capability would be *legal* to register
     * and would pass the determinism sweep, because a pure capability declares nothing outside the
     * boundary — and a `@deterministic` function could then read a clock.
     */
    const clocks = registry.forModule('drift/time');
    expect(clocks.length).toBeGreaterThanOrEqual(4);
    for (const clock of clocks) {
      expect(clock.effects, `drift/time.${clock.name}`).toContain('clock.read');
      expect(clock.deterministic, `drift/time.${clock.name}`).toBe(false);
    }
  });

  it('provides the standard library, which belongs to the language rather than this host', () => {
    expect(registry.forModule('std/math').length).toBeGreaterThan(0);
    expect(registry.forModule('std/time').length).toBeGreaterThan(0);
    /* And a target does not *list* it — a standard library a target could decline is not standard. */
    expect(ENGINE_MODULES).not.toContain('std/math');
    expect(providesModule(target, 'std/math')).toBe(true);
  });

  /**
   * Every module this host binds is one the language specifies.
   *
   * **This used to assert the opposite thing, and the change is DriftScript 1.7.0's.** The language
   * held a list of *unshipped* module names and this test checked the two agreed in both
   * directions: nothing bound may be called unshipped, nothing unshipped may be provided. That made
   * a track landing here a red test *there* — the engine could not bind a module until the language
   * cut a release removing the name, and the name was one host's roadmap living in a package that
   * may not know a host exists.
   *
   * `SPECIFIED_MODULES` replaced it with a catalogue of every surface the language designed, built
   * or not, which never shrinks. Read against that, the claim worth making is the one that stays
   * true as tracks land: a module this host binds should be a surface somebody specified, and a
   * name outside the catalogue is this host inventing one. The other direction is gone with the
   * list, and the linker asks the registry for it now instead.
   */
  it('binds only modules the language specifies', async () => {
    const { SPECIFIED_MODULES } = await import('driftscript/compiler');
    for (const module of ENGINE_MODULES) {
      expect(
        SPECIFIED_MODULES,
        `${module} is bound but the language specifies no such surface`,
      ).toContain(module);
    }
  });

  /**
   * **The list is empty, and emptying it is the last thing Track J did.**
   *
   * `drift/ai` was here until Track O bound it, `drift/ecs` and `drift/prefab` until Track M, and
   * `drift/editor` until Track K — each time the commit that landed the binding was red under this
   * test until the sentence changed, which is the mechanism rather than a memory. Track J removed
   * the final two.
   *
   * **It is kept as an empty list rather than deleted**, because the thing it asserts is still
   * worth asserting on the day somebody adds a module name to `ENGINE_MODULES` speculatively: the
   * check costs nothing and the next unshipped surface has somewhere to be written down. The two
   * surfaces the language specifies and this host still does not describe are `drift/xr`, which
   * waits on Track I, and `drift/render`; both are asserted below rather than here, because neither
   * is claimed and the question for them is a different one.
   *
   * **`drift/render` left that pair on 2026-09-04**, and why it was still in it is worth more than
   * the binding. Nothing was blocking it. The refusal named Track D, Track D completed on
   * 2026-09-03 with refraction, and the surface then sat refused for five releases because no
   * document re-read the mapping when the track closed. The sentence below had already been
   * corrected to say it waits on a row of its own; `CAPABILITIES.md` still named the track.
   */
  it('claims nothing whose track has not shipped', () => {
    const unshippedModules: readonly string[] = [];
    for (const unshipped of unshippedModules) {
      expect(ENGINE_MODULES, `${unshipped} is claimed`).not.toContain(unshipped);
      expect(providesModule(target, unshipped)).toBe(false);
    }
    expect(unshippedModules).toEqual([]);
  });

  /**
   * **And `drift/network` and `drift/rollback` left it on 2026-09-03**, which is the mechanism
   * working a fourth time.
   *
   * Both are bound together because they are one track and one mechanism: a rewind loop is what
   * lockstep corrects a guess with and what a predicting client corrects a mispredicted world with,
   * so a session and the rewind under it arrive at the same moment or neither is usable.
   */
  it('claims drift/network and drift/rollback, now that Track J has bound them', () => {
    expect(ENGINE_MODULES).toContain('drift/network');
    expect(ENGINE_MODULES).toContain('drift/rollback');
    expect(providesModule(target, 'drift/network')).toBe(true);
    expect(providesModule(target, 'drift/rollback')).toBe(true);
  });

  /**
   * **`drift/xr` is bound, and it was the last one.** Track I took it on 2026-09-05, and this file
   * asserted its absence until then, which is the mechanism working for the fifth time: the commit
   * that bound it was red here until this test was rewritten.
   *
   * **Nothing here is deterministic, and that is the property rather than a limitation.** A head
   * moves because a person moved it and a controller reports where a camera saw it, so a
   * `@deterministic` system reading either would take the other branch on replay and a stored run
   * would stop meaning anything. `drift/ui` settled the same question for a pointer.
   */
  it('binds drift/xr, and none of it is deterministic', () => {
    expect(ENGINE_MODULES).toContain('drift/xr');
    expect(providesModule(target, 'drift/xr')).toBe(true);

    const xr = [...registry.forModule('drift/xr')];
    expect(xr.map((c) => c.name).sort()).toEqual([
      'headX',
      'headY',
      'headZ',
      'holding',
      'jointX',
      'jointY',
      'jointZ',
      'pinching',
      'presenting',
      'squeeze',
      'supported',
      'trigger',
    ]);
    for (const capability of xr) {
      expect(capability.deterministic, `${capability.name} claims determinism`).toBe(false);
      expect(['scene.read', 'input.read']).toContain(capability.effects[0]);
    }
  });

  /**
   * **No script may read an eye's matrices**, which is the refusal this surface is most able to get
   * wrong.
   *
   * A projection is a fact about somebody's optics and a view is a fact about where their head is
   * in a room the script has never seen, so handing either over would be `drift/render`'s refused
   * dial read wearing different clothes: a machine-dependent number registered where a script could
   * compare two runs with it. Drawing the eyes is the host's, because the host owns the renderer.
   */
  it('hands a script no matrix and no view', () => {
    for (const capability of registry.forModule('drift/xr')) {
      expect(capability.name).not.toMatch(/matrix|projection|view|eye/i);
      /* Scalars and booleans only: nothing here returns a structure a matrix could hide in. */
      expect(['bool', 'f32']).toContain(capability.returns);
    }
  });

  /**
   * **`drift/render` is bound, and it binds the dials rather than the profile.**
   *
   * `RenderQuality` has fifty fields and none of them are reachable from a script. What is
   * here is the seven per-frame presentation dials — the split `renderQuality.ts` already argues for
   * depth of field, where a ceiling says what a pass may cost and a dial says how much of it this
   * frame takes. A profile is chosen once from what a device can afford and is clamped against what
   * the adapter reports; a dial is what a game drives, and only the second is a script's business.
   *
   * **The effect is the assertion.** `scene.write` is outside `DETERMINISTIC_EFFECTS`, so
   * `defineCapability` throws on any of these claiming determinism — which is the property rather
   * than a limitation: a `@deterministic` system may not dim the screen.
   */
  it('claims drift/render, and none of it is deterministic', () => {
    expect(ENGINE_MODULES).toContain('drift/render');
    expect(providesModule(target, 'drift/render')).toBe(true);

    const dials = registry.forModule('drift/render');
    expect([...dials].map((c) => c.name).sort()).toEqual([
      'bloom',
      'exposure',
      'focus',
      'medium',
      'motionBlur',
      'speedBlur',
      'veil',
    ]);
    for (const dial of dials) {
      expect(dial.effects, `${dial.name} declares more than the view`).toEqual(['scene.write']);
      expect(dial.deterministic, `${dial.name} claims determinism`).toBe(false);
    }
  });

  /**
   * **The two AI bridges reach a script through `drift/ai`, and not one of them duplicates
   * `drift/navigation`.**
   *
   * That module binds twelve capabilities and every one takes a `NavPath` or a `NavGraph`. What a
   * script could not do was aim any of them at an `Agent`, which is a session keyed by an id the
   * consumer registered rather than an entity. `path` is the join: one capability makes all twelve
   * work on an agent instead of any being bound a second time.
   *
   * **Every effect is inherited from a decision already made**, which is the assertion here.
   * `navigation.write` and `navigation.read` are both inside `DETERMINISTIC_EFFECTS` — 1.12.0
   * admitted the write on the argument that a route is a function of the graph and two endpoints
   * with ties broken on the node index — and `network.read` is inside on the narrowing that a role
   * cannot vary with packet timing. So `defineCapability` would throw on any of these claiming
   * determinism if the effect were wrong, and all four claim it.
   */
  it('binds the two AI bridges to drift/ai, on effects it already had', () => {
    const ai = [...registry.forModule('drift/ai')];
    expect(ai.map((c) => c.name).sort()).toEqual([
      'agent',
      'consider',
      'deciding',
      'degraded',
      'intentId',
      'navigate',
      'path',
      'reachable',
      'wake',
    ]);

    const byName = new Map(ai.map((c) => [c.name, c]));
    expect(byName.get('reachable')?.effects).toEqual(['navigation.read']);
    expect(byName.get('navigate')?.effects).toEqual(['navigation.write']);
    expect(byName.get('path')?.effects).toEqual(['navigation.read']);
    expect(byName.get('deciding')?.effects).toEqual(['network.read']);
    for (const name of ['reachable', 'navigate', 'path', 'deciding']) {
      expect(byName.get(name)?.deterministic, `${name} is not deterministic`).toBe(true);
    }
  });

  /**
   * **`reachable` asks and `navigate` answers, and the pair is the point.**
   *
   * `drift/navigation.route` computes *and writes*, so a script scoring a destination before
   * committing to it had to route and then undo — a write a `@deterministic` system would have had
   * to make and take back. The guard exposed as a question is what the navigation bridge adds that
   * nothing else could.
   */
  it('offers the navigation guard as a read as well as an act', () => {
    const byName = new Map([...registry.forModule('drift/ai')].map((c) => [c.name, c]));
    expect(byName.get('reachable')?.returns).toBe('bool');
    expect(byName.get('navigate')?.returns).toBe('bool');
    expect(byName.get('reachable')?.effects).not.toContain('navigation.write');
  });

  /**
   * **Nothing hands a script the tools or arguments a model chose**, and that is the refusal this
   * row is most able to get wrong.
   *
   * `intentId` is bound and its own comment says why it is safe: the current intent is state the
   * simulation owns, because the floor put it there and a replay recomputes it. A capability
   * returning the model's chosen action would let a `@deterministic` system branch on a provider's
   * answer, and the replay would take the other branch.
   */
  it('exposes no model-authored action to a script', () => {
    for (const capability of registry.forModule('drift/ai')) {
      expect(capability.returns, `${capability.name} answers a structure`).not.toContain('[');
      expect(capability.name).not.toMatch(/tool|args|argument/i);
    }
  });

  /**
   * Nothing in `drift/render` reads a dial back, and that is a decision rather than an omission.
   *
   * Every one of these is clamped against the ceiling the host set — `setBloom` does nothing at all
   * when the profile's `bloom` is 0, because the chain is never built — so a read would answer a
   * fact about the machine wearing the costume of a fact about the frame. The language wrote this
   * argument once already, for `network.read` and a confirmed-input watermark.
   */
  it('offers no way to read a dial back', () => {
    for (const capability of registry.forModule('drift/render')) {
      expect(capability.returns, `${capability.name} answers something`).toBe('void');
    }
  });

  /*
   * **And `drift/editor` left that list on 2026-09-03**, which is the mechanism working a third
   * time: the commit that bound it was red here until this test existed. Track K stopped at the
   * gizmo, where its own risk row said to stop, so the module is bound for the half that ships and
   * the inspector's half of the surface is simply not there rather than stubbed.
   */
  it('claims drift/editor, now that Track K has bound the gizmo', () => {
    expect(ENGINE_MODULES).toContain('drift/editor');
    expect(providesModule(target, 'drift/editor')).toBe(true);
  });

  it('claims drift/ai, now that Track O has bound it', () => {
    expect(ENGINE_MODULES).toContain('drift/ai');
    expect(providesModule(target, 'drift/ai')).toBe(true);
  });

  it('claims drift/ui and drift/2d, now that Track F has bound them', () => {
    for (const shipped of ['drift/ui', 'drift/2d']) {
      expect(ENGINE_MODULES).toContain(shipped);
      expect(providesModule(target, shipped)).toBe(true);
    }
  });
});

/**
 * A binding may not tolerate a method the engine does not have.
 *
 * `drift/camera` described `lookAt` and `setPosition`; `CinematicCamera` has neither. The
 * implementation reached them through `(camera as unknown as { lookAt?: … }).lookAt?.(…)`, so a
 * script calling it compiled, linked, ran, and did **nothing** — the silent no-op this repository
 * forbids, arriving through a binding written from memory of what a camera ought to have.
 *
 * The completeness tests above could not see it: the closure existed and was a function. What makes
 * it visible is the *shape of the call*. An optional call inside a binding is a binding that cannot
 * fail when the engine renames a method, which is precisely the property a binding must not have.
 */
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

describe('bindings call the engine directly', () => {
  const sources = import.meta.glob('./bindings/*.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  });

  const files = Object.entries(sources).filter(([path]) => !path.endsWith('.test.ts'));

  it('finds the binding files, so an empty glob is a failure rather than a pass', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it.each(files)('%s makes no optional call into the engine', (path, source) => {
    /* Comments stripped: this file's own prose describes the pattern it forbids, and a scan that
       could not tell a sentence from a call would report every explanation as a violation — the
       same correction `docs.test.mjs` needed for its sentinels. */
    const code = (source as string).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    expect(code, `${path} calls into the engine optionally`).not.toMatch(/\?\.\(/);
  });

  it.each(files)('%s casts nothing through `as unknown as`', (path, source) => {
    /* The cast that made the optional call type-check. Forbidding the call alone would leave the
       cast free to hide a different lie — a method that exists with a different signature. */
    const code = (source as string).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    expect(code, `${path} casts through \`as unknown as\``).not.toContain('as unknown as');
  });
});

describe('a script over the whole surface', () => {
  const compile = (source: string) =>
    compileDriftScript(source, {
      filename: 'a.drs',
      registry: engineRegistry(),
      manifest: engineTarget(),
      host: singleFileHost(),
      mode: 'development',
    });

  it('computes with the standard library against a host that supplies nothing', async () => {
    const result = compile(
      'import { clamp, lerp } from "std/math"\n' +
        '\n' +
        '@deterministic\n' +
        'fn ease(from: f32, to: f32, t: f32) -> f32 {\n' +
        '    return math.lerp(from, to, math.clamp(t, 0, 1))\n' +
        '}\n',
    );
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const namespace = (await import(
      /* @vite-ignore */ `data:text/javascript;base64,${btoa(result.code)}`
    )) as Record<string, unknown>;
    const module = loadModule(namespace);
    expect(bindModule(module, {})).toEqual({ bound: true });

    expect((module.exports.ease as (a: number, b: number, t: number) => number)(0, 10, 0.5)).toBe(
      5,
    );
    /* Clamped, so a `t` past the end does not extrapolate. */
    expect((module.exports.ease as (a: number, b: number, t: number) => number)(0, 10, 3)).toBe(10);
  });

  it('runs a seeded generator whose sequence a replay depends on', async () => {
    const result = compile(
      'import { unit } from "drift/random"\n' +
        '\n' +
        '@deterministic\n' +
        'fn jitter(seed: u32) -> f32 {\n' +
        '    return random.unit(seed)\n' +
        '}\n',
    );
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const namespace = (await import(
      /* @vite-ignore */ `data:text/javascript;base64,${btoa(result.code)}`
    )) as Record<string, unknown>;
    const module = loadModule(namespace);
    bindModule(module, {});

    const jitter = module.exports.jitter as (seed: number) => number;
    const { hashToUnit } = await import('@driftengine/core');
    /* The engine's own frozen sequence, not a reimplementation — which is what makes a script's
       randomness replay-safe alongside TypeScript that used the same seed. */
    expect(jitter(42)).toBeCloseTo(Math.fround(hashToUnit(42)), 6);
    expect(jitter(42)).toBe(jitter(42));
  });

  it('refuses a deterministic function that reads a clock, even the fixed one', () => {
    /* A simulation is *given* its delta. One that reached out and read it has stopped being a
       function of its inputs, which is what replay depends on. */
    const result = compile(
      'import { fixedDelta } from "drift/time"\n' +
        '\n' +
        '@deterministic\n' +
        'fn step() -> f32 {\n' +
        '    return time.fixedDelta()\n' +
        '}\n',
    );
    expect(result.diagnostics.some((d) => d.code === 'DS0261')).toBe(true);
  });

  it('accepts a deterministic function that reads the scene but not one that moves it', () => {
    const reads = compile(
      'import { positionX } from "drift/scene"\n' +
        '\n' +
        '@deterministic\n' +
        'fn where(node: Node) -> f32 {\n' +
        '    return scene.positionX(node)\n' +
        '}\n',
    );
    expect(reads.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const writes = compile(
      'import { setPosition } from "drift/scene"\n' +
        '\n' +
        '@deterministic\n' +
        'fn move(node: Node) {\n' +
        '    scene.setPosition(node, 1, 2, 3)\n' +
        '}\n',
    );
    expect(writes.diagnostics.some((d) => d.code === 'DS0261')).toBe(true);
  });

  /**
   * **A script drives a blend tree and does not build one, and until 2026-08-28 this said the
   * opposite.** `blendTree` took a `Skeleton` where the engine's constructor takes the graph's root
   * *node*, so calling it threw `Cannot read properties of undefined (reading 'length')`. The two
   * tests here asserted that the compiler required its third argument — which it did — and neither
   * ran the implementation, which is how a capability nobody could use survived being described,
   * typed and documented. A compile-time refusal is earlier than a runtime one, so the capability
   * is gone rather than repaired in place: building a graph needs a node value the language has no
   * shape for, and `docs/IMPROVEMENTS.md` carries that design.
   */
  it('does not offer to build a blend tree, because a script has no node to build one from', () => {
    const result = compile(
      'import { blendTree } from "drift/animation"\n' +
        '\n' +
        'fn build(skeleton: Skeleton, joints: u32) -> Blend {\n' +
        '    return animation.blendTree(skeleton, joints)\n' +
        '}\n',
    );
    expect(result.diagnostics.filter((d) => d.severity === 'error')).not.toEqual([]);
  });

  it('drives a tree it was handed: a parameter set, and an evaluation into a pose', () => {
    const result = compile(
      'import { blendSet, blendAt, pose } from "drift/animation"\n' +
        '\n' +
        'fn drive(tree: Blend, joints: u32, stride: f32) {\n' +
        '    let out = animation.pose(joints)\n' +
        '    animation.blendSet(tree, "stride", stride)\n' +
        '    animation.blendAt(tree, 0.0, out)\n' +
        '}\n',
    );
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('reads persistence as an option, because a key that is not there is ordinary', async () => {
    const result = compile(
      'import { read, write } from "drift/persistence"\n' +
        '\n' +
        'fn recall(store: Store, key: String) -> String {\n' +
        '    if let found = persistence.read(store, key) {\n' +
        '        return found\n' +
        '    } else {\n' +
        '        return "nothing"\n' +
        '    }\n' +
        '}\n',
    );
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const namespace = (await import(
      /* @vite-ignore */ `data:text/javascript;base64,${btoa(result.code)}`
    )) as Record<string, unknown>;
    const module = loadModule(namespace);
    bindModule(module, {});

    const { MemoryStore } = await import('@driftengine/core');
    const store = new MemoryStore();
    const recall = module.exports.recall as (s: unknown, k: string) => string;
    expect(recall(store, 'missing')).toBe('nothing');
    store.write('here', 'found it');
    expect(recall(store, 'here')).toBe('found it');
  });

  /*
   * **The other half of the refusal test above, and the one that goes green on the day a track
   * lands.** A binding that is written and not wired is invisible: the package compiles, the suite
   * is green, and a script author meets `DS0301` naming a track that shipped. These two say the
   * linker can see them.
   */
  /*
   * **`drift/2d` needs the namespace written out, and that is the whole of what 1.11.0 changed.**
   *
   * A module's namespace is the last segment of its path, so a call here would be `2d.sprite(...)`
   * — a number followed by an identifier the lexer refuses. This binding was written, wired, found
   * uncallable and withdrawn on 2026-09-03 rather than shipped, because a capability nobody can
   * spell is a silent no-op wearing a feature's clothes. The language answered it at the import.
   *
   * Both halves are asserted: the alias links, and the bare import is still refused *by the
   * language*, with the line to write, which is what a script author meets if they forget.
   */
  it('links a script that draws sprites, through the namespace it names', () => {
    const result = compile(
      'import { sprite, tinted } from "drift/2d" as sprites\n' +
        '\n' +
        'fn hud(batch: SpriteBatch) {\n' +
        '    sprites.sprite(batch, 0, 10, 10, 32, 32)\n' +
        '    sprites.tinted(batch, 0, 10, 50, 32, 32, 1, 0, 0, 1)\n' +
        '}\n',
    );
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('refuses the same import with no namespace, and says what to write', () => {
    const result = compile('import { sprite } from "drift/2d"\n\nfn f() {\n}\n');
    expect(result.diagnostics[0].code).toBe('DS0139');
    expect(result.diagnostics[0].message).toContain('from "drift/2d" as');
  });

  it('links a script that drives an interface tree', () => {
    const result = compile(
      'import { layout, hovered, show } from "drift/ui"\n' +
        '\n' +
        'fn menu(tree: UiTree) {\n' +
        '    ui.layout(tree, 0, 0, 1280, 720)\n' +
        '    ui.show(tree, "start", ui.hovered(tree, "start"))\n' +
        '}\n',
    );
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  /*
   * And the rule that makes `input.read` worth declaring: a `@deterministic` function may read a
   * laid-out box, because a rect is state the layout already produced, and may not ask where the
   * pointer is. Declaring `hovered` as `scene.read` would type-check and would pass the test above
   * while failing this one.
   */
  it('lets a deterministic function read a box and refuses it the pointer', () => {
    const reads = compile(
      'import { width } from "drift/ui"\n' +
        '\n' +
        '@deterministic\n' +
        'fn measure(tree: UiTree) -> f32 {\n' +
        '    return ui.width(tree, "start")\n' +
        '}\n',
    );
    expect(reads.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const points = compile(
      'import { hovered } from "drift/ui"\n' +
        '\n' +
        '@deterministic\n' +
        'fn peek(tree: UiTree) -> bool {\n' +
        '    return ui.hovered(tree, "start")\n' +
        '}\n',
    );
    expect(points.diagnostics.filter((d) => d.severity === 'error').length).toBeGreaterThan(0);
  });

  it('refuses a module nothing implements yet, and says so without blaming the script', () => {
    /*
     * The wording moved in `driftscript` 1.4.0 and the change is worth knowing rather than just
     * absorbing. The message used to name the internal roadmap slot the module was waiting on —
     * "Track J, which is scheduled and not started" — and that reached a script author inside a
     * diagnostic, where a letter out of this repository's planning is both meaningless and none of
     * their business. What it says now is what a reader can act on: the module is specified,
     * nothing provides it, and their own file is fine.
     *
     * **It moved again in 1.7.0, and narrowed.** "No host provides it yet" was a claim about every
     * host that has ever existed, made from a list inside the language; the linker asks *this*
     * host's registry now and says what it can actually know — that nothing here describes it, and
     * that the surface is real and the file is valid. The half a script author acts on is the same.
     *
     * `DS0301` is unchanged through both, which is the promise that matters: a diagnostic code is
     * never renumbered once it has shipped.
     *
     * **Compiled against a target with a module withheld, since 2026-09-05, and the reason is that
     * this engine ran out of unbound surfaces.** `drift/xr` was the example here until Track I
     * bound it, and it was the last one: every module the language specifies is now described. A
     * test that needed a real gap to point at would have had nothing to assert and would have been
     * deleted, taking the diagnostic's only coverage with it. So the gap is made rather than found,
     * which is a better test than the one it replaces — it asserts the mechanism instead of relying
     * on this repository being behind.
     */
    /*
     * A bare registry rather than this engine's, because the two halves of `DS0301` are different
     * messages and only one of them is the interesting one. A target that withholds a module this
     * host *does* describe is told to add it to the manifest, which is a configuration mistake. The
     * branch worth covering is the other: nothing describes it at all, which is what a script author
     * writing against an unbuilt surface actually meets.
     */
    const bare = createRegistry();
    const withheld = defineTarget(
      'withheld',
      ENGINE_MODULES.filter((m) => m !== 'drift/xr'),
    );
    const result = compileDriftScript('import { presenting } from "drift/xr"\n\nfn f() {\n}\n', {
      filename: 'a.drs',
      registry: bare,
      manifest: withheld,
      host: singleFileHost(),
      mode: 'development',
    });

    /* Searched rather than indexed. The first draft asserted `diagnostics[0]` and got `DS0290`,
       because the file imported the capability without calling it and an unused import is reported
       before a link is attempted. Which diagnostic comes first is the compiler's business; that this
       one is present is this test's. */
    const refusal = result.diagnostics.find((d) => d.code === 'DS0301');
    expect(
      refusal,
      `no DS0301 among ${result.diagnostics.map((d) => d.code).join(', ')}`,
    ).toBeDefined();
    expect(refusal?.message).toContain('nothing this host describes implements it');
    expect(refusal?.message).toContain('your file is valid');
  });
  /*
   * The wind, read from inside the fixed step.
   *
   * **The annotation is the assertion.** A capability that reached a wall clock could not carry
   * `scene.read`, so `@deterministic` is what proves the claim is enforced rather than asserted in a
   * comment. `wind.ts` builds its signal as a fundamental plus integer harmonics, repeating exactly
   * at the fundamental's period so a replay watched an hour later sees the gust the original run
   * saw; this is where that property is cashed in.
   */
  /**
   * **The effect split Track J was asked to make, cashed in as a compile.**
   *
   * `capability.ts` left `network.write` outside `DETERMINISTIC_EFFECTS` and said the exclusion was
   * *"a deferral rather than a judgement: the track that builds one is the one that can say whether
   * its writes are the simulation or a consequence of it."* Track J's answer is that it stays
   * outside, and the reason is the rewind loop: a `@deterministic` function is precisely the kind
   * that gets re-run, so a send inside one is published again for every replayed tick.
   *
   * These two tests are that answer in a form that cannot go stale. `self` is fixed for the life of
   * a session, so a deterministic function may read it; `replicate` sends, so it may not.
   */
  it('lets a deterministic function ask which participant it is', () => {
    const result = compile(
      'import { self } from "drift/network"\n' +
        '\n' +
        '@deterministic\n' +
        'fn me(session: Session) -> i32 {\n' +
        '    return network.self(session)\n' +
        '}\n',
    );
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('refuses a deterministic function that publishes, because a replay would publish again', () => {
    const result = compile(
      'import { replicate } from "drift/network"\n' +
        '\n' +
        '@deterministic\n' +
        'fn publish(session: Session, value: f32) {\n' +
        '    network.replicate(session, 0, value)\n' +
        '}\n',
    );
    expect(result.diagnostics.filter((d) => d.severity === 'error').length).toBeGreaterThan(0);
  });

  /**
   * And the same for the rollback surface, where getting it wrong would be least visible.
   *
   * A system branching on "am I being replayed" takes one path live and the other on replay, which
   * produces a world that differs from the world it is replaying. The checker refuses it.
   */
  it('refuses a deterministic function that asks whether it is replaying', () => {
    const result = compile(
      'import { isReplaying } from "drift/rollback"\n' +
        '\n' +
        '@deterministic\n' +
        'fn twice(rewind: Rewind) -> bool {\n' +
        '    return rollback.isReplaying(rewind)\n' +
        '}\n',
    );
    expect(result.diagnostics.filter((d) => d.severity === 'error').length).toBeGreaterThan(0);
  });

  it('lets a deterministic function read the wind', () => {
    const result = compile(
      'import { windSpeed, windGust, windDirectionX } from "drift/scene"\n' +
        '\n' +
        '@deterministic\n' +
        'fn press(wind: Wind) -> f32 {\n' +
        '    return scene.windSpeed(wind) + scene.windGust(wind) + scene.windDirectionX(wind)\n' +
        '}\n',
    );
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

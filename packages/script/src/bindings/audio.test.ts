import { describe, expect, it } from 'vitest';
import { compileDriftScript, singleFileHost } from 'driftscript/compiler';
import { loadModule } from 'driftscript';
import type { KickDetector } from '@driftengine/audio';
import { AUDIO_CAPABILITIES, AUDIO_MODULE, audioImplementation } from './audio.ts';
import { bindModule, engineRegistry, engineTarget } from '../host.ts';

/**
 * §48 step 11: one real registered engine capability, called from a script.
 *
 * The last step of the vertical slice, and the only one Phase 1 could not close — a binding needs
 * this package, and this package needs the language. Everything else in the slice was proved on a
 * dev server; this is proved by running the generated module against real engine objects.
 *
 * The `AudioGraph` and `SoundRegistry` here are minimal stand-ins rather than the real classes,
 * because a real `AudioGraph` needs an `AudioContext` and a browser. That is a deliberate limit and
 * it is stated: what this proves is that the *binding* is correct — the shapes, the option, the
 * effects, the dispatch — not that the audio engine works, which is Track G's own suite's job.
 */

/** Just enough of the engine objects for a binding to call: a graph, its mix, and the sounds. */
const fakeAudio = () => {
  const played: { gain: number; pan: number }[] = [];
  const buffers = new Map<string, object>();
  /* Every move the mix was asked for, by the bus or snapshot it named. */
  const moves: string[] = [];
  const bus = (name: string) => ({
    duck: (factor: number, seconds: number) => moves.push(`${name} duck ${factor} ${seconds}`),
    fadeLevel: (level: number, seconds: number) => moves.push(`${name} fade ${level} ${seconds}`),
  });
  const buses = new Map([['music', bus('music')]]);
  return {
    played,
    buffers,
    moves,
    graph: {
      play(_buffer: unknown, gain = 1, pan = 0) {
        played.push({ gain, pan });
      },
      console: {
        find: (name: string) => buses.get(name),
        recall: (name: string, seconds: number) => {
          if (name !== 'indoors') return false;
          moves.push(`recall ${name} ${seconds}`);
          return true;
        },
      },
    } as never,
    registry: {
      get: (slot: string) => buffers.get(slot),
    } as never,
  };
};

const compile = (source: string) =>
  compileDriftScript(source, {
    filename: 'a.drs',
    registry: engineRegistry(),
    manifest: engineTarget(),
    host: singleFileHost(),
    mode: 'development',
  });

const run = async (source: string, services: ReturnType<typeof fakeAudio>, kick?: KickDetector) => {
  const result = compile(source);
  if (result.diagnostics.some((d) => d.severity === 'error')) {
    throw new Error(result.diagnostics.map((d) => `${d.code} ${d.message}`).join('\n'));
  }
  const namespace = (await import(
    /* @vite-ignore */ `data:text/javascript;base64,${btoa(result.code)}`
  )) as Record<string, unknown>;
  const module = loadModule(namespace);
  const bound = bindModule(module, {
    audio: {
      graph: services.graph,
      registry: services.registry,
      ...(kick === undefined ? {} : { kick }),
    },
  });
  if (!bound.bound) throw new Error(bound.reason);
  return module;
};

describe('the audio binding', () => {
  it('declares every capability with an implementation that exists', () => {
    /* The registry *names* an implementation rather than holding one — R2 — so nothing mechanically
       ties a definition to the function it describes. This is that tie, asserted. */
    const services = fakeAudio();
    const implementations = audioImplementation(services.graph, services.registry);
    for (const capability of AUDIO_CAPABILITIES) {
      expect(
        implementations[capability.name],
        `${capability.name} has no implementation`,
      ).toBeTypeOf('function');
    }
  });

  it('marks every writing capability as outside the determinism boundary', () => {
    for (const capability of AUDIO_CAPABILITIES) {
      if (!capability.effects.includes('audio.write')) continue;
      expect(capability.deterministic, `${capability.name} claims determinism`).toBe(false);
    }
  });

  it('keeps the cheap positional functions deterministic, which is why effects are per capability', () => {
    const positional = AUDIO_CAPABILITIES.filter((c) =>
      ['distanceGain', 'stereoPan'].includes(c.name),
    );
    expect(positional).toHaveLength(2);
    for (const capability of positional) {
      expect(capability.deterministic).toBe(true);
      expect(capability.effects).toEqual(['pure']);
    }
  });

  it('types a sound slot as an option, because the file often is not there', () => {
    const sound = AUDIO_CAPABILITIES.find((c) => c.name === 'sound');
    expect(sound?.returns).toBe('Sound?');
  });

  it('step 11: a script calls a real engine capability, and it runs', async () => {
    const services = fakeAudio();
    services.buffers.set('door.open', { fake: 'buffer' });

    const module = await run(
      'import { sound, play } from "drift/audio"\n' +
        '\n' +
        'fn ring() {\n' +
        '    if let clip = audio.sound("door.open") {\n' +
        '        audio.play(clip, 0.8)\n' +
        '    }\n' +
        '}\n',
      services,
    );

    (module.exports.ring as () => void)();
    expect(services.played).toEqual([{ gain: 0.8, pan: 0 }]);
  });

  it('plays nothing when the slot is absent, without the script having to remember', async () => {
    /* The compiler made the check mandatory: `audio.sound` returns an option and there is no way to
       reach the value without handling the absent case. A script that "forgot" would not compile. */
    const services = fakeAudio();
    const module = await run(
      'import { sound, play } from "drift/audio"\n' +
        '\n' +
        'fn ring() {\n' +
        '    if let clip = audio.sound("missing") {\n' +
        '        audio.play(clip, 1)\n' +
        '    }\n' +
        '}\n',
      services,
    );

    (module.exports.ring as () => void)();
    expect(services.played).toEqual([]);
  });

  it('refuses a script that uses a sound without checking it resolved', () => {
    const result = compile(
      'import { sound, play } from "drift/audio"\n' +
        '\n' +
        'fn ring() {\n' +
        '    audio.play(audio.sound("door.open"), 1)\n' +
        '}\n',
    );
    /* `Sound?` where `Sound` is wanted. This is the no-implicit-null rule earning its keep on the
       first real engine surface it was applied to. */
    expect(result.diagnostics.some((d) => d.code === 'DS0263')).toBe(true);
  });

  it('refuses a deterministic function that plays a sound', () => {
    const result = compile(
      'import { sound, play } from "drift/audio"\n' +
        '\n' +
        '@deterministic\n' +
        'fn ring(clip: Sound) {\n' +
        '    audio.play(clip, 1)\n' +
        '}\n',
    );
    const [diagnostic] = result.diagnostics.filter((d) => d.code === 'DS0261');
    expect(diagnostic).toBeDefined();
    expect(diagnostic.message).toContain('drift/audio.play');
    expect(diagnostic.message).toContain('audio.write');
  });

  it('accepts a deterministic function that uses the positional maths', () => {
    const result = compile(
      'import { distanceGain } from "drift/audio"\n' +
        '\n' +
        '@deterministic\n' +
        'fn falloff(distance: f32) -> f32 {\n' +
        '    return audio.distanceGain(distance, 40m)\n' +
        '}\n',
    );
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('computes the same falloff a TypeScript caller would', async () => {
    const services = fakeAudio();
    const module = await run(
      'import { distanceGain } from "drift/audio"\n' +
        '\n' +
        'fn falloff(distance: f32) -> f32 {\n' +
        '    return audio.distanceGain(distance, 40m)\n' +
        '}\n',
      services,
    );
    const { distanceGain } = await import('@driftengine/audio');
    const script = (module.exports.falloff as (d: number) => number)(10);
    /* The engine's own function, called directly, must give the same answer — which is the check
       that a binding dispatches rather than reimplements. */
    expect(script).toBeCloseTo(distanceGain(10, 40), 6);
  });
});

describe('the mix, as dials a script turns by name', () => {
  it('ducks, fades and recalls what the host made, and says false for a name nothing answers to', async () => {
    const services = fakeAudio();
    const module = await run(
      'import { duck, fade, recall } from "drift/audio"\n' +
        '\n' +
        'fn bell() -> bool {\n' +
        '    return audio.duck("music", 0.3, 0.2) && audio.fade("music", 0.8, 1) && audio.recall("indoors", 2)\n' +
        '}\n' +
        '\n' +
        'fn stray() -> bool {\n' +
        '    return audio.duck("choir", 0.3, 0.2) || audio.fade("choir", 1, 1) || audio.recall("outdoors", 1)\n' +
        '}\n',
      services,
    );
    expect((module.exports.bell as () => boolean)()).toBe(true);
    expect(services.moves).toEqual(['music duck 0.3 0.2', 'music fade 0.8 1', 'recall indoors 2']);
    expect((module.exports.stray as () => boolean)()).toBe(false);
    expect(services.moves).toHaveLength(3);
  });

  it("reads the host's kick detector, and 0 when it runs none", async () => {
    const source =
      'import { pulse } from "drift/audio"\n\nfn glow() -> f32 {\n    return audio.pulse()\n}\n';
    const kicking = await run(source, fakeAudio(), { pulse: 0.75 } as KickDetector);
    expect((kicking.exports.glow as () => number)()).toBeCloseTo(0.75, 6);
    const silent = await run(source, fakeAudio());
    expect((silent.exports.glow as () => number)()).toBe(0);
  });

  it('refuses the kick in a deterministic function, since a replay hears what the speakers did', () => {
    const result = compile(
      'import { pulse } from "drift/audio"\n\n@deterministic\nfn glow() -> f32 {\n    return audio.pulse()\n}\n',
    );
    expect(result.diagnostics.some((d) => d.code === 'DS0261')).toBe(true);
  });
});

describe('binding a module to a host', () => {
  it('refuses in words when the host was not given a service the module needs', async () => {
    const result = compile(
      'import { play } from "drift/audio"\n\nfn ring(clip: Sound) {\n    audio.play(clip, 1)\n}\n',
    );
    const namespace = (await import(
      /* @vite-ignore */ `data:text/javascript;base64,${btoa(result.code)}`
    )) as Record<string, unknown>;
    const module = loadModule(namespace);

    const bound = bindModule(module, {});
    expect(bound.bound).toBe(false);
    if (bound.bound) throw new Error('expected a refusal');
    expect(bound.reason).toContain('drift/audio');
    expect(bound.reason).toContain('has not been given');
  });

  it('binds a module that needs nothing, without requiring the consumer to know that', async () => {
    const result = compile('fn add(a: f32, b: f32) -> f32 {\n    return a + b\n}\n');
    const namespace = (await import(
      /* @vite-ignore */ `data:text/javascript;base64,${btoa(result.code)}`
    )) as Record<string, unknown>;
    expect(bindModule(loadModule(namespace), {})).toEqual({ bound: true });
  });

  it('describes audio among what this engine has wired', () => {
    const registry = engineRegistry();
    expect(registry.modules()).toContain(AUDIO_MODULE);
    /* A target may not claim a module nothing provides, so a consumer cannot promise `drift/ecs`
       and discover the truth one call site at a time. */
    expect(() => engineTarget()).not.toThrow();
  });
});

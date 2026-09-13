import { describe, expect, it } from 'vitest';
import {
  AtmosphereField,
  ChemistryWorld,
  ParcelStore,
  ReactionRegistry,
  SpeciesRegistry,
  STANDARD_AIR,
  SubstanceRegistry,
  installLibrary,
  registerStandardSpecies,
} from '@driftengine/chemistry';
import { ORGANIC } from '@driftengine/chemistry/library/organic';
import { compileDriftScript } from 'driftscript/compiler';
import type { ModuleHost } from 'driftscript/compiler';
import { loadModule } from 'driftscript';
import { CHEMISTRY_COMPONENT } from './chemistry.ts';
import { bindModule, engineImplementations, engineRegistry, engineTarget } from '../host.ts';
import type { ChemistryServices } from './chemistry.ts';

function scene(): ChemistryServices {
  const species = new SpeciesRegistry();
  registerStandardSpecies(species);
  const reactions = new ReactionRegistry(species);
  const substances = new SubstanceRegistry(species, reactions);
  installLibrary(ORGANIC, species, reactions, substances);
  const parcels = new ParcelStore(substances);
  const air = new AtmosphereField(species, { cellSize: 1, ambient: STANDARD_AIR, maxChunks: 1 });
  return { world: new ChemistryWorld(parcels, air), parcels, air, substances, species };
}

const host: ModuleHost = { resolve: (s) => s, load: () => null };

/** Compile a script against this engine's real registry and run it with a real chemistry world. */
async function run(
  source: string,
  chemistry: ChemistryServices,
): Promise<Record<string, (...a: never[]) => unknown>> {
  const result = compileDriftScript(source, {
    filename: 'Fire.drs',
    host,
    registry: engineRegistry(),
    manifest: engineTarget(),
    mode: 'development',
  });
  expect(result.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  const namespace = (await import(
    /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(result.code)}`
  )) as Record<string, unknown>;
  const bound = bindModule(loadModule(namespace), { chemistry });
  expect(bound).toEqual({ bound: true });
  return namespace as Record<string, (...a: never[]) => unknown>;
}

describe('drift/chemistry, against a real world', () => {
  it('SPAWNS A LOG AND READS IT BACK, through the language', () => {
    const chemistry = scene();
    const implementations = engineImplementations({ chemistry }) as Record<
      string,
      Record<string, (...a: never[]) => unknown>
    >;
    const chem = implementations['drift/chemistry'] as Record<string, (...a: never[]) => unknown>;

    const oak = chem.substance?.(null as never, 'oak' as never) as number;
    const log = chem.place?.(
      null as never,
      oak as never,
      8 as never,
      0.2 as never,
      0 as never,
      0 as never,
      0 as never,
    ) as number;

    expect(chem.alive?.(null as never, log as never)).toBe(true);
    expect(chem.mass?.(null as never, log as never)).toBeCloseTo(8, 6);
    /* Seasoned oak, authored on a dry basis, and it reads back on one. */
    expect(chem.moisture?.(null as never, log as never)).toBeCloseTo(0.12, 4);
    expect(chem.burning?.(null as never, log as never)).toBe(false);
  });

  it('REFUSES A MISSPELLED SUBSTANCE, naming where to find real ones', () => {
    /*
     * Not `-1`, and not a silent no-op. A script that misspells `oak` would otherwise spawn from a
     * substance index of minus one and read zeroes for the rest of the run — a behaviour that runs,
     * reports success and is wrong.
     */
    const chemistry = scene();
    const chem = (
      engineImplementations({ chemistry }) as Record<
        string,
        Record<string, (...a: never[]) => unknown>
      >
    )['drift/chemistry'] as Record<string, (...a: never[]) => unknown>;
    expect(() => chem.substance?.(null as never, 'oke' as never)).toThrow(/oke/);
    expect(() => chem.substance?.(null as never, 'oke' as never)).toThrow(/library\/organic/);
  });

  it('LETS A @deterministic SCRIPT WRITE CHEMISTRY, which is the effect decision', async () => {
    /*
     * **The whole reason `chemistry.write` went inside `DETERMINISTIC_EFFECTS`.** A parcel's
     * enthalpy is a simulated quantity in exactly the sense a component's fields are — it is
     * integrated on the fixed step and touches no clock — so a rule that refused this function
     * would refuse the canonical operation of the package.
     *
     * If the effect were outside, this compiles to `DS0230` rather than to a module.
     */
    const chemistry = scene();
    const module = await run(
      `
      import { addHeat, ignite, place, substance, surfaceTemperature } from "drift/chemistry"

      @deterministic
      fn light(chem: Chemistry) -> f32 {
        let oak = chemistry.substance(chem, "oak")
        let log = chemistry.place(chem, oak, 2, 0.2, 0, 0, 0)
        chemistry.addHeat(chem, log, 200000)
        chemistry.ignite(chem, log)
        return chemistry.surfaceTemperature(chem, log)
      }
    `,
      chemistry,
    );

    const surface = module.light?.(chemistry.world as never) as number;
    /* The heat really landed: two hundred kilojoules into a surface shell is a real rise. */
    expect(surface).toBeGreaterThan(293.15);
    expect(chemistry.parcels.count).toBe(1);
  });

  it('POURS WATER FROM A SCRIPT, and the water is really there', async () => {
    const chemistry = scene();
    const module = await run(
      `
      import { place, substance, wet, wetness } from "drift/chemistry"

      @deterministic
      fn soak(chem: Chemistry) -> f32 {
        let log = chemistry.place(chem, chemistry.substance(chem, "oak"), 2, 0.5, 0, 0, 0)
        chemistry.wet(chem, log, 0.25)
        return chemistry.wetness(chem, log)
      }
    `,
      chemistry,
    );

    /* Quarter of a kilogram over half a square metre. */
    expect(module.soak?.(chemistry.world as never) as number).toBeGreaterThan(0.4);
  });

  it('READS THE AIR AT A POINT, in the units a game acts on', async () => {
    const chemistry = scene();
    const module = await run(
      `
      import { humidity, oxygenFraction, visibility } from "drift/chemistry"

      @deterministic
      fn room(chem: Chemistry) -> f32 {
        return chemistry.oxygenFraction(chem, 0.5, 0.5, 0.5)
             + chemistry.humidity(chem, 0.5, 0.5, 0.5)
             + chemistry.visibility(chem, 0.5, 0.5, 0.5)
      }
    `,
      chemistry,
    );

    /* 0.209 oxygen plus 0.5 humidity plus ten kilometres of clear air. */
    expect(module.room?.(chemistry.world as never) as number).toBeCloseTo(10000.71, 1);
  });

  it('ACCEPTS degC AS A THRESHOLD AND REFUSES IT AS A DIFFERENCE', () => {
    /*
     * The trap `§20.6` names, end to end through the real registry: `140degC` is a browning
     * threshold and reads correctly, and `t - 5degC` is a difference that would erase 273.15 too
     * high and is refused before it can be believed.
     */
    const compile = (source: string) =>
      compileDriftScript(source, {
        filename: 'T.drs',
        host,
        registry: engineRegistry(),
        manifest: engineTarget(),
        mode: 'development',
      });
    expect(compile('@pure\nfn hot(t: f32) -> bool { return t > 140degC }').diagnostics).toEqual([]);
    expect(
      compile('@pure\nfn cooler(t: f32) -> f32 { return t - 5degC }').diagnostics.map(
        (d) => d.code,
      ),
    ).toContain('DS0298');
  });

  it('declares the Chemistry component here, which is where §19 puts it', () => {
    /*
     * Not in `@driftengine/entities`, whose design is explicit that it declares no components, and
     * not in `@driftengine/chemistry`, which imports no engine package at all. This layer is the one
     * place that already depends on both.
     */
    expect(CHEMISTRY_COMPONENT.schema.name).toBe('Chemistry');
    expect(CHEMISTRY_COMPONENT.schema.fields.map((f) => f.name)).toEqual(['parcel', 'standoff']);
  });
});

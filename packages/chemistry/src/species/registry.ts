/**
 * The species a world knows about, and the one place a molar mass comes from.
 *
 * Registration is init-time and fails fast, per `AGENTS.md`: an unknown element, a duplicate id, a
 * subscript that is negative or not a number, an empty formula. Each throws naming the offending
 * value. Nothing here is reachable from a frame, so the cost of checking thoroughly is nothing and
 * the cost of not checking is a `NaN` that appears twenty ticks into a burn.
 *
 * A species is an `i32` index everywhere after registration. That is `drift/physics`'s convention
 * for a body and it is followed rather than improved on.
 */
import { ATOMIC_MASS, elementIndex } from '../element/elements.ts';
import { SpeciesElementMatrix } from '../element/matrix.ts';
import { STANDARD_TEMPERATURE, type Phase, type SpeciesDefinition } from './species.ts';

export class SpeciesRegistry {
  /** Moles of each element per mole of each species. Public because conservation reduces it. */
  readonly elements = new SpeciesElementMatrix();

  private readonly ids: string[] = [];
  private readonly byId = new Map<string, number>();
  private readonly phases: number[] = [];
  private readonly pseudo: boolean[] = [];
  private readonly masses: number[] = [];
  private readonly formation: number[] = [];
  private readonly cpA: number[] = [];
  private readonly cpB: number[] = [];

  get count(): number {
    return this.ids.length;
  }

  register(definition: SpeciesDefinition): number {
    const { id, formula } = definition;
    if (this.byId.has(id)) {
      throw new Error(`species "${id}" is already registered`);
    }

    const symbols = Object.keys(formula);
    if (symbols.length === 0) {
      throw new Error(`species "${id}" has an empty formula`);
    }

    /* Validated in full before anything is written, so a refusal leaves the registry as it was
       rather than half-holding a species nothing can name. */
    for (const symbol of symbols) {
      if (elementIndex(symbol) < 0) {
        throw new Error(
          `species "${id}" names ${symbol}, which is not one of the fifteen elements`,
        );
      }
      const moles = formula[symbol] as number;
      if (!Number.isFinite(moles) || moles < 0) {
        throw new Error(`species "${id}" has ${moles} moles of ${symbol}`);
      }
    }

    const species = this.elements.addRow();
    let gramsPerMole = 0;
    for (const symbol of symbols) {
      const element = elementIndex(symbol);
      const moles = formula[symbol] as number;
      this.elements.set(species, element, moles);
      gramsPerMole += moles * (ATOMIC_MASS[element] as number);
    }

    this.ids.push(id);
    this.byId.set(id, species);
    this.phases.push(definition.phase);
    this.pseudo.push(definition.pseudo === true);
    this.masses.push(gramsPerMole / 1000);
    this.formation.push(definition.formationEnthalpy);
    this.cpA.push(definition.cpA);
    this.cpB.push(definition.cpB ?? 0);
    return species;
  }

  indexOf(id: string): number {
    return this.byId.get(id) ?? -1;
  }

  idOf(species: number): string {
    return this.ids[this.check(species)] as string;
  }

  /** Kilograms per mole, derived from the formula at registration. */
  molarMass(species: number): number {
    return this.masses[this.check(species)] as number;
  }

  phaseOf(species: number): Phase {
    return this.phases[this.check(species)] as Phase;
  }

  formationEnthalpyOf(species: number): number {
    return this.formation[this.check(species)] as number;
  }

  /** Specific heat at a temperature, J/(kg·K), linear about the standard state. */
  heatCapacityOf(species: number, temperature: number): number {
    const at = this.check(species);
    return (
      (this.cpA[at] as number) + (this.cpB[at] as number) * (temperature - STANDARD_TEMPERATURE)
    );
  }

  isPseudo(species: number): boolean {
    return this.pseudo[this.check(species)] as boolean;
  }

  private check(species: number): number {
    if (!Number.isInteger(species) || species < 0 || species >= this.ids.length) {
      throw new Error(`species ${species} is outside a registry of ${this.ids.length}`);
    }
    return species;
  }
}

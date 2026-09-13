/**
 * The reactions a world knows about, balanced and costed at registration.
 *
 * Two things happen here that cannot happen later, and both are refusals rather than warnings.
 *
 * **Every reaction is checked against the element matrix**, and one that does not balance is
 * refused naming the element and the size of the gap. An unbalanced reaction invents or destroys
 * matter every time it runs, and every symptom of that is subtle — a fire that will not go out, a
 * mass that quietly grows, smoke that never clears. CH-0 built the matrix for exactly this moment.
 *
 * **Every reaction's enthalpy is derived by Hess's law** from the formation enthalpies CH-0 stores,
 * rather than typed in. A `ΔH` that disagreed with its own species would conserve energy in the
 * code and lose it against the world, with nothing to detect it. Derived, the two cannot disagree,
 * and a wrong formation enthalpy shows up in every reaction that touches the species at once —
 * which is a bug that can be found.
 */
import { ELEMENT_COUNT, ELEMENTS } from '../element/elements.ts';
import type { SpeciesRegistry } from '../species/registry.ts';
import { type RateTable, tabulateArrhenius, tabulateCardinal } from './rates.ts';
import type { Reaction, ReactionKind, SpeciesAmount } from './reaction.ts';

export * from './reaction.ts';

/** How far a reaction may be from balancing, in moles of an element per unit extent. */
const BALANCE_TOLERANCE = 1e-9;

/** `instant` has no table; the solver's clamp is what bounds it. A huge constant stands in. */
const INSTANT_RATE = 1e12;

export class ReactionRegistry {
  private readonly ids: string[] = [];
  private readonly byId = new Map<string, number>();
  private readonly kinds: ReactionKind[] = [];
  private readonly gateMin: number[] = [];
  private readonly gateMax: number[] = [];
  private readonly gateWidth: number[] = [];
  private readonly transport: number[] = [];
  private readonly enthalpies: number[] = [];
  private readonly tables: (RateTable | null)[] = [];
  private readonly reactantIndex: Int32Array[] = [];
  private readonly reactantAmount: Float64Array[] = [];
  private readonly productIndex: Int32Array[] = [];
  private readonly productAmount: Float64Array[] = [];

  /* Scratch for the balance check. Registration-time, so this is tidiness rather than a hot path. */
  private readonly balance = new Float64Array(ELEMENT_COUNT);

  constructor(private readonly species: SpeciesRegistry) {}

  get count(): number {
    return this.ids.length;
  }

  register(reaction: Reaction): number {
    const { id } = reaction;
    if (this.byId.has(id)) throw new Error(`reaction "${id}" is already registered`);
    if (reaction.reactants.length === 0) throw new Error(`reaction "${id}" has no reactants`);
    if (reaction.products.length === 0) throw new Error(`reaction "${id}" has no products`);

    const resolve = (side: readonly SpeciesAmount[], what: string): [Int32Array, Float64Array] => {
      const index = new Int32Array(side.length);
      const amount = new Float64Array(side.length);
      for (let i = 0; i < side.length; i++) {
        const entry = side[i] as SpeciesAmount;
        const at = this.species.indexOf(entry.species);
        if (at < 0) {
          throw new Error(
            `reaction "${id}" names ${what} "${entry.species}", which is not a registered species`,
          );
        }
        if (!Number.isFinite(entry.moles) || entry.moles <= 0) {
          throw new Error(
            `reaction "${id}" gives ${what} "${entry.species}" a coefficient of ${entry.moles}`,
          );
        }
        index[i] = at;
        amount[i] = entry.moles;
      }
      return [index, amount];
    };

    const [reactantIndex, reactantAmount] = resolve(reaction.reactants, 'reactant');
    const [productIndex, productAmount] = resolve(reaction.products, 'product');

    /* Products minus reactants, element by element. Zero everywhere or it does not run. */
    this.balance.fill(0);
    for (let i = 0; i < productIndex.length; i++) {
      this.species.elements.addScaledRow(
        productIndex[i] as number,
        productAmount[i] as number,
        this.balance,
      );
    }
    for (let i = 0; i < reactantIndex.length; i++) {
      this.species.elements.addScaledRow(
        reactantIndex[i] as number,
        -(reactantAmount[i] as number),
        this.balance,
      );
    }
    for (let e = 0; e < ELEMENT_COUNT; e++) {
      const gap = this.balance[e] as number;
      if (Math.abs(gap) > BALANCE_TOLERANCE) {
        const side = gap > 0 ? 'more' : 'less';
        throw new Error(
          `reaction "${id}" does not balance: its products hold ${Math.abs(gap)} mol ${side} ` +
            `${ELEMENTS[e]} than its reactants`,
        );
      }
    }

    /* Hess's law: the products' formation enthalpies less the reactants'. */
    let enthalpy = 0;
    for (let i = 0; i < productIndex.length; i++) {
      enthalpy +=
        (productAmount[i] as number) * this.species.formationEnthalpyOf(productIndex[i] as number);
    }
    for (let i = 0; i < reactantIndex.length; i++) {
      enthalpy -=
        (reactantAmount[i] as number) *
        this.species.formationEnthalpyOf(reactantIndex[i] as number);
    }

    const kinetics = reaction.kinetics;
    let table: RateTable | null;
    let transportLimit = 0;
    switch (kinetics.type) {
      case 'arrhenius':
        table = tabulateArrhenius(kinetics.A, kinetics.activationEnergy, kinetics.n ?? 0);
        break;
      case 'diffusion':
        table = tabulateArrhenius(kinetics.A, kinetics.activationEnergy, kinetics.n ?? 0);
        transportLimit = kinetics.transportLimit;
        if (!(transportLimit > 0)) {
          throw new Error(`reaction "${id}" is transport-limited at ${transportLimit} per second`);
        }
        break;
      case 'cardinal':
        table = tabulateCardinal(
          kinetics.peak,
          kinetics.minimum,
          kinetics.optimum,
          kinetics.maximum,
        );
        break;
      case 'instant':
        table = null;
        break;
    }

    const index = this.ids.length;
    this.ids.push(id);
    this.byId.set(id, index);
    this.kinds.push(reaction.kind);
    const gates = reaction.gates;
    this.gateMin.push(gates?.minTemperature ?? Number.NEGATIVE_INFINITY);
    this.gateMax.push(gates?.maxTemperature ?? Number.POSITIVE_INFINITY);
    this.gateWidth.push(gates?.width ?? 0);
    this.enthalpies.push(enthalpy);
    this.tables.push(table);
    this.transport.push(transportLimit);
    this.reactantIndex.push(reactantIndex);
    this.reactantAmount.push(reactantAmount);
    this.productIndex.push(productIndex);
    this.productAmount.push(productAmount);
    return index;
  }

  indexOf(id: string): number {
    return this.byId.get(id) ?? -1;
  }

  idOf(reaction: number): string {
    return this.ids[this.check(reaction)] as string;
  }

  kindOf(reaction: number): ReactionKind {
    return this.kinds[this.check(reaction)] as ReactionKind;
  }

  /** J per unit extent. Negative releases heat; positive absorbs it. */
  enthalpyOf(reaction: number): number {
    return this.enthalpies[this.check(reaction)] as number;
  }

  rateTableOf(reaction: number): RateTable {
    const table = this.tables[this.check(reaction)];
    if (table === null) {
      throw new Error(`reaction "${this.ids[reaction]}" is instant and has no rate table`);
    }
    return table;
  }

  /** K below which this reaction does not run at all. */
  minTemperatureOf(reaction: number): number {
    return this.gateMin[this.check(reaction)] as number;
  }

  /** K above which it does not run at all. */
  maxTemperatureOf(reaction: number): number {
    return this.gateMax[this.check(reaction)] as number;
  }

  /** K over which the lower gate opens rather than snapping. */
  gateWidthOf(reaction: number): number {
    return this.gateWidth[this.check(reaction)] as number;
  }

  /** The ceiling transport puts on this reaction in still air, per second. Zero means none. */
  transportLimitOf(reaction: number): number {
    return this.transport[this.check(reaction)] as number;
  }

  /** The table, or `null` where the reaction is instant. What the localiser packs. */
  rateTableOrNull(reaction: number): RateTable | null {
    return this.tables[this.check(reaction)] as RateTable | null;
  }

  /** The rate constant at a temperature. An instant reaction answers with a very large number. */
  rateOf(reaction: number, temperature: number): number {
    const table = this.tables[this.check(reaction)];
    if (table === null) return INSTANT_RATE;
    if (temperature <= table.minTemperature) return table.rate[table.knots - 1] as number;
    if (temperature >= table.maxTemperature) return table.rate[0] as number;
    const position =
      ((1 / temperature - table.inverseMin) / (table.inverseMax - table.inverseMin)) *
      (table.knots - 1);
    const low = Math.floor(position);
    const high = low + 1;
    if (high >= table.knots) return table.rate[table.knots - 1] as number;
    const at = position - low;
    return (table.rate[low] as number) * (1 - at) + (table.rate[high] as number) * at;
  }

  reactantSpecies(reaction: number): Int32Array {
    return this.reactantIndex[this.check(reaction)] as Int32Array;
  }

  reactantMoles(reaction: number): Float64Array {
    return this.reactantAmount[this.check(reaction)] as Float64Array;
  }

  productSpecies(reaction: number): Int32Array {
    return this.productIndex[this.check(reaction)] as Int32Array;
  }

  productMoles(reaction: number): Float64Array {
    return this.productAmount[this.check(reaction)] as Float64Array;
  }

  private check(reaction: number): number {
    if (!Number.isInteger(reaction) || reaction < 0 || reaction >= this.ids.length) {
      throw new Error(`reaction ${reaction} is outside a registry of ${this.ids.length}`);
    }
    return reaction;
  }
}

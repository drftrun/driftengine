import { describe, expect, it } from 'vitest';
import { SpeciesRegistry } from '../species/registry.ts';
import { registerStandardSpecies } from '../species/standard.ts';
import { ReactionRegistry } from '../reaction/registry.ts';
import { SubstanceRegistry } from '../substance/registry.ts';
import { installLibrary } from './library.ts';
import { ORGANIC } from './organic.ts';

function world(): {
  species: SpeciesRegistry;
  reactions: ReactionRegistry;
  substances: SubstanceRegistry;
} {
  const species = new SpeciesRegistry();
  registerStandardSpecies(species);
  const reactions = new ReactionRegistry(species);
  const substances = new SubstanceRegistry(species, reactions);
  installLibrary(ORGANIC, species, reactions, substances);
  return { species, reactions, substances };
}

/** J per kilogram of the first reactant, which is how a pyrolysis enthalpy is quoted. */
function perKilogram(reactions: ReactionRegistry, species: SpeciesRegistry, id: string): number {
  const index = reactions.indexOf(id);
  const first = reactions.reactantSpecies(index)[0] as number;
  const moles = reactions.reactantMoles(index)[0] as number;
  return reactions.enthalpyOf(index) / (moles * species.molarMass(first));
}

describe('the organic library', () => {
  it('installs: every reaction balances and every substance resolves', () => {
    const { substances } = world();
    for (const id of ['oak', 'pine', 'paper', 'cotton', 'leather', 'straw']) {
      expect(substances.indexOf(id)).toBeGreaterThanOrEqual(0);
    }
  });

  it('costs the volatile branch what pyrolysis is MEASURED to cost, and nothing said so', () => {
    /*
     * **The check that says the tar species is right.** Its formation enthalpy is back-derived from
     * two measurements that have nothing to do with pyrolysis heat — the higher heating value of
     * wood pyrolysis oil, 17.0 MJ/kg, and the sublimation enthalpy of levoglucosan, 105 kJ/mol.
     *
     * Hess's law over that and cellulose's own back-derived enthalpy then gives the *third* measured
     * quantity: the endotherm of the volatile-forming branch, which the design's `§8.3` quotes at
     * +255 kJ/kg. Three independent measurements agreeing is what makes this a model rather than a
     * fit, and if the arithmetic were wrong in either back-derivation this is where it would show.
     */
    const { reactions, species } = world();
    const volatile = perKilogram(reactions, species, 'cellulose-to-tar');
    expect(volatile).toBeGreaterThan(200000);
    expect(volatile).toBeLessThan(320000);
  });

  it('makes the char branch exothermic, which is why a charcoal pit works', () => {
    /*
     * The other half of the Broido-Shafizadeh competition, and it has to be the other sign: the
     * branch that leaves carbon behind releases heat, which is what lets a slow, air-starved heap
     * carbonise itself once it is started. `§8.3`'s "nobody will have implemented charcoal".
     */
    const { reactions, species } = world();
    expect(perKilogram(reactions, species, 'cellulose-to-char')).toBeLessThan(0);
  });

  it('gives the volatile branch the higher barrier, which is the whole competition', () => {
    /*
     * `§8.3`'s single most useful consequence: the volatile branch has the higher activation energy,
     * so it wins when heating is fast and loses when heating is slow. Kindling in a hot fire is
     * consumed to ash; a log at the edge of one chars deeply and never flames. Same two reactions.
     */
    const { reactions } = world();
    const table = (id: string, t: number): number => reactions.rateOf(reactions.indexOf(id), t);
    /* At 500 K the char branch leads. */
    expect(table('cellulose-to-char', 500)).toBeGreaterThan(table('cellulose-to-tar', 500));
    /* At 800 K the volatile branch has overtaken it. */
    expect(table('cellulose-to-tar', 800)).toBeGreaterThan(table('cellulose-to-char', 800));
  });

  it('LEAVES THE RIGHT AMOUNT OF CHAR, which nothing states', () => {
    /* Char yield is stoichiometry, not a parameter: lignin is the char source and cellulose's
       char branch is the minority path. Measured wood-science figures are 40-50% for lignin and
       25-35% for slow cellulose pyrolysis. */
    const { reactions, species } = world();
    const yieldOf = (id: string): number => {
      const index = reactions.indexOf(id);
      const first = reactions.reactantSpecies(index)[0] as number;
      const inputMass = (reactions.reactantMoles(index)[0] as number) * species.molarMass(first);
      const char = species.indexOf('C(char)');
      const products = reactions.productSpecies(index);
      let charMass = 0;
      for (let i = 0; i < products.length; i++) {
        if (products[i] === char)
          charMass += (reactions.productMoles(index)[i] as number) * species.molarMass(char);
      }
      return charMass / inputMass;
    };
    expect(yieldOf('pyrolyse-lignin')).toBeGreaterThan(0.4);
    expect(yieldOf('pyrolyse-lignin')).toBeLessThan(0.5);
    expect(yieldOf('cellulose-to-char')).toBeGreaterThan(0.2);
    expect(yieldOf('cellulose-to-char')).toBeLessThan(0.35);
  });

  it('releases HCN when leather burns, because the formula says so', () => {
    /*
     * Nothing here knows that burning protein is dangerous. Collagen carries 1.3 nitrogen per
     * residue, that nitrogen has to leave somewhere, and ammonia and hydrogen cyanide are where it
     * goes. `§8.4`: the model reports, it does not moralise.
     */
    const { reactions, species } = world();
    const index = reactions.indexOf('pyrolyse-collagen');
    const hcn = species.indexOf('HCN');
    expect([...reactions.productSpecies(index)]).toContain(hcn);
  });

  it('pins oak at the boiling point until it is dry, which is a property of the substance', () => {
    const { substances } = world();
    const oak = substances.indexOf('oak');
    expect(substances.definitionOf(oak).reactions).toContain('boil-water');
    expect(substances.ignitionOf(oak)?.pilotedSurfaceK).toBe(623);
  });

  it("puts a wood fire's volatiles at the heating value they are MEASURED to have", () => {
    /*
     * `§8.3` says the volatile mixture off wood comes out "near 16 MJ/kg", from wood-pyrolysis
     * product analyses. Nothing here was given that number: the tar's formation enthalpy came from
     * bio-oil's *higher* heating value and a sublimation enthalpy, and this is its **lower** heating
     * value falling out of a different reaction. 16.29 MJ/kg measured.
     */
    const { reactions, species } = world();
    const perKg =
      -reactions.enthalpyOf(reactions.indexOf('burn-tar')) /
      species.molarMass(species.indexOf('tar'));
    expect(perKg).toBeGreaterThan(15.5e6);
    expect(perKg).toBeLessThan(17e6);
  });

  it('COSTS A KILOGRAM OF OAK WHAT WOOD IS MEASURED TO COST TO PYROLYSE', () => {
    /*
     * **The check that says the C₂ cap has not bitten here.** Each component's endotherm on its own
     * looks extreme — hemicellulose at +1,025 kJ/kg and lignin at +1,191 — because this species set
     * stops at C₂ and its char is pure carbon, so the products hold more chemical energy per
     * kilogram than the solid did and the step that makes them absorbs the difference.
     *
     * What matters is the *aggregate over a real composition*, and it lands where wood is measured
     * to land: **+223 kJ/kg** if every gram of cellulose takes the char branch, **+696** if every
     * gram takes the volatile one, against a literature band of roughly zero to +700 for wood. The
     * real answer is between the two and moves with the heating rate, which is the point.
     *
     * Both figures are recorded rather than tuned; the band is the literature's, widened to hold
     * both ends of the branch competition.
     */
    const { reactions, species } = world();
    const dry: Record<string, number> = {
      cellulose: 0.43,
      hemicellulose: 0.26,
      lignin: 0.26,
      extractives: 0.04,
    };
    const sum = (celluloseBranch: string): number =>
      dry.cellulose! * perKilogram(reactions, species, celluloseBranch) +
      dry.hemicellulose! * perKilogram(reactions, species, 'pyrolyse-hemicellulose') +
      dry.lignin! * perKilogram(reactions, species, 'pyrolyse-lignin') +
      dry.extractives! * perKilogram(reactions, species, 'pyrolyse-extractives');

    const charring = sum('cellulose-to-char');
    const volatilising = sum('cellulose-to-tar');
    expect(charring).toBeGreaterThan(0);
    expect(charring).toBeLessThan(400000);
    expect(volatilising).toBeGreaterThan(charring);
    expect(volatilising).toBeLessThan(750000);
  });
});

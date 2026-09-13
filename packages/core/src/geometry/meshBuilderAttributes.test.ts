import { expect, test } from 'vitest';
import { MeshBuilder } from './meshBuilder.ts';
import { validateMeshData } from '../render/mesh.ts';

/**
 * Every primitive emits exactly one value per vertex for every attribute.
 *
 * **The bug.** Each `add*` method pushed to the optional attribute arrays by hand, and
 * they had drifted out of agreement: `addQuad` and the box face helper pushed roughness
 * twice per vertex, `addCapsule` five times, and `addMesh`/`addOrientedMesh` never pushed
 * it at all. So a mesh's `roughness` array could be longer than its vertex count, or —
 * the case that mattered — shorter.
 *
 * A short attribute buffer is not benign. WebGL lets a driver read zeroes past the end
 * *or* drop the draw entirely, and both are conformant. Desktop drivers clamp and carry
 * on, so the author sees a perfect picture; Apple's rejects the draw, so the geometry
 * simply is not there. No GL error is raised on either path.
 *
 * What that cost: a courtyard scene that rendered flawlessly on every machine here and
 * arrived on an iPhone as a fire burning in an empty void. Its statues were merged with
 * `addOrientedMesh`, so its roughness array was short by exactly the vertices they
 * contributed. Six wrong diagnoses went past it — sampler binding, cube map sizes, a
 * reflection target, texture units, uniform array naming, dead point lights — because
 * every one of them was a theory about *shading*, and nothing was being shaded at all.
 *
 * Asserted per primitive rather than on one combined mesh, so a failure names the method
 * that broke rather than the builder in general.
 */

const RED: [number, number, number] = [1, 0, 0];

/** Every attribute array is exactly `perVertex` long per vertex. Nothing else will do. */
function expectConsistent(builder: MeshBuilder, what: string): void {
  const data = builder.build();
  const vertices = data.positions.length / 3;
  expect(vertices, `${what} produced no vertices`).toBeGreaterThan(0);

  expect(data.normals.length, `${what}: normals`).toBe(vertices * 3);
  expect(data.colors.length, `${what}: colors`).toBe(vertices * 3);
  expect(data.emissive.length, `${what}: emissive`).toBe(vertices);
  if (data.specular !== undefined) expect(data.specular.length, `${what}: specular`).toBe(vertices);
  if (data.uvs !== undefined) expect(data.uvs.length, `${what}: uvs`).toBe(vertices * 2);
  if (data.emissiveColor !== undefined) {
    expect(data.emissiveColor.length, `${what}: emissiveColor`).toBe(vertices * 3);
  }
  if (data.roughness !== undefined) {
    expect(data.roughness.length, `${what}: roughness`).toBe(vertices);
  }
  if (data.grain !== undefined) {
    expect(data.grain.length, `${what}: grain`).toBe(vertices);
  }

  // And the engine's own gate agrees, so the two cannot drift apart.
  expect(() => validateMeshData(data), `${what}: validateMeshData`).not.toThrow();
}

/*
 * Roughness is set on every builder, because the arrays are only *emitted* when some
 * vertex names a value — a builder that never mentions roughness omits the array
 * entirely and would pass this test without exercising anything.
 */
test('addBox emits one of every attribute per vertex', () => {
  const builder = new MeshBuilder().setGrain(0.5).setRoughness(0.3).setEmissiveColor([1, 0.5, 0]);
  builder.addBox([0, 0, 0], [1, 1, 1], RED, 0.2, 0.4);
  expectConsistent(builder, 'addBox');
});

test('addQuad emits one of every attribute per vertex', () => {
  const builder = new MeshBuilder().setGrain(0.5).setRoughness(0.3).setEmissiveColor([1, 0.5, 0]);
  builder.addQuad([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], RED, 0.2, 0.4);
  expectConsistent(builder, 'addQuad');
});

test('addCapsule emits one of every attribute per vertex', () => {
  // The worst of them: it was pushing roughness five times for each vertex.
  const builder = new MeshBuilder().setGrain(0.5).setRoughness(0.3).setEmissiveColor([1, 0.5, 0]);
  builder.addCapsule([0, 0, 0], 1, 2, RED, 0.2, 8);
  expectConsistent(builder, 'addCapsule');
});

test('addSphere emits one of every attribute per vertex', () => {
  const builder = new MeshBuilder().setGrain(0.5).setRoughness(0.3).setEmissiveColor([1, 0.5, 0]);
  builder.addSphere([0, 0, 0], 1, RED, 0.2, 10, 6);
  expectConsistent(builder, 'addSphere');
});

test('addCylinder emits one of every attribute per vertex', () => {
  const builder = new MeshBuilder().setGrain(0.5).setRoughness(0.3).setEmissiveColor([1, 0.5, 0]);
  builder.addCylinder([0, 0, 0], 1, 2, 'y', RED, 0.2, 10);
  expectConsistent(builder, 'addCylinder');
});

test('addTube emits one of every attribute per vertex', () => {
  const builder = new MeshBuilder().setGrain(0.5).setRoughness(0.3).setEmissiveColor([1, 0.5, 0]);
  builder.addTube([0, 0, 0, 0, 1, 0, 0, 2, 0], [0.5, 0.8, 0.3], RED, 0.2, 10);
  expectConsistent(builder, 'addTube');
});

test('addMesh carries roughness across, which is the merge path that failed', () => {
  /*
   * The defect exactly: merging carried every attribute except this one, so the result
   * was short by the number of vertices merged. Both merge paths are covered because
   * both were wrong, and `addOrientedMesh` is the one the broken scene actually used.
   */
  const source = new MeshBuilder().setGrain(0.5).setRoughness(0.9);
  source.addBox([0, 0, 0], [1, 1, 1], RED, 0, 0);
  const merged = source.build();

  const builder = new MeshBuilder().setGrain(0.5).setRoughness(0.3);
  builder.addBox([5, 0, 0], [1, 1, 1], RED, 0, 0);
  builder.addMesh(merged, 0, 0, 0, 1);
  expectConsistent(builder, 'addMesh');

  const oriented = new MeshBuilder().setGrain(0.5).setRoughness(0.3);
  oriented.addBox([5, 0, 0], [1, 1, 1], RED, 0, 0);
  oriented.addOrientedMesh(merged, [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 1);
  expectConsistent(oriented, 'addOrientedMesh');
});

test('a mesh that merges another keeps the merged mesh own roughness values', () => {
  // Carrying the array is not enough if it carries the wrong numbers.
  const source = new MeshBuilder().setGrain(0.5).setRoughness(0.9);
  source.addBox([0, 0, 0], [1, 1, 1], RED, 0, 0);

  const builder = new MeshBuilder().setGrain(0.5).setRoughness(0.2);
  builder.addMesh(source.build(), 0, 0, 0, 1);
  const data = builder.build();

  expect(
    data.roughness?.[0],
    'the merged mesh brought its own roughness, not the host’s',
  ).toBeCloseTo(0.9, 5);
});

test('grain is absent unless a surface asks for it, and absent means none', () => {
  /*
   * The contract the attribute exists for. Grain was inferred from `specular` and then
   * from `roughness`, and both inferences gave grain to surfaces that had never claimed
   * any — painted masonry at roughness 0.55 took 55% of it. A builder that never mentions
   * grain must emit no array at all, which is what makes "not mineral" expressible.
   */
  const plain = new MeshBuilder().setRoughness(0.88);
  plain.addBox([0, 0, 0], [1, 1, 1], RED, 0, 0.5);
  expect(plain.build().grain, 'a surface that never said it was mineral').toBeUndefined();

  const stone = new MeshBuilder().setGrain(0.8);
  stone.addBox([0, 0, 0], [1, 1, 1], RED, 0, 0);
  expect(stone.build().grain?.[0], 'and one that did').toBeCloseTo(0.8, 5);
});

test('a mesh that merges another keeps the merged mesh own grain', () => {
  // The merge path is where roughness was lost once; grain must not repeat it.
  const source = new MeshBuilder().setGrain(0.9);
  source.addBox([0, 0, 0], [1, 1, 1], RED, 0, 0);
  const merged = source.build();

  const builder = new MeshBuilder().setGrain(0.1);
  builder.addMesh(merged, 0, 0, 0, 1);
  expect(builder.build().grain?.[0], 'the merged mesh brought its own grain').toBeCloseTo(0.9, 5);

  const oriented = new MeshBuilder().setGrain(0.1);
  oriented.addOrientedMesh(merged, [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 1);
  expect(oriented.build().grain?.[0], 'through the oriented path too').toBeCloseTo(0.9, 5);
});

test('every primitive in one builder still agrees, which is how a real scene is built', () => {
  const builder = new MeshBuilder()
    .setGrain(0.5)
    .setRoughness(0.35)
    .setEmissiveColor([0.2, 0.4, 0.9]);
  builder.addBox([0, 0, 0], [1, 1, 1], RED, 0.1, 0.2);
  builder.addQuad([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], RED, 0, 0);
  builder.addCapsule([3, 0, 0], 0.5, 1, RED, 0, 8);
  builder.addSphere([6, 0, 0], 1, RED, 0, 10, 6);
  builder.addCylinder([9, 0, 0], 0.5, 2, 'y', RED, 0, 10);
  builder.addTube([12, 0, 0, 12, 1, 0], [0.4, 0.2], RED, 0, 8);
  expectConsistent(builder, 'a mixed scene');
});

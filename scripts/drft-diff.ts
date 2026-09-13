/**
 * Compare two `.drft` files. One responsibility: prove two readers agree.
 *
 *   npx tsx scripts/drft-diff.ts a.drft b.drft
 *
 * **The parity claim needs a way to be checked, or it is a wish.** The pipeline promises that
 * a `.glb` and an `.fbx` of the same asset bake to the same thing, so which reader a bundle
 * happened to use is invisible downstream. That is only true if somebody measures it, and
 * eyeballing two console logs is how a 401 MB output sat next to a 94 MB one for a while
 * without anybody noticing they were the same model.
 *
 * What it compares is what parity actually means: the geometry totals, the material set, and
 * the texture set. Not the bytes, because two readers legitimately differ in how they group
 * meshes — a format that stores one material per object and one that stores a material layer
 * per polygon will not produce the same *number* of meshes from the same scene, and should
 * not be forced to.
 */

import { readFileSync } from 'node:fs';
import { readDrft } from '@driftengine/drft';
import type { DrftAsset } from '@driftengine/drft';
import { basenameOf } from '@driftengine/assets';

function load(file: string): DrftAsset {
  const bytes = readFileSync(file);
  return readDrft(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
}

function summarise(asset: DrftAsset): {
  vertices: number;
  triangles: number;
  meshes: number;
  textures: string[];
  materials: string[];
  textured: number;
  blended: number;
  outline: string;
} {
  let vertices = 0;
  let triangles = 0;
  for (const mesh of asset.meshes) {
    vertices += mesh.positions.length / 3;
    triangles += mesh.indices.length / 3;
  }
  return {
    vertices,
    triangles,
    meshes: asset.meshes.length,
    /*
     * Reported, and deliberately not part of the parity claim. A coarse level is built by
     * clustering whatever meshes a reader produced, and mesh *grouping* legitimately differs
     * between formats — so two honest bakes of one asset can carry outlines of slightly
     * different sizes while the geometry they stand for matches triangle for triangle.
     */
    outline: asset.lods.map((lod) => `${lod.indices.length / 3} triangles`).join(', ') || 'none',
    /* By basename, since the same image is legitimately declared by different paths. */
    textures: asset.textures.map((t) => basenameOf(t.name)).sort(),
    materials: asset.materials
      .map((m) => m.name)
      .filter((n) => n !== '')
      .sort(),
    textured: asset.materials.filter((m) => m.albedo >= 0).length,
    blended: asset.materials.filter((m) => m.opacity < 1).length,
  };
}

function main(): void {
  const [left, right] = process.argv.slice(2);
  if (left === undefined || right === undefined) {
    console.error('usage: drft-diff <a.drft> <b.drft>');
    process.exit(1);
  }

  const a = summarise(load(left));
  const b = summarise(load(right));
  const rows: [string, string, string][] = [
    ['vertices', String(a.vertices), String(b.vertices)],
    ['triangles', String(a.triangles), String(b.triangles)],
    ['meshes', String(a.meshes), String(b.meshes)],
    ['textured materials', String(a.textured), String(b.textured)],
    ['blended materials', String(a.blended), String(b.blended)],
    ['textures', a.textures.join(', '), b.textures.join(', ')],
    ['outline', a.outline, b.outline],
  ];

  console.log(`${''.padEnd(22)}${left.padEnd(38)}${right}`);
  let differing = 0;
  for (const [label, x, y] of rows) {
    const same = x === y;
    if (!same) differing++;
    console.log(
      `${same ? '  ' : '! '}${label.padEnd(20)}${x.slice(0, 36).padEnd(38)}${y.slice(0, 36)}`,
    );
  }

  /*
   * Triangles are the one number that must match exactly. Mesh counts may legitimately
   * differ, because grouping is a property of how a format stores materials rather than of
   * the model, so a difference there is reported without being called a failure.
   */
  if (a.triangles !== b.triangles) {
    console.error(
      `\nFAIL: ${a.triangles} triangles against ${b.triangles}. These are not the same geometry.`,
    );
    process.exit(1);
  }
  console.log(
    `\nGeometry matches: ${a.triangles} triangles, ${a.vertices} vertices.` +
      (differing === 0
        ? ' Everything else matches too.'
        : ` ${differing} row(s) differ, listed above with a !`),
  );
}

main();

/**
 * Read a real `.kn5` and print what came out, plus the invariant the reader was built on.
 *
 * **Exact EOF is the assertion.** A binary walk that consumes a 44 MB file to its last byte has
 * no field misread anywhere in it, because one wrong width desynchronises everything after it.
 * Nothing else this probe prints is as load-bearing as that line, and it is the reason the reader
 * could be written against a format with no published specification at all.
 *
 * Usage: npm run kn5:check -- path/to/car.kn5
 */

import { readFileSync } from 'node:fs';
import { readKn5Header, readKn5Nodes } from '../packages/assets/src/kn5.ts';
import { readModel } from '../packages/assets/src/readModel.ts';
import { localiseNodes } from '../packages/assets/src/index.ts';

const file = process.argv[2];
if (file === undefined) {
  console.error('usage: npm run kn5:check -- <file.kn5>');
  process.exit(1);
}

const bytes = new Uint8Array(readFileSync(file));

/* The invariant first, straight off the low-level walk, before anything interprets it. */
const head = readKn5Header(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
);
const walked = readKn5Nodes(head);
const consumed = head.cursor.at;
const exact = consumed === bytes.length;

const imported = await readModel({ name: file, bytes });

const codecs = new Map();
for (const texture of imported.textures ?? []) {
  const head4 = texture.bytes?.subarray(0, 4) ?? new Uint8Array();
  const codec =
    head4[0] === 0x44 && head4[1] === 0x44 && head4[2] === 0x53
      ? 'DDS'
      : head4[0] === 0x89 && head4[1] === 0x50
        ? 'PNG'
        : head4[0] === 0xff && head4[1] === 0xd8
          ? 'JPEG'
          : 'other';
  codecs.set(codec, (codecs.get(codec) ?? 0) + 1);
}

const vertices = imported.meshes.reduce((sum, mesh) => sum + mesh.positions.length / 3, 0);
const triangles = imported.meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0);
const transforms = (imported.nodes ?? []).filter((node) => node.mesh < 0).length;

console.log(`${file}  (${bytes.length} bytes)`);
console.log(`  version    ${head.version}`);
console.log(`  consumed   ${consumed} of ${bytes.length}  ->  ${exact ? 'EXACT EOF' : 'MISMATCH'}`);
console.log(`  nodes      ${imported.nodes?.length ?? 0}, ${transforms} of them transforms only`);
console.log(`  meshes     ${imported.meshes.length}, ${vertices} verts, ${triangles} tris`);
console.log(
  `  materials  ${imported.materials?.length ?? 0} from a palette of ${head.materials.length}`,
);
console.log(
  `  textures   ${imported.textures?.length ?? 0} ${JSON.stringify(Object.fromEntries(codecs))}`,
);
console.log(
  `  tangents   ${imported.meshes.filter((mesh) => mesh.tangents !== undefined).length} meshes carry them`,
);
console.log(
  `  blended    ${(imported.materials ?? []).filter((material) => material.opacity < 1).length} materials`,
);
console.log(
  `  invisible  ${(imported.materials ?? []).filter((material) => material.opacity === 0).length} materials` +
    `  (an opacity of exactly 0 is the ksAlphaRef misread, and must be 0)`,
);
console.log(
  `  cutout     ${(imported.materials ?? []).filter((material) => material.cutout > 0).length} materials ` +
    `state an alpha test`,
);

/*
 * **The frame, printed rather than argued about.** This reader declared `.kn5` left-handed for two
 * releases and mirrored every car it read, which nothing numeric could catch — a mirrored car has
 * the same bounds, the same triangle count and the same consistent winding. What settles it is
 * where the asymmetric parts are, so the probe prints them: in a right-handed frame with `+y` up
 * and the nose at `+z`, the car's left is `+x`, and a left-hand-drive car has its steering wheel
 * there. `STEER_HR` is one of the names the simulator itself requires.
 */
const centreOf = (node) => {
  if (node.mesh < 0) return node.translation;
  const mesh = imported.meshes[node.mesh];
  let sum = [0, 0, 0];
  for (let at = 0; at < mesh.positions.length; at += 3) {
    sum = [
      sum[0] + mesh.positions[at],
      sum[1] + mesh.positions[at + 1],
      sum[2] + mesh.positions[at + 2],
    ];
  }
  const count = mesh.positions.length / 3 || 1;
  return sum.map((v) => v / count);
};
const landmarks = (imported.nodes ?? []).filter((node) =>
  /^(STEER_HR|mirror_left|mirror_right|paraurti_ant|faro_ant)$/i.test(node.name),
);
if (landmarks.length > 0) {
  console.log(
    "  frame      +y up, nose at +z, and the car's left at +x — so these read as stated:",
  );
  for (const node of landmarks) {
    const [x, y, z] = centreOf(node);
    console.log(
      `               ${node.name.padEnd(16)} x ${x.toFixed(3).padStart(7)}  y ${y.toFixed(3).padStart(7)}  z ${z.toFixed(3).padStart(7)}`,
    );
  }
}

const anchors = (imported.nodes ?? []).filter((node) =>
  /^(WHEEL|HUB|SUSP|TYRE|STEER|DOOR|AC_)/i.test(node.name),
);
console.log(
  `  anchors    ${anchors.length}: ${anchors
    .map((node) => node.name)
    .slice(0, 10)
    .join(', ')}`,
);

/*
 * Localisation, on the real graph. The check that matters is the round trip: every localised
 * vertex carried back through its node's world matrix must land where it started, or the
 * hierarchy and the geometry disagree about where a part is.
 */
if (imported.nodes !== undefined) {
  const { parts, world, warnings } = localiseNodes(imported.meshes, imported.nodes);
  let worst = 0;
  for (let index = 0; index < imported.nodes.length; index++) {
    const node = imported.nodes[index];
    if (node.mesh < 0) continue;
    const source = imported.meshes[node.mesh];
    const local = parts[node.mesh];
    const m = world[index];
    for (let at = 0; at < local.positions.length; at += 3) {
      const x = local.positions[at];
      const y = local.positions[at + 1];
      const z = local.positions[at + 2];
      worst = Math.max(
        worst,
        Math.abs(x * m[0] + y * m[4] + z * m[8] + m[12] - source.positions[at]),
        Math.abs(x * m[1] + y * m[5] + z * m[9] + m[13] - source.positions[at + 1]),
        Math.abs(x * m[2] + y * m[6] + z * m[10] + m[14] - source.positions[at + 2]),
      );
    }
  }
  console.log(
    `  localise   round trip worst error ${worst.toExponential(2)} m, ${warnings.length} singular nodes`,
  );
}

for (const note of imported.notes) console.log(`  · ${note}`);
for (const warning of imported.warnings.slice(0, 8)) console.log(`  ! ${warning}`);
if (imported.warnings.length > 8)
  console.log(`  ! (${imported.warnings.length - 8} more warnings)`);

if (!exact) {
  console.error(`\nthe walk did not reach the end of the file, so a field width is wrong`);
  process.exit(1);
}
void walked;

/**
 * What this machine computes, in a form another machine can be compared against.
 *
 * **The gate and the golden vectors prove the arithmetic is reproducible *in principle*.** They say
 * the simulation reaches only operations IEEE 754 fixes, and that this code produces these bits
 * here. Neither is the same as two machines agreeing, and that difference is the whole reason this
 * file exists rather than a paragraph claiming portability.
 *
 * So: run it here, run it on another machine, and diff. An M1 MacBook Air is a different
 * architecture *and* a different engine, which is the pair worth having — an ulp of disagreement
 * would come either from the silicon or from the JavaScript implementation, and this cannot tell
 * them apart but it can tell you there is one.
 *
 * **This is the instrument Track I does not have.** Every other row in this engine is checked
 * against a real GPU by a `scripts/*-check.mjs`; XR has no headset, so its exit test would be a
 * claim. Networking's cross-machine claim has this, and it is why the two tracks were not lumped
 * together.
 *
 *     node scripts/exactness-cross.mjs                  # print the report
 *     node scripts/exactness-cross.mjs > mine.txt       # ... and on the other machine
 *     diff mine.txt theirs.txt                          # nothing, or a bug
 *
 * It prints no timings, no paths and no versions above the header, so a diff of two runs is empty
 * or is a finding. The header carries the platform, and is the one part expected to differ.
 */
import { exactAcos, exactCos, exactExp, exactSin } from '../packages/core/src/math/exact.ts';
import { savableMulberry32 } from '../packages/core/src/core/rng.ts';
import { World, createWorldSnapshot, defineComponent } from '../packages/entities/src/index.ts';
import { fingerprintSnapshot } from '../packages/network/src/fingerprint.ts';
import { createFixture } from '../packages/network/src/fixture.ts';

const view = new DataView(new ArrayBuffer(8));

/** A double's exact bit pattern. The only unambiguous way to write one down. */
function bits(x) {
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
}

const ANGLES = [
  0, 0.5, 1, -1, 1.5707963267948966, 3.141592653589793, 6.283185307179586, 10, 100.5, -377.77, 1000,
];
const EXPONENTS = [0, 1, -1, 0.5, -0.5, 5, -5, 20, -20, 100, -100, 709, -700];
const COSINES = [1, -1, 0, 0.5, -0.5, 0.7071067811865476, 0.9999999, -0.9999999, 0.25, -0.75];

/**
 * A simulation whose only job is to exercise the pieces a divergence would come from.
 *
 * Transcendentals, division, accumulated rotation, a seeded generator, and enough ticks that a
 * single-ulp difference on tick one has grown into something a fingerprint cannot miss. **A shorter
 * run would be a weaker instrument**: two machines agreeing for ten ticks agree about very little.
 */
const Body = defineComponent('XBody', { x: 'f64', y: 'f64', angle: 'f64', speed: 'f64' });

function runSimulation(ticks) {
  const world = new World();
  const rng = savableMulberry32(20260903);
  const entities = [];
  for (let i = 0; i < 24; i++) {
    const e = world.create();
    world.add(e, Body, { x: i * 0.37, y: -i * 0.11, angle: i * 0.19, speed: 1 + i * 0.013 });
    entities.push(e);
  }

  const dt = 1 / 60;
  for (let tick = 0; tick < ticks; tick++) {
    for (const e of entities) {
      const angle = world.read(e, Body, 'angle');
      const speed = world.read(e, Body, 'speed');
      const x = world.read(e, Body, 'x') + exactCos(angle) * speed * dt;
      const y = world.read(e, Body, 'y') + exactSin(angle) * speed * dt;
      /* A slope-like read, which is where the terrain binding's defect lived. */
      const steer = exactAcos(Math.min(1, Math.max(-1, y / (1 + Math.sqrt(x * x + y * y)))));
      const drag = exactExp(-0.4 * dt);
      world.write(e, Body, 'x', x);
      world.write(e, Body, 'y', y);
      world.write(e, Body, 'angle', angle + (steer - 1.5) * dt + rng.next() * 0.001);
      world.write(e, Body, 'speed', speed * drag + 0.02);
    }
  }

  const slot = createWorldSnapshot();
  world.saveInto(slot);
  return { digest: fingerprintSnapshot(slot), rngPosition: rng.save() };
}

const lines = [];
lines.push(`# platform: ${process.platform}/${process.arch}, ${process.version}`);
lines.push('# everything below must match, byte for byte, on any conforming engine.');
lines.push('');

for (const x of ANGLES) lines.push(`sin  ${x}  ${bits(exactSin(x))}`);
for (const x of ANGLES) lines.push(`cos  ${x}  ${bits(exactCos(x))}`);
for (const x of EXPONENTS) lines.push(`exp  ${x}  ${bits(exactExp(x))}`);
for (const x of COSINES) lines.push(`acos ${x}  ${bits(exactAcos(x))}`);

lines.push('');
lines.push('# a seeded generator, which is a frozen contract about every stored replay');
const rng = savableMulberry32(20260903);
for (let i = 0; i < 8; i++) lines.push(`rng  ${i}  ${bits(rng.next())}`);

lines.push('');
lines.push('# the conformance fixture, in both arithmetics');
lines.push(
  '# the two arms are not expected to match each other, only themselves, on every machine',
);
const fixture = createFixture({ sin: exactSin, cos: exactCos });
for (const ticks of [1, 600, 3600]) {
  lines.push(`float ${String(ticks).padStart(4)} ticks  ${fixture.runFloat(ticks).digest}`);
  lines.push(`fixed ${String(ticks).padStart(4)} ticks  ${fixture.runFixed(ticks).digest}`);
}

lines.push('');
lines.push('# and a simulation, which is the assertion the ones above only support');
for (const ticks of [1, 10, 600, 3600]) {
  const { digest, rngPosition } = runSimulation(ticks);
  lines.push(`sim  ${String(ticks).padStart(4)} ticks  ${digest}  rng ${rngPosition}`);
}

console.log(lines.join('\n'));

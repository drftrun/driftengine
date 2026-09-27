/**
 * The baker finds copies an export merged into one mesh, and writes them as one mesh and `INST`.
 *
 * Driven through the real baker, and the container read back by `FORMAT.md` §4.2 rather than by
 * this repository's reader, for the reason `bake-textures.test.mjs` gives: a reader and a writer that
 * share a mistake agree with each other.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

/** A tetrahedron, repeated `copies` times along x in one glTF primitive, three metres apart. */
function mergedCopies(copies) {
  const tet = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
  const tris = [0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2];
  const positions = [];
  const normals = [];
  const indices = [];
  for (let k = 0; k < copies; k++) {
    for (let v = 0; v < 4; v++) {
      positions.push(tet[v * 3] + 3 * k, tet[v * 3 + 1], tet[v * 3 + 2]);
      const n = [tet[v * 3] - 0.25, tet[v * 3 + 1] - 0.25, tet[v * 3 + 2] - 0.25];
      const len = Math.hypot(...n);
      normals.push(n[0] / len, n[1] / len, n[2] / len);
    }
    for (const i of tris) indices.push(i + 4 * k);
  }
  const p = Buffer.from(new Float32Array(positions).buffer);
  const n = Buffer.from(new Float32Array(normals).buffer);
  const i = Buffer.from(new Uint16Array(indices).buffer);
  const bin = Buffer.concat([p, n, i]);
  const max = [3 * (copies - 1) + 1, 1, 1];
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: copies * 4, type: 'VEC3', min: [0, 0, 0], max },
      { bufferView: 1, componentType: 5126, count: copies * 4, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: indices.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: p.length },
      { buffer: 0, byteOffset: p.length, byteLength: n.length },
      { buffer: 0, byteOffset: p.length + n.length, byteLength: i.length },
    ],
    buffers: [
      {
        byteLength: bin.length,
        uri: `data:application/octet-stream;base64,${bin.toString('base64')}`,
      },
    ],
  };
}

function bake(doc, extra = []) {
  const dir = mkdtempSync(path.join(tmpdir(), 'drft-bake-'));
  try {
    const model = path.join(dir, 'model.gltf');
    const out = path.join(dir, 'model.drft');
    writeFileSync(model, JSON.stringify(doc));
    execFileSync(
      'npx',
      [
        'tsx',
        '--conditions=drift-source',
        'scripts/bake.ts',
        model,
        '-o',
        out,
        '--no-lod',
        ...extra,
      ],
      { stdio: 'pipe' },
    );
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every chunk as `{ code, flags, at, length }`, by the table §4.2 states. */
function chunks(container) {
  assert.equal(container.toString('ascii', 0, 4), 'DRFT');
  const count = container.readUInt32LE(12);
  const out = [];
  for (let i = 0; i < count; i++) {
    const entry = 32 + i * 16;
    out.push({
      code: container.toString('ascii', entry, entry + 4),
      at: container.readUInt32LE(entry + 4),
      length: container.readUInt32LE(entry + 8),
      flags: container.readUInt16LE(entry + 12),
    });
  }
  return out;
}

test('A MESH OF MERGED COPIES IS BAKED AS ONE COPY AND A REQUIRED INST CHUNK', () => {
  const container = bake(mergedCopies(5));
  const table = chunks(container);
  const inst = table.find((chunk) => chunk.code === 'INST');
  assert.ok(inst, 'an INST chunk');
  assert.equal(inst.flags & 1, 1, 'required');
  /* One group: mesh 0, five placements, the fifth moved twelve metres along x. */
  assert.equal(container.readUInt32LE(inst.at), 1);
  assert.equal(container.readUInt32LE(inst.at + 4), 0);
  assert.equal(container.readUInt32LE(inst.at + 8), 5);
  const fifth = inst.at + 12 + 4 * 64;
  assert.ok(Math.abs(container.readFloatLE(fifth + 12 * 4) - 12) < 1e-5, 'copy 4 at x = 12');
  /* And the one mesh holds one tetrahedron's worth of triangles. */
  /* `MSHQ` since 1.18, which the baker writes by default: the same two counts open its header. */
  const mesh = table.find((chunk) => chunk.code === 'MESH' || chunk.code === 'MSHQ');
  assert.ok(mesh);
  const vertexCount = container.readUInt32LE(mesh.at);
  const indexCount = container.readUInt32LE(mesh.at + 4);
  assert.equal(indexCount, 12, 'four triangles, one copy');
  assert.ok(vertexCount <= 12, `one copy's vertices, not five: ${vertexCount}`);
});

test('--no-instances bakes the merged mesh whole, as every bake before 1.18 did', () => {
  const table = chunks(bake(mergedCopies(5), ['--no-instances']));
  assert.equal(
    table.some((chunk) => chunk.code === 'INST'),
    false,
  );
});

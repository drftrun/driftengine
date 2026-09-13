/**
 * What the baker welds a normal-mapped corner soup down to.
 *
 * **The order a tangent frame is derived in, asserted through the real baker.** A great many files
 * store one vertex per triangle corner. `generateTangents` accumulates per index, so derived on
 * such a file every corner gets one triangle's frame, no two corners at a point agree, and the
 * weld — which keys on the frame, since a mirrored UV shell differs in nothing else — merges none
 * of them. The reader used to derive; the baker derives after welding now.
 *
 * The fixture's unwrap is **rotational**, and that is what makes it measure anything: the frame is
 * normalised, so what has to differ between two triangles is the direction u increases in and not
 * its rate. A separable unwrap gives every triangle on a plane one direction, every corner the
 * same frame, and a weld that never noticed.
 *
 * The count is read from the line the baker prints, which is the number a person reads.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const CELLS = 12;

/** A grid of quads as corner soup, unwrapped by angle and radius about its own centre. */
function soup(cells) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const push = (x, y) => {
    positions.push(x, y, 0);
    normals.push(0, 0, 1);
    const dx = x - cells / 2;
    const dy = y - cells / 2;
    uvs.push(Math.atan2(dy, dx) / (Math.PI * 2) + 0.5, Math.hypot(dx, dy) / cells);
  };
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      push(x, y);
      push(x + 1, y);
      push(x + 1, y + 1);
      push(x, y);
      push(x + 1, y + 1);
      push(x, y + 1);
    }
  }
  return { positions, normals, uvs, count: positions.length / 3 };
}

/** A 1x1 PNG, so the material can declare a normal map without a real image beside it. */
const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** A `.gltf` of that soup, whose one material declares a normal map when asked to. */
function gltf(normalMapped) {
  const { positions, normals, uvs, count } = soup(CELLS);
  const position = new Float32Array(positions);
  const normal = new Float32Array(normals);
  const uv = new Float32Array(uvs);
  const index = new Uint32Array(count);
  for (let i = 0; i < count; i++) index[i] = i;

  const parts = [position, normal, uv, index].map((a) => Buffer.from(a.buffer));
  const bin = Buffer.concat(parts);
  let at = 0;
  const views = parts.map((part) => {
    const view = { buffer: 0, byteOffset: at, byteLength: part.length };
    at += part.length;
    return view;
  });

  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [
          { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 },
        ],
      },
    ],
    materials: [normalMapped ? { normalTexture: { index: 0 } } : {}],
    textures: [{ source: 0 }],
    images: [{ name: 'n', uri: `data:image/png;base64,${ONE_PIXEL_PNG}` }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [CELLS, CELLS, 0],
      },
      { bufferView: 1, componentType: 5126, count, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count, type: 'VEC2' },
      { bufferView: 3, componentType: 5125, count, type: 'SCALAR' },
    ],
    bufferViews: views,
    buffers: [
      {
        byteLength: bin.length,
        uri: `data:application/octet-stream;base64,${bin.toString('base64')}`,
      },
    ],
  };
}

/** Bake it, and return what the baker says it wrote. */
function bakedVertices(normalMapped) {
  const dir = mkdtempSync(path.join(tmpdir(), 'drft-weld-'));
  try {
    const model = path.join(dir, 'model.gltf');
    writeFileSync(model, JSON.stringify(gltf(normalMapped)));
    const log = execFileSync(
      'npx',
      [
        'tsx',
        '--conditions=drift-source',
        'scripts/bake.ts',
        model,
        '-o',
        path.join(dir, 'model.drft'),
        '--no-lod',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const match = /([\d]+) vertices/.exec(log);
    assert.ok(match, `the baker printed no vertex count:\n${log}`);
    return Number(match[1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a normal-mapped corner soup welds as far as the same model with no map', () => {
  const corners = CELLS * CELLS * 6;
  const plain = bakedVertices(false);
  const mapped = bakedVertices(true);

  assert.equal(plain, (CELLS + 1) ** 2, 'the fixture welds hard, which the comparison rests on');
  assert.ok(
    plain < corners / 4,
    `${corners} corners should weld well below a quarter, got ${plain}`,
  );
  assert.equal(
    mapped,
    plain,
    'a material declaring a normal map must not cost vertices; the frame belongs after the weld',
  );
});

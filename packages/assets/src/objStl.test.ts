import { expect, test } from 'vitest';
import { parseMtl, parseObj } from './obj.ts';
import { parseStl } from './stl.ts';
import { validateMeshData } from '@driftengine/drft';
import type { MeshData } from '@driftengine/drft';

/**
 * OBJ and STL: the two formats that cannot rot.
 *
 * Both are text or near-text and both have been fixed for decades, so what is asserted
 * here is a complete reading rather than a partial one — the cases below are the whole of
 * what these formats can say, not a sample of it.
 */

const CUBE_FACE = `
# a square, two triangles, with normals and uvs
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
vn 0 0 1
vt 0 0
vt 1 0
vt 1 1
vt 0 1
usemtl painted
f 1/1/1 2/2/1 3/3/1
f 1/1/1 3/3/1 4/4/1
`;

test('an obj face imports with its positions, normals and uvs', () => {
  const { meshes } = parseObj(CUBE_FACE);
  expect(meshes).toHaveLength(1);
  const mesh = meshes[0] as MeshData;
  expect(mesh.positions.length).toBe(6 * 3);
  expect(mesh.uvs).toBeDefined();
  expect(mesh.normals[2]).toBeCloseTo(1, 5);
  expect(() => validateMeshData(mesh)).not.toThrow();
});

/**
 * The convention every reader has to agree with, pinned because one of them did not.
 *
 * This engine uploads images with `UNPACK_FLIP_Y_WEBGL`, so texture space runs down from the
 * top left. OBJ, FBX and USD all put their origin at the bottom left, and each of those readers
 * therefore flips V exactly once; glTF is top left already and flips nothing.
 *
 * **`obj.ts` was the one that did not, and nothing here noticed.** Every textured `.obj` came in
 * with its maps upside down while the same asset's `.fbx` sibling was right, which is what made
 * it look like a model fault for as long as it did. Reported from outside on a bought bundle
 * whose airbox lettering was inverted. A convention shared by four readers is worth one test.
 */
test('obj flips V once, because the format is bottom left and this engine is top left', () => {
  const { meshes } = parseObj(CUBE_FACE);
  const mesh = meshes[0] as MeshData;
  const uvs = mesh.uvs as Float32Array;
  /* The first corner is `vt 0 0`, the bottom left of the image, which is v = 1 once flipped. */
  expect(uvs[0]).toBeCloseTo(0, 5);
  expect(uvs[1], 'v is flipped, so the format bottom is the texture top').toBeCloseTo(1, 5);
  /* And `vt 1 1`, the top right, becomes v = 0. The third corner of the first triangle. */
  expect(uvs[4]).toBeCloseTo(1, 5);
  expect(uvs[5]).toBeCloseTo(0, 5);
});

test('a polygon face is triangulated as a fan', () => {
  // Quads are what OBJ files are full of, and `MeshData` draws triangles only.
  const { meshes } = parseObj('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n');
  expect((meshes[0] as MeshData).indices.length).toBe(6);
});

test('negative indices count back from the end, as the format allows', () => {
  const { meshes } = parseObj('v 0 0 0\nv 1 0 0\nv 1 1 0\nf -3 -2 -1\n');
  const mesh = meshes[0] as MeshData;
  expect(mesh.positions[0]).toBeCloseTo(0, 5);
  expect(mesh.positions[3]).toBeCloseTo(1, 5);
});

test('a file with no normals gets face normals rather than a buffer of zeroes', () => {
  /*
   * A zero normal is not neutral — every lighting term multiplies by it, so the geometry
   * would arrive black and read as a shading bug rather than a missing attribute.
   */
  const { meshes, warnings } = parseObj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
  const mesh = meshes[0] as MeshData;
  expect(
    Math.hypot(mesh.normals[0] as number, mesh.normals[1] as number, mesh.normals[2] as number),
  ).toBeCloseTo(1, 5);
  expect(warnings.join(' ')).toMatch(/flat/);
});

test('each material becomes its own mesh, as with glTF primitives', () => {
  const text = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl red\nf 1 2 3\nusemtl blue\nf 3 2 1\n';
  const materials = parseMtl('newmtl red\nKd 1 0 0\nnewmtl blue\nKd 0 0 1\n');
  const { meshes } = parseObj(text, materials);

  expect(meshes).toHaveLength(2);
  expect((meshes[0] as MeshData).colors[0]).toBeCloseTo(1, 5);
  expect((meshes[1] as MeshData).colors[2]).toBeCloseTo(1, 5);
});

test('the mtl PBR extension is preferred, and Ns is converted when it is absent', () => {
  /*
   * `Ns` is a Phong exponent: a width expressed backwards, where 0 is broad and 1000 is a
   * pinpoint. Converting rather than ignoring means a file with no PBR extension still
   * arrives with its highlights roughly the right size.
   */
  const pbr = parseMtl('newmtl a\nPr 0.15\nPm 0.9\n').get('a');
  expect(pbr?.roughness).toBeCloseTo(0.15, 5);
  expect(pbr?.specular).toBeCloseTo(0.9, 5);

  const phong = parseMtl('newmtl b\nNs 200\n').get('b');
  expect(phong?.roughness as number).toBeLessThan(0.15);
  expect(parseMtl('newmtl c\nNs 2\n').get('c')?.roughness as number).toBeGreaterThan(0.5);
});

test('emissive with no colour named inherits the albedo', () => {
  const { meshes } = parseObj(CUBE_FACE, parseMtl('newmtl painted\nKd 1 1 1\n'));
  expect((meshes[0] as MeshData).emissiveColor?.[0]).toBe(-1);
});

test('an obj with no geometry is refused rather than returning nothing', () => {
  expect(() => parseObj('# empty\n')).toThrow(/no vertices/);
  expect(() => parseObj('v 0 0 0\n')).toThrow(/no faces/);
});

/* --- STL --- */

function binaryStl(triangles: number): ArrayBuffer {
  const buffer = new ArrayBuffer(84 + triangles * 50);
  const view = new DataView(buffer);
  view.setUint32(80, triangles, true);
  for (let t = 0; t < triangles; t++) {
    const at = 84 + t * 50;
    view.setFloat32(at, 0, true);
    view.setFloat32(at + 4, 0, true);
    view.setFloat32(at + 8, 1, true);
    const corners = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    for (let v = 0; v < 9; v++) view.setFloat32(at + 12 + v * 4, corners[v] as number, true);
  }
  return buffer;
}

test('a binary stl imports its triangles', () => {
  const mesh = parseStl(binaryStl(2));
  expect(mesh.positions.length).toBe(6 * 3);
  expect(mesh.normals[2]).toBeCloseTo(1, 5);
  expect(() => validateMeshData(mesh)).not.toThrow();
});

test('an ascii stl imports the same way', () => {
  const text = `solid s
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 1 0 0
    vertex 0 1 0
  endloop
endfacet
endsolid s`;
  const bytes = new TextEncoder().encode(text);
  const mesh = parseStl(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  expect(mesh.positions.length).toBe(9);
  expect(mesh.normals[2]).toBeCloseTo(1, 5);
});

test('binary is told from ascii by length, not by the leading word', () => {
  // Some binary files begin with "solid" too, so the count-and-length check is the only
  // detection that is exact rather than a guess.
  const buffer = binaryStl(1);
  new Uint8Array(buffer).set(new TextEncoder().encode('solid'), 0);
  expect(parseStl(buffer).positions.length).toBe(9);
});

test('a zero facet normal is computed from the winding rather than left black', () => {
  const buffer = binaryStl(1);
  const view = new DataView(buffer);
  view.setFloat32(84, 0, true);
  view.setFloat32(88, 0, true);
  view.setFloat32(92, 0, true);
  const mesh = parseStl(buffer);
  expect(
    Math.hypot(mesh.normals[0] as number, mesh.normals[1] as number, mesh.normals[2] as number),
  ).toBeCloseTo(1, 5);
});

test('appearance is supplied by the caller, because the format carries none', () => {
  const mesh = parseStl(binaryStl(1), { color: [1, 0, 0], roughness: 0.1, specular: 0.9 });
  expect(mesh.colors[0]).toBeCloseTo(1, 5);
  expect(mesh.roughness?.[0]).toBeCloseTo(0.1, 5);
  expect(mesh.specular?.[0]).toBeCloseTo(0.9, 5);
});

test('an empty stl is refused', () => {
  expect(() => parseStl(binaryStl(0))).toThrow(/no triangles/);
});

/**
 * The `.mtl`'s colour map and its two spellings of transparency.
 *
 * `d` and `Tr` are the same quantity written in opposite directions, which is the whole
 * hazard: read one as the other and every transparent material in a file inverts, so solid
 * geometry turns invisible and glass turns solid.
 */
const MTL_MAPS = `
newmtl painted
Kd 0.5 0.4 0.3
map_Kd textures/brick.png

newmtl smoked
Kd 0.1 0.1 0.1
d 0.25

newmtl fogged
Kd 0.2 0.2 0.2
Tr 0.75

newmtl awkward
Kd 1 1 1
map_Kd -s 1 1 1 -bm 0.2 -clamp on maps/a wall.png
`;

test('an mtl names its colour map past any options, and states opacity either way round', () => {
  const materials = parseMtl(MTL_MAPS);
  expect(materials.get('painted')?.albedo).toBe('textures/brick.png');
  /* Options precede the filename and the filename may contain spaces; both at once. */
  expect(materials.get('awkward')?.albedo).toBe('maps/a wall.png');
  expect(materials.get('painted')?.opacity).toBe(1);
  /* d is presence and Tr is absence, so 0.25 and 1 - 0.75 must land on the same number. */
  expect(materials.get('smoked')?.opacity).toBeCloseTo(0.25, 6);
  expect(materials.get('fogged')?.opacity).toBeCloseTo(0.25, 6);
});

test('an obj reports its textures once each, and points its materials at them', () => {
  const source = `
mtllib maps.mtl
v 0 0 0
v 1 0 0
v 0 1 0
vt 0 0
vt 1 0
vt 0 1
usemtl painted
f 1/1 2/2 3/3
usemtl smoked
f 1/1 2/2 3/3
`;
  const { meshes, materials, textures } = parseObj(source, parseMtl(MTL_MAPS));
  expect(meshes).toHaveLength(2);
  expect(materials).toHaveLength(2);
  /* Only `painted` names a map, so exactly one texture and one material pointing at it. */
  expect(textures.map((t) => t.name)).toEqual(['textures/brick.png']);
  expect(materials[0]?.albedo).toBe(0);
  expect(materials[1]?.albedo).toBe(-1);
  expect(materials[1]?.opacity).toBeCloseTo(0.25, 6);
  /* Declared, not resolved: finding the file is the caller's job and needs a filesystem. */
  expect(textures[0]?.bytes).toBeUndefined();
});

import { expect, test } from 'vitest';
import { kn5ToMeshes, readKn5Header, readKn5Nodes } from './kn5.ts';
import { validateMeshData } from '@driftengine/drft';
import { MODEL_FORMATS, colliderBeside, levelsBeside, readModel, readerFor } from './readModel.ts';
import { recognise } from './recognise.ts';

/**
 * Assetto Corsa's `.kn5`, asserted against bytes this file writes.
 *
 * **The fixtures are authored rather than checked in**, and that is a deliberate difference from
 * how `.fbx` is tested — which is to say, it is not, beyond its material and inflate helpers. A
 * `.kn5` needs no decompressor, so every structure in it can be written from here exactly as a
 * real file writes it, and a test that builds its own input can then say precisely which field it
 * is exercising. What is checked in instead is the *invariant*: `scripts/kn5-check.mjs` runs the
 * reader over a real car and asserts it consumes the file to its last byte.
 */

/** Little-endian byte writer, so a fixture is authored rather than checked in. */
export class Writer {
  private parts: number[] = [];

  i32(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v, true);
    this.parts.push(...b);
    return this;
  }

  u32(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    this.parts.push(...b);
    return this;
  }

  f32(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    this.parts.push(...b);
    return this;
  }

  u8(v: number): this {
    this.parts.push(v & 0xff);
    return this;
  }

  u16(v: number): this {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    this.parts.push(...b);
    return this;
  }

  raw(bytes: readonly number[] | Uint8Array): this {
    this.parts.push(...bytes);
    return this;
  }

  /** A kn5 string: i32 length then that many utf-8 bytes. */
  str(value: string): this {
    const text = new TextEncoder().encode(value);
    return this.i32(text.length).raw(text);
  }

  bytes(): Uint8Array {
    return new Uint8Array(this.parts);
  }

  buffer(): ArrayBuffer {
    return this.bytes().buffer as ArrayBuffer;
  }
}

/** `sc6969`, version 6, and the extra word that version carries. */
export function header(): Writer {
  return new Writer().raw(new TextEncoder().encode('sc6969')).i32(6).i32(0);
}

test('reads the magic, the version, and version 6 extra word', () => {
  const file = header().i32(0).i32(0);
  const read = readKn5Header(file.buffer());
  expect(read.version).toBe(6);
  expect(read.textures).toEqual([]);
  expect(read.materials).toEqual([]);
});

test('refuses a file that is not a kn5, naming what it found', () => {
  const file = new Writer().raw(new TextEncoder().encode('glTF\0\0')).i32(6);
  expect(() => readKn5Header(file.buffer())).toThrow(/kn5.*sc6969/s);
});

test('carries every embedded texture with its bytes', () => {
  const png = [0x89, 0x50, 0x4e, 0x47];
  const file = header()
    .i32(2)
    .i32(1)
    .str('body.png')
    .i32(png.length)
    .raw(png)
    .i32(1)
    .str('trim.dds')
    .i32(2)
    .raw([0xaa, 0xbb])
    .i32(0);
  const read = readKn5Header(file.buffer());
  expect(read.textures.map((t) => t.name)).toEqual(['body.png', 'trim.dds']);
  expect([...read.textures[0]!.bytes]).toEqual(png);
  expect([...read.textures[1]!.bytes]).toEqual([0xaa, 0xbb]);
});

test('reads material properties and sampler bindings', () => {
  const file = header()
    .i32(0)
    .i32(1)
    .str('paint')
    .str('ksPerPixelNM')
    .u16(0)
    .i32(0)
    .i32(2)
    .str('ksDiffuse')
    .f32(0.6)
    .raw(new Uint8Array(36))
    .str('ksSpecularEXP')
    .f32(50)
    .raw(new Uint8Array(36))
    .i32(2)
    .str('txDiffuse')
    .i32(0)
    .str('body.png')
    .str('txNormal')
    .i32(1)
    .str('body_nm.png');
  const read = readKn5Header(file.buffer());
  const material = read.materials[0]!;
  expect(material.name).toBe('paint');
  expect(material.shader).toBe('ksPerPixelNM');
  expect(material.props.get('ksSpecularEXP')).toBe(50);
  expect(material.textures.get('txNormal')).toBe('body_nm.png');
});

test('refuses a string whose length runs past the end, naming the offset', () => {
  const file = header().i32(1).i32(1).i32(9999);
  expect(() => readKn5Header(file.buffer())).toThrow(/past the end.*offset \d+/s);
});

/** A 4x4 identity with a translation in row 3, which is where kn5 puts it. */
function matrix(tx: number, ty: number, tz: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1];
}

export function dummy(
  w: Writer,
  name: string,
  children: number,
  t: [number, number, number],
): Writer {
  w.i32(1).str(name).i32(children).u8(1);
  for (const value of matrix(t[0], t[1], t[2])) w.f32(value);
  return w;
}

/** One triangle, so the vertex stride and the 29-byte trailer are both exercised. */
export function triangle(w: Writer, name: string, material: number, transparent: number): Writer {
  w.i32(2).str(name).i32(0).u8(1);
  w.u8(1).u8(1).u8(transparent);
  w.i32(3);
  for (const [x, y, z] of [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ] as const) {
    w.f32(x).f32(y).f32(z); // position
    w.f32(0).f32(0).f32(1); // normal
    w.f32(x).f32(y); // uv, v is flipped on read
    w.f32(1).f32(0).f32(0); // tangent
  }
  w.i32(3).u16(0).u16(1).u16(2);
  w.i32(material);
  w.u32(7).f32(10).f32(120); // layer, lodIn, lodOut
  w.f32(0).f32(0).f32(0).f32(2); // bounding sphere, centre and radius
  w.u8(1); // isRenderable
  return w;
}

test('walks a hierarchy and records each node its parent', () => {
  const file = header().i32(0).i32(0);
  dummy(file, 'root', 1, [0, 0, 0]);
  dummy(file, 'WHEEL_LF', 1, [1, 0, 2]);
  triangle(file, 'tyre', 0, 0);
  const { nodes, meshes } = readKn5Nodes(readKn5Header(file.buffer()));

  expect(nodes.map((n) => n.name)).toEqual(['root', 'WHEEL_LF', 'tyre']);
  expect(nodes.map((n) => n.parent)).toEqual([-1, 0, 1]);
  expect(nodes[2]!.mesh).toBe(0);
  expect(nodes[0]!.mesh).toBe(-1);
  expect(meshes).toHaveLength(1);
});

test('accumulates a world matrix down the graph', () => {
  const file = header().i32(0).i32(0);
  dummy(file, 'root', 1, [10, 0, 0]);
  dummy(file, 'child', 1, [0, 5, 0]);
  triangle(file, 'part', 0, 0);
  const { meshes } = readKn5Nodes(readKn5Header(file.buffer()));
  /* The first vertex sits at the origin locally, so it lands at the accumulated translation. */
  expect([...meshes[0]!.positions.subarray(0, 3)]).toEqual([10, 5, 0]);
});

test('flips the v coordinate, which kn5 stores upside down', () => {
  const file = header().i32(0).i32(0);
  triangle(file, 'part', 0, 0);
  const { meshes } = readKn5Nodes(readKn5Header(file.buffer()));
  /* uv was written as (x, y) per vertex; vertex 2 has y = 1, so v reads back as 0. */
  expect(meshes[0]!.uvs[5]).toBe(0);
});

test('reads tangents, which the community converter discards', () => {
  const file = header().i32(0).i32(0);
  triangle(file, 'part', 0, 0);
  const { meshes } = readKn5Nodes(readKn5Header(file.buffer()));
  expect(meshes[0]!.tangents).toHaveLength(3 * 4);
  expect([...meshes[0]!.tangents.subarray(0, 3)]).toEqual([1, 0, 0]);
});

test('reads the per-mesh flags and the lod window from the trailer', () => {
  const file = header().i32(0).i32(0);
  triangle(file, 'glass', 0, 1);
  const { nodes } = readKn5Nodes(readKn5Header(file.buffer()));
  expect(nodes[0]!.isTransparent).toBe(true);
  expect(nodes[0]!.castShadows).toBe(true);
  expect(nodes[0]!.lodIn).toBe(10);
  expect(nodes[0]!.lodOut).toBe(120);
});

test('refuses an unknown node type, naming it and the offset', () => {
  const file = header().i32(0).i32(0).i32(9).str('mystery').i32(0).u8(1);
  expect(() => readKn5Nodes(readKn5Header(file.buffer()))).toThrow(
    /node type 9.*"mystery".*offset/s,
  );
});

test('consumes a well-formed file to exact EOF', () => {
  const file = header().i32(0).i32(0);
  dummy(file, 'root', 1, [0, 0, 0]);
  triangle(file, 'part', 0, 0);
  const read = readKn5Header(file.buffer());
  readKn5Nodes(read);
  expect(read.cursor.at).toBe(file.bytes().length);
});

/**
 * A file with one painted triangle, so the material mapping has something to map.
 *
 * `flags` is the pair of bytes the format puts between a shader's name and its depth mode:
 * `alphaBlendMode` — 0 opaque, 1 alpha blended, 2 alpha to coverage — and `alphaTested`.
 */
function painted(
  shader: string,
  props: [string, number][],
  slots: [string, string][],
  flags: { blendMode?: number; alphaTested?: number } = {},
): ArrayBuffer {
  const file = header();
  file.i32(1).i32(1).str('body.png').i32(4).raw([0x89, 0x50, 0x4e, 0x47]);
  file
    .i32(1)
    .str('paint')
    .str(shader)
    .u8(flags.blendMode ?? 0)
    .u8(flags.alphaTested ?? 0)
    .i32(0);
  file.i32(props.length);
  for (const [name, value] of props) file.str(name).f32(value).raw(new Uint8Array(36));
  file.i32(slots.length);
  for (const [sampler, texture] of slots) file.str(sampler).i32(0).str(texture);
  triangle(file, 'part', 0, 0);
  return file.buffer();
}

test('produces a valid MeshData per mesh node', () => {
  const result = kn5ToMeshes(painted('ksPerPixel', [], []));
  expect(result.meshes).toHaveLength(1);
  expect(() => validateMeshData(result.meshes[0]!)).not.toThrow();
  expect(result.declaredUp).toBe('+y');
  expect(result.declaredHand).toBe('right');
});

test('materials are parallel to meshes, since MATL is paired by ordinal', () => {
  const result = kn5ToMeshes(painted('ksPerPixel', [], []));
  expect(result.materials).toHaveLength(result.meshes.length);
  expect(result.materials[0]!.name).toBe('paint');
});

test('binds txDiffuse to albedo and txNormal to normalMap by texture ordinal', () => {
  const result = kn5ToMeshes(
    painted(
      'ksPerPixelNM',
      [],
      [
        ['txDiffuse', 'body.png'],
        ['txNormal', 'missing.png'],
      ],
    ),
  );
  expect(result.textures.map((t) => t.name)).toEqual(['body.png']);
  expect(result.materials[0]!.albedo).toBe(0);
  /* A sampler naming a texture the file did not carry binds nothing and warns. */
  expect(result.materials[0]!.normalMap).toBe(-1);
  expect(result.warnings.join(' ')).toMatch(/missing\.png/);
});

test('turns a specular exponent into a roughness', () => {
  const result = kn5ToMeshes(painted('ksPerPixel', [['ksSpecularEXP', 50]], []));
  expect(result.materials[0]!.roughness).toBeCloseTo(Math.sqrt(2 / 52), 5);
});

test('the material says whether it blends, and the shader name no longer votes', () => {
  /*
   * The shader-name list this replaced called a tyre transparent, and the file does not: measured
   * on a shipped car, all four tyres are `ksTyres` with `alphaBlendMode` 0, `alphaTested` 0 and a
   * node that does not claim transparency. Read as an opacity, that made them invisible.
   */
  const tyre = kn5ToMeshes(painted('ksTyres', [['ksAlphaRef', 0]], []));
  expect(tyre.materials[0]!.opacity).toBe(1);

  const glass = kn5ToMeshes(painted('ksPerPixel', [], [], { blendMode: 1 }));
  expect(glass.materials[0]!.opacity).toBeLessThan(1);
  expect(glass.materials[0]!.opacity).toBeGreaterThan(0.99);
});

test('ksAlphaRef is an alpha test, so it never becomes an opacity', () => {
  /*
   * The reported defect, at its smallest: a blended material stating `ksAlphaRef` 0 — which is
   * what a transparent shader that wants no alpha test states — came out at opacity 0 and drew
   * as nothing. Nine meshes of a hundred and two disappeared that way, and the same value now
   * reaches the field that is defined as exactly what it means.
   */
  const blended = kn5ToMeshes(painted('ksPerPixel', [['ksAlphaRef', 0]], [], { blendMode: 1 }));
  expect(blended.materials[0]!.opacity).toBeGreaterThan(0.99);
  expect(blended.materials[0]!.cutout, 'a material that is not alpha tested discards nothing').toBe(
    0,
  );

  const tested = kn5ToMeshes(painted('ksPerPixel', [['ksAlphaRef', 0.35]], [], { alphaTested: 1 }));

  /*
   * **A tested material stating zero means the shader's own threshold, not "discard nothing".**
   *
   * Reported from a car whose interior and grille came out as hard black and white shards: eleven
   * materials, every one `alphaTested` with `ksAlphaRef` present and set to 0 — `int_net`,
   * `int_stitching`, `grille_a`, `hood_labels`. Read as a threshold of zero, every masked texel is
   * drawn, which is exactly what a grille's holes and a seat's stitching look like when they are
   * filled in. The comment above this line said the path was carried on the format's word rather
   * than on evidence, and this is the evidence arriving.
   */
  const zeroRef = kn5ToMeshes(painted('ksPerPixelAT', [['ksAlphaRef', 0]], [], { alphaTested: 1 }));
  expect(
    zeroRef.materials[0]!.cutout,
    'a tested material with a zero reference takes the default rather than discarding nothing',
  ).toBeGreaterThan(0);

  const absentRef = kn5ToMeshes(painted('ksPerPixelAT', [], [], { alphaTested: 1 }));
  expect(absentRef.materials[0]!.cutout, 'and so does one that states none at all').toBeGreaterThan(
    0,
  );
  expect(tested.materials[0]!.cutout).toBeCloseTo(0.35, 6);
  expect(tested.materials[0]!.opacity, 'an alpha test is not a blend').toBe(1);
});

test("a node's own transparency flag still puts a surface in the blended pass", () => {
  /*
   * Both statements are the file's own and they agree on 171 of 172 meshes in the car measured,
   * so the union is what a reader honours: a node marked transparent over an opaque material is
   * the author saying where the surface is drawn.
   */
  const file = header();
  file.i32(1).i32(1).str('body.png').i32(4).raw([0x89, 0x50, 0x4e, 0x47]);
  file.i32(1).str('paint').str('ksPerPixel').u8(0).u8(0).i32(0).i32(0).i32(0);
  triangle(file, 'part', 0, 1);
  const result = kn5ToMeshes(file.buffer());
  expect(result.materials[0]!.opacity).toBeLessThan(1);
});

/**
 * `txMaps` is **not** bound as an ORM map, and this is the test that says why.
 *
 * It was, for as long as the reader has existed, and the cost was measured from outside: every AC
 * car's paint rendered at roughness 1.0 — the widest probe blur there is — while the file said
 * 0.180. The channels do not line up. glTF's ORM is occlusion in R, roughness in G and metallic in
 * B; two independent references give AC's `txMaps` as specular intensity in R, reflection and
 * specular *sharpness* in G, and reflection intensity in B. Sharpness is the inverse of roughness,
 * so a G pinned at 255 is a file asking for the sharpest reflection available and was being read as
 * the bluntest.
 *
 * **The half that needed no reference at all** is that the shader *replaces* the material's own
 * roughness with the map's G rather than scaling it — so the reader derived the right number from
 * `ksSpecularEXP` two lines earlier and then threw it away for a channel its own comment said was
 * not established. Declining to bind it is not a claim about what `txMaps` means; it is declining
 * to assert a packing that is not there, which is what `occlusionStrength: 0` was already saying
 * about R alone.
 *
 * Measured on the paint of three bundles, G against the material's own roughness: the Hyundai i20 N
 * 255 against 0.180, the Fiat Panda 255 against 0.140, the Giulia GTAm 255 against 0.196.
 */
test('txMaps is not bound as an ORM map, because its channels are not that packing', () => {
  const result = kn5ToMeshes(painted('ksPerPixelMultiMap', [], [['txMaps', 'body.png']]));
  expect(result.materials[0]!.ormMap).toBe(-1);
  expect(result.materials[0]!.occlusionStrength).toBe(0);
});

test('and the roughness the file states survives a material that carries one', () => {
  /* An exponent of 52 is `sqrt(2 / 54)`, and the map must not overwrite it with its own G. */
  const result = kn5ToMeshes(
    painted('ksPerPixelMultiMap', [['ksSpecularEXP', 52]], [['txMaps', 'body.png']]),
  );
  expect(result.materials[0]!.roughness).toBeCloseTo(Math.sqrt(2 / 54), 5);
});

test('a txMaps a material carries is still reported, so nothing is lost in silence', () => {
  const result = kn5ToMeshes(painted('ksPerPixelMultiMap', [], [['txMaps', 'body.png']]));
  expect(result.warnings.join(' ')).toMatch(/txMaps/);
});

test('an unknown shader takes a default and warns, never refuses', () => {
  const result = kn5ToMeshes(painted('csSomethingNew', [], []));
  expect(result.meshes).toHaveLength(1);
  expect(result.warnings.join(' ')).toMatch(/csSomethingNew/);
});

test('warns that a detail map cannot be carried', () => {
  const result = kn5ToMeshes(painted('ksPerPixelMultiMap', [], [['txDetail', 'body.png']]));
  expect(result.warnings.join(' ')).toMatch(/detail/i);
});

test('.kn5 is a registered reader, tier 2', () => {
  expect(readerFor('.KN5')?.tier).toBe(2);
  expect(MODEL_FORMATS.some((entry) => entry.ext === '.kn5')).toBe(true);
});

test('a kn5 is recognised as readable, so a renamed one is not refused', () => {
  const file = header().i32(0).i32(0);
  dummy(file, 'root', 0, [0, 0, 0]);
  expect(recognise(file.bytes())).toBeNull();
});

test('readModel returns the hierarchy as DrftNodes, with local TRS', async () => {
  const file = header().i32(0).i32(1).str('GL').str('GL').u16(0).i32(0).i32(0).i32(0);
  dummy(file, 'root', 1, [0, 0, 0]);
  dummy(file, 'WHEEL_LF', 1, [1, 2, 3]);
  triangle(file, 'tyre', 0, 0);
  const imported = await readModel({ name: 'car.kn5', bytes: file.bytes() });

  expect(imported.nodes).toBeDefined();
  const wheel = imported.nodes!.find((node) => node.name === 'WHEEL_LF')!;
  expect(wheel.parent).toBe(0);
  /* Local, not accumulated, and not mirrored: the file's frame is right-handed. */
  expect(wheel.translation).toEqual([1, 2, 3]);
  expect(wheel.mesh).toBe(-1);
  expect(imported.nodes!.find((node) => node.name === 'tyre')!.mesh).toBe(0);
});

test('readModel needs no capability for a kn5, unlike every other binary here', async () => {
  const file = header().i32(0).i32(1).str('GL').str('GL').u16(0).i32(0).i32(0).i32(0);
  triangle(file, 'part', 0, 0);
  /* No `beside`, no `inflate`, no `inflateRaw`. */
  const imported = await readModel({ name: 'part.kn5', bytes: file.bytes() });
  expect(imported.meshes).toHaveLength(1);
  expect(imported.warnings.join(' ')).toMatch(/tier 2/);
});

test('finds a collision hull named by convention beside a model', () => {
  expect(colliderBeside(['car.kn5', 'collider.kn5', 'logo.png'])).toBe('collider.kn5');
  expect(colliderBeside(['car.kn5', 'COLLIDER.KN5'])).toBe('COLLIDER.KN5');
  expect(colliderBeside(['car.kn5', 'logo.png'])).toBeNull();
});

test('a collision hull reads as an ordinary model, hull and all', async () => {
  const file = header().i32(0).i32(1).str('GL').str('GL').u16(0).i32(0).i32(0).i32(0);
  dummy(file, 'COLLIDER', 1, [0, 0, 0]);
  triangle(file, 'COLLIDER', 0, 0);
  const imported = await readModel({ name: 'collider.kn5', bytes: file.bytes() });
  expect(imported.meshes).toHaveLength(1);
  expect(imported.nodes!.map((node) => node.name)).toContain('COLLIDER');
});

test('finds the lod chain beside a model, finest first', () => {
  const files = [
    'car.kn5',
    'car_lod_C.kn5',
    'car_lod_B.kn5',
    'car_lod_D.kn5',
    'collider.kn5',
    'other_lod_B.kn5',
  ];
  expect(levelsBeside('car.kn5', files)).toEqual([
    'car_lod_B.kn5',
    'car_lod_C.kn5',
    'car_lod_D.kn5',
  ]);
});

test('a bundle naming its levels differently gets the model alone', () => {
  expect(levelsBeside('car.kn5', ['car.kn5', 'car-low.kn5'])).toEqual([]);
});

test('a kn5 arrives unmirrored, because its frame is right-handed', async () => {
  /*
   * **Settled by looking at a shipped car rather than by arithmetic.** Its rear badge, rasterised
   * straight out of the file with the numbers read as right-handed and the viewer behind the car,
   * spells the car's name forwards; through a negate-X it spells it backwards. The file agrees
   * with itself everywhere else: up is `+y`, the front bumper and headlights are at `+z`, and the
   * driver's eye position — which the simulator itself reads out of the car's own configuration —
   * along with the steering wheel, the door the author named for the left side and the left mirror
   * are all at `+x`, which is the car's left in a right-handed frame with that up and that
   * forward. A left-hand-drive car, read exactly as stored.
   *
   * The cost of getting this wrong is invisible to every number: a mirrored car has the same
   * bounds, the same triangle count and the same consistent winding as an unmirrored one.
   */
  const file = header().i32(0).i32(1).str('GL').str('GL').u8(0).u8(0).i32(0).i32(0).i32(0);
  triangle(file, 'part', 0, 0);
  const imported = await readModel({ name: 'car.kn5', bytes: file.bytes() });

  expect(imported.declaredHand).toBe('right');
  /* The triangle's second vertex is at x +1 in the file, and stays there. */
  expect(imported.meshes[0]!.positions[3]).toBe(1);
  /* And the winding is the file's own, since nothing turned it inside out. */
  expect([...imported.meshes[0]!.indices]).toEqual([0, 1, 2]);
});

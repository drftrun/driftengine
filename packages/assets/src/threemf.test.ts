/**
 * The 3MF reader.
 *
 * A printing format, so the interesting parts are the two places it differs from every
 * other reader here: it carries no normals, and it states its colours in sRGB.
 */
import { expect, test } from 'vitest';
import { parseThreeMfModel, threeMfToMeshes } from './threemf.ts';
import { DrftError } from '@driftengine/drft';

/** A single triangle in the XY plane, coloured through the materials extension. */
const MODEL = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US">
  <resources>
    <m:colorgroup id="7">
      <m:color color="#B34D19FF" />
      <m:color color="#00000080" />
    </m:colorgroup>
    <object id="1" name="wedge" type="model" pid="7" pindex="0">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0" />
          <vertex x="10" y="0" z="0" />
          <vertex x="0" y="10" z="0" />
        </vertices>
        <triangles>
          <triangle v1="0" v2="1" v3="2" />
        </triangles>
      </mesh>
    </object>
  </resources>
</model>
`;

test('geometry and its derived normals come out of a format that carries none', () => {
  const result = parseThreeMfModel(MODEL);

  expect(result.meshes).toHaveLength(1);
  const mesh = result.meshes[0];
  if (mesh === undefined) throw new Error('no mesh');
  expect(mesh.indices.length).toBe(3);
  expect(mesh.positions.length / 3).toBe(3);

  /*
   * 3MF has no normals: a printing format describes a solid and leaves shading to whoever
   * shows it. Wound counter-clockwise in the XY plane, the derived normal is +Z, and every
   * vertex carries it — getting the cross product backwards would face the triangle away
   * and light it as if it were pointing into the ground.
   */
  expect(mesh.normals[0]).toBeCloseTo(0, 5);
  expect(mesh.normals[1]).toBeCloseTo(0, 5);
  expect(mesh.normals[2], 'the winding decides the facing').toBeCloseTo(1, 5);
});

test('a colour is converted from sRGB rather than taken as a byte', () => {
  /*
   * The failure this guards is not a crash, it is a scene that is uniformly too bright and
   * reads as a lighting bug. `#B3` is 0.70 as a byte and 0.45 linear, and only one of those
   * is what a renderer should multiply.
   */
  const material = parseThreeMfModel(MODEL).materials[0];
  if (material === undefined) throw new Error('no material');
  expect(material.name).toBe('wedge');
  expect(material.color[0], '0xB3 is 0.70 as sRGB and 0.45 linear').toBeCloseTo(0.4508, 3);
  expect(material.color[0]).not.toBeCloseTo(0.702, 2);
});

test('the alpha byte of a colour becomes opacity', () => {
  const withAlpha = MODEL.replace('pindex="0"', 'pindex="1"');
  expect(parseThreeMfModel(withAlpha).materials[0]?.opacity).toBeCloseTo(0.502, 2);
});

test('the unit is read, stated, and left for the container to carry', () => {
  expect(parseThreeMfModel(MODEL).unitScale, 'millimetres').toBeCloseTo(0.001, 6);
  expect(parseThreeMfModel(MODEL.replace('millimeter', 'inch')).unitScale).toBeCloseTo(0.0254, 6);
  /* Z-up is fixed by the specification, so it is a fact about the format, not about a file. */
  expect(parseThreeMfModel(MODEL).declaredUp).toBe('+z');
});

test('an unknown unit is said out loud rather than assumed away', () => {
  const odd = parseThreeMfModel(MODEL.replace('millimeter', 'furlong'));
  expect(odd.warnings.join(' ')).toContain('furlong');
  expect(odd.unitScale, 'and it falls back to the format default').toBeCloseTo(0.001, 6);
});

test('a triangle indexing a vertex that does not exist is refused', () => {
  const broken = MODEL.replace('v3="2"', 'v3="9"');
  expect(() => parseThreeMfModel(broken)).toThrow(/indexing 0, 1, 9 of 3/);
});

test('a model with no object at all is refused rather than returned empty', () => {
  expect(() => parseThreeMfModel('<model unit="meter"></model>')).toThrow(DrftError);
});

test('the archive is opened through the relationship it declares, not by guessing', () => {
  /*
   * The model part is named by the OPC relationships. Guessing `3D/3dmodel.model` works
   * until it meets an exporter that names it something else, and then it fails on a file
   * that is perfectly valid.
   */
  const inflate = (): Uint8Array => {
    throw new Error('these entries are stored, so nothing should ask to inflate');
  };
  const archive = storedZip([
    {
      name: '_rels/.rels',
      bytes: encode('<Relationships><Relationship Target="/parts/shape.model" /></Relationships>'),
    },
    { name: 'parts/shape.model', bytes: encode(MODEL) },
    { name: '3D/decoy.model', bytes: encode('<model unit="meter"></model>') },
  ]);
  const result = threeMfToMeshes(archive, inflate);
  expect(result.meshes, 'the declared part was read, not the decoy').toHaveLength(1);
});

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** A zip with every entry stored, which is enough to exercise the 3MF side. */
function storedZip(files: readonly { name: string; bytes: Uint8Array }[]): ArrayBuffer {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const local = new Uint8Array(30 + name.length + file.bytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(18, file.bytes.length, true);
    lv.setUint32(22, file.bytes.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(file.bytes, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(20, file.bytes.length, true);
    cv.setUint32(24, file.bytes.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, entry) => sum + entry.length, 0);
  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const local of locals) {
    out.set(local, at);
    at += local.length;
  }
  const centralStart = at;
  for (const central of centrals) {
    out.set(central, at);
    at += central.length;
  }
  const end = new DataView(out.buffer, at);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralStart, true);
  return out.buffer;
}

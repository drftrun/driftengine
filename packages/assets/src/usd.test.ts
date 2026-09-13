/**
 * The USD reader, held to the reader parity matrix.
 *
 * These are the columns that matrix asks a tier 1 format for — geometry, transforms,
 * materials, UVs, textures, opacity, reflectivity — plus the refusals that keep a partial
 * import from ever being produced. Written against a stage small enough to read, because a
 * fixture nobody can check by eye is a fixture that proves whatever the reader happens to do.
 */
import { expect, test } from 'vitest';
import { parseUsda, usdzToMeshes } from './usd.ts';
import { DrftError } from '@driftengine/drft';

/** A quad, one material, one texture, offset two metres along X by an xform op. */
const STAGE = `#usda 1.0
(
    defaultPrim = "root"
    metersPerUnit = 0.01
    upAxis = "Z"
)

def Xform "root"
{
    double3 xformOp:translate = (2, 0, 0)
    uniform token[] xformOpOrder = ["xformOp:translate"]

    def Mesh "panel"
    {
        int[] faceVertexCounts = [4]
        int[] faceVertexIndices = [0, 1, 2, 3]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]
        normal3f[] normals = [(0, 0, 1), (0, 0, 1), (0, 0, 1), (0, 0, 1)]
        texCoord2f[] primvars:st = [(0, 0), (1, 0), (1, 1), (0, 1)]
        rel material:binding = </root/paint>
    }

    def Material "paint"
    {
        token outputs:surface.connect = </root/paint/surface.outputs:surface>

        def Shader "surface"
        {
            uniform token info:id = "UsdPreviewSurface"
            color3f inputs:diffuseColor.connect = </root/paint/map.outputs:rgb>
            float inputs:metallic = 0.75
            float inputs:roughness = 0.2
            float inputs:opacity = 0.4
            color3f inputs:emissiveColor = (0.5, 0.25, 0)
        }

        def Shader "map"
        {
            uniform token info:id = "UsdUVTexture"
            asset inputs:file = @textures/paint.png@
        }
    }
}
`;

test('a stage yields triangulated geometry in world space, with its UVs flipped', () => {
  const result = parseUsda(STAGE);

  expect(result.meshes).toHaveLength(1);
  const mesh = result.meshes[0];
  if (mesh === undefined) throw new Error('no mesh');

  /* A quad is two triangles, and USD indexes corners, so four corners become four vertices. */
  expect(mesh.indices.length, 'a quad fans into two triangles').toBe(6);
  expect(mesh.positions.length / 3).toBe(4);

  /* The xform op is applied: the first corner sits at the origin plus the translation. */
  expect(mesh.positions[0]).toBeCloseTo(2, 5);
  expect(mesh.positions[1]).toBeCloseTo(0, 5);
  expect(mesh.positions[2]).toBeCloseTo(0, 5);

  /*
   * V flipped once, here, because USD puts the origin at the bottom left and this engine
   * uploads with it at the top left. The corner whose st is (0, 0) must arrive as (0, 1).
   */
  expect(mesh.uvs?.[0]).toBeCloseTo(0, 5);
  expect(mesh.uvs?.[1], 'the origin corner is flipped to the top').toBeCloseTo(1, 5);
});

test('the stage metadata is reported rather than applied', () => {
  /*
   * The reader states what the file claims and turns nothing, exactly as FBX does after the
   * upside-down car: one format-agnostic turn on the shared intermediate, told through
   * `--up`, is the only place an axis change is allowed to happen.
   */
  const result = parseUsda(STAGE);
  expect(result.declaredUp, 'USD says "Z" and means +z').toBe('+z');
  expect(result.unitScale, 'metersPerUnit, carried for the baker to scale by').toBeCloseTo(0.01, 6);
});

test('a UsdPreviewSurface fills every column the parity matrix asks for', () => {
  const result = parseUsda(STAGE);
  const material = result.materials[0];
  if (material === undefined) throw new Error('no material');

  expect(material.name).toBe('paint');
  expect(material.roughness).toBeCloseTo(0.2, 5);
  expect(material.opacity, 'opacity, which glass needs and the matrix names').toBeCloseTo(0.4, 5);
  /*
   * Metalness onto both specular and reflectivity, the same approximation `gltf.ts` makes
   * from the same input. It matters that the two agree rather than that either is exact: a
   * .glb and a .usdz of one asset have to bake to the same .drft.
   */
  expect(material.specular).toBeCloseTo(0.75, 5);
  expect(material.reflectivity).toBeCloseTo(0.75, 5);
  expect(material.emissive, 'emissive strength from the brightest channel').toBeCloseTo(0.5, 5);
  expect(material.emissiveColor[0]).toBeCloseTo(0.5, 5);
});

test('a texture is followed through the shader network it connects to', () => {
  /*
   * The value is not on the surface: `inputs:diffuseColor` connects to a UsdUVTexture, and
   * the image is that shader's `inputs:file`. One hop, which is what an exporter writes.
   */
  const result = parseUsda(STAGE);
  expect(result.textures.map((texture) => texture.name)).toEqual(['textures/paint.png']);
  expect(result.materials[0]?.albedo, 'and the material indexes it').toBe(0);
});

test('a mesh with no geometry is skipped and said, not silently dropped', () => {
  const empty = `#usda 1.0
def Mesh "hollow"
{
    int[] faceVertexCounts = []
    int[] faceVertexIndices = []
}

def Mesh "real"
{
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0, 1, 2]
    point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
}
`;
  const result = parseUsda(empty);
  expect(result.meshes).toHaveLength(1);
  expect(result.warnings.join(' ')).toContain('hollow');
});

test('an index past the end of the points is refused, not clamped', () => {
  /*
   * The same rule the container is built on: a file that is wrong is refused with what
   * failed, never approximated. An out-of-range index silently clamped is a mesh that draws
   * the wrong shape on one machine and drops the draw on another.
   */
  const broken = `#usda 1.0
def Mesh "wrong"
{
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0, 1, 9]
    point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
}
`;
  expect(() => parseUsda(broken)).toThrow(/indexes point 9 of 3/);
});

test('something that is not ASCII USD is refused immediately', () => {
  expect(() => parseUsda('PK not usd at all')).toThrow(DrftError);
  expect(() => parseUsda('#usda 1.0\n')).toThrow(/no readable Mesh/);
});

test('a usdz holding only a binary crate refuses and names the way out', () => {
  /*
   * `.usdc` is a separate specified reader, and half-reading it would be exactly the partial
   * import tier 1 forbids. The refusal has to name the tool that converts it, or somebody is
   * left with a file that does not work and no next step.
   */
  const archive = storedZip([
    { name: 'model.usdc', bytes: new Uint8Array([0x50, 0x58, 0x52, 0x2d]) },
  ]);
  expect(() => usdzToMeshes(archive)).toThrow(/usdcat/);
});

test('a usdz resolves its own images, so nothing is left for a filesystem to find', () => {
  /*
   * The archive is the whole asset. A texture the stage names by a relative path has to come
   * out with bytes attached, or the baker goes looking for a file that only exists inside the
   * zip it was just handed.
   */
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const archive = storedZip([
    { name: 'model.usda', bytes: new TextEncoder().encode(STAGE) },
    { name: 'textures/paint.png', bytes: png },
  ]);
  const result = usdzToMeshes(archive);
  expect(result.textures).toHaveLength(1);
  expect(
    result.textures[0]?.bytes,
    'carried out of the archive rather than resolved later',
  ).toEqual(png);
});

/**
 * A zip with every entry STORED, which is what a conforming `.usdz` is.
 *
 * Built here rather than checked in, because what these tests are about is the USD inside;
 * `zip.test.ts` is where the container's own traps live.
 */
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
    lv.setUint16(8, 0, true); // stored
    lv.setUint32(14, 0, true); // crc, unchecked by the reader
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
    cv.setUint32(16, 0, true);
    cv.setUint32(20, file.bytes.length, true);
    cv.setUint32(24, file.bytes.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, entry) => sum + entry.length, 0);
  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
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

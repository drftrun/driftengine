import { expect, test } from 'vitest';
import { gltfToMeshes } from './gltf.ts';
import type { GltfDocument } from './gltf.ts';

/**
 * `KHR_lights_punctual`: a model's lamps come out where its author put them, in world space.
 *
 * The expected places are derived by hand from the node transforms, and the defaults are the
 * extension's own: colour white, intensity 1, no range, a spot's cone 0 to a quarter turn.
 */

const POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);

function lit(extra: Partial<GltfDocument>) {
  const positions = new Uint8Array(POSITIONS.buffer.slice(0));
  const doc: GltfDocument = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0, 1] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length }],
    buffers: [{ byteLength: positions.length }],
    ...extra,
  };
  return gltfToMeshes(doc, [positions]);
}

test('A LAMP UNDER A MOVED PARENT IS WHERE THE PARENT PUT IT, and a spot points down its node', () => {
  const { lights } = lit({
    extensionsUsed: ['KHR_lights_punctual'],
    extensions: {
      KHR_lights_punctual: {
        lights: [
          { type: 'point', color: [1, 0.5, 0.25], intensity: 40, range: 6 },
          { type: 'spot', spot: { innerConeAngle: 0.1, outerConeAngle: 0.5 } },
        ],
      },
    },
    nodes: [
      { mesh: 0 },
      {
        name: 'hanger',
        translation: [10, 4, 0],
        children: [2, 3],
      },
      { name: 'lamp', translation: [0, -1, 2], extensions: { KHR_lights_punctual: { light: 0 } } },
      /* A quarter turn about −x takes the node's −z to world −y: a spot aimed at the floor. (About
         +x takes it to +y, which a first version of this test expected and the reader refused.) */
      {
        name: 'down',
        rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2],
        extensions: { KHR_lights_punctual: { light: 1 } },
      },
    ],
  });
  expect(lights).toHaveLength(2);
  const [lamp, down] = lights;
  expect(lamp?.kind).toBe('point');
  expect(lamp?.name).toBe('lamp');
  expect(lamp?.position).toEqual([10, 3, 2]);
  expect(lamp?.color).toEqual([1, 0.5, 0.25]);
  expect([lamp?.intensity, lamp?.range]).toEqual([40, 6]);
  expect(down?.kind).toBe('spot');
  expect(down?.position).toEqual([10, 4, 0]);
  expect(down?.direction.map((v) => Math.round(v * 1e6) / 1e6 + 0)).toEqual([0, -1, 0]);
  /* The extension's defaults, where the file said nothing. */
  expect(down?.color).toEqual([1, 1, 1]);
  expect([down?.intensity, down?.range]).toEqual([1, 0]);
  expect([down?.innerConeRad, down?.outerConeRad]).toEqual([0.1, 0.5]);
});

test('a file requiring the lights extension is no longer told this reader lacks it', () => {
  const { warnings } = lit({
    extensionsRequired: ['KHR_lights_punctual'],
    nodes: [{ mesh: 0 }, {}],
  });
  expect(warnings.some((w) => w.includes('KHR_lights_punctual'))).toBe(false);
});

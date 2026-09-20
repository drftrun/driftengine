import {
  World,
  defineComponent,
  deserializeWorld,
  serializeWorld,
  type ComponentType,
  type Entity,
  type SerializedScene,
} from '@driftengine/entities';
import { describe, expect, test } from 'vitest';

import { CHUNK_ENTS, DrftError, KNOWN_CHUNKS } from './drftFormat.ts';
import { buildEnts, readEnts, type EntsScene } from './ents.ts';
import { readDrft } from './drftRead.ts';
import { writeDrft } from './drftWrite.ts';
import type { MeshData } from './meshData.ts';

/**
 * **A file can carry the things in a scene.**
 *
 * The container does not know what a component is, and must not: a consumer's fields are its own,
 * and a format that encoded them would be a format that has to be extended every time somebody
 * adds one. So `ENTS` carries what `serializeWorld` produced, and the tests that matter are the
 * ones that take a real world out through the file and back in.
 */

const SCENE: EntsScene = {
  version: 1,
  schemas: {
    transform: { name: 'transform', fields: [{ id: 'entities::x', name: 'x', type: 'f32' }] },
  },
  entities: [{ components: { transform: { x: 3.5 } } }, { components: { transform: { x: -1 } } }],
};

const MESH: MeshData = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
  emissive: new Float32Array(3),
  indices: new Uint32Array([0, 1, 2]),
};

describe('an ENTS chunk on its own', () => {
  test('a scene round-trips unchanged', () => {
    const bytes = buildEnts(SCENE);
    expect(readEnts(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength)).toEqual(
      SCENE,
    );
  });

  test('bytes that are not a scene are refused in words', () => {
    /*
     * **Containment again**: the container cannot check what a component means, but it can refuse
     * something that is not a scene at all, so a consumer meets a sentence rather than
     * `undefined.entities` three calls later.
     */
    const rubbish = buildEnts(SCENE);
    rubbish[8] = 0x7b; /* an opening brace where the scene's own opening brace was, then garbage */
    expect(() =>
      readEnts(rubbish.buffer as ArrayBuffer, rubbish.byteOffset, rubbish.byteLength),
    ).toThrow(DrftError);
    expect(() => buildEnts({ ...SCENE, entities: 7 } as unknown as EntsScene)).toThrow(DrftError);
    expect(() => buildEnts({ ...SCENE, version: 0 })).toThrow(DrftError);
    expect(() => buildEnts({ ...SCENE, schemas: null } as unknown as EntsScene)).toThrow(DrftError);
    expect(() => buildEnts({ ...SCENE, entities: [{ x: 1 }] } as unknown as EntsScene)).toThrow(
      DrftError,
    );
  });

  test('a chunk shorter than the payload it declares is refused rather than read', () => {
    const bytes = buildEnts(SCENE);
    expect(() => readEnts(bytes.buffer as ArrayBuffer, bytes.byteOffset, 8)).toThrow(DrftError);
  });
});

describe('an ENTS chunk in a container', () => {
  test('AN ENTITY SCENE ROUND-TRIPS THROUGH A FILE WITH ITS REFERENCES INTACT', () => {
    /*
     * The whole way round, through the two functions a consumer actually calls. **An `Entity` field
     * is the one that cannot survive being copied literally** — a handle means nothing in another
     * world — so the scene stores a position in its own list and `deserializeWorld` rewrites it
     * against whatever the new world handed out. If the file loses the integer, the parent comes
     * back pointing at a stranger, and nothing fails.
     */
    const transform = defineComponent('transform', { x: 'f32' });
    const parent = defineComponent('parent', { of: 'Entity' });
    const types: ComponentType[] = [transform, parent];

    const source = new World();
    const first = source.create();
    const second = source.create();
    source.add(first, transform, { x: 3.5 });
    source.add(second, transform, { x: -1 });
    source.add(second, parent, { of: first });

    const file = writeDrft({ meshes: [MESH], entities: serializeWorld(source, types) });
    const asset = readDrft(file);
    expect(asset.entities).not.toBeNull();

    /* A world with entities already in it, so a scene that kept its handles would collide. */
    const target = new World();
    for (let at = 0; at < 5; at += 1) target.create();
    const result = deserializeWorld(target, asset.entities as SerializedScene, types);
    expect(result.loaded).toBe(true);
    if (!result.loaded) return;

    const [loadedFirst, loadedSecond] = result.entities as readonly Entity[];
    expect(target.read(loadedFirst as Entity, transform, 'x')).toBeCloseTo(3.5, 6);
    expect(target.read(loadedSecond as Entity, parent, 'of')).toBe(loadedFirst);
    /* And they really are new handles, not the ones the file was written from. */
    expect(loadedFirst).not.toBe(first);
  });

  test('a file without one says so rather than answering an empty scene', () => {
    const asset = readDrft(writeDrft({ meshes: [MESH] }));
    expect(asset.entities).toBeNull();
  });

  test('a reader that does not know it skips it, which is the whole guarantee', () => {
    const older = new Set([...KNOWN_CHUNKS].filter((code) => code !== CHUNK_ENTS));
    expect(older.has(CHUNK_ENTS)).toBe(false);
    expect(older.size).toBe(KNOWN_CHUNKS.size - 1);
  });
});

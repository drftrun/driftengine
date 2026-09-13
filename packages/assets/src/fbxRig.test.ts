import { describe, expect, it } from 'vitest';

import { fbxToMeshes } from './fbx.ts';
import { readModel } from './readModel.ts';
import { D, I, L, S, connect, doubles, ints, longs, node, p, writeFbx } from './fbxHarness.ts';
import type { FbxWritable } from './fbxHarness.ts';

/**
 * A rig, read out of an FBX.
 *
 * **This is the bar that makes a character format useful, and it is the one `.fbx` did not reach.**
 * `readModel` documents `skins` and `clips` as "where the format carries them. glTF does; nothing
 * else here does", and FBX is how characters are sold — it is the only thing Mixamo exports, and a
 * bought character arrived here as a bag of triangles with no skeleton, no weights and no clip. A
 * clip can be authored afterwards; **a skin cannot be recovered from a mesh**, which is why it is
 * the half that matters most.
 *
 * The files that would prove this on real bytes are bought character assets, tens of megabytes and
 * licensed, so none of them can be committed here. `fbxHarness.ts` writes the records instead, in
 * the shape Autodesk's exporters emit them, and says at more length why.
 */

/** One second in FBX's own time unit, which is what `KeyTime` counts. */
const KTIME = 46186158000;

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const translation = (x: number, y: number, z: number): number[] => [
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  x,
  y,
  z,
  1,
];

/**
 * A quad on four control points, bound to two joints, with one translation curve.
 *
 * Deliberately small enough to assert by hand and deliberately *ragged*: the two clusters cover
 * two control points each rather than all four, so a reader that handed every vertex the same
 * influence would pass a fixture where every vertex has the same influence and fail here.
 */
function rigged(
  options: { readonly clip?: boolean; readonly weights?: readonly number[] } = {},
): ArrayBuffer {
  const [rootWeight = 1, tipWeight = 1] = options.weights ?? [];
  const objects: FbxWritable[] = [
    node(
      'Geometry',
      [L(100), S('Geometry::bar'), S('Mesh')],
      [
        node('Vertices', [doubles([0, 0, 0, 1, 0, 0, 1, 2, 0, 0, 2, 0])]),
        /* One quad, whose last corner is stored complemented. The reader fans it into two. */
        node('PolygonVertexIndex', [ints([0, 1, 2, -4])]),
        node(
          'LayerElementNormal',
          [I(0)],
          [
            node('MappingInformationType', [S('ByPolygonVertex')]),
            node('ReferenceInformationType', [S('Direct')]),
            node('Normals', [doubles([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])]),
          ],
        ),
      ],
    ),
    node('Model', [L(200), S('Model::bar'), S('Mesh')], [node('Properties70', [], [])]),
    node('Model', [L(300), S('Model::root'), S('LimbNode')], [node('Properties70', [], [])]),
    node(
      'Model',
      [L(301), S('Model::tip'), S('LimbNode')],
      [node('Properties70', [], [p('Lcl Translation', 'Lcl Translation', D(0), D(2), D(0))])],
    ),
    node('Deformer', [L(400), S('Deformer::skin'), S('Skin')], []),
    /*
     * **Both clusters carry a `Transform` that is nonsense on purpose.** It is the field the SDK
     * documents as the mesh's bind transform, and the bought character this reader was built for
     * fills it per cluster with something close to the inverse of that cluster's own
     * `TransformLink` — so a reader trusting it composes the bone's frame in twice. Every
     * expectation below is written as though this field does not exist, because it must not matter.
     */
    node(
      'Deformer',
      [L(401), S('SubDeformer::root'), S('Cluster')],
      [
        node('Indexes', [ints([0, 1])]),
        node('Weights', [doubles([rootWeight, rootWeight])]),
        node('Transform', [doubles(translation(0, -40, 40))]),
        node('TransformLink', [doubles(IDENTITY)]),
      ],
    ),
    node(
      'Deformer',
      [L(402), S('SubDeformer::tip'), S('Cluster')],
      [
        node('Indexes', [ints([2, 3])]),
        node('Weights', [doubles([tipWeight, tipWeight])]),
        node('Transform', [doubles(translation(0, -60, 60))]),
        node('TransformLink', [doubles(translation(0, 2, 0))]),
      ],
    ),
  ];

  const connections: FbxWritable[] = [
    connect(100, 200),
    connect(400, 100),
    connect(401, 400),
    connect(402, 400),
    /*
     * A bone's connection to its cluster is written before its connection to its parent bone, which
     * is what a real exporter does and what a reader taking "the first OO parent" gets wrong: the
     * tip's parent would come back as a cluster rather than as the root.
     */
    connect(300, 401),
    connect(301, 402),
    connect(301, 300),
  ];

  if (options.clip === true) {
    objects.push(
      node(
        'AnimationStack',
        [L(500), S('AnimStack::Take 001'), S('')],
        [node('Properties70', [], [p('LocalStop', 'KTime', L(KTIME))])],
      ),
      node('AnimationLayer', [L(501), S('AnimLayer::BaseLayer'), S('')], []),
      node(
        'AnimationCurveNode',
        [L(502), S('AnimCurveNode::T'), S('')],
        [
          node(
            'Properties70',
            [],
            [p('d|X', 'Number', D(0)), p('d|Y', 'Number', D(2)), p('d|Z', 'Number', D(0))],
          ),
        ],
      ),
      node(
        'AnimationCurve',
        [L(503), S('AnimCurve::'), S('')],
        [node('KeyTime', [longs([0, KTIME])]), node('KeyValueFloat', [doubles([0, 5])])],
      ),
    );
    connections.push(
      connect(501, 500),
      connect(502, 501),
      connect(502, 301, 'Lcl Translation'),
      connect(503, 502, 'd|X'),
    );
  }

  return writeFbx([
    node('FBXHeaderExtension', [], [node('FBXVersion', [I(7400)])]),
    node('Objects', [], objects),
    node('Connections', [], connections),
  ]);
}

const read = (buffer: ArrayBuffer) =>
  fbxToMeshes(buffer, () => {
    throw new Error('the harness writes uncompressed arrays, so nothing should ask to inflate');
  });

describe('a skin', () => {
  /**
   * **The skeleton, sorted parents-first**, which is a requirement rather than a convention:
   * `Skeleton` refuses an unsorted rig because a palette is resolved in index order, and a nearly
   * sorted one is wrong in exactly one limb.
   */
  it('reads the joints a cluster names, parents before children', () => {
    const result = read(rigged());

    expect(result.skins).toHaveLength(1);
    const skin = result.skins[0];
    expect(skin?.joints.map((joint) => joint.name)).toEqual(['root', 'tip']);
    expect(skin?.joints[0]?.parent, 'a root of the skin').toBe(-1);
    expect(skin?.joints[1]?.parent, 'and its child, by index into this array').toBe(0);
  });

  /**
   * **`inverseBind` takes a vertex from model space into the joint's bind-pose space**, which is
   * what makes a palette identity at the bind pose. It is the bone's bind transform undone, and
   * where the mesh was bound applied: `inverse(TransformLink) * meshWorld`. The mesh's half comes
   * from the node graph and never from the cluster, which the fixture's deliberately wrong
   * `Transform` is here to prove.
   */
  it('undoes the bone’s bind transform, and ignores the cluster’s claim about the mesh', () => {
    const skin = read(rigged()).skins[0];

    expect(Array.from(skin?.inverseBind.slice(0, 16) ?? []), 'the root, at the origin').toEqual(
      IDENTITY,
    );
    expect(
      Array.from(skin?.inverseBind.slice(16, 32) ?? []),
      'the tip, two metres up, so its inverse bind takes a vertex two metres down',
    ).toEqual(translation(0, -2, 0));
  });

  /**
   * **The test above cannot tell a right formula from a wrong one, and this one can.**
   *
   * Both bones there sit on a mesh at the origin, so every candidate for "where was the mesh when
   * it was bound" gives the same answer and a reader taking any of them would pass. That is the
   * shape of fixture that lets a defect ship, and it did: 3.40.0 went out composing the *cluster's*
   * `Transform` into the inverse bind, which is what the SDK documents it as and is not what
   * exporters write. Here the mesh is bound three metres along x by its own node, so a reader
   * reading that from the wrong place lands three metres away.
   */
  it('takes where the mesh was bound from the node graph, which is the only authority for it', () => {
    const buffer = writeFbx([
      node('FBXHeaderExtension', [], [node('FBXVersion', [I(7400)])]),
      node(
        'Objects',
        [],
        [
          node(
            'Geometry',
            [L(100), S('bar'), S('Mesh')],
            [
              node('Vertices', [doubles([0, 0, 0, 1, 0, 0, 0, 1, 0])]),
              node('PolygonVertexIndex', [ints([0, 1, -3])]),
            ],
          ),
          node(
            'Model',
            [L(200), S('bar'), S('Mesh')],
            [node('Properties70', [], [p('Lcl Translation', 'Lcl Translation', D(3), D(0), D(0))])],
          ),
          node('Model', [L(300), S('root'), S('LimbNode')], [node('Properties70', [], [])]),
          node('Deformer', [L(400), S('skin'), S('Skin')], []),
          node(
            'Deformer',
            [L(401), S('root'), S('Cluster')],
            [
              node('Indexes', [ints([0, 1, 2])]),
              node('Weights', [doubles([1, 1, 1])]),
              /*
               * Deliberately nonsense, and deliberately *plausible* nonsense: this is the field the SDK
               * says holds the mesh's bind transform, and the measured character fills it with something
               * close to the inverse of this cluster's own `TransformLink` instead. A reader that trusts
               * it composes the bone's frame in twice.
               */
              node('Transform', [doubles(translation(0, -50, 50))]),
              node('TransformLink', [doubles(translation(0, 0, 7))]),
            ],
          ),
        ],
      ),
      node(
        'Connections',
        [],
        [connect(100, 200), connect(400, 100), connect(401, 400), connect(300, 401)],
      ),
    ]);

    const skin = read(buffer).skins[0];

    expect(
      Array.from(skin?.inverseBind.slice(0, 16) ?? []),
      'the bone seven along z undone, and the mesh three along x still applied',
    ).toEqual(translation(3, 0, -7));
  });

  /**
   * **The regression this hotfix is, stated as the measurement that found it.**
   *
   * Invert a joint's bind matrix, take the translation, and it should land on the geometry that
   * joint holds. On the bought character it landed on a mirror of the skeleton: the hip read
   * `(0, 94.4, -94.4)` where its vertices are at `(0.5, 102.8, -1.3)`, because the cluster's own
   * frame went in twice — and one joint came back at the origin, which no bind pose contains. Here
   * the same check runs on a bar bound to one bone, which is enough to tell a doubled frame from a
   * single one.
   */
  it('puts a joint where the vertices it holds actually are', () => {
    const result = read(rigged());
    const mesh = result.meshes[0];
    const skin = result.skins[0];

    /* Joint 1 holds control points 2 and 3, both at y = 2 by construction. */
    const inverseBind = Array.from(skin?.inverseBind.slice(16, 32) ?? []);
    /* Where the joint is, which is the translation of the inverse of its bind matrix. Its bind is a
       pure translation here, so inverting it is a negation and the expectation stays hand-derived. */
    const jointY = -(inverseBind[13] as number);
    let held = 0;
    let sum = 0;
    for (let v = 0; v < (mesh?.positions.length ?? 0) / 3; v++) {
      if (mesh?.joints?.[v * 4] !== 1) continue;
      held++;
      sum += mesh?.positions[v * 3 + 1] as number;
    }

    expect(held, 'the two control points the tip cluster names').toBe(2);
    expect(jointY, 'and the joint sits on them rather than on a mirror of them').toBeCloseTo(
      sum / held,
      5,
    );
  });

  /**
   * The per-vertex half, which is the thing `.drft` learned to carry at 1.11 and which nothing
   * could produce for an FBX until now.
   */
  it('puts four influences a vertex on the mesh itself', () => {
    const mesh = read(rigged()).meshes[0];
    const vertices = mesh === undefined ? 0 : mesh.positions.length / 3;

    expect(mesh?.joints?.length, 'four floats a vertex').toBe(vertices * 4);
    expect(mesh?.weights?.length).toBe(vertices * 4);
    /* Control points 0 and 1 belong to the root and 2 and 3 to the tip, by construction. */
    expect(Array.from(mesh?.joints?.slice(0, 4) ?? [])).toEqual([0, 0, 0, 0]);
    expect(Array.from(mesh?.weights?.slice(0, 4) ?? [])).toEqual([1, 0, 0, 0]);
    expect(Array.from(mesh?.joints?.slice(8, 12) ?? [])).toEqual([1, 0, 0, 0]);
    expect(Array.from(mesh?.weights?.slice(8, 12) ?? [])).toEqual([1, 0, 0, 0]);
  });

  /**
   * **Weights are normalised on the way in, warning per mesh**, which is the rule the glTF reader
   * already keeps in the same words. A vertex whose influences sum to a half is not half painted:
   * it is a vertex that collapses towards the origin, which reads as geometry hanging off a figure
   * rather than as a number being wrong.
   */
  it('normalises weights that do not sum to one, and says so', () => {
    const result = read(rigged({ weights: [0.5, 0.25] }));
    const mesh = result.meshes[0];

    expect(Array.from(mesh?.weights?.slice(0, 4) ?? [])).toEqual([1, 0, 0, 0]);
    expect(result.warnings.join(' ')).toMatch(/normalis/i);
  });
});

describe('a clip', () => {
  it('reads a take, its tracks, and the joint each one drives', () => {
    const result = read(rigged({ clip: true }));

    expect(result.clips).toHaveLength(1);
    const clip = result.clips[0];
    expect(clip?.name).toBe('Take 001');
    expect(clip?.durationSec).toBeCloseTo(1, 5);
    expect(clip?.tracks).toHaveLength(1);
    const track = clip?.tracks[0];
    expect(track?.joint, 'the tip, which is joint 1 in the sorted skeleton').toBe(1);
    expect(track?.path).toBe('translation');
    expect(Array.from(track?.times ?? [])).toEqual([0, 1]);
    /*
     * Three floats a key. Only X is curved; Y and Z come from the curve node's own defaults, which
     * is where FBX puts the value of a channel nothing animates — reading them as zero would drop
     * the joint to the floor for the whole clip.
     */
    expect(Array.from(track?.values ?? [])).toEqual([0, 2, 0, 5, 2, 0]);
  });

  /** A file with no `AnimationStack` has no clips, which is not the same as having an empty one. */
  it('reads none from a file that carries none', () => {
    expect(read(rigged()).clips).toEqual([]);
  });
});

/**
 * **Indexed, rather than one vertex per corner.**
 *
 * The reader emitted `indices[i] = i` over every corner it had fanned, so a bought character came
 * back with five times the vertices its own file describes — 64,518 against the 12,216 the same
 * asset gives through glTF. The baker welds, so a baked asset was never affected; anything calling
 * `readModel` directly was.
 */
describe('the geometry a rig hangs off', () => {
  it('shares a vertex between the triangles that meet at it', () => {
    const mesh = read(rigged()).meshes[0];

    expect(mesh?.indices.length, 'a quad, fanned into two triangles').toBe(6);
    expect(mesh?.positions.length ?? 0 / 3, 'over the four control points it names').toBe(4 * 3);
    expect(Array.from(mesh?.indices ?? []), 'the fan, in order').toEqual([0, 1, 2, 0, 2, 3]);
  });
});

/**
 * **A bone is connected to its cluster and to its parent bone, and only one of those is hierarchy.**
 *
 * `readTransforms` took the first `OO` parent it found for any object, which for a bone is
 * whichever of the two the exporter happened to write first. A cluster is not a model, so the walk
 * up to the world stopped there and returned identity — silently losing every ancestor above that
 * bone. A mesh parented to a bone, which is how a rigid binding is authored and how the car rigs
 * in this repository are built, then drew as though its own bone were a root.
 *
 * The static path is what this is about, so the mesh here is deliberately *not* skinned: a skinned
 * one keeps its own space and would pass whatever the walk answered.
 */
it('walks a model’s hierarchy through models, not through the cluster a bone also names', () => {
  const buffer = writeFbx([
    node('FBXHeaderExtension', [], [node('FBXVersion', [I(7400)])]),
    node(
      'Objects',
      [],
      [
        node(
          'Geometry',
          [L(100), S('Geometry::prop'), S('Mesh')],
          [
            node('Vertices', [doubles([0, 0, 0, 1, 0, 0, 0, 1, 0])]),
            node('PolygonVertexIndex', [ints([0, 1, -3])]),
          ],
        ),
        node('Model', [L(200), S('Model::prop'), S('Mesh')], [node('Properties70', [], [])]),
        node(
          'Model',
          [L(300), S('Model::hand'), S('LimbNode')],
          [node('Properties70', [], [p('Lcl Translation', 'Lcl Translation', D(10), D(0), D(0))])],
        ),
        node(
          'Model',
          [L(302), S('Model::shoulder'), S('LimbNode')],
          [node('Properties70', [], [p('Lcl Translation', 'Lcl Translation', D(0), D(5), D(0))])],
        ),
        node('Deformer', [L(400), S('Deformer::skin'), S('Skin')], []),
        node('Deformer', [L(401), S('SubDeformer::hand'), S('Cluster')], []),
      ],
    ),
    node(
      'Connections',
      [],
      [
        connect(100, 200),
        connect(200, 300),
        connect(401, 400),
        /* The cluster first, exactly as an exporter writes it, and the hierarchy after. */
        connect(300, 401),
        connect(300, 302),
      ],
    ),
  ]);

  const mesh = read(buffer).meshes[0];
  expect(mesh?.positions[0], 'ten along x, from the hand it hangs off').toBeCloseTo(10, 5);
  expect(mesh?.positions[1], 'and five up, from the shoulder above that').toBeCloseTo(5, 5);
});

/**
 * **The surface a consumer actually calls.**
 *
 * `fbxToMeshes` is where the reading happens and `readModel` is what anybody outside this package
 * uses — and a field read correctly and then dropped by the layer above is a failure this
 * repository has shipped before: a normal-map index was written, carried and readable for a whole
 * release while `DrftLoader` was the single layer that did not pass it on. Nothing failed, and a
 * bought model simply drew smoother than its maker shipped it. So the wiring is asserted rather
 * than assumed.
 */
it('hands the rig on through readModel, which is what a caller reaches for', async () => {
  const bytes = new Uint8Array(rigged({ clip: true }));
  const model = await readModel({
    name: 'bar.fbx',
    bytes,
    inflate: () => {
      throw new Error('the harness writes uncompressed arrays');
    },
  });

  expect(model.skins?.[0]?.joints.map((joint) => joint.name)).toEqual(['root', 'tip']);
  expect(model.clips?.[0]?.name).toBe('Take 001');
  expect(model.meshes[0]?.joints, 'and the per-vertex half, on the mesh').toBeDefined();
});

/**
 * **A refusal that says which of the three shapes of nothing it met.**
 *
 * Two rig-specific exports of one bought character both failed with «fbx: no geometry found in a
 * version 7300 file», and the trail ended there: the message could not say whether the records
 * were missing, present but not polygon meshes, or present and empty. Each is a different next
 * step. The counts are cheap and they are the difference between a report somebody can act on and
 * one they can only forward.
 */
describe('a file this reader finds nothing in', () => {
  const nothing = (objects: readonly FbxWritable[]) =>
    writeFbx([
      node('FBXHeaderExtension', [], [node('FBXVersion', [I(7400)])]),
      node('Objects', [], objects),
      node('Connections', [], []),
    ]);

  it('says so when there are no geometry records at all', () => {
    expect(() =>
      read(nothing([node('Model', [L(200), S('Model::empty'), S('Mesh')], [])])),
    ).toThrow(/no Geometry records at all/);
  });

  it('says so when the records are not polygon meshes', () => {
    expect(() =>
      read(
        nothing([
          node(
            'Geometry',
            [L(100), S('Geometry::blend'), S('Shape')],
            [node('Vertices', [doubles([0, 0, 0])])],
          ),
        ]),
      ),
    ).toThrow(/lack Vertices or PolygonVertexIndex/);
  });
});

/**
 * **A binary FBX separates a name from its class with `\0\x01`, not with `::`.**
 *
 * The ASCII form of the container writes `Model::spine_01` and the binary form writes
 * `spine_01\0\x01Model`, and this reader only knew the first. Every joint on a bought character
 * therefore came back named `rp_nathan_animated_003_walking_spine_01\0\x01Model`, and the take was
 * `Take 001\0\x01AnimStack`. Nothing fails on a name: `Joint.name` is what **retargeting matches
 * on**, so a rig whose every joint carries a class suffix matches nothing and the failure appears
 * one subsystem away from its cause. Found on real bytes, which is what real bytes are for.
 */
describe('the names a binary file writes', () => {
  it('strips the class the container appends, in either of the two forms', () => {
    const buffer = writeFbx([
      node('FBXHeaderExtension', [], [node('FBXVersion', [I(7400)])]),
      node(
        'Objects',
        [],
        [
          node(
            'Geometry',
            [L(100), S('bar\u0000\u0001Geometry'), S('Mesh')],
            [
              node('Vertices', [doubles([0, 0, 0, 1, 0, 0, 0, 1, 0])]),
              node('PolygonVertexIndex', [ints([0, 1, -3])]),
            ],
          ),
          node(
            'Model',
            [L(200), S('bar\u0000\u0001Model'), S('Mesh')],
            [node('Properties70', [], [])],
          ),
          node(
            'Model',
            [L(300), S('spine_01\u0000\u0001Model'), S('LimbNode')],
            [node('Properties70', [], [])],
          ),
          node('Deformer', [L(400), S('skin\u0000\u0001Deformer'), S('Skin')], []),
          node(
            'Deformer',
            [L(401), S('spine_01\u0000\u0001SubDeformer'), S('Cluster')],
            [
              node('Indexes', [ints([0])]),
              node('Weights', [doubles([1])]),
              node('Transform', [doubles(IDENTITY)]),
              node('TransformLink', [doubles(IDENTITY)]),
            ],
          ),
          node('AnimationStack', [L(500), S('Take 001\u0000\u0001AnimStack'), S('')], []),
          node('AnimationLayer', [L(501), S('BaseLayer\u0000\u0001AnimLayer'), S('')], []),
          node(
            'AnimationCurveNode',
            [L(502), S('T\u0000\u0001AnimCurveNode'), S('')],
            [node('Properties70', [], [p('d|X', 'Number', D(0))])],
          ),
          node(
            'AnimationCurve',
            [L(503), S('\u0000\u0001AnimCurve'), S('')],
            [node('KeyTime', [longs([0])]), node('KeyValueFloat', [doubles([1])])],
          ),
        ],
      ),
      node(
        'Connections',
        [],
        [
          connect(100, 200),
          connect(400, 100),
          connect(401, 400),
          connect(300, 401),
          connect(501, 500),
          connect(502, 501),
          connect(502, 300, 'Lcl Translation'),
          connect(503, 502, 'd|X'),
        ],
      ),
    ]);

    const result = read(buffer);

    expect(result.skins[0]?.joints[0]?.name, 'the joint a rig is retargeted by').toBe('spine_01');
    expect(result.clips[0]?.name).toBe('Take 001');
  });
});

/**
 * **`PreRotation` is a fixed rotation between a joint and its animated one**, and ignoring it is
 * silent: the clip plays, every key interpolates, and twenty-nine of a bought character's
 * eighty-eight joints are turned by a constant amount. That reads as a broken take rather than as
 * an unread field, which is why it was worth composing rather than warning about.
 *
 * FBX puts it in the rotation chain as `PreRotation * R * inverse(PostRotation)`, so a joint whose
 * curve says nothing still carries its pre-rotation — which is what this asserts, because a key of
 * zero is where the mistake shows up whole rather than mixed with the animation.
 */
describe('a joint carrying a pre-rotation', () => {
  it('composes it into the clip rather than leaving the joint a quarter turn out', () => {
    const buffer = writeFbx([
      node('FBXHeaderExtension', [], [node('FBXVersion', [I(7400)])]),
      node(
        'Objects',
        [],
        [
          node(
            'Geometry',
            [L(100), S('bar\u0000\u0001Geometry'), S('Mesh')],
            [
              node('Vertices', [doubles([0, 0, 0, 1, 0, 0, 0, 1, 0])]),
              node('PolygonVertexIndex', [ints([0, 1, -3])]),
            ],
          ),
          node(
            'Model',
            [L(200), S('bar\u0000\u0001Model'), S('Mesh')],
            [node('Properties70', [], [])],
          ),
          node(
            'Model',
            [L(300), S('arm\u0000\u0001Model'), S('LimbNode')],
            [node('Properties70', [], [p('PreRotation', 'Vector3D', D(0), D(0), D(90))])],
          ),
          node('Deformer', [L(400), S('skin\u0000\u0001Deformer'), S('Skin')], []),
          node(
            'Deformer',
            [L(401), S('arm\u0000\u0001SubDeformer'), S('Cluster')],
            [
              node('Indexes', [ints([0])]),
              node('Weights', [doubles([1])]),
              node('Transform', [doubles(IDENTITY)]),
              node('TransformLink', [doubles(IDENTITY)]),
            ],
          ),
          node('AnimationStack', [L(500), S('Take 001\u0000\u0001AnimStack'), S('')], []),
          node('AnimationLayer', [L(501), S('BaseLayer\u0000\u0001AnimLayer'), S('')], []),
          node(
            'AnimationCurveNode',
            [L(502), S('R\u0000\u0001AnimCurveNode'), S('')],
            [
              node(
                'Properties70',
                [],
                [p('d|X', 'Number', D(0)), p('d|Y', 'Number', D(0)), p('d|Z', 'Number', D(0))],
              ),
            ],
          ),
          node(
            'AnimationCurve',
            [L(503), S('\u0000\u0001AnimCurve'), S('')],
            [node('KeyTime', [longs([0])]), node('KeyValueFloat', [doubles([0])])],
          ),
        ],
      ),
      node(
        'Connections',
        [],
        [
          connect(100, 200),
          connect(400, 100),
          connect(401, 400),
          connect(300, 401),
          connect(501, 500),
          connect(502, 501),
          connect(502, 300, 'Lcl Rotation'),
          connect(503, 502, 'd|Z'),
        ],
      ),
    ]);

    const track = read(buffer).clips[0]?.tracks[0];
    const half = Math.SQRT1_2;

    expect(track?.path).toBe('rotation');
    /* A quarter turn about z, hand-derived: sin(45°) in z and cos(45°) in w. */
    expect(track?.values[0]).toBeCloseTo(0, 6);
    expect(track?.values[1]).toBeCloseTo(0, 6);
    expect(track?.values[2]).toBeCloseTo(half, 6);
    expect(track?.values[3]).toBeCloseTo(half, 6);
  });
});

/**
 * **The two readers disagreed about units for the same character, and neither was wrong.**
 *
 * A glTF states metres and this format states its own, in `GlobalSettings.UnitScaleFactor`, which
 * counts centimetres per file unit — one for a file authored in centimetres, which is what a bought
 * character is. `ModelImport.unitScale` is documented as metres per source unit and said "USD does;
 * nothing else here does", so a baker had nothing to scale by and divided by a measured height
 * instead, which is a guess dressed as arithmetic.
 */
describe('the units a file declares', () => {
  const withFactor = (factor: number | null) =>
    writeFbx([
      node('FBXHeaderExtension', [], [node('FBXVersion', [I(7400)])]),
      ...(factor === null
        ? []
        : [
            node(
              'GlobalSettings',
              [],
              [node('Properties70', [], [p('UnitScaleFactor', 'double', D(factor))])],
            ),
          ]),
      node(
        'Objects',
        [],
        [
          node(
            'Geometry',
            [L(100), S('bar'), S('Mesh')],
            [
              node('Vertices', [doubles([0, 0, 0, 1, 0, 0, 0, 1, 0])]),
              node('PolygonVertexIndex', [ints([0, 1, -3])]),
            ],
          ),
          node('Model', [L(200), S('bar'), S('Mesh')], [node('Properties70', [], [])]),
        ],
      ),
      node('Connections', [], [connect(100, 200)]),
    ]);

  it('reads centimetres as a hundredth of a metre', () => {
    expect(read(withFactor(1)).unitScale).toBeCloseTo(0.01, 9);
  });

  it('reads a file already in metres as one', () => {
    expect(read(withFactor(100)).unitScale).toBeCloseTo(1, 9);
  });

  /**
   * **Centimetres is the container's own default and not a guess**, so a file that states nothing
   * gets it. Answering 1 there would say "metres" about a file that means centimetres, which is the
   * error this field exists to remove rather than relocate.
   */
  it('falls back to the unit the container defines when a file states none', () => {
    expect(read(withFactor(null)).unitScale).toBeCloseTo(0.01, 9);
  });
});

---
title: Worlds from a kit
description: A world built from a few pieces placed many times, carried as its placements in a .drft, expanded by arithmetic, and paged in region by region.
packages: ['@driftengine/drft', '@driftengine/assets', '@driftengine/script']
covers: ['Worlds from a kit']
---

# Worlds from a kit

A city of boxes, columns and cornices is a few thousand distinct shapes placed hundreds of thousands
of times, each at its own size and in its own paint. Merged into vertices it is most of a gigabyte;
as placements of its pieces it is a few tens of megabytes. A `.drft` can carry a mesh either way,
and a mesh carried as placements is expanded into ordinary geometry where it is needed.

The example is a street built from three pieces, a box, a column and a sphere. Its figures say what
the street weighs as placements and as vertices. Lengthen the street, or paint each copy by the
piece it is, and save a change to the rules in `street.drs` to have the street built again.

<!-- run: kit -->

## Pieces, surfaces and copies

```ts sample=kit/main.ts#kit
/** The kit: three unit pieces. Their own colours are ignored; a copy's surface paints it. */
const WHITE: Vec3 = [1, 1, 1];
const PIECES: MeshData[] = [
  new MeshBuilder().addBox([0, 0, 0], [0.5, 0.5, 0.5], WHITE).build(),
  new MeshBuilder().addCylinder([0, 0, 0], 0.5, 0.5, 'y', WHITE, 0, 12).build(),
  new MeshBuilder().addSphere([0, 0, 0], 0.5, WHITE, 0, 16, 8).build(),
];
const BOX = 0;
const COLUMN = 1;
const SPHERE = 2;

/** The surfaces a copy can wear: four wall paints, glass, stone, copper and the road. */
const PAINTS: [Vec3, number][] = [
  [[0.78, 0.66, 0.52], 0],
  [[0.7, 0.52, 0.42], 0],
  [[0.82, 0.78, 0.68], 0],
  [[0.58, 0.6, 0.62], 0],
  [[0.12, 0.15, 0.2], 0.7],
  [[0.86, 0.84, 0.8], 0.1],
  [[0.36, 0.6, 0.5], 0.4],
  [[0.22, 0.22, 0.24], 0],
  /* And one per piece, for painting the street by which piece each copy is. */
  [[1, 0.5, 0.25], 0],
  [[1, 0.85, 0.3], 0],
  [[0.35, 0.6, 1], 0],
];
const GLASS = 4;
const STONE = 5;
const COPPER = 6;
const ROAD = 7;
const BY_PIECE = 8;
const surfaces = new Float32Array(PAINTS.length * SURFACE_FLOATS);
PAINTS.forEach(([colour, specular], i) => {
  surfaces.set(colour, i * SURFACE_FLOATS + SURFACE.color);
  surfaces[i * SURFACE_FLOATS + SURFACE.specular] = specular;
});
```

A piece is an ordinary mesh, usually of unit size. A piece is shape only: its colours, emissive and
other per-vertex constants are ignored, and the copy's surface supplies them. A piece carries
positions and normals, texture coordinates and tangents where the result is textured, and its own
sway `channel` where the result sways, so a tree's sway rises from its root however it is placed.

A surface is `SURFACE_FLOATS` (12) numbers, laid out as `SURFACE` names them: `color` at 0,
`emissive` at 3, `specular` at 4, `emissiveColor` at 5, `roughness` at 8, `grain` at 9, `relief`
at 10 and the texture-array `layer` at 11. Only the values the assembly's attributes ask for are
read.

```ts sample=kit/main.ts#copies
/** Copies collected for one street, before they become an assembly. */
const pieces: number[] = [];
const surfaceOf: number[] = [];
const transforms: number[] = [];
let paintByPiece = flag('paint', 'surfaces') === 'pieces';

/** One copy: a piece, a surface, and a box it fills, from its centre and its size on each axis. */
function place(piece: number, surface: number, centre: Vec3, size: Vec3): void {
  pieces.push(piece);
  surfaceOf.push(paintByPiece ? BY_PIECE + piece : surface);
  /* Three columns of the linear part, then the translation: a scale and a move. */
  transforms.push(size[0], 0, 0, 0, size[1], 0, 0, 0, size[2], centre[0], centre[1], centre[2]);
}

/** Lots down both sides of the street, each a building the rules describe. */
function buildStreet(lots: number): DrftAssembly {
  pieces.length = 0;
  surfaceOf.length = 0;
  transforms.length = 0;
  const storeys = rule<number>('storeys');
  const bays = rule<number>('bays');
  const arcaded = rule<boolean>('arcaded');
  const domed = rule<boolean>('domed');
  const paint = rule<number>('paint');
  const along = [0, 0];
  for (let lot = 0; lot < lots; lot += 1) {
    const side = lot % 2 === 0 ? -1 : 1;
    const width = bays(lot) * 3.2 + 1.6;
    const height = (storeys(lot) + 1) * 3.4;
    const z = (along[lot % 2] ?? 0) + width / 2;
    along[lot % 2] = z + width / 2 + 0.6;
    const front = side * 7;
    const middle = side * 13;
    const wall = paint(lot);
    place(BOX, wall, [middle, height / 2, z], [12, height, width]);
    place(BOX, STONE, [middle, height + 0.25, z], [12.6, 0.5, width + 0.3]);
    for (let floor = 1; floor <= storeys(lot); floor += 1) {
      for (let bay = 0; bay < bays(lot); bay += 1) {
        const across = z - width / 2 + 2.4 + bay * 3.2;
        place(BOX, GLASS, [front - side * 0.05, floor * 3.4 + 1.7, across], [0.2, 1.8, 1.4]);
      }
    }
    if (arcaded(lot)) {
      for (let column = 0; column <= bays(lot); column += 1) {
        const across = z - width / 2 + 0.8 + column * 3.2;
        place(COLUMN, STONE, [front - side * 1.6, 1.7, across], [0.5, 3.4, 0.5]);
      }
      place(BOX, STONE, [front - side * 1.2, 3.6, z], [2.8, 0.4, width]);
    }
    if (domed(lot)) place(SPHERE, COPPER, [middle, height + 0.5, z], [7, 7, 7]);
  }
  const length = Math.max(along[0] ?? 0, along[1] ?? 0);
  place(BOX, ROAD, [0, -0.1, length / 2], [60, 0.2, length + 40]);

  const copies = pieces.length;
  /* A stretch of one along each piece axis and no offset: untextured, so it changes nothing. */
  const uv = new Float32Array(copies * COPY_UV_FLOATS);
  for (let c = 0; c < copies; c += 1) uv.set([1, 1, 1, 1, 1, 1, 0, 0], c * COPY_UV_FLOATS);
  return {
    attributes: 0,
    surfaces,
    pieces: Uint32Array.from(pieces),
    surfaceOf: Uint32Array.from(surfaceOf),
    transforms: Float32Array.from(transforms),
    uv,
  };
}
```

A `DrftAssembly` is the mesh described as copies:

- `attributes`, the optional arrays the expanded mesh carries, as a `MESH`'s attribute bits
  (`ATTR_SPECULAR`, `ATTR_UVS`, `ATTR_TANGENT`, `ATTR_LAYERS`, `ATTR_CHANNEL` and the rest).
  `ASSEMBLY_ATTRIBUTES` is every bit an assembly may carry; skinning is not among them.
- `surfaces`, the surface table.
- `pieces` and `surfaceOf`, one piece and one surface a copy.
- `transforms`, `COPY_MATRIX_FLOATS` (12) a copy: the three columns of the linear part, then the
  translation.
- `uv`, `COPY_UV_FLOATS` (8) a copy: how far a texture coordinate stretches along each of the
  piece's three axes for u, the same for v, and an offset. One along every axis and no offset leave
  a piece's coordinates as they are.

## Expanding a copy

```ts sample=kit/main.ts#expand
/** The street as a mesh, built again whenever the rules, the length or the paint change. */
let mesh: MeshHandle | null = null;
const readout = createReadout(renderer, 2);
let lots = Number(flag('lots', '128'));

function rebuild(): void {
  const assembly = buildStreet(lots);
  const expanded = expandAssembly(assembly, (ordinal) => PIECES[ordinal] as MeshData);
  const next = renderer.createMesh(expanded);
  if (mesh !== null) renderer.disposeMesh(mesh);
  mesh = next;

  const copies = assembly.pieces.length;
  /* What the file would carry: a surface table, then 88 bytes a copy. */
  const placed =
    12 + surfaces.byteLength + copies * (8 + (COPY_MATRIX_FLOATS + COPY_UV_FLOATS) * 4);
  const vertices =
    expanded.positions.byteLength +
    expanded.normals.byteLength +
    expanded.colors.byteLength +
    expanded.emissive.byteLength +
    (expanded.specular?.byteLength ?? 0) +
    expanded.indices.byteLength;
  readout.set(0, `${copies} COPIES OF ${PIECES.length} PIECES`);
  readout.set(
    1,
    `PLACEMENTS ${(placed / 1e6).toFixed(2)} MB  EXPANDED ${(vertices / 1e6).toFixed(2)} MB`,
  );
}
```

`expandAssembly(assembly, piece)` builds the `MeshData` the assembly describes, given a function
that finds a piece by its mesh ordinal. Each copy's positions go through its matrix and its normals
through the matrix's inverse transpose, so a slope stretched along one axis stays perpendicular to
its surface. A copy whose matrix mirrors, with a negative determinant, has its triangles wound back
and its tangents' handedness flipped, so its faces still face outward and a mirrored texture still
lights the right way up. `assemblyBounds(assembly, piece, out)` gives the box the expanded mesh
will fill without expanding it.

A texture coordinate is stretched along the piece's own tangent, so one unit box can serve every
box in a city: a copy 13 metres by 4 with stretches of its size over the texture's tile size repeats
its facade in metres on every face. A stretch that varies across one face, as it does along a
cone's side, comes out as the stretch at each vertex's own tangent.

The rules for each building are a DriftScript module, which the page calls once a lot:

```drs sample=kit/street.drs#rules
// Floors above the ground, from two to seven.
fn storeys(lot: u32) -> u32 {
    return 2 + random.index(lot, 6)
}

// Windows across the front, from three to five.
fn bays(lot: u32) -> u32 {
    return 3 + random.index(lot + 101, 3)
}

// Two buildings in five stand on an arcade of columns.
fn arcaded(lot: u32) -> bool {
    return random.unit(lot + 7) < 0.4
}

// One in seven carries a dome.
fn domed(lot: u32) -> bool {
    return random.unit(lot + 13) < 0.15
}

// Which of the four wall paints a building wears.
fn paint(lot: u32) -> u32 {
    return random.index(lot + 29, 4)
}
```

## In a container

```ts sample=snippets/kit.ts#assembly
/** Two pieces, and a tower made of four copies of them: a body, a roof and two columns. */
const box = new MeshBuilder().addBox([0, 0, 0], [0.5, 0.5, 0.5], [1, 1, 1]).build();
const column = new MeshBuilder().addCylinder([0, 0, 0], 0.5, 0.5, 'y', [1, 1, 1]).build();

const surfaces = new Float32Array(2 * SURFACE_FLOATS);
surfaces.set([0.8, 0.7, 0.6], SURFACE.color);
surfaces.set([0.9, 0.9, 0.88], SURFACE_FLOATS + SURFACE.color);

const UNSTRETCHED = [1, 1, 1, 1, 1, 1, 0, 0];
export const tower: DrftAssembly = {
  attributes: 0,
  surfaces,
  /* By mesh ordinal in the file: 0 is the box and 1 the column. */
  pieces: Uint32Array.of(0, 0, 1, 1),
  surfaceOf: Uint32Array.of(0, 1, 1, 1),
  /* Per copy, the three columns of a scale and then where it stands. */
  transforms: Float32Array.of(
    ...[10, 0, 0, 0, 30, 0, 0, 0, 10, 0, 15, 0],
    ...[11, 0, 0, 0, 1, 0, 0, 0, 11, 0, 30.5, 0],
    ...[0.6, 0, 0, 0, 4, 0, 0, 0, 0.6, -3, 2, 6],
    ...[0.6, 0, 0, 0, 4, 0, 0, 0, 0.6, 3, 2, 6],
  ),
  /* No texture to stretch: a stretch of one along every piece axis, and no offset, a copy. */
  uv: Float32Array.of(...UNSTRETCHED, ...UNSTRETCHED, ...UNSTRETCHED, ...UNSTRETCHED),
};

/** The mesh it describes, as a `MESH` would have carried it. */
export const expanded = expandAssembly(tower, (ordinal) => (ordinal === 0 ? box : column));
```

```ts sample=snippets/kit.ts#container
/** The kit names the pieces; the assembly stands in a mesh slot like any other mesh. */
const block = new MeshBuilder().addBox([0, 15.5, 0], [5.5, 15.5, 5.5], [0.75, 0.68, 0.6]).build();
export const district = writeDrft({
  head: { name: 'district' },
  meshes: [box, column, tower, block],
  kit: [0, 1],
  regions: [
    {
      id: 0,
      bounds: [-6, 0, -6, 6, 31, 7],
      levels: [
        { error: 0, meshes: [2] },
        { error: 1, meshes: [3] },
      ],
      instances: [],
      occluders: new Float32Array(0),
      collision: null,
    },
  ],
  texturesFirst: true,
});
```

`writeDrft` takes assemblies in `meshes`, where each stands in a mesh slot and counts as one in
every ordinal, so materials and regions name it like any other mesh. `kit` lists the ordinals of
the meshes that are pieces. Two chunks carry them:

- `KITS` names the pieces and is written ahead of the geometry. A piece is drawn only inside the
  meshes assembled from it; without the list, a streaming reader would draw every piece at the
  origin.
- `MSHC` carries an assembly: its attribute bits, its surface table, and 88 bytes a copy.

Both are required, so a reader older than format 1.23 refuses such a file and names them. A piece
travels with the first region that copies it, among that region's meshes and ahead of its
assemblies, so the first regions a walker reaches arrive without the rest of the kit.
`texturesFirst: true` writes the pictures ahead of all geometry, for a world whose materials must be
ready before its first region; its first mesh then arrives later by the size of the pictures.

Measured on a two-kilometre city of 18.7 million triangles in 579,164 copies of 7,308 pieces: with
its coarse levels, collision, lights, scene and pictures the file is 123 MB, and the 14 regions
within 150 metres of its spawn point are whole after the first 7.1 MB.

`buildKit`, `readKit`, `buildAssembly`, `readAssembly`, `checkAssembly`, `checkCopies` and
`isAssembly` are the chunk-level reader and writer `writeDrft` and `readDrft` use, for a tool
that writes the chunks itself.

## Paging the finest level

```ts sample=snippets/kit.ts#paging
/**
 * Page a region's finest level in while the selection draws it, and out once the eye has left.
 * Until it is resident, the region is drawn at its next level.
 */
const paged = new Map<number, boolean>();
export function pageFinest(loader: DrftLoader, hlod: HlodSet): void {
  for (const region of loader.regions.values()) {
    if (region.levels[0]?.paged !== true) continue;
    const wanted = hlod.levelOf(region.id) === 0;
    if (paged.get(region.id) === wanted) continue;
    paged.set(region.id, wanted);
    loader.pageRegion(region.id, 0, wanted);
  }
}

/** The level to draw for a region the selection put at `level`. */
export function drawnLevel(loader: DrftLoader, id: number, level: number): number {
  const region = loader.regions.get(id);
  if (level === 0 && region?.levels[0]?.resident === false) return 1;
  return level;
}
```

`DrftLoader` keeps a region's level that arrived as assemblies small, as the copies the file
carried, and marks it `paged`. `pageRegion(id, level, resident)` brings it up, expanding and
uploading each mesh on the loader's clocked queue over the next `update`s and turning `resident`
true when the last is up, or frees its meshes and keeps the copies. A level that is not paged
ignores it. The game decides from what it will draw: page in the levels
[`HlodSet`](hierarchical-detail.md) is choosing, draw a coarser one until the fine one is resident,
and page out what the eye has left.

A reader of its own built on `streamDrft` is told the kit's pieces by `onKit` when `KITS` lands,
each piece by `onPiece`, and each assembly by `onAssembly` with a lookup for its pieces, all of
which have arrived by then. Without `onAssembly`, the stream expands an assembly itself and hands
the result to `onMesh`.

Two more options split a file between the loader and the game:

- `onImage(name, image)` takes each picture as it decodes and the loader uploads none, for a game
  that packs every picture into a texture array of its own. Materials that name an image then draw
  untextured, which is the game's to answer.
- `onMesh(mesh, ordinal)` is offered each mesh no region holds; return `true` to take it, and it is
  neither uploaded as a part nor merged. For meshes a game draws its own way, such as a crowd it
  instances and moves every frame. A taken mesh leaves its upload budget and fade to the game.

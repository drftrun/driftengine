/**
 * Trees, hedges and shrubs, grown from a species, a height and a seed.
 *
 * **The reference grows them in its engine and says nothing of how**: its scripts give a species,
 * a height, a seed and a wind strength, and seven leaf pictures nothing names sit beside its other
 * pictures, one a species. So this generator is ours, built to the same inputs: a tapered trunk and
 * a few branches, and a crown of crossed leaf cards wearing the species' picture — a round crown for
 * a plane and a ginkgo, a cone for a pine, a column for a poplar, a fan of fronds for a palm, a
 * clump for a shrub and a filled box for a hedge. **What would make it wrong** is a capture of the
 * reference where a species reads as another shape; the shapes are a table below.
 *
 * **A species' picture is four in one**: bark in its top-left quarter and three leaves in the
 * others. So the wood wears the bark quarter, wrapped once around each limb, and each card one of
 * the three leaves, picked by the seed — the whole picture on a card was a slab of bark in the air.
 *
 * **A crown is lit as a crown**: each card's normal points out from the crown's middle rather than
 * off its own face, so the canopy shades as one rounded mass and not as a scatter of flat cards.
 * **It moves**: sway rises from nothing at the root to all of it at the leaves (`MeshData.channel`),
 * for the shared wind to move. A tree is one unit tall and scaled by its height where it stands; a
 * hedge is grown at its own size, which a uniform scale cannot give it.
 */
import { generateTangents, mulberry32 } from '@driftengine/core';
import type { MeshData } from '@driftengine/drft';

import type { TextureRef } from './materials.ts';

type Crown = 'round' | 'cone' | 'column' | 'fan' | 'clump' | 'box';

interface Species {
  readonly leaves: string;
  readonly crown: Crown;
  /** Where the crown starts, as a share of the height. */
  readonly base: number;
  /** Crown radius, as a share of the height. */
  readonly radius: number;
  /** Trunk radius at the root, as a share of the height; 0 for none. */
  readonly trunk: number;
  readonly cards: number;
  /** A card's side, as a share of the height. */
  readonly card: number;
  readonly bark: readonly [number, number, number];
  readonly leaf: readonly [number, number, number];
}

export const SPECIES: Readonly<Record<string, Species>> = {
  TreePlane: {
    leaves: 'plane',
    crown: 'round',
    base: 0.38,
    radius: 0.34,
    trunk: 0.03,
    cards: 46,
    card: 0.2,
    bark: [0.3, 0.27, 0.22],
    leaf: [0.62, 0.72, 0.5],
  },
  TreeGinkgo: {
    leaves: 'ginkgo',
    crown: 'round',
    base: 0.32,
    radius: 0.24,
    trunk: 0.024,
    cards: 38,
    card: 0.17,
    bark: [0.24, 0.21, 0.18],
    leaf: [0.78, 0.8, 0.46],
  },
  TreePine: {
    leaves: 'pine',
    crown: 'cone',
    base: 0.3,
    radius: 0.22,
    trunk: 0.026,
    cards: 40,
    card: 0.16,
    bark: [0.26, 0.2, 0.16],
    leaf: [0.42, 0.52, 0.4],
  },
  TreePoplar: {
    leaves: 'poplar',
    crown: 'column',
    base: 0.16,
    radius: 0.11,
    trunk: 0.02,
    cards: 34,
    card: 0.13,
    bark: [0.33, 0.31, 0.27],
    leaf: [0.6, 0.7, 0.44],
  },
  TreePalm: {
    leaves: 'palm',
    crown: 'fan',
    base: 0.9,
    radius: 0.36,
    trunk: 0.022,
    cards: 12,
    card: 0.34,
    bark: [0.4, 0.34, 0.26],
    leaf: [0.6, 0.7, 0.42],
  },
  TreeShrub: {
    leaves: 'shrub',
    crown: 'clump',
    base: 0,
    radius: 0.6,
    trunk: 0,
    cards: 10,
    card: 0.7,
    bark: [0.3, 0.27, 0.22],
    leaf: [0.58, 0.68, 0.46],
  },
  TreeHedge: {
    leaves: 'hedge',
    crown: 'box',
    base: 0,
    radius: 0.5,
    trunk: 0,
    cards: 0,
    card: 0.5,
    bark: [0.3, 0.27, 0.22],
    leaf: [0.52, 0.64, 0.42],
  },
};

/** A species' leaf picture, which the reference keeps beside its other pictures, unnamed. */
export function leafPicture(species: string): TextureRef {
  const s = SPECIES[species] ?? (SPECIES.TreePlane as Species);
  return { file: `etc/assets/foliage/${s.leaves}.svg`, width: 256, height: 256 };
}

export interface TreeSpec {
  readonly species: string;
  /** Which of the species' variants, from the tree's seed. */
  readonly variant: number;
  /** The share of leaves missing: a plane in winter. */
  readonly bare: number;
  /** A hedge's size; trees are one unit tall and take none. */
  readonly size: readonly [number, number, number] | null;
  /** A hedge's card side, in metres. */
  readonly leafSize: number;
}

/** A mesh under construction: positions, normals, texture coordinates and sway. */
class Grower {
  readonly p: number[] = [];
  readonly n: number[] = [];
  readonly uv: number[] = [];
  readonly sway: number[] = [];
  readonly i: number[] = [];

  vertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
    sway: number,
  ): number {
    this.p.push(x, y, z);
    const l = Math.hypot(nx, ny, nz) || 1;
    this.n.push(nx / l, ny / l, nz / l);
    this.uv.push(u, v);
    this.sway.push(sway);
    return this.p.length / 3 - 1;
  }

  /** A tapered column between two points, `segments` round, faceted. */
  limb(
    a: readonly number[],
    b: readonly number[],
    ra: number,
    rb: number,
    segments: number,
    swayA: number,
    swayB: number,
  ): void {
    const d = [
      (b[0] as number) - (a[0] as number),
      (b[1] as number) - (a[1] as number),
      (b[2] as number) - (a[2] as number),
    ];
    const len = Math.hypot(d[0] as number, d[1] as number, d[2] as number) || 1;
    const t = d.map((x) => x / len);
    /* Any unit vector square to the axis, then the one square to both. */
    const side = Math.abs(t[1] as number) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const s = cross(t, side);
    const sl = Math.hypot(s[0] as number, s[1] as number, s[2] as number) || 1;
    const e1 = s.map((x) => x / sl);
    const e2 = cross(t, e1);
    const base = this.p.length / 3;
    for (let k = 0; k <= segments; k++) {
      const ang = (k / segments) * Math.PI * 2;
      const [c, sn] = [Math.cos(ang), Math.sin(ang)];
      const dir = [0, 1, 2].map((j) => (e1[j] as number) * c + (e2[j] as number) * sn);
      for (const [end, r, sw, v] of [
        [a, ra, swayA, 1],
        [b, rb, swayB, 0],
      ] as const) {
        this.vertex(
          (end[0] as number) + (dir[0] as number) * r,
          (end[1] as number) + (dir[1] as number) * r,
          (end[2] as number) + (dir[2] as number) * r,
          dir[0] as number,
          dir[1] as number,
          dir[2] as number,
          /* The bark quarter: the picture's top left, u around and v down the limb. */
          (k / segments) * 0.5,
          v * 0.5,
          sw,
        );
      }
    }
    for (let k = 0; k < segments; k++) {
      const q = base + k * 2;
      this.i.push(q, q + 2, q + 1, q + 1, q + 2, q + 3);
    }
  }

  /** Two cards crossed at `at`, `size` across, turned `yaw`, lit as if facing out from `centre`. */
  cards(
    at: readonly number[],
    size: number,
    yaw: number,
    tilt: number,
    centre: readonly number[],
    sway: number,
    leaf: number,
  ): void {
    /* One of the three leaf quarters: top right, bottom left, bottom right. */
    const [ou, ov] = [
      [0.5, 0],
      [0, 0.5],
      [0.5, 0.5],
    ][leaf % 3] as [number, number];
    const out = [0, 1, 2].map((j) => (at[j] as number) - (centre[j] as number));
    for (const turn of [0, Math.PI / 2]) {
      const a = yaw + turn;
      const u = [Math.cos(a), 0, Math.sin(a)];
      const up = [-Math.sin(tilt) * Math.sin(a), Math.cos(tilt), Math.sin(tilt) * Math.cos(a)];
      const base = this.p.length / 3;
      for (const [su, sv] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const) {
        this.vertex(
          (at[0] as number) + ((u[0] as number) * su + (up[0] as number) * sv) * (size / 2),
          (at[1] as number) + ((u[1] as number) * su + (up[1] as number) * sv) * (size / 2),
          (at[2] as number) + ((u[2] as number) * su + (up[2] as number) * sv) * (size / 2),
          out[0] as number,
          (out[1] as number) + size * 0.5,
          out[2] as number,
          ou + (su + 1) / 4,
          /* v runs down a picture: its top at the card's top. */
          ov + (1 - sv) / 4,
          sway,
        );
      }
      /* Both faces, since a card is seen from either side. */
      this.i.push(
        base,
        base + 1,
        base + 2,
        base,
        base + 2,
        base + 3,
        base,
        base + 2,
        base + 1,
        base,
        base + 3,
        base + 2,
      );
    }
  }

  mesh(color: readonly [number, number, number], layer: number): MeshData {
    const count = this.p.length / 3;
    const positions = new Float32Array(this.p);
    const normals = new Float32Array(this.n);
    const uvs = new Float32Array(this.uv);
    const indices = new Uint32Array(this.i);
    const channel = new Float32Array(count * 4);
    for (let v = 0; v < count; v++) {
      channel[v * 4] = this.sway[v] as number;
      channel[v * 4 + 1] = 1;
      channel[v * 4 + 2] = 1;
    }
    const colors = new Float32Array(count * 3);
    for (let v = 0; v < count; v++) colors.set(color, v * 3);
    return {
      positions,
      normals,
      colors,
      emissive: new Float32Array(count),
      uvs,
      tangents: generateTangents(positions, normals, uvs, indices),
      layers: new Float32Array(count).fill(layer),
      channel,
      indices,
    };
  }
}

function cross(a: readonly number[], b: readonly number[]): number[] {
  return [
    (a[1] as number) * (b[2] as number) - (a[2] as number) * (b[1] as number),
    (a[2] as number) * (b[0] as number) - (a[0] as number) * (b[2] as number),
    (a[0] as number) * (b[1] as number) - (a[1] as number) * (b[0] as number),
  ];
}

/** The seed a variant grows from: the species' name and the variant, so a bake is repeatable. */
function seedOf(spec: TreeSpec): number {
  let h = 2166136261;
  for (const c of `${spec.species}:${spec.variant}:${spec.bare}`)
    h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/**
 * A tree's wood and its leaves, as two meshes: the wood opaque in its bark colour, the leaves cut out
 * of their picture at `leafLayer`. The wood is empty for a shrub and a hedge.
 */
export function growTree(
  spec: TreeSpec,
  woodLayer: number,
  leafLayer: number,
): { wood: MeshData | null; leaves: MeshData } {
  const s = SPECIES[spec.species] ?? (SPECIES.TreePlane as Species);
  const random = mulberry32(seedOf(spec));
  const wood = new Grower();
  const leaves = new Grower();
  if (s.crown === 'box') {
    /* A hedge: cards over a box of its size, a few to a square of their own side. */
    const [w, h, d] = spec.size ?? [1, 1, 1];
    const side = Math.max(0.2, spec.leafSize);
    const across = Math.max(1, Math.round(w / side));
    const up = Math.max(1, Math.round(h / side));
    const deep = Math.max(1, Math.round(d / side));
    const centre = [0, h / 2, 0];
    for (let i = 0; i < across; i++) {
      for (let j = 0; j < up; j++) {
        for (let k = 0; k < deep; k++) {
          const at = [
            ((i + 0.5) / across - 0.5) * w + (random() - 0.5) * side * 0.4,
            ((j + 0.5) / up) * h,
            ((k + 0.5) / deep - 0.5) * d,
          ];
          leaves.cards(
            at,
            side * 1.3,
            random() * Math.PI,
            (random() - 0.5) * 0.5,
            centre,
            0.4 + (0.6 * (at[1] as number)) / h,
            Math.floor(random() * 3),
          );
        }
      }
    }
    return { wood: null, leaves: leaves.mesh(s.leaf, leafLayer) };
  }
  const top = 1;
  const crownMid = s.base + (top - s.base) / 2;
  const centre = [0, s.crown === 'fan' ? top : crownMid, 0];
  if (s.trunk > 0) {
    /* A palm's trunk leans and bends; the others stand straight to the crown's middle. */
    const lean = s.crown === 'fan' ? (random() - 0.5) * 0.16 : 0;
    const end = s.crown === 'fan' ? [lean, top, lean * 0.5] : [0, crownMid, 0];
    const mid = [(end[0] as number) * 0.4, (end[1] as number) * 0.5, (end[2] as number) * 0.4];
    wood.limb([0, 0, 0], mid, s.trunk, s.trunk * 0.8, 7, 0, 0.1);
    wood.limb(mid, end, s.trunk * 0.8, s.trunk * 0.55, 7, 0.1, 0.25);
    if (s.crown !== 'fan') {
      const branches = 4 + Math.floor(random() * 2);
      for (let b = 0; b < branches; b++) {
        const a = ((b + random() * 0.5) / branches) * Math.PI * 2;
        const from = [0, s.base + (crownMid - s.base) * random() * 0.8, 0];
        const to = [
          Math.cos(a) * s.radius * 0.7,
          (from[1] as number) + (top - s.base) * 0.3,
          Math.sin(a) * s.radius * 0.7,
        ];
        wood.limb(from, to, s.trunk * 0.45, s.trunk * 0.2, 5, 0.2, 0.6);
      }
    }
  }
  const count = Math.round(s.cards * (1 - spec.bare));
  for (let c = 0; c < count; c++) {
    let at: number[];
    let tilt = (random() - 0.5) * 0.6;
    if (s.crown === 'fan') {
      /* Fronds out from the top, drooping at their tips. */
      const a = (c / count) * Math.PI * 2 + random() * 0.3;
      const reach = s.radius * (0.55 + random() * 0.3);
      at = [Math.cos(a) * reach, top - reach * 0.35, Math.sin(a) * reach];
      tilt = 0.9;
    } else {
      /* A point in the crown's volume, denser towards its surface. */
      const a = random() * Math.PI * 2;
      const r = Math.sqrt(0.35 + 0.65 * random());
      const t = s.crown === 'clump' ? random() : s.base + (top - s.base) * random();
      const span = s.crown === 'clump' ? 1 : top - s.base;
      const along = s.crown === 'clump' ? t : (t - s.base) / span;
      const width =
        s.crown === 'cone'
          ? s.radius * (1 - along)
          : s.crown === 'column'
            ? s.radius * Math.sin(Math.PI * Math.min(1, 0.15 + along))
            : s.radius * Math.sqrt(Math.max(0, 1 - (2 * along - 1) ** 2));
      at = [
        Math.cos(a) * width * r,
        s.crown === 'clump' ? t * 0.75 + s.card * 0.25 : t,
        Math.sin(a) * width * r,
      ];
    }
    leaves.cards(
      at,
      s.card * (0.8 + random() * 0.4),
      random() * Math.PI,
      tilt,
      centre,
      1,
      Math.floor(random() * 3),
    );
  }
  return {
    wood: wood.p.length === 0 ? null : wood.mesh(s.bark, woodLayer),
    leaves: leaves.mesh(s.leaf, leafLayer),
  };
}

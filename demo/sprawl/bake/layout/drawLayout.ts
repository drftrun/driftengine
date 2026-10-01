/**
 * The layout drawn as a plot: what each stage placed, in colours chosen to read against the
 * reference's own map — district tints for building blocks, green for parks, stone for squares,
 * light grey for avenues, darker for streets, orange for the elevated road.
 */
import type { CityLayout } from './layout.ts';
import type { Vec2 } from './plane.ts';
import { Plot } from './plot.ts';
import type { Colour } from './plot.ts';

const GROUND: Record<string, Colour> = {
  BlockPark: [58, 104, 62],
  BlockPlaza: [132, 130, 122],
  BlockYard: [104, 88, 70],
};

export function drawLayout(layout: CityLayout, size = 1400): Plot {
  const plot = new Plot(size, 1100, [22, 26, 32]);
  for (const block of layout.blocks) {
    const accent = layout.tables.district(block.district).accent;
    const tint: Colour = GROUND[block.kind] ?? [accent[0] * 0.3, accent[1] * 0.3, accent[2] * 0.3];
    plot.fill(block.outline, tint);
  }
  for (const lot of layout.lots) {
    const accent = layout.tables.district(lot.district).accent;
    const shrink = lot.outline.map(([x, z]): Vec2 => {
      const cx = (lot.bounds.x0 + lot.bounds.x1) / 2;
      const cz = (lot.bounds.z0 + lot.bounds.z1) / 2;
      return [cx + (x - cx) * 0.9, cz + (z - cz) * 0.9];
    });
    const tint: Colour = [accent[0] * 0.55, accent[1] * 0.55, accent[2] * 0.55];
    plot.fill(shrink, lot.polygon ? [accent[0] * 0.8, accent[1] * 0.8, accent[2] * 0.8] : tint);
  }
  for (const b of layout.buildings) {
    const c = Math.cos(b.yaw);
    const s = Math.sin(b.yaw);
    const corner = (lx: number, lz: number): Vec2 => [
      b.position[0] + lx * c + lz * s,
      b.position[1] - lx * s + lz * c,
    ];
    const hw = b.width / 2;
    const hd = b.depth / 2;
    const t = Math.min(1, b.height / 120);
    const shade: Colour = [60 + 195 * t, 60 + 170 * t, 70 + 120 * t];
    const sky = b.props.get('skyport');
    const lot = layout.lots[b.lot];
    const outline = lot?.polygon
      ? lot.outline
      : [corner(-hw, -hd), corner(hw, -hd), corner(hw, hd), corner(-hw, hd)];
    plot.fill(outline, sky?.k === 'num' && sky.v === 1 ? [255, 60, 200] : shade);
  }
  for (const lot of layout.vacant) plot.fill(lot.outline, GROUND.BlockPlaza ?? [132, 130, 122]);
  for (const plan of layout.plans) {
    if (plan.court) plot.fill(plan.court, [70, 92, 64]);
    if (plan.alley) plot.fill(plan.alley, [40, 44, 50]);
  }
  if (layout.wall) {
    const w = layout.wall;
    plot.line([...w.outer, w.outer[0] as Vec2], 3, [40, 70, 110]);
    plot.line(w.path, 3.6, [226, 200, 150]);
    const at = (s: number): Vec2 => {
      const i = Math.floor(s);
      const a = w.path[i] as Vec2;
      const b = w.path[i + 1] as Vec2;
      return [a[0] + (b[0] - a[0]) * (s - i), a[1] + (b[1] - a[1]) * (s - i)];
    };
    for (const t of w.towers) {
      const [x, z] = at(t.s);
      plot.fill(
        [
          [x - t.r, z - t.r],
          [x + t.r, z - t.r],
          [x + t.r, z + t.r],
          [x - t.r, z + t.r],
        ],
        [255, 230, 180],
      );
    }
    for (const g of w.gates) {
      const [x, z] = at(g.s);
      plot.fill(
        [
          [x - 3, z - 3],
          [x + 3, z - 3],
          [x + 3, z + 3],
          [x - 3, z + 3],
        ],
        [90, 200, 255],
      );
    }
  }
  for (const road of layout.roads.roads) {
    if (layout.closed.has(road.id)) continue;
    const colour: Colour = road.avenue ? [192, 198, 206] : [112, 120, 132];
    const [a, b]: Vec2[] = road.vertical
      ? [
          [road.at, road.from],
          [road.at, road.to],
        ]
      : [
          [road.from, road.at],
          [road.to, road.at],
        ];
    plot.line([a, b], road.cls.width, colour);
  }
  for (const lm of layout.landmarks) {
    const c = Math.cos(lm.yaw);
    const sn = Math.sin(lm.yaw);
    const corner = (lx: number, lz: number): Vec2 => [
      lm.position[0] + lx * c + lz * sn,
      lm.position[1] - lx * sn + lz * c,
    ];
    const hw = lm.width / 2;
    const hd = lm.depth / 2;
    plot.fill(
      [corner(-hw, -hd), corner(hw, -hd), corner(hw, hd), corner(-hw, hd)],
      [150, 150, 120],
    );
    const bw = lm.props.get('bw');
    const bd = lm.props.get('bd');
    const bz = lm.props.get('bz');
    const n = (v: typeof bw): number => (v?.k === 'num' ? v.v : 0);
    plot.fill(
      [
        corner(-n(bw) / 2, n(bz) - n(bd) / 2),
        corner(n(bw) / 2, n(bz) - n(bd) / 2),
        corner(n(bw) / 2, n(bz) + n(bd) / 2),
        corner(-n(bw) / 2, n(bz) + n(bd) / 2),
      ],
      [255, 220, 90],
    );
  }
  const dot = (p: Vec2, r: number, colour: Colour): void =>
    plot.fill(
      [
        [p[0] - r, p[1] - r],
        [p[0] + r, p[1] - r],
        [p[0] + r, p[1] + r],
        [p[0] - r, p[1] + r],
      ],
      colour,
    );
  for (const p of layout.props) dot(p.position, 0.9, p.light ? [255, 200, 120] : [150, 220, 210]);
  for (const s of layout.signals) dot(s.position, 1.2, [255, 70, 70]);
  for (const l of layout.lamps) if (l.light) dot(l.position, 1.1, [255, 236, 170]);
  for (const line of layout.rail.lines) {
    const tint = line.row.c('tint');
    plot.line(line.path, 5, [tint[0], tint[1], tint[2]]);
  }
  for (const stop of layout.rail.stops) {
    const [x, z] = stop.position;
    const tint = stop.row.c('tint', [255, 255, 255, 255]);
    plot.fill(
      [
        [x - 9, z - 9],
        [x + 9, z - 9],
        [x + 9, z + 9],
        [x - 9, z + 9],
      ],
      [tint[0], tint[1], tint[2]],
    );
  }
  const flat = (points: readonly (readonly [number, number, number])[]): Vec2[] =>
    points.map(([x, , z]) => [x, z] as const);
  plot.line(flat(layout.roads.diagonal.points), layout.roads.diagonal.cls.width, [192, 198, 206]);
  plot.line(flat(layout.roads.highway.points), 23.2, [255, 160, 60], 0.85);
  return plot;
}

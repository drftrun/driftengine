/**
 * The minimap and the city map, both the one map mesh (`mapMesh.ts`) drawn into a scissored inset
 * by a camera straight overhead, high and narrow enough to be a map's projection to within a pixel.
 *
 * **The minimap** is 220 px showing 350 m about the walker, turned so the walker's heading is up —
 * or north up (`northUp`) — top right under the frame's rate. **The city map** fills the screen,
 * north up, the whole city in view, each district and destination labelled where it stands.
 *
 * North is +z, as the drones' flight levels have it. A marker at the walker points its way.
 */
import {
  Camera,
  DEFAULT_TEXT_STYLE,
  MeshBuilder,
  textWidthPx,
} from '../../packages/core/src/index';
import type {
  Environment,
  MeshHandle,
  RendererApi,
  TextHandle,
  TextStyle,
  Vec3,
} from '../../packages/core/src/index';
import { buildMapMesh, mapEnvironment } from './mapMesh';
import type { CityScene } from './scene';

const MINI_PX = 220;
const MINI_M = 350;
const HIGH_M = 2000;
const CITY_HIGH_M = 5000;
const STREET: Vec3 = [0.035, 0.04, 0.05];
const MARK_DESTINATION = [1, 0.75, 0.3] as const;
const MARK_SKYPORT = [0.4, 0.85, 1] as const;
const LABEL: Vec3 = [0.9, 0.92, 0.96];

export class CityMaps {
  northUp = false;
  open = false;
  private readonly mesh: MeshHandle;
  private readonly marker: MeshHandle;
  private readonly env: Environment = mapEnvironment();
  private readonly camera = new Camera();
  private readonly model = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  private readonly spot = new Float32Array(16);
  private readonly labels: { handle: TextHandle; x: number; z: number; width: number }[];
  private readonly style: { -readonly [K in keyof TextStyle]: TextStyle[K] } = {
    ...DEFAULT_TEXT_STYLE,
    glow: 0,
  };
  private extent = 1000;
  private sinceOrigin = 0;
  private readonly at = { left: 0, top: 0 };

  constructor(
    private readonly renderer: RendererApi,
    private readonly canvas: HTMLCanvasElement,
    scene: CityScene,
  ) {
    this.mesh = renderer.createMesh(
      buildMapMesh({
        districts: scene.districts,
        blocks: scene.blocks,
        lines: scene.lines,
        marks: [
          ...scene.destinations.map((d) => ({ x: d.x, z: d.z, color: MARK_DESTINATION })),
          ...scene.skyports.map((p) => ({ x: p.x, z: p.z, color: MARK_SKYPORT })),
        ],
      }),
    );
    /* An arrowhead pointing +z, bright enough to read over any district. */
    this.marker = renderer.createMesh(
      new MeshBuilder().addBox([0, 2, 0], [5, 1, 9], [1, 1, 1], 1).build(),
    );
    for (const b of scene.blocks) {
      for (let k = 0; k < b.outline.length; k++)
        this.extent = Math.max(this.extent, Math.abs(b.outline[k] as number));
    }
    this.labels = [
      ...scene.districts.map((d) => ({ name: d.name, x: d.labelX, z: d.labelZ })),
      ...scene.destinations.map((d) => ({ name: d.name, x: d.x, z: d.z })),
    ].map((l) => {
      const handle = renderer.createText();
      const text = l.name.replace(/_/g, ' ');
      renderer.setText(handle, text);
      return { handle, x: l.x, z: l.z, width: textWidthPx(text, 1) };
    });
    this.camera.near = 50;
    this.camera.far = CITY_HIGH_M + 1000;
  }

  /** The minimap about (x, z), the walker facing `yaw`. */
  drawMinimap(x: number, z: number, yaw: number): void {
    const r = this.renderer;
    const origin = this.origin();
    const pad = Math.max(2, Math.round(Math.min(r.cssWidth, r.cssHeight) / 260)) * 3;
    const top = origin.top + pad * 5;
    const left = origin.left + r.cssWidth - pad - MINI_PX;
    this.aim(x, z, HIGH_M, MINI_M, this.northUp ? 0 : yaw);
    this.inset(left, top, MINI_PX, MINI_PX, x, z, yaw, 1);
  }

  /** The whole city, north up, labelled, the walker marked at (x, z) facing `yaw`. */
  drawCity(x: number, z: number, yaw: number): void {
    const r = this.renderer;
    const origin = this.origin();
    this.aim(0, 0, CITY_HIGH_M, this.extent * 1.05, 0);
    this.inset(origin.left, origin.top, r.cssWidth, r.cssHeight, x, z, yaw, 5);
    const cell = Math.max(1, Math.round(Math.min(r.cssWidth, r.cssHeight) / 400));
    const vp = this.camera.viewProjection;
    const style = this.style;
    style.cellSize = cell;
    style.color = LABEL;
    for (const l of this.labels) {
      /* Where the label's place lands in the frame. */
      const cx = (vp[0] as number) * l.x + (vp[8] as number) * l.z + (vp[12] as number);
      const cy = (vp[1] as number) * l.x + (vp[9] as number) * l.z + (vp[13] as number);
      const cw = (vp[3] as number) * l.x + (vp[11] as number) * l.z + (vp[15] as number);
      if (cw <= 0) continue;
      const sx = ((cx / cw) * 0.5 + 0.5) * r.cssWidth;
      const sy = (0.5 - (cy / cw) * 0.5) * r.cssHeight;
      r.drawText(l.handle, r.cssWidth, r.cssHeight, sx - (l.width * cell) / 2, sy, style, 0);
    }
  }

  /** Where the canvas stands in the page, read once a second rather than every frame. */
  private origin(): { left: number; top: number } {
    if (this.sinceOrigin++ % 60 === 0) {
      const rect = this.canvas.getBoundingClientRect();
      this.at.left = rect.left;
      this.at.top = rect.top;
    }
    return this.at;
  }

  /** The overhead camera at `height` over (x, z), showing `half` metres either way, turned by `yaw`. */
  private aim(x: number, z: number, height: number, half: number, yaw: number): void {
    const c = this.camera;
    c.position[0] = x;
    c.position[1] = height;
    c.position[2] = z;
    c.fovYDeg = (2 * Math.atan(half / height) * 180) / Math.PI;
    /* Straight down keeps the yaw it is given, which is what puts the heading at the top. */
    c.lookAt(x + Math.sin(yaw) * 1e-3, 0, z + Math.cos(yaw) * 1e-3);
  }

  private inset(
    left: number,
    top: number,
    width: number,
    height: number,
    x: number,
    z: number,
    yaw: number,
    scale: number,
  ): void {
    const r = this.renderer;
    const aspect = r.beginInset({ left, top, width, height } as DOMRect, STREET);
    this.camera.updateMatrices(aspect);
    r.bindMeshPass(this.camera, this.env);
    /* Untextured: the world's last class leaves its arrays bound, and the map wears none. */
    r.setMaterial(null);
    r.drawMesh(this.mesh, this.model);
    const m = this.spot;
    const s = Math.sin(yaw) * scale;
    const c = Math.cos(yaw) * scale;
    m.fill(0);
    m[0] = c;
    m[2] = -s;
    m[5] = scale;
    m[8] = s;
    m[10] = c;
    m[12] = x;
    m[13] = 3;
    m[14] = z;
    m[15] = 1;
    r.drawMesh(this.marker, m);
    r.endInset();
  }
}

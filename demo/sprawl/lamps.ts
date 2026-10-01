/**
 * The city's lamps: every one of them summed into the volume the bake made (`LVOL`), and the
 * nearest shaded exactly (`LITE`), chosen through a grid so the choice does not scan them all.
 *
 * **Both at the city's night.** A lamp listed `night` shines as the city's timetable says — its
 * colour scaled by the night factor, rescaled only when that changes — and the volume is dimmed by
 * the same number, so the two agree where they crossfade. A lamp listed `always` burns regardless;
 * the volume summed those in too, which by day leaves them to the exact choice near the eye.
 *
 * **Every lamp is in the volume**, so the exact choice is told so (`inLightField`) and does not
 * count one twice. Intensities are the reference's own, times the unit the bake summed them in,
 * which the scene carries: the two must agree or the seam between exact and summed light moves.
 *
 * **Every night lamp near the eye shows its bulb**: a light comes from something a walker can point
 * at, and the reference's own bulbs are glow sprites its engine draws, which fade to a few pixels
 * past fifty metres. Here each is a small emissive sphere, tinted by its lamp, which the frame's
 * night gates and its bloom haloes — for the lamps the exact choice took, faded out between
 * `BULB_FADE_FROM` and `BULB_FADE_TO`. Every bulb in the city at full glow was a white star from the
 * air over every street.
 *
 * What it gives up for now: the nearest lamps' shadows, which want the regions' geometry as
 * casters; and a bulb's glow at a distance, where the reference's sprite keeps a few pixels and a
 * sphere goes smaller than one.
 */
import {
  MeshBuilder,
  createLightGrid,
  createMeshInstances,
  createPointLightBuffer,
  selectGridLights,
} from '../../packages/core/src/index';
import type {
  Environment,
  InstancedHandle,
  MeshInstances,
  PointLightSource,
  RendererApi,
  WorldLightField,
} from '../../packages/core/src/index';
import type { DrftLightVolume, DrftLight } from '@driftengine/drft';

/** Metres a grid cell spans: about a lamp's reach. */
const GRID_CELL = 50;
/** How far the exact choice looks for lamps. */
const VIEW_RANGE = 400;
/**
 * What a lamp's light is scaled by before it reaches the frame: the reference's intensities are read
 * through an eye that adapts to the dark, which this frame has no auto-exposure to do, so a night
 * street at their numbers is a sheet of orange. Chosen by eye against its captures; the first
 * thing a side-by-side comparison should correct.
 */
const LAMP_EXPOSURE = 0.27;
/**
 * How bright a bulb glows at night: past the bloom's threshold, so a bulb near the eye haloes, and
 * no further — at 6 every bulb in the city was a white star from the air, where the reference's
 * glow sprites fade to a few pixels with distance.
 */
const BULB_GLOW = 3;
/** Where a bulb starts to fade from the eye, and where it is gone, metres. */
const BULB_FADE_FROM = 80;
const BULB_FADE_TO = 200;
/** How far the eye moves before the near bulbs are chosen again, metres. */
const BULB_STEP = 1;
/** A lamp's bulb, whose size softens its light and its shadow. */
const BULB = 0.2;

export class CityLamps {
  readonly buffer;
  private sources: PointLightSource[] = [];
  /** Each source's colour at full night, three floats a lamp, and whether it waits for night. */
  private base = new Float32Array(0);
  private nightly = new Uint8Array(0);
  private grid: ReturnType<typeof createLightGrid> | null = null;
  private field: WorldLightField | null = null;
  private night = -1;
  private bulbs: { batch: InstancedHandle; data: MeshInstances } | null = null;
  /** Each lamp's bulb tint at full glow, three floats a lamp, and where the near ones were chosen. */
  private bulbTints = new Float32Array(0);
  private readonly bulbAt = new Float32Array([Infinity, Infinity, Infinity]);

  constructor(
    private readonly renderer: RendererApi,
    env: Environment,
  ) {
    this.buffer = createPointLightBuffer(renderer.quality.clusteredLights ? 320 : 16);
    env.lightPositions = this.buffer.positions;
    env.lightColors = this.buffer.colors;
    env.lightRadii = this.buffer.radii;
    env.lightSourceRadii = this.buffer.sourceRadii;
    env.lightWeights = this.buffer.weights;
    env.lightDirections = this.buffer.directions;
    env.lightConeCos = this.buffer.coneCos;
    env.lightIesProfiles = this.buffer.iesProfiles;
    env.activeLightWorldIndices = this.buffer.sourceIndex;
  }

  /** Take the lamps and the volume as the container hands them over; once each. */
  arrive(lights: readonly DrftLight[], volume: DrftLightVolume | null, unit: number): void {
    if (this.grid === null && lights.length > 0) {
      this.sources = lights.map((l) => ({
        x: l.position[0],
        y: l.position[1],
        z: l.position[2],
        r: 0,
        g: 0,
        b: 0,
        radius: l.range,
        flicker: 0,
        shadowNear: 0.1,
        sourceRadius: BULB,
        castsShadow: false,
        inLightField: volume !== null,
      }));
      this.base = new Float32Array(lights.length * 3);
      this.nightly = new Uint8Array(lights.length);
      lights.forEach((l, i) => {
        for (let c = 0; c < 3; c++)
          this.base[i * 3 + c] = (l.color[c] as number) * l.intensity * unit * LAMP_EXPOSURE;
        this.nightly[i] = l.name === 'night' ? 1 : 0;
      });
      this.grid = createLightGrid(this.sources, GRID_CELL);
      this.night = -1;
      this.bulbs = this.makeBulbs(lights);
      this.bulbAt[0] = Infinity;
    }
    if (this.field === null && volume !== null) {
      this.field = this.renderer.createWorldLightField(volume, { fadeSec: 0 });
      for (const source of this.sources) source.inLightField = true;
      /* The volume is scaled where the night changes; one arriving after the lamps has to be told. */
      this.night = -1;
    }
  }

  /** Every night lamp's bulb, drawn in the frame's opaque pass. */
  drawBulbs(): void {
    if (this.bulbs !== null) this.renderer.drawInstanced(this.bulbs.batch, this.bulbs.data);
  }

  /** The batch the near bulbs are drawn from, as many as the exact choice takes; each bulb's tint. */
  private makeBulbs(lights: readonly DrftLight[]): { batch: InstancedHandle; data: MeshInstances } {
    const mesh = this.renderer.createMesh(
      new MeshBuilder().addSphere([0, 0, 0], BULB, [1, 1, 1], BULB_GLOW, 8, 4).build(),
    );
    this.bulbTints = new Float32Array(lights.length * 3);
    lights.forEach((l, i) => {
      /* The light's own colour at its brightest channel's full strength. */
      const peak = Math.max(l.color[0], l.color[1], l.color[2], 1e-3);
      for (let c = 0; c < 3; c++) this.bulbTints[i * 3 + c] = (l.color[c] as number) / peak;
    });
    const capacity = this.buffer.positions.length / 3;
    const data = createMeshInstances(capacity);
    const batch = this.renderer.createInstanced(mesh, capacity, { cull: true });
    return { batch, data };
  }

  /** The bulbs of the night lamps the exact choice took, faded with their distance from (x, y, z). */
  private chooseBulbs(x: number, y: number, z: number): void {
    const bulbs = this.bulbs;
    if (bulbs === null) return;
    const { data } = bulbs;
    const m = data.models;
    let n = 0;
    for (let k = 0; k < this.buffer.count; k++) {
      const i = this.buffer.sourceIndex[k] as number;
      if (this.nightly[i] !== 1) continue;
      const source = this.sources[i] as PointLightSource;
      const d = Math.hypot(source.x - x, source.y - y, source.z - z);
      const t = Math.min(Math.max((d - BULB_FADE_FROM) / (BULB_FADE_TO - BULB_FADE_FROM), 0), 1);
      const fade = 1 - t * t * (3 - 2 * t);
      if (fade <= 0) continue;
      const o = n * 16;
      m.fill(0, o, o + 16);
      m[o] = m[o + 5] = m[o + 10] = m[o + 15] = 1;
      m[o + 12] = source.x;
      m[o + 13] = source.y;
      m[o + 14] = source.z;
      for (let c = 0; c < 3; c++)
        data.tints[n * 3 + c] = (this.bulbTints[i * 3 + c] as number) * fade;
      n += 1;
    }
    data.count = n;
    this.renderer.uploadInstanced(bulbs.batch, data);
  }

  /** Light the frame from (x, y, z) at `night`, the city's own. */
  update(night: number, x: number, y: number, z: number, dt: number, env: Environment): void {
    if (night !== this.night) {
      this.night = night;
      for (let i = 0; i < this.sources.length; i++) {
        const source = this.sources[i] as PointLightSource;
        const gate = this.nightly[i] === 1 ? night : 1;
        source.r = (this.base[i * 3] as number) * gate;
        source.g = (this.base[i * 3 + 1] as number) * gate;
        source.b = (this.base[i * 3 + 2] as number) * gate;
      }
      if (this.field !== null) this.field.scale = night * LAMP_EXPOSURE;
    }
    if (this.grid === null) {
      env.lightCount = 0;
      return;
    }
    selectGridLights(this.grid, x, y, z, this.buffer, 0, VIEW_RANGE);
    env.lightCount = this.buffer.count;
    const a = this.bulbAt;
    if (Math.hypot(x - (a[0] as number), y - (a[1] as number), z - (a[2] as number)) >= BULB_STEP) {
      a[0] = x;
      a[1] = y;
      a[2] = z;
      this.chooseBulbs(x, y, z);
    }
    this.field?.follow(this.buffer.complete, x, y, z, dt);
  }
}

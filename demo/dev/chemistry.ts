/**
 * A hearth, and everything in shot is doing real chemistry.
 *
 * **`§24` of the chemistry design is the exit test for Track P, and its exit condition is not "it
 * looks like fire".** It is the panel in the corner: element totals for all fifteen elements, energy
 * in and out, parcel and chunk counts. *A demo whose conservation panel drifts is a failed demo.*
 *
 *     /chemistry.html                  the hearth
 *     /chemistry.html?backend=webgpu   the other backend
 *
 * What is in shot, and what each object is there to show:
 *
 *   - **Seasoned oak, close to the embers.** `§21`'s timeline: it dries with its surface pinned at
 *     the boiling point, then smokes, then chars — and it darkens and shrinks as it does, because
 *     `present/` reads its char fraction and its remaining mass.
 *   - **Green oak beside it, at the same distance.** One number different — 60% moisture against
 *     12% — and it does not catch. Nothing anywhere was told about wet wood.
 *   - **Kindling.** Thermally thin, so it goes first. The depth stack is the whole difference.
 *   - **A kettle of water.** The boiling plateau, visible: its readout climbs to 100 °C and stops.
 *   - **A block of ice on the stones.** The fusion plateau, and then a puddle.
 *   - **An iron nail and a copper coin.** Emissivity, which is the number that decides how fast a
 *     metal heats beside a fire — and it is why they are still cool when the wood is charring.
 *   - **A limestone block in the fire.** Calcination, endothermic, above 825 °C.
 *
 * **Deterministic.** Nothing here reads a clock or `Math.random`: the simulation runs on a fixed
 * step counted in frames, and every parcel's state is a function of how many have elapsed. Two runs
 * at the same frame count agree exactly, which is what `§15` asks of the model and what makes the
 * ledger below worth reading.
 *
 * **`AGENTS.md`'s standing trap is live in this page.** Emissive is gated on `nightFactor`, so the
 * embers are drawn against a dark environment on purpose — at noon they would look dead however hot
 * they are. That is the engine's rule rather than this scene's choice, and it is exactly the trap a
 * consumer meets first.
 *
 * ---
 *
 * ## What it reads at five minutes, and what each number is evidence of
 *
 * ```
 * seasoned oak     347°C  core    23°C  char   4%     the depth stack: the core has not noticed
 * green oak        100°C  core    17°C  char   0%     pinned on its plateau, and it stays there
 * kindling         747°C  core   736°C  char  18%     thermally thin, heated right through
 * kettle            99°C  core    19°C  char   0%     the boiling plateau, visibly
 * ice               91°C  core    -1°C  char   0%     the fusion plateau, at the core
 * nail             611°C  core   611°C  char   0%     emissivity 0.65
 * coin              75°C  core    75°C  char   0%     emissivity 0.05, same fire, same distance
 * drift  2.56e-10                                     the exit condition
 * ```
 *
 * **Two of those were bugs this page found**, which is what a demo is for. The copper coin reached
 * 4,000 K on its first frame and 100 K a minute later: conduction's sub-step cap let a thin,
 * highly conductive parcel ring instead of settling, and `conduction.ts` now clamps a pair at the
 * point they would be equal. And the panel's own drift measure read 1.0 while nothing was wrong —
 * `elementTotals` nets against the far field, so nitrogen is two large terms cancelling, and a
 * per-element relative measure divides noise by nearly zero.
 *
 * **The smoke count stayed at zero until something flamed, and that was the gap rather than the
 * scene.** Soot forms above about 1,000 K in a rich mixture, so a hearth that is drying and charring
 * makes volatiles and no soot — and what a real one makes instead is condensed tar aerosol, which
 * this model had nowhere to put. `tar(l)` is a species now, `library/organic` condenses tar into it
 * below a 523 K dew point and evaporates it back above one, and `aerosolAt` sums it: so the pale
 * smoke over a smouldering log is the model's answer rather than the consumer's to invent.
 *
 * **Which is the thing to look at first on this page now**, and the thing this comment cannot
 * assert: the plume over the seasoned oak should be pale while it is drying and charring, and should
 * darken only once something is flaming above it.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type { MeshHandle, ParticleHandle, RendererApi, Vec3 } from '../../packages/core/src/index';
import { ELEMENTS, ELEMENT_COUNT } from '../../packages/chemistry/src/index';
import {
  installChemistry,
  parcelFromBounds,
  writeSurface,
  emitSmoke,
  flameHeight,
} from '../../packages/chemistry/src/present/index';
import type { SmokeTarget, SurfaceTarget } from '../../packages/chemistry/src/present/index';
import { ORGANIC } from '../../packages/chemistry/src/library/organic';
import { FOOD } from '../../packages/chemistry/src/library/food';
import { MINERAL } from '../../packages/chemistry/src/library/mineral';
import { METAL } from '../../packages/chemistry/src/library/metal';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const BACKGROUND: Vec3 = [0.015, 0.018, 0.024];
/** The fixed step, and it is coarse on purpose: a fire is minutes long and a frame is not. */
const DT = 0.25;
const SMOKE_CAPACITY = 512;

/** One object on the hearth: what it is, where it sits, and how big a box it is. */
interface Thing {
  readonly substance: string;
  readonly label: string;
  readonly at: Vec3;
  readonly size: Vec3;
  /** Overrides the substance's own moisture, for the green log. */
  readonly wet?: number;
}

const HEARTH: readonly Thing[] = [
  { substance: 'oak', label: 'seasoned oak', at: [0.55, 0.1, 0], size: [0.07, 0.07, 0.5] },
  {
    substance: 'oak',
    label: 'green oak',
    at: [0.55, 0.1, 0.35],
    size: [0.07, 0.07, 0.5],
    wet: 1.5,
  },
  { substance: 'pine', label: 'kindling', at: [0.42, 0.06, -0.3], size: [0.012, 0.012, 0.3] },
  { substance: 'water', label: 'kettle', at: [-0.55, 0.12, 0.1], size: [0.14, 0.14, 0.14] },
  { substance: 'ice', label: 'ice', at: [-0.55, 0.06, -0.3], size: [0.08, 0.08, 0.08] },
  { substance: 'iron', label: 'nail', at: [0.3, 0.04, 0.5], size: [0.004, 0.004, 0.08] },
  { substance: 'copper', label: 'coin', at: [0.36, 0.04, 0.5], size: [0.02, 0.02, 0.002] },
  { substance: 'limestone', label: 'limestone', at: [0.2, 0.08, -0.5], size: [0.12, 0.12, 0.12] },
];

/** A box, built once at a char level. See `charStep` for why there are several of each. */
function box(size: Vec3, colour: Vec3, emissive: number): ReturnType<MeshBuilder['build']> {
  return new MeshBuilder()
    .addBox([0, 0, 0], [size[0] / 2, size[1] / 2, size[2] / 2], colour, emissive)
    .build({});
}

/**
 * How many pre-built meshes each object gets, one per step of charring.
 *
 * **A per-instance albedo would be better and this engine has no such thing**: colour is a vertex
 * attribute, baked at build. Rebuilding a mesh every frame to recolour it would upload geometry to
 * say a colour, so the darkening is quantised into eight steps and the scene picks one. That is a
 * limitation of the *demo* rather than of `present/`, which writes a continuous albedo into whatever
 * array a consumer with per-instance colour hands it.
 */
const CHAR_STEPS = 8;

function model(at: Vec3, scale: number): Float32Array {
  const m = new Float32Array([scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, 1]);
  m[12] = at[0];
  m[13] = at[1];
  m[14] = at[2];
  return m;
}

/**
 * A particle pool this scene owns, satisfying **both** shapes at once.
 *
 * That is the whole point of `present/` being structural: `SmokeTarget` names what `emitSmoke` must
 * write and `ParticleInstances` names what `drawParticles` must read, and one object is both without
 * either package importing the other. `spins` is core's and `emitSmoke` never touches it.
 */
function smokeTarget(capacity: number): SmokeTarget & { spins: Float32Array } {
  return {
    spins: new Float32Array(capacity),
    positions: new Float32Array(capacity * 3),
    velocities: new Float32Array(capacity * 3),
    colors: new Float32Array(capacity * 3),
    alphas: new Float32Array(capacity),
    sizes: new Float32Array(capacity),
    ages: new Float32Array(capacity),
    seeds: new Float32Array(capacity),
    count: 0,
    capacity,
  };
}

function surfaceTarget(capacity: number): SurfaceTarget {
  return {
    albedos: new Float32Array(capacity * 3),
    emissives: new Float32Array(capacity * 3),
    roughness: new Float32Array(capacity),
    scales: new Float32Array(capacity),
    count: 0,
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const ledger = document.getElementById('ledger') as HTMLElement;
  canvas.width = canvas.clientWidth || 1280;
  canvas.height = canvas.clientHeight || 720;

  const created = await createRenderer(canvas, { ...askedQuality(), ...DEV_RENDERER });
  const renderer: RendererApi = created.renderer;

  /* Four families, and a consumer's whole wiring job is this call. */
  const chem = installChemistry({ libraries: [ORGANIC, FOOD, MINERAL, METAL], maxChunks: 8 });

  /* Everything on the hearth, spawned from its own bounding box. */
  const parcels: number[] = [];
  for (const thing of HEARTH) {
    const substance = chem.substances.indexOf(thing.substance);
    const density = chem.substances.densityOf(substance);
    const b = parcelFromBounds(thing.size[0], thing.size[1], thing.size[2], density);
    const parcel = chem.parcels.spawn({
      substance,
      mass: b.mass,
      temperature: 288.15,
      area: b.area,
      /* The field is in cell coordinates and the scene is in metres; the hearth sits at cell 4. */
      x: 4 + thing.at[0],
      y: 4 + thing.at[1],
      z: 4 + thing.at[2],
    });
    /* The green log: the same wood with one number changed, poured on rather than re-authored. */
    if (thing.wet !== undefined) chem.parcels.wet(parcel, b.mass * thing.wet * 0.2);
    parcels.push(parcel);
  }

  /* Meshes: one per object per char step, plus the flame and the hearth stones. */
  const meshes: MeshHandle[][] = HEARTH.map((thing, i) => {
    const appearance = chem.substances.appearanceOf(chem.parcels.substanceOf(parcels[i] as number));
    const base: Vec3 =
      appearance === null
        ? [0.5, 0.5, 0.5]
        : [appearance.albedo[0], appearance.albedo[1], appearance.albedo[2]];
    const charred: Vec3 =
      appearance === null
        ? [0.1, 0.1, 0.1]
        : [appearance.charAlbedo[0], appearance.charAlbedo[1], appearance.charAlbedo[2]];
    return Array.from({ length: CHAR_STEPS }, (_, step) => {
      const t = step / (CHAR_STEPS - 1);
      const mixed: Vec3 = [
        base[0] * (1 - t) + charred[0] * t,
        base[1] * (1 - t) + charred[1] * t,
        base[2] * (1 - t) + charred[2] * t,
      ];
      return renderer.createMesh(box(thing.size, mixed, 0));
    });
  });
  const stones: MeshHandle = renderer.createMesh(box([2.2, 0.08, 1.6], [0.3, 0.29, 0.27], 0));
  const embers: MeshHandle = renderer.createMesh(box([0.5, 0.06, 0.4], [0.5, 0.16, 0.03], 1));

  const smokeBatch: ParticleHandle = renderer.createParticles(SMOKE_CAPACITY, {
    material: 'smoke',
    blend: 'alpha',
    erosion: 0.5,
  });

  const camera = new Camera();
  camera.fovYDeg = 50;
  camera.near = 0.05;
  camera.far = 60;
  camera.position[0] = 1.4;
  camera.position[1] = 0.9;
  camera.position[2] = 2.0;
  camera.lookAt(0, 0.2, 0);
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);
  /* Night, and it has to be: emissive is gated on `nightFactor`, so an ember at noon looks dead. */
  const env = createEnvironment({ nightFactor: 1 });

  const smoke = smokeTarget(SMOKE_CAPACITY);
  const look = surfaceTarget(HEARTH.length);
  const before = new Float64Array(ELEMENT_COUNT);
  const after = new Float64Array(ELEMENT_COUNT);
  chem.world.elementTotals(before);
  const energyBefore = chem.parcels.count > 0 ? totalEnergy(chem) : 0;
  let frame = 0;

  const draw = (): void => {
    frame++;
    /* The tick, on a fixed step counted in frames. No clock is read anywhere in this page. */
    chem.world.sources.clear();
    chem.world.sources.add(4, 4.05, 4, 1150, 0.2, 90000);
    chem.world.contacts.clear();
    for (const parcel of parcels) chem.parcels.ignite(parcel);
    chem.world.simulate(DT, 0.15, 0);

    writeSurface(chem.parcels, parcels, look);
    emitSmoke(chem.air, 0, 3, 0, 8, smoke, { threshold: 1e-9, size: 0.22, wind: 0.15 });

    renderer.beginFrame(BACKGROUND);
    renderer.bindMeshPass(camera, env);
    renderer.setMaterial(null);
    renderer.drawMesh(stones, model([0, -0.02, 0], 1));
    renderer.drawMesh(embers, model([0, 0.05, 0], 1));

    for (let i = 0; i < HEARTH.length; i++) {
      const thing = HEARTH[i] as Thing;
      const parcel = parcels[i] as number;
      const char = chem.parcels.charFractionOf(parcel);
      const step = Math.min(CHAR_STEPS - 1, Math.max(0, Math.round(char * (CHAR_STEPS - 1))));
      /*
       * The glow, per instance, through `emissiveScale` — which is the one per-draw colour this
       * renderer has. `writeSurface` wrote a linear RGB already multiplied by `T⁴`, so a cold object
       * scales by zero and disappears from the emissive term entirely.
       */
      const at3 = i * 3;
      renderer.setMaterial({
        emissiveScale: [
          look.emissives[at3] as number,
          look.emissives[at3 + 1] as number,
          look.emissives[at3 + 2] as number,
        ],
      });
      renderer.drawMesh(
        (meshes[i] as MeshHandle[])[step] as MeshHandle,
        model(thing.at, look.scales[i] as number),
      );
    }
    renderer.setMaterial(null);
    renderer.drawParticles(smokeBatch, smoke, camera, env, frame * DT);
    renderer.endFrame();

    /* The panel, which is the exit condition. */
    /*
     * **Measured against the magnitudes involved rather than per element**, and the difference is
     * not pedantic. `elementTotals` nets the live chunks against the far-field ledger, so an
     * unreactive element like nitrogen is two ~17,000 mol terms cancelling to nearly nothing — and a
     * relative-per-element measure then divides floating-point noise by a near-zero net and reports
     * a drift of one. This panel said exactly that on its first run.
     */
    chem.world.elementTotals(after);
    let worst = 0;
    let magnitude = 0;
    const rows: string[] = [];
    for (let e = 0; e < ELEMENT_COUNT; e++) {
      const gap = Math.abs((after[e] as number) - (before[e] as number));
      if (gap > worst) worst = gap;
      magnitude += Math.abs(before[e] as number) + Math.abs(after[e] as number);
      if ((after[e] as number) !== 0) {
        rows.push(`${ELEMENTS[e]} ${(after[e] as number).toExponential(3)}`);
      }
    }
    const drift = magnitude > 0 ? worst / magnitude : 0;
    const kw =
      chem.parcels.count > 0
        ? parcels.reduce((sum, p) => sum + chem.parcels.heatReleaseOf(p), 0) / 1000
        : 0;
    ledger.innerHTML =
      `<b>element totals, mol</b>\n${rows.join('\n')}\n\n` +
      `drift  <span class="${drift < 1e-9 ? '' : 'bad'}">${drift.toExponential(2)}</span>\n` +
      /* In, not conserved: the radiative source is outside the ledger by construction, and a
         hearth that absorbed nothing would be a hearth that was not lit. */
      `energy in ${(totalEnergy(chem) - energyBefore).toExponential(3)} J\n` +
      `parcels ${parcels.length}   chunks ${chem.air.chunkCount}\n` +
      `smoke   ${smoke.count} particles\n` +
      `magnitude ${magnitude.toExponential(2)} mol`;

    stats.textContent =
      `${created.backend} · t=${(frame * DT).toFixed(0)}s · ${kw.toFixed(2)} kW · ` +
      `flame ${flameHeight(Math.max(0, kw), 0.4).toFixed(2)} m\n` +
      HEARTH.map((thing, i) => {
        const p = parcels[i] as number;
        return (
          `${thing.label.padEnd(14)} ${(chem.parcels.surfaceTemperatureOf(p) - 273.15).toFixed(0).padStart(5)}°C  ` +
          `core ${(chem.parcels.coreTemperatureOf(p) - 273.15).toFixed(0).padStart(5)}°C  ` +
          `char ${(chem.parcels.charFractionOf(p) * 100).toFixed(0).padStart(3)}%  ` +
          (chem.parcels.burning(p) ? 'burning' : '')
        );
      }).join('\n');

    (globalThis as unknown as { __drift: number }).__drift = drift;
    (globalThis as unknown as { __drawn: boolean }).__drawn = true;
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}

/** Thermal plus chemical, over every parcel: the sum a conserving model holds constant. */
function totalEnergy(chem: ReturnType<typeof installChemistry>): number {
  let total = 0;
  for (let p = 0; p < chem.parcels.count; p++) {
    if (!chem.parcels.alive(p)) continue;
    total += chem.parcels.enthalpyOf(p) + chem.parcels.chemicalEnergyOf(p);
  }
  return total;
}

void main();

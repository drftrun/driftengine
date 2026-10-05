/**
 * The shading models, side by side, on either backend.
 *
 *     /models.html                    WebGPU: standard, anisotropic, hair, skin, eye, left to right
 *     /models.html?backend=webgl2     the other backend
 *     /models.html?spin=1             turning, for a highlight that should move with the light
 *     /models.html?backlight=0        the lamp behind them off, the control for what glows through
 *     /models.html?view=disc          brushed discs, grooves running round them: anisotropic at
 *                                     strength 0 (the control), 0.8, and 0.8 turned a quarter
 *     /models.html?view=hair          a curtain of bowed strands, a lamp behind it on the line of
 *                                     sight: &backlit=0 turns the transmitted lobe off, the
 *                                     control for its glow; &standard=1 draws them unmodelled
 *     /models.html?view=skin          at a person's scale: a head's curvature, a thin fin like an
 *                                     ear with a lamp behind it, a low sun across the terminator;
 *                                     &standard=1 draws both unmodelled, &backlight=0 the lamp off,
 *                                     &skinscatter=screen adds the screen-space blur, and
 *                                     &radius= sets the scatter: at 0.0001 the blur spans under
 *                                     half a pixel, the control for the split adding back whole;
 *                                     &pane=1 draws a dark pane over the head after it, which must
 *                                     dim the spread skin as it dims the whole
 *     /models.html?view=eye           an eye at a person's scale, a painted iris under its cornea:
 *                                     &turn=30 turns it, &ior=1 takes the refraction away (the
 *                                     control), &standard=1 draws it unmodelled
 *     /models.html?view=cornea        a flat four-centimetre patch of cornea over a dot, seen at
 *                                     30° from +X: the dot moves toward the eye by the refracted
 *                                     crossing, 1.21 mm under 3 mm — &ior=1 is where it really is
 *
 * Five spheres with tangents, one material each, lit by a low sun from the front-left, a warm lamp
 * to the right and a cool lamp behind. Every model compiles its own pipeline the first time a draw
 * asks for it, so this page is also where a model that fails to compile on one backend shows.
 *
 * **What is measured**: each sphere against the standard one beside it, on both backends, and the
 * two backends against each other. Deterministic: a fixed camera and no clock unless `?spin=1`.
 * Nothing under `src/` may import this.
 */
import {
  Camera,
  MeshBuilder,
  anisotropicModel,
  createEnvironment,
  createRenderer,
  eyeModel,
  generateTangents,
  hairModel,
  skinModel,
} from '../../packages/core/src/index';
import type {
  MeshData,
  RendererApi,
  SurfaceMaterial,
  SurfaceTextureHandle,
  Vec3,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const BACKGROUND: Vec3 = [0.05, 0.055, 0.065];
const ASKED = new URLSearchParams(location.search);

/** A sphere with texture coordinates and the tangent frame the generator gives them. */
function sphere(color: Vec3): MeshData {
  const data = new MeshBuilder()
    .addSphere([0, 0, 0], 0.9, color, 0, 48, 24)
    .build({ planarUvs: true });
  /* Projected along Z, so an eye's iris sits at +Z and the tangent runs along +X. */
  const uvs = new Float32Array((data.positions.length / 3) * 2);
  for (let v = 0; v < data.positions.length / 3; v++) {
    uvs[v * 2] = 0.5 + (data.positions[v * 3] as number) / 1.8;
    uvs[v * 2 + 1] = 0.5 + (data.positions[v * 3 + 1] as number) / 1.8;
  }
  return {
    ...data,
    uvs,
    tangents: generateTangents(data.positions, data.normals, uvs, data.indices),
  };
}

/**
 * A flat disc facing +Z whose tangents run round it, as a lathe's grooves do: an anisotropic
 * highlight is then a streak across the grooves, through the centre, toward the light.
 */
function disc(color: Vec3): MeshData {
  const rings = 24;
  const segments = 96;
  const count = (rings + 1) * (segments + 1);
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const tangents = new Float32Array(count * 4);
  for (let r = 0; r <= rings; r++) {
    for (let k = 0; k <= segments; k++) {
      const v = r * (segments + 1) + k;
      const radius = 0.05 + (r / rings) * 0.85;
      const angle = (k / segments) * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      positions.set([x, y, 0], v * 3);
      normals.set([0, 0, 1], v * 3);
      colors.set(color, v * 3);
      uvs.set([0.5 + x / 1.8, 0.5 + y / 1.8], v * 2);
      tangents.set([-Math.sin(angle), Math.cos(angle), 0, 1], v * 4);
    }
  }
  const indices: number[] = [];
  for (let r = 0; r < rings; r++) {
    for (let k = 0; k < segments; k++) {
      const a = r * (segments + 1) + k;
      const b = a + segments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return {
    positions,
    normals,
    colors,
    emissive: new Float32Array(count),
    uvs,
    tangents,
    indices: new Uint32Array(indices),
  };
}

/**
 * A curtain of strands, each a thin tube bowed toward the eye, its tangent running down it from root
 * to tip: the highlights fall in bands across it where each strand's angle to the light puts them,
 * rather than lighting a straight strand all or nothing.
 */
function strands(color: Vec3): MeshData {
  const count = 180;
  const sides = 6;
  const rings = 40;
  const radius = 0.012;
  const perStrand = (rings + 1) * sides;
  const vertices = count * perStrand;
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const colors = new Float32Array(vertices * 3);
  const tangents = new Float32Array(vertices * 4);
  const roughness = new Float32Array(vertices).fill(0.3);
  const indices: number[] = [];
  for (let k = 0; k < count; k++) {
    const jitter = Math.sin(k * 12.9898) * 0.5;
    const x = -3 + (6 * (k + 0.5)) / count + jitter * 0.02;
    const z = jitter * 0.08;
    const bow = 0.6 + jitter * 0.1;
    for (let r = 0; r <= rings; r++) {
      const u = r / rings;
      const along = [0, -3.2, bow * Math.PI * Math.cos(Math.PI * u)];
      const length = Math.hypot(along[1] as number, along[2] as number);
      const ty = (along[1] as number) / length;
      const tz = (along[2] as number) / length;
      for (let a = 0; a < sides; a++) {
        const angle = (a / sides) * Math.PI * 2;
        const v = k * perStrand + r * sides + a;
        /* Round the strand: across it in x, and in the plane of its bow. */
        const nx = Math.cos(angle);
        const ny = Math.sin(angle) * tz;
        const nz = -Math.sin(angle) * ty;
        positions.set(
          [
            x + radius * nx,
            1.6 - 3.2 * u + radius * ny,
            z + bow * Math.sin(Math.PI * u) + radius * nz,
          ],
          v * 3,
        );
        normals.set([nx, ny, nz], v * 3);
        colors.set(color, v * 3);
        tangents.set([0, ty, tz, 1], v * 4);
      }
    }
    for (let r = 0; r < rings; r++) {
      for (let a = 0; a < sides; a++) {
        const p = k * perStrand + r * sides;
        const b = (a + 1) % sides;
        indices.push(p + a, p + sides + a, p + b, p + b, p + sides + a, p + sides + b);
      }
    }
  }
  return {
    positions,
    normals,
    colors,
    emissive: new Float32Array(vertices),
    uvs: new Float32Array(vertices * 2),
    tangents,
    roughness,
    indices: new Uint32Array(indices),
  };
}

/** An ellipsoid with these semi-axes, its normals true to its shape, and a tangent frame. */
function ellipsoid(color: Vec3, axes: Vec3, roughness: number): MeshData {
  const rings = 48;
  const segments = 64;
  const count = (rings + 1) * (segments + 1);
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  for (let r = 0; r <= rings; r++) {
    const theta = (r / rings) * Math.PI;
    for (let k = 0; k <= segments; k++) {
      const phi = (k / segments) * Math.PI * 2;
      const v = r * (segments + 1) + k;
      const unit = [
        Math.sin(theta) * Math.cos(phi),
        Math.cos(theta),
        Math.sin(theta) * Math.sin(phi),
      ];
      positions.set([unit[0]! * axes[0], unit[1]! * axes[1], unit[2]! * axes[2]], v * 3);
      const nx = unit[0]! / axes[0];
      const ny = unit[1]! / axes[1];
      const nz = unit[2]! / axes[2];
      const length = Math.hypot(nx, ny, nz);
      normals.set([nx / length, ny / length, nz / length], v * 3);
      colors.set(color, v * 3);
      uvs.set([k / segments, r / rings], v * 2);
    }
  }
  const indices: number[] = [];
  for (let r = 0; r < rings; r++) {
    for (let k = 0; k < segments; k++) {
      const a = r * (segments + 1) + k;
      const b = a + segments + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const index = new Uint32Array(indices);
  return {
    positions,
    normals,
    colors,
    emissive: new Float32Array(count),
    uvs,
    tangents: generateTangents(positions, normals, uvs, index),
    roughness: new Float32Array(count).fill(roughness),
    indices: index,
  };
}

/**
 * An eye's colour, planar along its axis: a sclera, an iris of `iris` of the texture's width in
 * radius with streaks running out from the pupil and a darker limbus, and a pupil.
 */
function irisTexture(iris: number): HTMLCanvasElement {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return canvas;
  const c = size / 2;
  ctx.fillStyle = 'rgb(236, 229, 220)';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = 'rgb(58, 92, 120)';
  ctx.beginPath();
  ctx.arc(c, c, iris * size, 0, Math.PI * 2);
  ctx.fill();
  for (let k = 0; k < 72; k++) {
    const a = (k / 72) * Math.PI * 2;
    ctx.strokeStyle = k % 2 === 0 ? 'rgb(120, 150, 170)' : 'rgb(40, 66, 92)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * 0.1 * size, c + Math.sin(a) * 0.1 * size);
    ctx.lineTo(c + Math.cos(a) * iris * 0.95 * size, c + Math.sin(a) * iris * 0.95 * size);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgb(28, 40, 52)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(c, c, iris * size - 3, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = 'rgb(8, 8, 10)';
  ctx.beginPath();
  ctx.arc(c, c, 0.09 * size, 0, Math.PI * 2);
  ctx.fill();
  return canvas;
}

/** An eyeball of radius `radius`, its texture planar along +Z so the iris faces the eye's axis. */
function eyeball(radius: number): MeshData {
  const data = new MeshBuilder()
    .addSphere([0, 0, 0], radius, [1, 1, 1], 0, 64, 48)
    .build({ planarUvs: true });
  const uvs = new Float32Array((data.positions.length / 3) * 2);
  for (let v = 0; v < data.positions.length / 3; v++) {
    uvs[v * 2] = 0.5 + (data.positions[v * 3] as number) / (2 * radius);
    uvs[v * 2 + 1] = 0.5 - (data.positions[v * 3 + 1] as number) / (2 * radius);
  }
  return {
    ...data,
    uvs,
    roughness: new Float32Array(data.positions.length / 3).fill(0.3),
    tangents: generateTangents(data.positions, data.normals, uvs, data.indices),
  };
}

/** A white square with one black dot at its centre. */
function dotTexture(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return canvas;
  ctx.fillStyle = 'rgb(240, 240, 240)';
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = 'rgb(0, 0, 0)';
  ctx.beginPath();
  ctx.arc(128, 128, 12, 0, Math.PI * 2);
  ctx.fill();
  return canvas;
}

/** A flat square `size` across facing +Z, texture coordinates across it, tangents along +X. */
function patch(size: number): MeshData {
  const h = size / 2;
  return {
    positions: new Float32Array([-h, -h, 0, h, -h, 0, h, h, 0, -h, h, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array(12).fill(1),
    emissive: new Float32Array(4),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    tangents: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
    roughness: new Float32Array(4).fill(0.5),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

/** A one-texel map of the colour given, read linear: a model's channels where it wants constants. */
function constantMap(r: number, g: number, b: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    ctx.fillStyle = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
    ctx.fillRect(0, 0, 1, 1);
  }
  return canvas;
}

/** A one-texel ORM map: occlusion none, the roughness given, fully metal. */
function metalOrm(roughness: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    ctx.fillStyle = `rgb(255, ${Math.round(roughness * 255)}, 255)`;
    ctx.fillRect(0, 0, 1, 1);
  }
  return canvas;
}

function at(x: number, y: number, z: number, turn: number): Float32Array {
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, y, z, 1]);
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const view = ASKED.get('view');
  const skin = view === 'skin';
  const cornea = view === 'cornea';
  const eye = view === 'eye' || cornea;
  const env = createEnvironment({
    directionalDir: skin ? [-0.85, 0.2, 0.48] : [-0.55, 0.35, 0.76],
    directionalColor: [1.0, 0.95, 0.88],
    ambient: [0.12, 0.13, 0.16],
    ambientGround: [0.05, 0.05, 0.06],
    fogDensity: 0,
  });
  const camera = new Camera();
  camera.fovYDeg = 32;
  camera.near = skin || eye ? 0.005 : 0.3;
  camera.far = skin || eye ? 5 : 80;
  renderer.resize();
  /* `&camx=` moves the camera across, for an eye seen from the side without turning it. */
  camera.position[0] = cornea
    ? 0.09 * Math.sin(Math.PI / 6)
    : eye
      ? Number(ASKED.get('camx') ?? 0)
      : 0;
  camera.position[1] = skin ? 0.02 : cornea ? 0 : eye ? 0.004 : 0.6;
  camera.position[2] = skin ? 0.55 : cornea ? 0.09 * Math.cos(Math.PI / 6) : eye ? 0.09 : 12;
  camera.lookAt(skin ? 0.01 : 0, 0, 0);
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  /* A warm lamp to the front right, and a cool one behind the row: what glows through hair and an ear. */
  const backlight = ASKED.get('backlight') !== '0';
  env.lightCount = backlight ? 2 : 1;
  env.lightPositions.set([5, 2.5, 4, 0.5, 1.2, -3.5]);
  env.lightColors.set([3.2, 2.3, 1.5, 1.6, 2.4, 3.8]);
  env.lightRadii.set([16, 12]);
  env.lightSourceRadii.set([0.12, 0.12]);
  if (view === 'hair') {
    /* Behind the curtain on the line from the eye through it, where light passes straight through. */
    env.lightPositions.set([0.4, -0.2, -3.2], 3);
    env.lightSourceRadii.set([0.12, 0.5]);
  }
  if (eye) {
    /* A small lamp up and to the right, for the cornea's glint; the sun from the left for the iris. */
    env.lightCount = 1;
    env.lightPositions.set([0.08, 0.07, 0.12]);
    env.lightColors.set([3, 2.9, 2.7]);
    env.lightRadii.set([1]);
    env.lightSourceRadii.set([0.004]);
  }
  if (skin) {
    /* The sun low from the left, across the head's terminator; one lamp just behind the fin. */
    env.lightCount = backlight ? 1 : 0;
    env.lightPositions.set([0.085, 0.01, -0.09]);
    env.lightColors.set([2.4, 2.1, 1.8]);
    env.lightRadii.set([0.5]);
    env.lightSourceRadii.set([0.02]);
  }

  const orm = renderer.createSurfaceTexture(metalOrm(0.35), { colorSpace: 'linear' });
  const discs = view === 'disc';
  const hair = view === 'hair';
  const standard = ASKED.get('standard') === '1';
  const radius = Number(ASKED.get('radius') ?? NaN);
  const skinned = skinModel(Number.isFinite(radius) ? { radius } : {});
  const materials: {
    label: string;
    color: Vec3;
    material: SurfaceMaterial<SurfaceTextureHandle>;
    mesh?: MeshData;
    place?: Vec3;
  }[] = cornea
    ? [
        {
          label: 'cornea',
          color: [1, 1, 1],
          material: {
            model: eyeModel({ irisRadius: 0.5, ior: Number(ASKED.get('ior') ?? 1.336) }),
            albedo: renderer.createSurfaceTexture(dotTexture(), { colorSpace: 'srgb' }),
          },
          mesh: patch(0.04),
          place: [0, 0, 0],
        },
      ]
    : eye
      ? [
          {
            label: standard ? 'eye, standard' : 'eye',
            color: [1, 1, 1],
            material: {
              model: standard
                ? null
                : eyeModel({
                    irisRadius: 0.24,
                    ior: Number(ASKED.get('ior') ?? 1.336),
                  }),
              albedo: renderer.createSurfaceTexture(irisTexture(0.24), { colorSpace: 'srgb' }),
            },
            mesh: eyeball(0.012),
            place: [0, 0, 0],
          },
        ]
      : skin
        ? [
            {
              label: standard ? 'head, standard' : 'head',
              color: [0.8, 0.57, 0.47],
              material: { model: standard ? null : skinned },
              mesh: ellipsoid([0.8, 0.57, 0.47], [0.09, 0.09, 0.09], 0.45),
              place: [-0.06, 0, 0],
            },
            {
              /* Six millimetres thick and gently curved: the map's red and green say so. */
              label: standard ? 'fin, standard' : 'fin',
              color: [0.8, 0.57, 0.47],
              material: {
                model: standard ? null : skinned,
                modelMap: renderer.createSurfaceTexture(constantMap(0.3, 0.25, 1), {
                  colorSpace: 'linear',
                }),
              },
              mesh: ellipsoid([0.8, 0.57, 0.47], [0.025, 0.035, 0.003], 0.45),
              place: [0.085, 0, 0],
            },
          ]
        : hair
          ? [
              {
                label: ASKED.get('standard') === '1' ? 'strands, standard' : 'strands',
                color: [0.45, 0.28, 0.14],
                material: {
                  model:
                    ASKED.get('standard') === '1'
                      ? null
                      : hairModel({ backlit: ASKED.get('backlit') === '0' ? 0 : 1 }),
                },
              },
            ]
          : discs
            ? [
                {
                  label: 'strength 0',
                  color: [0.85, 0.84, 0.82],
                  /* ?standard=1 draws this one with no model: strength 0 must be the same picture. */
                  material: {
                    model: ASKED.get('standard') === '1' ? null : anisotropicModel({ strength: 0 }),
                    orm,
                  },
                },
                {
                  label: 'strength 0.8',
                  color: [0.85, 0.84, 0.82],
                  material: { model: anisotropicModel({ strength: 0.8 }), orm },
                },
                {
                  label: 'turned a quarter',
                  color: [0.85, 0.84, 0.82],
                  material: {
                    model: anisotropicModel({ strength: 0.8, rotation: Math.PI / 2 }),
                    orm,
                  },
                },
              ]
            : [
                { label: 'standard', color: [0.75, 0.62, 0.5], material: {} },
                {
                  label: 'anisotropic',
                  color: [0.8, 0.8, 0.82],
                  material: { model: anisotropicModel({ strength: 0.8 }), orm },
                },
                { label: 'hair', color: [0.35, 0.2, 0.1], material: { model: hairModel() } },
                { label: 'skin', color: [0.82, 0.6, 0.5], material: { model: skinModel() } },
                { label: 'eye', color: [0.9, 0.9, 0.88], material: { model: eyeModel() } },
              ];
  /* A dark pane across the head's lower half, drawn after it: the blur must land beneath it. */
  const pane =
    skin && ASKED.get('pane') === '1'
      ? renderer.createMesh(ellipsoid([0.05, 0.05, 0.06], [0.12, 0.05, 0.002], 0.3))
      : null;
  const meshes = materials.map((m) =>
    renderer.createMesh(
      m.mesh ?? (hair ? strands(m.color) : discs ? disc(m.color) : sphere(m.color)),
    ),
  );
  const spin = ASKED.get('spin') === '1';

  let turn = 0;
  const draw = (): void => {
    renderer.beginFrame(BACKGROUND);
    renderer.bindMeshPass(camera, env);
    materials.forEach((m, k) => {
      renderer.setMaterial(m.material);
      const x = hair ? 0 : discs ? (k - 1) * 2.4 : (k - 2) * 2.1;
      const place = m.place ?? [x, 0, 0];
      const turned = eye ? turn + (Number(ASKED.get('turn') ?? 0) * Math.PI) / 180 : turn;
      renderer.drawMesh(meshes[k] as never, at(place[0], place[1], place[2], turned));
    });
    renderer.setMaterial(null);
    if (pane !== null) renderer.drawTranslucentMesh(pane, at(-0.06, -0.04, 0.1, 0), 0.8);
    renderer.endFrame();
    if (spin) {
      turn += 0.01;
      requestAnimationFrame(draw);
    }
  };
  draw();
  stats.textContent =
    `${renderer.backend} · ${materials.map((m) => m.label).join(' | ')}` +
    ` · backlight ${backlight ? 'on' : 'off'}`;
  (window as unknown as { __modelsReady: boolean }).__modelsReady = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null) {
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
});

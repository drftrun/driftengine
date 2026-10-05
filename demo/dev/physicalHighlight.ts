/**
 * A lamp's highlight on a black floor, the look's and GGX's own (`SurfaceMaterial.physicalSpecular`).
 *
 *     /physicalHighlight.html               the look: a peak of 1 times the specular attribute
 *     /physicalHighlight.html?physical=1    GGX's own, `π · D · Vis · F · N·L`
 *     ...&sun=1                             the same from the sun in place of the lamp
 *     ...&color=0.2253                      the light's brightness, 1 when absent
 *     ...&aniso=0                           the anisotropic model at that strength, whose physical
 *                                           lobe at 0 is the standard one's, pixel for pixel
 *     ...&uvs=0                             a floor with no texture coordinates, so no frame: the
 *                                           anisotropic model drew it black until 4.8.7
 *
 * **The geometry is chosen so the peak can be worked by hand.** The lamp at (0, 2, −1) and the eye
 * at (0, 2, 1) are mirrored about the floor's normal through the origin, which is the middle of the
 * frame: there the half vector is the normal, and N·L = N·V = 2/√5. At roughness 0.5, α is 0.25 and
 * the physical lobe is 4 / √0.8125 = 4.43760 (`anisotropicLobe.test.ts` works the same number), with
 * Schlick's F at V·H = 2/√5 adding 1.3 × 10⁻⁵ of the remainder to the attribute's 0.5. The look's
 * peak is 1 times 0.5. So the physical frame at a brightness of 1 / 4.43766 = 0.22534 must show the
 * look's middle pixel exactly, and every other pixel differently.
 *
 * The lamp falls off by its own exponent 1 over a radius of a kilometre, so its shape at √5 m is
 * 0.999995 in both frames, and the floor is black and lit by nothing else, so the highlight is all
 * there is. Deterministic: a fixed camera, no clock.
 */
import {
  Camera,
  MeshBuilder,
  anisotropicModel,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type { RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const ASKED = new URLSearchParams(location.search);
const BACKGROUND: Vec3 = [0, 0, 0];

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  const renderer: RendererApi = created.renderer;

  const physical = ASKED.get('physical') === '1';
  const sun = ASKED.get('sun') === '1';
  const brightness = Number(ASKED.get('color') ?? 1);
  const env = createEnvironment({
    directionalColor: [0, 0, 0],
    ambient: [0, 0, 0],
    ambientGround: [0, 0, 0],
    fogDensity: 0,
  });
  if (sun) {
    env.directionalDir = [0, 2 / Math.sqrt(5), -1 / Math.sqrt(5)];
    env.directionalColor = [brightness, brightness, brightness];
  } else {
    env.lightCount = 1;
    env.lightPositions.set([0, 2, -1]);
    env.lightColors.set([brightness, brightness, brightness]);
    env.lightRadii[0] = 1000;
    env.lightSourceRadii[0] = 0;
    env.lightFalloffExponents = new Float32Array(env.lightRadii.length);
    env.lightFalloffExponents[0] = 1;
  }

  const camera = new Camera();
  camera.fovYDeg = 50;
  camera.near = 0.1;
  camera.far = 100;
  camera.position[0] = 0;
  camera.position[1] = 2;
  camera.position[2] = 1;
  camera.lookAt(0, 0, 0);
  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  /*
   * Black, so no diffuse; a specular attribute of 0.5, read as F0 by the physical highlight. Planar
   * coordinates, because the anisotropic model takes its direction from the texture's.
   */
  const floor = renderer.createMesh(
    new MeshBuilder()
      .setRoughness(0.5)
      .addQuad([-20, 0, 20], [20, 0, 20], [20, 0, -20], [-20, 0, -20], [0, 0, 0], 0, 0.5)
      .build({ planarUvs: ASKED.get('uvs') !== '0' }),
  );
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const aniso = ASKED.get('aniso');
  const material = {
    physicalSpecular: physical,
    model: aniso === null ? null : anisotropicModel({ strength: Number(aniso) }),
  };
  const frame = (): void => {
    renderer.beginFrame(BACKGROUND);
    renderer.bindMeshPass(camera, env);
    renderer.setMaterial(material);
    renderer.drawMesh(floor, identity);
    renderer.setMaterial(null);
    renderer.endFrame();
    requestAnimationFrame(frame);
  };
  frame();
  stats.textContent = `${created.backend} · ${physical ? 'physical' : 'look'} · ${location.search}`;
}

void main();

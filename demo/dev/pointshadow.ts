/**
 * A point light, a fixture around it, and a caster that moves. The two shadows a lamp casts.
 *
 * **This page exists because two defects were reported against exactly this arrangement and no
 * scene in this repository has it.** Every point-lit demo here is static — `nightCourt` passes
 * `NO_MOVING_CASTERS` and says so — so the *live* half of the point-shadow system, the one that
 * shadows a mover, has never had a page of its own. It was verified by a consumer or not at
 * all.
 *
 * The two reports, from a game, 2026-08-25:
 *
 *   1. a flickering source stopped casting a moving character's shadow;
 *   2. a square larger than the fixture pulses around it.
 *
 * **Every candidate mechanism is a query flag here, so the page is an elimination rather than a
 * picture.** The 2026-08-10 rule says isolate by switching one thing off at a time, before any
 * theory; these are the switches.
 *
 *     /pointshadow.html                  a steady lamp, a still caster and a mover
 *     ?flicker=0                         colour modulation off
 *     ?pulse=1                           animate the light's *radius*, which is not the same thing
 *     ?near=0.02                         a near plane far too small for a fixture
 *     ?mover=0                           no moving caster at all
 *     ?fixture=0                         no geometry around the lamp
 *     ?lights=3                          three lamps, so ownership changes hands
 *     ?castfrom=camera                   select the shadow pool for the camera, not the mover
 *     ?area=1                            a rectangular emitter instead of the lamps, casting
 *     ?area=1&areacast=0                 the same rectangle with no occlusion, which is the control
 *     ?area=1&areaw=3&areah=0.05         a long thin strip, which is the shape reported from outside
 *     ?area=1&arearange=6                a shadow map far plane too short to reach the floor
 *
 * **`?pulse=1` is the one worth understanding.** `flicker` modulates *colour* and `matchesSource`
 * does not compare colour, so a flickering lamp keeps its map. An animated **radius** is a
 * different matter entirely: the range is the cube's far plane, so `matchesSource` compares it and
 * a lamp whose radius moves every frame is stale every frame — perpetually re-baking, and taking
 * bake budget from every other lamp while it does. `pointLightSelection.ts` documents that at
 * `castsShadow` and this flag is how to see it.
 *
 * Deterministic: the caster's position is a closed form of a frame counter, nothing reads a clock,
 * and the camera never moves — so two runs of one build differ in zero pixels.
 */
import {
  Camera,
  DEFAULT_POINT_LIGHT_VIEW_RANGE,
  MeshBuilder,
  createEnvironment,
  createAreaLightBuffer,
  createPointLightBuffer,
  createRenderer,
  selectAreaLights,
  selectPointLights,
} from '../../packages/core/src/index';
import type {
  AreaLightSource,
  MeshHandle,
  PointLightSource,
  RendererApi,
  ShadowCasters,
  Vec3,
} from '../../packages/core/src/index';

import { DEV_RENDERER, askedQuality } from './askedQuality';

const BACKGROUND: Vec3 = [0.01, 0.012, 0.016];

/** Where the lamp hangs. High enough that its own fixture is not the whole sky it sees. */
const LAMP_Y = 2.4;
/** How far the mover travels either side of the lamp, and how fast in frames. */
const TRAVEL = 3.2;
const PERIOD_FRAMES = 180;

function identity(): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

function at(x: number, y: number, z: number): Float32Array {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

/**
 * The ground the shadows land on, wound so its normal points up.
 *
 * **`gloss` is what makes an area light's *specular* half visible on this page**, and until
 * 2026-09-04 nothing here could see it: the floor is matte, so `vSpecular` is zero, so the whole
 * term was skipped and a capture of this page would have passed with it deleted. That is the same
 * shape as the mistake `envSpecularEnergy` records — an acceptance measurement bound no ORM map and
 * so tested a dielectric, the one material the defect was small on.
 *
 * A roughness near a tenth puts the rectangle's reflection on the floor as a legible patch rather
 * than a mirror-sharp one no sampling disc would land inside.
 */
function buildFloor(gloss: number | null): ReturnType<MeshBuilder['build']> {
  const half = 14;
  const builder = new MeshBuilder();
  if (gloss !== null) builder.setRoughness(gloss);
  return builder
    .addQuad(
      [-half, 0, half],
      [half, 0, half],
      [half, 0, -half],
      [-half, 0, -half],
      [0.5, 0.5, 0.53],
      0,
      gloss === null ? 0 : 1,
    )
    .build();
}

/**
 * The lamp's housing: a small box the light sits *inside*.
 *
 * This is the geometry the first report is about. A fixture surrounding a source occludes an
 * enormous solid angle from the source's point of view, and with a near plane of a few centimetres
 * it is *in* the shadow map — so the lamp shadows itself and throws its own housing across the
 * ground as a hard square far larger than the housing is. `POINT_SHADOW_NEAR` exists for this and
 * `?near=` is how to watch it fail.
 */
function buildFixture(): ReturnType<MeshBuilder['build']> {
  return new MeshBuilder().addBox([0, LAMP_Y, 0], [0.22, 0.22, 0.22], [0.3, 0.28, 0.24], 0).build();
}

/** A still caster, so there is always something a *static* map should be showing. */
function buildPost(): ReturnType<MeshBuilder['build']> {
  return new MeshBuilder().addBox([1.9, 0.9, 0], [0.18, 0.9, 0.18], [0.62, 0.6, 0.58], 0).build();
}

/** The mover, which only a *live* map can shadow. */
function buildMover(): ReturnType<MeshBuilder['build']> {
  return new MeshBuilder().addBox([0, 0.55, 0], [0.3, 0.55, 0.3], [0.75, 0.72, 0.68], 0).build();
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
  const stats = document.getElementById('stats');
  if (canvas === null || stats === null) return;

  const params = new URLSearchParams(location.search);
  const number = (name: string, fallback: number): number => {
    const raw = params.get(name);
    if (raw === null) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };

  const wantsFlicker = params.get('flicker') !== '0';
  const wantsPulse = params.get('pulse') === '1';
  const wantsMover = params.get('mover') !== '0';
  const wantsFixture = params.get('fixture') !== '0';
  const shadowNear = number('near', 0.25);
  /*
   * **`?radius=` matters more than it looks.** A light is only offered a shadow map while the
   * casting reference point handed to `selectPointLights` is *inside* its radius — see the guard
   * there — so a radius smaller than that distance means no map at all, and a scene that looks
   * perfectly lit casts nothing. That is a different failure from a map that never baked and the
   * picture cannot tell them apart, which is why this page publishes `shadowCount`.
   *
   * **It used to be the camera's distance, and this page was the proof of what that costs.** The
   * camera sits 9.708 m from the lamp and the default here is 9, so at its own defaults this page
   * offered *zero* maps and every measurement taken on it needed `?radius=` raised first. The
   * reference point is now the mover; `?castfrom=camera` restores the old behaviour.
   */
  const lampRadius = number('radius', 9);
  /*
   * **`?source=` is the emitter's physical size, and it is not a softness slider.** `sphereLobe`
   * and the shadow filter both read it: a wider source widens the penumbra *and* fades the
   * shadow's strength, and `lobes.ts` tabulates the pair — at a spread of 0.625 the strength
   * reaches zero and there is no shadow left to blur. So a caster far from what it shadows can
   * lose its shadow entirely to this, which is indistinguishable in the picture from a map that
   * never baked.
   */
  const lampSourceRadius = number('source', 0.18);
  /*
   * **`?cone=` turns every lamp into a spot aimed straight down**, and `?coneinner=` sets where the
   * bright middle ends. Absent leaves them point lights, which is the state every published scene
   * is in and the state the collapse has to reproduce exactly.
   *
   * On this page rather than a page of its own because the interesting question about a spot is
   * what its *shadow* does — a cone crops the shadow map's useful area to the part of the sphere
   * the cone covers, and the casters here are already arranged to show that.
   */
  const coneOuterDeg = number('cone', 0);
  const coneInnerDeg = number('coneinner', coneOuterDeg * 0.75);
  /*
   * **`?ies=1` loads a synthetic photometric profile rather than a file**, because the engine ships
   * none and this page's job is to show that the machinery shapes a light rather than to test a
   * particular fixture. The profile is a hand-built cosine-squared falling to nothing at 60
   * degrees, so what it should produce is obvious by eye: a pool with a soft edge and no cone
   * anywhere in the light's declaration.
   */
  const wantsIes = params.get('ies') === '1';
  /*
   * **`?area=1` hangs a rectangular emitter over the scene** and switches the lamps off, so what is
   * on screen is the area light alone. The rectangle is drawn as an emissive panel so its outline
   * is visible and the shape of what it lights can be compared against it — a light whose falloff
   * does not match the shape above it is the failure this page can show and a number cannot.
   */
  const wantsArea = params.get('area') === '1';
  /*
   * **The rectangle casts by default once `?area=1` is on, and `?areacast=0` is the control.**
   *
   * The engine's own default is the other way round — `AreaLightSource.castsShadow` is false,
   * because every scene that declared a rectangle before 2026-08-28 was authored against a light
   * that passed through stone. A page whose whole purpose is to photograph the occlusion wants the
   * opposite default, and wants the unoccluded frame one reload away: the two differ in nothing but
   * this flag, which is the elimination the 2026-08-10 rule asks for.
   */
  const areaCasts = params.get('areacast') !== '0';
  /*
   * **`?areaw=`/`?areah=` are the reported shape.** A festoon on a cable is a metres-long emitter a
   * few centimetres tall, and that is the case a round penumbra cannot express: `areaShadow` opens
   * its filter along the rectangle's own axes, so a strip should read as soft along its length and
   * tight across it. At the defaults below the rectangle is a panel, where the two axes are within
   * a factor of three and the anisotropy is subtle — `?areaw=3&areah=0.05` is where it is the whole
   * effect.
   */
  const areaHalfWidth = number('areaw', 1.6);
  const areaHalfHeight = number('areah', 0.5);
  /*
   * **`?arearange=` is the far plane, and a rectangle has no radius to take one from.** Set it
   * shorter than the floor is far and the shadow stops in a straight line partway across, which is
   * a failure worth being able to produce on purpose: it looks like a broken projection and it is a
   * number a consumer chose.
   */
  const areaRange = number('arearange', 24);
  const areaNear = number('areanear', 0.25);
  /*
   * **`?areay=` is how the one measurement `docs/IMPROVEMENTS.md` named can be made.** That row
   * priced a representative-point map before it was built and said which case would show its limit:
   * "a panel a metre across, half a metre above its caster — the case where a point origin is most
   * wrong". The mover's top is at 1.1, so `?areay=1.6&areaw=0.5&areah=0.5` is that case, and the
   * emitter's default 3 is far enough up that nothing about it shows.
   */
  const areaY = number('areay', 3);
  const lampCount = Math.max(1, Math.min(4, Math.round(number('lights', 1))));

  const created = await createRenderer(
    canvas,
    {
      ...askedQuality(),
      directionalShadows: false,
    },
    DEV_RENDERER,
  );
  const renderer: RendererApi = created.renderer;
  /* Published so a readback script can reach the point-shadow array. Dev pages only; nothing in
     the engine exposes a renderer this way and nothing should. */
  (globalThis as unknown as { __renderer?: unknown }).__renderer = renderer;

  /**
   * **`?areagloss=` makes the ground specular, which is the only way this page can see a highlight.**
   *
   * A number is the roughness; absent leaves the floor matte, which is every capture written before
   * 2026-09-04 and is what keeps them comparable.
   */
  const areaDim = Number(params.get('areadim') ?? 1);
  const glossParam = params.get('areagloss');
  const floorGloss = glossParam === null ? null : Number(glossParam);
  const floorMesh = renderer.createMesh(buildFloor(floorGloss));
  const fixtureMesh = renderer.createMesh(buildFixture());
  const postMesh = renderer.createMesh(buildPost());
  const moverMesh = renderer.createMesh(buildMover());
  const floorModel = identity();
  const postModel = identity();

  /* Lamps in a row on the X axis, so a mover walking that axis changes which one owns it. */
  /* `?lampx=` slides the lamp along the axis the post stands on, so "does offset matter" is one
     reload rather than a rebuilt scene. */
  const lampOffsetX = number('lampx', 0);
  const lampX = (n: number): number => (n - (lampCount - 1) / 2) * 4.2 + lampOffsetX;
  const lights: PointLightSource[] = [];
  for (let n = 0; n < lampCount; n++) {
    lights.push({
      x: lampX(n),
      y: LAMP_Y,
      z: 0,
      r: 1,
      g: 0.72,
      b: 0.42,
      radius: lampRadius,
      flicker: wantsFlicker ? 0.35 : 0,
      shadowNear,
      sourceRadius: lampSourceRadius,
      castsShadow: true,
      /* Aimed straight down. A zero angle means no cone at all, which is a point light. */
      ...(coneOuterDeg > 0 ? { dirX: 0, dirY: -1, dirZ: 0, coneOuterDeg, coneInnerDeg } : {}),
    });
  }

  if (wantsArea) lights.length = 0;

  const areaLights: AreaLightSource[] = wantsArea
    ? [
        {
          x: 0,
          y: areaY,
          z: 0,
          /*
           * Bright enough that the pool's shape is legible against a dark floor.
           *
           * **`?areadim=` scales it, and exists so a highlight can be measured rather than clipped.**
           * A specular reflection of an emitter this bright saturates at 255 on a smooth floor, and
           * a clipped sample cannot tell a correct term from one several times too bright — which is
           * exactly the distinction the capture beside this has to make. Default 1, so every reading
           * taken before it existed still holds.
           */
          r: 9 * areaDim,
          g: 7.8 * areaDim,
          b: 6.6 * areaDim,
          /* Facing down: right along +X, up along +Z, so the emitting normal is -Y. */
          rightX: 1,
          rightY: 0,
          rightZ: 0,
          upX: 0,
          upY: 0,
          upZ: 1,
          halfWidth: areaHalfWidth,
          halfHeight: areaHalfHeight,
          castsShadow: areaCasts,
          shadowRange: areaRange,
          shadowNear: areaNear,
        },
      ]
    : [];
  const areaBuffer = createAreaLightBuffer();
  selectAreaLights(areaLights, areaBuffer);

  /* The panel itself, so its outline can be compared against the pool it casts. */
  const panelMesh = wantsArea
    ? renderer.createMesh(
        new MeshBuilder()
          .addBox([0, areaY, 0], [areaHalfWidth, 0.02, areaHalfHeight], [1, 0.92, 0.82], 1)
          .build({}),
      )
    : null;

  const lightBuffer = createPointLightBuffer();
  const env = createEnvironment({
    directionalColor: [0, 0, 0],
    ambient: [0.012, 0.013, 0.016],
    ambientGround: [0.008, 0.008, 0.01],
    emissiveGain: 1,
    /*
     * **One, or an emissive surface emits nothing.** `emissiveGain` reads like the switch and is
     * not: the multiplier that actually gates the term defaults to zero, so the area light's own
     * panel was invisible and the page could not show the emitter beside the pool it casts —
     * which is the one comparison a picture can make and a number cannot.
     */
    nightFactor: 1,
    fogColor: BACKGROUND,
    fogDensity: 0,
  });

  const camera = new Camera();
  camera.fovYDeg = 52;
  camera.near = 0.3;
  camera.far = 60;
  camera.position[0] = 0;
  camera.position[1] = 4.4;
  camera.position[2] = 9.5;
  camera.lookAt(0, 0.8, 0);

  renderer.resize();
  const aspect = (): number => (canvas.height > 0 ? canvas.width / canvas.height : 1);
  camera.updateMatrices(aspect());

  /* The mover's model, mutated in place: a per-frame path allocates nothing. */
  const moverModel = identity();
  let moverX = 0;

  /*
   * Casters, closed over the meshes and never building a list — the contract `ShadowCasters`
   * states, because a sink is called once per cubemap face.
   */
  /*
   * **`?poststatic=0` moves the still post into the dynamic list without moving the post.**
   *
   * The two lists are baked into different maps by different code paths — the pool, spread over
   * frames against a budget, and the live pair, rebaked every frame — and nothing else about the
   * geometry changes. So a caster that casts from one list and not the other says which path is at
   * fault, in one reload, with the sample points unmoved. That is the elimination the 2026-08-10
   * rule asks for, applied to a system rather than to a draw.
   */
  const postIsStatic = params.get('poststatic') !== '0';

  /*
   * **`?floorcasts=0` takes the ground out of the caster list without taking it out of the scene.**
   * A floor is the largest thing a lamp sees and the one most likely to fill a cubemap's whole
   * lower hemisphere, so whether it belongs in the enumeration at all is worth being able to ask.
   */
  const floorCasts = params.get('floorcasts') !== '0';
  /*
   * **`?post=0` removes the still post from the scene entirely, and it is not redundant with
   * `?poststatic=0`.** The post's own shadow is long — a metre-and-a-half column under a lamp two
   * and a half metres up throws several metres of it — and it sweeps across exactly the ground
   * where the mover's shadow is sampled. Measuring one caster while another's shadow lies over the
   * sample is how a working shadow reads as a missing one.
   */
  const wantsPost = params.get('post') !== '0';

  const staticCasters: ShadowCasters = (sink) => {
    if (floorCasts) sink.mesh(floorMesh, floorModel);
    if (wantsPost && postIsStatic) sink.mesh(postMesh, postModel);
    if (wantsFixture) sink.mesh(fixtureMesh, floorModel);
  };
  const dynamicCasters: ShadowCasters = (sink) => {
    if (wantsMover) sink.mesh(moverMesh, moverModel);
    if (wantsPost && !postIsStatic) sink.mesh(postMesh, postModel);
  };

  /**
   * **The call without which none of this page measures anything.**
   *
   * `prepareStaticPointShadows` builds the octahedral array itself — `texStorage3D` is immutable,
   * so it is sized from the world's light count rather than from the maximum — and every demo that
   * uses point shadows calls it once. This page did not, for its first several measurements, and
   * what that produced is worth writing down: `updatePointShadows` runs, the bake budget is spent,
   * nothing warns, and **no shadow appears anywhere at all**. It read as "static casters never
   * cast", which is a precise answer to a question nobody asked.
   *
   * The picture cannot tell a renderer with no shadow array from one whose maps are wrong, which
   * is why this page publishes `hasArray` beside `shadowCount`.
   */
  if (wantsIes) {
    const samples = 19;
    const verticalAngles = new Float32Array(samples);
    const candela = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      const deg = (i / (samples - 1)) * 180;
      verticalAngles[i] = deg;
      const t = Math.max(0, 1 - deg / 60);
      candela[i] = 1000 * t * t;
    }
    renderer.setIesProfiles([
      { verticalAngles, horizontalAngles: new Float32Array([0]), candela, maxCandela: 1000 },
    ]);
    for (const light of lights) light.iesProfile = 0;
  }

  /*
   * **The rectangles go in the same call, because there is one shadow array.** Leaving them out is
   * the area-light form of the failure this page's own comment above describes for point lights:
   * `updatePointShadows` runs, the budget is spent, nothing warns, and the rectangle lights through
   * the post as if the feature had never landed.
   */
  renderer.prepareStaticPointShadows(lights, areaLights);

  let frame = 0;
  const DT = 1 / 60;

  /**
   * **Holding the caster still is not the same as holding the renderer still**, and the first
   * version of this page conflated them.
   *
   * `updatePointShadows` is a per-frame call: it advances the arrival ramp, re-selects which light
   * owns a live map, and re-bakes the live pair. A page that stops calling it has frozen the shadow
   * system mid-stride rather than given it a settled scene to finish in, and every figure taken
   * afterwards is about that frozen state. So the caster's *motion* stops at the hold and the
   * update keeps running.
   */
  function moveCaster(): void {
    /* A closed form of the frame counter, so the page is reproducible frame for frame. */
    const phase = (frame % PERIOD_FRAMES) / PERIOD_FRAMES;
    moverX = Math.sin(phase * Math.PI * 2) * TRAVEL;
    moverModel[12] = moverX;
    moverModel[14] = 1.4;

    if (wantsPulse) {
      /*
       * **The radius, not the colour.** This is the switch that makes a lamp stale every frame,
       * because the range is the cube's far plane and `matchesSource` compares it.
       */
      for (let n = 0; n < lights.length; n++) {
        const light = lights[n];
        if (light !== undefined)
          light.radius = lampRadius + Math.sin(phase * Math.PI * 2 + n) * 0.6;
      }
    }
  }

  function updateShadows(): void {
    /*
     * **The clock stops at the hold, not just the caster.**
     *
     * `flicker` modulates a lamp's colour from this time value, so a page that keeps advancing it
     * is a page whose brightness is different in every capture. Three captures of one unchanged
     * build measured mean luminance 12.48, 12.78 and 13.46 — which reads as a build difference in
     * any cross-capture comparison and is a lamp flickering. The pixel gate was unmoved at 0
     * because the drift is spread thin, so the two metrics disagreed about whether anything had
     * changed, which is worse than either being wrong.
     */
    const clock = Math.min(frame, HOLD_AT) * DT;
    /*
     * **The pool is selected for the mover, and the mover is already where the maps are centred.**
     *
     * This page handed the camera to `selectPointLights` and `moverX, 0.55, 1.4` to
     * `updatePointShadows` — two reference points for one decision, which is exactly the defect
     * the guard below was filed as. At this page's own defaults it was not academic: the camera
     * sits **9.708 m** from a lamp of radius **9**, so `shadowCount` was **0** and the only page
     * in this repository with a moving caster offered no live map at all. Every measurement ever
     * taken here needed `?radius=` raised past the camera to see anything.
     *
     * `?castfrom=camera` puts it back, because a control has to be able to hold the old state:
     * the two differ in `shadowCount` alone, which is the one number that separates "never
     * offered a map" from "offered one that never baked".
     */
    const castFromCamera = params.get('castfrom') === 'camera';
    selectPointLights(
      lights,
      camera.position[0] ?? 0,
      camera.position[1] ?? 0,
      camera.position[2] ?? 0,
      lightBuffer,
      clock,
      DEFAULT_POINT_LIGHT_VIEW_RANGE,
      castFromCamera ? (camera.position[0] ?? 0) : moverX,
      castFromCamera ? (camera.position[1] ?? 0) : 0.55,
      castFromCamera ? (camera.position[2] ?? 0) : 1.4,
    );
    env.lightCount = lightBuffer.count;
    env.lightPositions = lightBuffer.positions;
    env.lightColors = lightBuffer.colors;
    env.lightRadii = lightBuffer.radii;
    env.lightSourceRadii = lightBuffer.sourceRadii;
    env.lightWeights = lightBuffer.weights;
    env.lightDirections = lightBuffer.directions;
    env.lightConeCos = lightBuffer.coneCos;
    env.lightIesProfiles = lightBuffer.iesProfiles;
    env.areaLights = wantsArea ? areaBuffer : null;
    env.activeLightWorldIndices = lightBuffer.sourceIndex;

    /* The live maps centre on the mover, which is what makes them the mover's shadow. */
    renderer.updatePointShadows(
      lights,
      lightBuffer.sourceIndex,
      lightBuffer.count,
      moverX,
      0.55,
      1.4,
      DT,
      staticCasters,
      dynamicCasters,
      lightBuffer.shadowIndex,
      lightBuffer.shadowCount,
      /* The same list and the same order `selectAreaLights` was given, which is what makes a slot
         mean one rectangle. */
      areaLights,
    );
  }

  function renderFrame(): void {
    renderer.beginFrame(BACKGROUND);
    renderer.bindMeshPass(camera, env);
    renderer.setMaterial(null);
    /* A matte floor reflects nothing and a glossy one is the point; see `buildFloor`. */
    renderer.setSurfaceReflectivity(floorGloss === null ? 0 : 1);
    renderer.drawMesh(floorMesh, floorModel);
    if (wantsPost) renderer.drawMesh(postMesh, postModel);
    if (wantsFixture) renderer.drawMesh(fixtureMesh, floorModel);
    if (wantsMover) renderer.drawMesh(moverMesh, moverModel);
    if (panelMesh !== null) renderer.drawMesh(panelMesh, floorModel);
    renderer.endFrame();
  }

  /*
   * Published for a measuring script: where the mover is on screen, where the post is, and where
   * the fixture is — so a check samples the ground beside a caster rather than a guessed grid.
   */
  const projected = new Float32Array(2);
  /**
   * Where a caster's shadow lands under the emitter, along the ray from it through the caster.
   *
   * The emitter's centre is at y=3 — see the declaration — so a caster whose top is at `h` throws
   * its shadow `3 / (3 - h)` of the way along its own offset. The mover's top is 0.55 and the
   * post's is 0.9, which are the two numbers the meshes are built with.
   */
  const AREA_Y = areaY;
  const AREA_T = AREA_Y / (AREA_Y - 0.55);
  const AREA_POST_T = AREA_Y / (AREA_Y - 0.9);
  /** Where the mover's shadow sits under the emitter, so the two lines above cross it. */
  const areaShadowXOf = (x: number): number => x * AREA_T;
  /**
   * The strip of ground the mover's shadow covers *past the mover itself*, which is the only part
   * of it a line can be walked along.
   *
   * The mover is a box 0.6 by 1.1 by 0.6 at z=1.4, so it spans z 1.1 to 1.7 and stands on the
   * ground it shadows; a line through its own footprint reads the box's silhouette, and that is a
   * hard edge whatever the emitter's shape. Measured, that gave 3.09 against 0.14 and *reversing
   * the emitter did not reverse it* — the number was the box.
   *
   * The top face at y=1.1 projects from the emitter's centre at y=3 by 3/(3-1.1), so its shadow
   * lands between z 1.74 and 2.68. The band's middle is clear of the box in z, and the far edge is
   * where a line along z crosses a penumbra rather than a mesh.
   */
  /*
   * Where the rectangle's reflection lands on the floor for this camera. See `areaGloss` below.
   */
  const AREA_GLOSS_Z =
    (camera.position[2] ?? 0) *
    (1 - (camera.position[1] ?? 0) / ((camera.position[1] ?? 0) + AREA_Y));

  const AREA_TOP_T = AREA_Y / (AREA_Y - 1.1);
  const AREA_NEAR_Z = 1.1 * AREA_TOP_T;
  const AREA_FAR_Z = 1.7 * AREA_TOP_T;
  const AREA_BAND_Z = (AREA_NEAR_Z + AREA_FAR_Z) / 2;
  /**
   * One of the rectangle's resolved layer indices, or -1.
   *
   * Reaching into the renderer, as `hasArray` above does and for the same reason: the number is
   * private, it is invisible in the frame, and the whole value of publishing it is that a
   * measuring script can tell "no layer" from "a layer that reads the wrong thing". Dev pages
   * only; nothing in the engine exposes this and nothing should.
   */
  const areaLayerOf = (field: 'layer' | 'liveLayer'): number => {
    const held = (renderer as unknown as { resolvedAreaShadows?: Record<string, Int32Array> })
      .resolvedAreaShadows;
    return held?.[field]?.[0] ?? -1;
  };
  const publish = (): void => {
    const place = (x: number, y: number, z: number): { x: number; y: number } => {
      camera.project(projected, x, y, z, canvas.clientWidth, canvas.clientHeight);
      return { x: projected[0] ?? 0, y: projected[1] ?? 0 };
    };
    /*
     * **Where a shadow actually lands, derived rather than guessed, and each with a control at
     * the same distance from the lamp.**
     *
     * The first writing of this page sampled "open ground far from everything" as its control and
     * measured 3.1 against 25.9 in the shadow — the control was darker than the thing it was
     * controlling for, because a point light falls off and distance was the dominant term. A
     * control has to separate the one thing under test and nothing else, which here means the
     * mirror of each sample through the lamp: same lamp, same distance, same falloff, caster or
     * no caster.
     *
     * The shadow of a caster at height `h` under a lamp at `LAMP_Y` lands where the ray from the
     * lamp through the caster meets the ground: `t = LAMP_Y / (LAMP_Y - h)` along it.
     */
    const moverT = LAMP_Y / (LAMP_Y - 0.55);
    const moverShadowX = moverX * moverT;
    const moverShadowZ = 1.4 * moverT;
    const postT = LAMP_Y / (LAMP_Y - 0.9);
    const postShadowX = 1.9 * postT;

    (globalThis as unknown as { __points?: unknown }).__points = {
      /* Where the mover's shadow must fall, and its mirror through the lamp, which must be lit. */
      moverShadow: place(moverShadowX, 0.02, moverShadowZ),
      moverControl: place(-moverShadowX, 0.02, -moverShadowZ),
      /* The same for the still post, whose shadow a *static* map owns. */
      postShadow: place(postShadowX, 0.02, 0),
      postControl: place(-postShadowX, 0.02, 0),
      /* Directly under the fixture, which is where a self-shadowing lamp throws its square, and
         a ring of ground at the same radius, which such a square would not reach. */
      underFixture: place(0, 0.02, 0),
      fixtureRing: place(0, 0.02, 2.6),
      moverX,
      /* What the selection actually produced, because "no shadow" has two very different causes
         and only one of them is the shadow system: a light that was never offered a map at all
         looks identical in the picture to a map that never baked. */
      lightCount: lightBuffer.count,
      shadowCount: lightBuffer.shadowCount,
      /*
       * **Where the rectangle's shadow lands, and its control at the same distance.**
       *
       * The emitter hangs at y=3 rather than the lamps' 2.4, so the same similar-triangles walk
       * gives a different point — sampling the lamps' points on an area-lit frame measures ground
       * beside the shadow and reads as a shadow that never arrived, which is a mistake worth
       * spending four lines to make impossible.
       *
       * The control is the mirror through the emitter's centre, so it shares the emitter, the
       * distance and the falloff and differs only in having no caster above it. This page's own
       * history is why: its first control was "open ground far from everything", which measured
       * darker than the shadow it was controlling for because distance was the dominant term.
       */
      /**
       * **Where the camera sees the rectangle reflected in the floor, and a control off it.**
       *
       * The specular reflection point on a plane is where the segment from the eye to the emitter
       * *mirrored through that plane* crosses it, which for a floor at y=0 is a walk along z alone.
       * The control sits at the same radius from the emitter's centre, so it shares the emitter, the
       * distance and the falloff and differs only in not being where the reflection lands — the same
       * discipline the shadow controls above are built on, and for the same reason.
       *
       * Meaningless without `?areagloss=`: a matte floor has no specular half to find.
       */
      areaGloss: place(0, 0.02, AREA_GLOSS_Z),
      areaGlossControl: place(AREA_GLOSS_Z, 0.02, 0),
      areaMoverShadow: place(moverX * AREA_T, 0.02, 1.4 * AREA_T),
      areaMoverControl: place(-moverX * AREA_T, 0.02, -1.4 * AREA_T),
      areaPostShadow: place(1.9 * AREA_POST_T, 0.02, 0),
      areaPostControl: place(-1.9 * AREA_POST_T, 0.02, 0),
      /*
       * Which layers the rectangle holds, or -1. The same distinction `shadowCount` draws for a
       * lamp: a rectangle that was never offered a layer and one whose bake never landed produce
       * the identical picture, and only one of them is a bug in the shadow path.
       */
      areaLayer: areaLayerOf('layer'),
      areaLiveLayer: areaLayerOf('liveLayer'),
      areaCasts,
      /*
       * **Two lines across the mover's shadow, one along each of the emitter's axes.**
       *
       * This is what a picture of an *area* shadow has to be measured on, and one line cannot do
       * it. The rectangle's penumbra is an ellipse the shape of the emitter, so a strip lying along
       * X blurs the same shadow's edge widely along X and hardly at all along Z — one frame, two
       * directions, no second configuration to compare against and no rotated emitter geometry in
       * the way.
       *
       * **The `axis` line above cannot answer it.** It runs along X at z=0 through the post, and the
       * post is 1.8 m tall under an emitter 3 m up: its umbra covers the floor from x≈1.7 to x≈5.2,
       * so the whole useful window is inside the shadow and there is no edge in it at all. Measured,
       * that reads as a penumbra with no shape — 1.80 against 1.87 — from a frame where the shapes
       * are 9 to 1. Use `?fixture=0&post=0` so the mover is the only caster.
       */
      areaAxisX: Array.from({ length: 61 }, (_, i) => {
        const x = areaShadowXOf(moverX) - 3 + (i * 6) / 60;
        const point = place(x, 0.02, AREA_BAND_Z);
        return { x, sx: point.x, sy: point.y };
      }),
      areaAxisZ: Array.from({ length: 61 }, (_, i) => {
        const z = AREA_FAR_Z - 0.7 + (i * 3) / 60;
        const point = place(areaShadowXOf(moverX), 0.02, z);
        return { x: z, sx: point.x, sy: point.y };
      }),
      /* Whether the array exists at all: the difference between "no shadows" and "wrong
         shadows", and invisible in the frame. */
      hasArray:
        (renderer as unknown as { pointShadowArray?: unknown }).pointShadowArray !== null &&
        (renderer as unknown as { pointShadowArray?: unknown }).pointShadowArray !== undefined,
      frame,
      /* A line of ground along the x axis at z=0, so a measuring script can see the *shape* of a
         shadow rather than sample where it guessed one would be. The post stands at x=1.9. */
      axis: Array.from({ length: 49 }, (_, i) => {
        const x = -6 + (i * 12) / 48;
        const p = place(x, 0.02, 0);
        return { x, sx: p.x, sy: p.y };
      }),
    };
  };

  /**
   * **The page holds still once it is ready to be measured, and that is not a convenience.**
   *
   * The mover's position is a function of the frame, and both the published sample points and the
   * screenshot are taken from outside — so a page that keeps moving hands a measuring script points
   * from one frame and pixels from another. That produced a control reading 10.0 against a sample
   * of 49.8 on one backend and nothing of the sort on the other, which reads exactly like a backend
   * difference and was two frames of drift.
   *
   * So the caster advances until the maps have certainly settled, then stops. Everything after that
   * is one unchanging frame, which is also what makes two runs of one build differ in zero pixels.
   */
  const HOLD_AT = Math.max(1, Math.round(number('hold', 90)));

  const tick = (): void => {
    if (frame < HOLD_AT) moveCaster();
    updateShadows();
    renderFrame();
    frame++;
    publish();
    /*
     * Held at a frame the bake has certainly settled by. The budget spreads a cubemap over
     * several frames, so a page that photographs frame one photographs a shadow that has not
     * finished arriving — which reads exactly like the defect this page is here to find.
     */
    if (frame === HOLD_AT + 12) (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
    if (frame < 600) requestAnimationFrame(tick);
  };

  stats.textContent =
    `${created.backend} · ${lampCount} lamp${lampCount === 1 ? '' : 's'} · ` +
    `flicker ${wantsFlicker ? 'on' : 'off'} · radius pulse ${wantsPulse ? 'on' : 'off'} · ` +
    `area ${wantsArea ? 'on' : 'off'} · ies ${wantsIes ? 'on' : 'off'} · cone ${coneOuterDeg > 0 ? `${coneInnerDeg}/${coneOuterDeg}deg` : 'none'} · lampx ${lampOffsetX} · source ${lampSourceRadius} · hold ${HOLD_AT} · radius ${lampRadius} · near ${shadowNear} · mover ${wantsMover ? 'on' : 'off'} · fixture ${wantsFixture ? 'on' : 'off'}`;

  requestAnimationFrame(tick);
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null) box.textContent = String(error);
  throw error;
});

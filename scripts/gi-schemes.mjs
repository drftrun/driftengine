/**
 * Wave 4A task 6 step 5: the two interpolation schemes, measured against the same rooms.
 *
 * **The spec left this open and said to decide it by measurement.** A visibility-weighted probe
 * volume is known to work; a radiance cascade arrangement, trading probe density against angular
 * resolution with distance, is more interesting and less proven. This builds both over the same
 * analytic scene and reports what each costs and what each leaks.
 *
 * **The scene is analytic on purpose.** A baked field would put its own error into both columns,
 * and the question here is about the interpolation rather than about the field. Every ray below is
 * a closed-form intersection against two axis-aligned boxes: a room, and a partition across it.
 * The half at `+x` emits; the half at `-x` is black, and any light measured there arrived through
 * a solid wall.
 *
 * Run: `node scripts/gi-schemes.mjs`. It needs no GPU and no browser.
 */

const ROOT = new URL('..', import.meta.url).pathname;
const { octInsetDir, octInsetUv } = await import(
  `${ROOT}packages/core/src/render/shaders/octahedral.ts`
);
const { ProbeGrid, createProbeBlend } = await import(
  `${ROOT}packages/core/src/render/probeGrid.ts`
);
const { createProbeVisibility, sampleProbeVolume, visibleProbes } = await import(
  `${ROOT}packages/core/src/render/gi/probeVolume.ts`
);
const { composeGlobalField, createGlobalField } = await import(
  `${ROOT}packages/core/src/render/gi/globalField.ts`
);
const { newIndirectResult, traceIndirect } = await import(
  `${ROOT}packages/core/src/render/gi/chain.ts`
);

/* ---------------------------------------------------------------- the rooms */

/** The room's inside, and the partition standing across the middle of it. */
const ROOM = { min: [-4, -2, -2], max: [4, 2, 2] };

/** Where a ray leaves a box it is inside. Slabs, and the near face is behind it by definition. */
function exitBox(box, ox, oy, oz, dx, dy, dz) {
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  let far = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(d[axis]) < 1e-12) continue;
    const inv = 1 / d[axis];
    const a = (box.min[axis] - o[axis]) * inv;
    const b = (box.max[axis] - o[axis]) * inv;
    far = Math.min(far, Math.max(a, b));
  }
  return far;
}

/** Where a ray enters a box it is outside, or Infinity if it never does. */
function enterBox(box, ox, oy, oz, dx, dy, dz) {
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  let near = 0;
  let far = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(d[axis]) < 1e-12) {
      if (o[axis] < box.min[axis] || o[axis] > box.max[axis]) return Infinity;
      continue;
    }
    const inv = 1 / d[axis];
    let a = (box.min[axis] - o[axis]) * inv;
    let b = (box.max[axis] - o[axis]) * inv;
    if (a > b) [a, b] = [b, a];
    near = Math.max(near, a);
    far = Math.min(far, b);
  }
  return near <= far && far > 0 ? Math.max(near, 0) : Infinity;
}

/**
 * Cast a ray and report where it stopped and how bright what it hit was.
 *
 * The room's own inner face at `+x` is the only thing in the scene that emits.
 */
function cast(scene, ox, oy, oz, dx, dy, dz) {
  const wall = enterBox(scene.wall, ox, oy, oz, dx, dy, dz);
  const room = exitBox(ROOM, ox, oy, oz, dx, dy, dz);
  if (wall < room) return { t: wall, radiance: 0 };
  return { t: room, radiance: ox + dx * room > scene.wallX ? 1 : 0 };
}

/**
 * The partition, standing **off the probe lattice on purpose**.
 *
 * At `x = 0` with probes every two metres one probe stands *inside* the wall, reads black in every
 * direction, and shields the dark room from its own lit neighbour — so the unweighted grid leaks
 * nothing and the measurement says the visibility term buys nothing. That is an accident of where
 * the wall was put, and it is exactly the accident a scene built to flatter a technique contains.
 * At `x = 1` the stencil around a point just inside the dark room holds one probe on each side,
 * which is the ordinary case and the one the leak is about.
 */
const WALL_X = 1;

function makeScene(thickness) {
  return {
    thickness,
    wallX: WALL_X,
    wall: { min: [WALL_X - thickness / 2, -2, -2], max: [WALL_X + thickness / 2, 2, 2] },
  };
}

/** Whether a point stands inside the partition, where no probe should be asked anything. */
function insideWall(scene, x) {
  return Math.abs(x - scene.wallX) <= scene.thickness / 2;
}

/* ------------------------------------------------- scheme A: a probe volume */

function buildProbeVolume(scene, spacing, visEdge, irradianceRays) {
  const counts = [
    Math.floor((ROOM.max[0] - ROOM.min[0]) / spacing) + 1,
    Math.floor((ROOM.max[1] - ROOM.min[1]) / spacing) + 1,
    Math.floor((ROOM.max[2] - ROOM.min[2]) / spacing) + 1,
  ];
  const grid = new ProbeGrid({
    origin: [ROOM.min[0], ROOM.min[1], ROOM.min[2]],
    spacing: [spacing, spacing, spacing],
    counts,
  });
  const visibility = createProbeVisibility(visEdge, grid.layers);
  const values = new Float32Array(grid.layers * 3);
  const at = [0, 0, 0];
  const dir = [0, 0, 0];
  let traces = 0;

  for (let layer = 0; layer < grid.layers; layer++) {
    grid.positionOf(layer, at);

    /* Visibility, filtered over a small cone a texel so the variance is not identically zero. */
    const base = layer * visEdge * visEdge * 2;
    for (let ty = 0; ty < visEdge; ty++) {
      for (let tx = 0; tx < visEdge; tx++) {
        let mean = 0;
        let meanSquare = 0;
        for (let jitter = 0; jitter < 4; jitter++) {
          const ju = (tx + 0.25 + (jitter % 2) * 0.5) / visEdge;
          const jv = (ty + 0.25 + Math.floor(jitter / 2) * 0.5) / visEdge;
          octInsetDir(ju, jv, visEdge, dir);
          const { t } = cast(scene, at[0], at[1], at[2], dir[0], dir[1], dir[2]);
          traces++;
          mean += t / 4;
          meanSquare += (t * t) / 4;
        }
        visibility.moments[base + (tx + ty * visEdge) * 2] = mean;
        visibility.moments[base + (tx + ty * visEdge) * 2 + 1] = meanSquare;
      }
    }

    /* Irradiance: the mean radiance over the sphere, which is all a leak test needs. */
    let total = 0;
    for (let i = 0; i < irradianceRays; i++) {
      fibonacci(i, irradianceRays, dir);
      const { radiance } = cast(scene, at[0], at[1], at[2], dir[0], dir[1], dir[2]);
      traces++;
      total += radiance;
    }
    const mean = total / irradianceRays;
    values[layer * 3] = mean;
    values[layer * 3 + 1] = mean;
    values[layer * 3 + 2] = mean;
  }

  const floats = grid.layers * (3 + visEdge * visEdge * 2);
  return { grid, visibility, values, bytes: floats * 4, traces };
}

function sampleProbeScheme(volume, blend, out, x, y, z, weighted) {
  visibleProbes(volume.grid, weighted ? volume.visibility : null, x, y, z, blend);
  sampleProbeVolume(blend, volume.values, 3, out);
  return out[0];
}

/* ------------------------------------------- scheme B: radiance cascades */

/**
 * Cascade `i`: probes spaced `2^i` further apart, `4^i` more directions, an interval `4^i` longer.
 *
 * Octahedral direction grids rather than a Fibonacci set, because the merge needs a cascade's
 * direction to map onto exactly four of the next one's — which an `n` to `2n` octahedral grid does
 * by construction and a Fibonacci set does not do at all.
 */
function buildCascades(scene, spacing0, dirEdge0, interval0, levels) {
  const cascades = [];
  let bytes = 0;
  let traces = 0;
  let start = 0;

  for (let level = 0; level < levels; level++) {
    const spacing = spacing0 * 2 ** level;
    const dirEdge = dirEdge0 * 2 ** level;
    const length = interval0 * 4 ** level;
    const counts = [
      Math.floor((ROOM.max[0] - ROOM.min[0]) / spacing) + 1,
      Math.floor((ROOM.max[1] - ROOM.min[1]) / spacing) + 1,
      Math.floor((ROOM.max[2] - ROOM.min[2]) / spacing) + 1,
    ];
    const grid = new ProbeGrid({
      origin: [ROOM.min[0], ROOM.min[1], ROOM.min[2]],
      spacing: [spacing, spacing, spacing],
      counts,
    });
    const dirs = dirEdge * dirEdge;
    /* Radiance and transmittance per probe per direction. */
    const radiance = new Float32Array(grid.layers * dirs);
    const through = new Float32Array(grid.layers * dirs);
    const at = [0, 0, 0];
    const dir = [0, 0, 0];

    for (let layer = 0; layer < grid.layers; layer++) {
      grid.positionOf(layer, at);
      for (let ty = 0; ty < dirEdge; ty++) {
        for (let tx = 0; tx < dirEdge; tx++) {
          octInsetDir((tx + 0.5) / dirEdge, (ty + 0.5) / dirEdge, dirEdge, dir);
          const from = [at[0] + dir[0] * start, at[1] + dir[1] * start, at[2] + dir[2] * start];
          const { t, radiance: value } = cast(
            scene,
            from[0],
            from[1],
            from[2],
            dir[0],
            dir[1],
            dir[2],
          );
          traces++;
          const slot = layer * dirs + tx + ty * dirEdge;
          if (t <= length) {
            radiance[slot] = value;
            through[slot] = 0;
          } else {
            radiance[slot] = 0;
            through[slot] = 1;
          }
        }
      }
    }

    cascades.push({ grid, dirEdge, dirs, radiance, through, start, length });
    bytes += grid.layers * dirs * 2 * 4;
    start += length;
  }

  /* Merge from the top down: a cascade's ray is its own interval, then what is beyond it. */
  const blend = createProbeBlend();
  for (let level = levels - 2; level >= 0; level--) {
    const here = cascades[level];
    const above = cascades[level + 1];
    const at = [0, 0, 0];
    const dir = [0, 0, 0];
    const uv = [0, 0];
    for (let layer = 0; layer < here.grid.layers; layer++) {
      here.grid.positionOf(layer, at);
      visibleProbes(above.grid, null, at[0], at[1], at[2], blend);
      for (let ty = 0; ty < here.dirEdge; ty++) {
        for (let tx = 0; tx < here.dirEdge; tx++) {
          const slot = layer * here.dirs + tx + ty * here.dirEdge;
          if (here.through[slot] === 0) continue;
          /* The four directions of the cascade above that this one covers. */
          let beyond = 0;
          for (let sy = 0; sy < 2; sy++) {
            for (let sx = 0; sx < 2; sx++) {
              octInsetDir((tx + 0.5) / here.dirEdge, (ty + 0.5) / here.dirEdge, here.dirEdge, dir);
              octInsetUv(dir[0], dir[1], dir[2], above.dirEdge, uv);
              const ax = Math.min(
                above.dirEdge - 1,
                Math.max(0, Math.floor(uv[0] * above.dirEdge) + sx - 0),
              );
              const ay = Math.min(
                above.dirEdge - 1,
                Math.max(0, Math.floor(uv[1] * above.dirEdge) + sy - 0),
              );
              let spatial = 0;
              for (let corner = 0; corner < blend.layers.length; corner++) {
                const weight = blend.weights[corner];
                if (weight === 0) continue;
                spatial +=
                  above.radiance[blend.layers[corner] * above.dirs + ax + ay * above.dirEdge] *
                  weight;
              }
              beyond += spatial / 4;
            }
          }
          here.radiance[slot] += beyond;
        }
      }
    }
  }

  return { cascades, bytes, traces };
}

function sampleCascades(built, blend, x, y, z) {
  const base = built.cascades[0];
  visibleProbes(base.grid, null, x, y, z, blend);
  let total = 0;
  for (let corner = 0; corner < blend.layers.length; corner++) {
    const weight = blend.weights[corner];
    if (weight === 0) continue;
    const layer = blend.layers[corner];
    let mean = 0;
    for (let d = 0; d < base.dirs; d++) mean += base.radiance[layer * base.dirs + d];
    total += (mean / base.dirs) * weight;
  }
  return total;
}

/* ------------------------------------------------------------- the measure */

function fibonacci(index, count, out) {
  const z = 1 - (2 * index + 1) / count;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = index * Math.PI * (3 - Math.sqrt(5));
  out[0] = r * Math.cos(phi);
  out[1] = r * Math.sin(phi);
  out[2] = z;
}

/** Points well inside the dark room, where every lux measured came through a wall. */
function darkPoints(scene) {
  const points = [];
  for (let x = -3.5; x <= WALL_X - 0.3; x += 0.25) {
    if (insideWall(scene, x)) continue;
    for (let y = -1.5; y <= 1.5; y += 0.5) {
      for (let z = -1.5; z <= 1.5; z += 0.5) points.push([x, y, z]);
    }
  }
  return points;
}

function leak(sample, points) {
  let worst = 0;
  let total = 0;
  for (const [x, y, z] of points) {
    const value = sample(x, y, z);
    worst = Math.max(worst, value);
    total += value;
  }
  return { worst, mean: total / points.length };
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/* ------------------------------------------------- what the kept scheme costs */

/**
 * The cost of the arrangement that won, which Task 10 asked for and the leak table does not say.
 *
 * **Memory first, because it is the number a consumer budgets against.** A probe here carries one
 * irradiance value and one octahedral visibility map; the field carries its cascades. Both are
 * reported for a room-sized volume, which is the scale the plan's own scenes are.
 *
 * **Then the time, per ray and per frame.** This is the TypeScript reference rather than a shader,
 * so the absolute figure is not what a frame would pay — what it is for is the *shape*: which of
 * the three levels the time goes to, and how the composition scales with instances. A device
 * figure needs the WGSL, which this wave did not write.
 */
function cost() {
  const scene = makeScene(0.5);
  const spacing = 2;
  const visEdge = 16;

  let started = performance.now();
  const volume = buildProbeVolume(scene, spacing, visEdge, 256);
  const bakeMs = performance.now() - started;

  const field = createGlobalField(65, 4);
  const source = sphereField(0.5, 1, 33);
  const instances = [];
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    instances.push({
      source,
      transform: mat4FromTranslation(Math.cos(a) * 3, ((i % 5) - 2) * 0.8, Math.sin(a) * 3),
    });
  }

  started = performance.now();
  for (let run = 0; run < 10; run++) composeGlobalField(instances, [0, 0, 0], 4, field);
  const composeMs = (performance.now() - started) / 10;

  const grid = volume.grid;
  const visibility = volume.visibility;
  const probeValues = volume.values;
  const resources = {
    eye: [0, 0, 0],
    project: () => false,
    sceneDistance: () => Infinity,
    screenRadiance: (u, v, out) => out.fill(0),
    field,
    fieldRadiance: (x, y, z, out) => out.fill(1),
    grid,
    visibility,
    probeValues,
    probeChannels: 3,
  };

  const out = newIndirectResult();
  const rays = 20000;
  started = performance.now();
  for (let i = 0; i < rays; i++) {
    const a = (i * 2.399963) % (Math.PI * 2);
    const b = ((i * 0.7548) % 1) * Math.PI - Math.PI / 2;
    traceIndirect(
      {
        point: [Math.cos(a) * 2, Math.sin(b), Math.sin(a) * 2],
        normal: [0, 1, 0],
        direction: [Math.cos(b) * Math.cos(a), Math.sin(b), Math.cos(b) * Math.sin(a)],
        coneAngle: 0,
      },
      resources,
      out,
    );
  }
  const traceMs = performance.now() - started;

  let fieldBytes = 0;
  for (const cascade of field.cascades) fieldBytes += cascade.field.byteLength;
  const probeBytes = visibility.moments.byteLength + probeValues.byteLength;

  const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  console.log('\n=== what the kept scheme costs ===');
  console.log(
    `probe memory  ${mb(probeBytes)}  (${grid.layers} probes at ${spacing} m, ` +
      `${visEdge}x${visEdge} visibility moments and one irradiance each)`,
  );
  console.log(
    `field memory  ${mb(fieldBytes)}  (${field.cascades.length} cascades of 65 cubed, ` +
      `finest step ${field.cascades[0].step.toFixed(3)} m)`,
  );
  console.log(`probe bake    ${bakeMs.toFixed(0)} ms once, for all ${grid.layers} probes`);
  console.log(
    `compose       ${composeMs.toFixed(1)} ms a frame, ${instances.length} instances over 4 cascades`,
  );
  console.log(
    `trace         ${((traceMs / rays) * 1000).toFixed(2)} us a ray, ` +
      `${traceMs.toFixed(0)} ms for ${rays} — the TypeScript reference, not a shader`,
  );
}

/** A translation matrix without importing gl-matrix into a script that needs nothing else of it. */
function mat4FromTranslation(x, y, z) {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

function sphereField(radius, half, resolution) {
  const field = new Float32Array(resolution ** 3);
  const step = (2 * half) / (resolution - 1);
  for (let iz = 0; iz < resolution; iz++) {
    for (let iy = 0; iy < resolution; iy++) {
      for (let ix = 0; ix < resolution; ix++) {
        field[ix + resolution * (iy + resolution * iz)] =
          Math.hypot(-half + ix * step, -half + iy * step, -half + iz * step) - radius;
      }
    }
  }
  return {
    field,
    dims: [resolution, resolution, resolution],
    bounds: new Float32Array([-half, -half, -half, half, half, half]),
  };
}

for (const thickness of [0.5, 0.1]) {
  const scene = makeScene(thickness);
  const points = darkPoints(scene);
  const blend = createProbeBlend();
  const out = new Float32Array(3);

  console.log(`\n=== a ${thickness * 100} cm wall, ${points.length} points in the dark room ===`);

  /*
   * **Spacing two, because `MAX_ENV_PROBES` is 64 and a metre would be 225.** That cap is a memory
   * argument about the *reflection* array — a probe there is a 683 KB octahedral radiance chain —
   * and a global-illumination probe carrying one irradiance value and a 16x16 visibility map is
   * two orders of magnitude cheaper. Both schemes are held to it here, so what is compared is the
   * schemes rather than two probe counts.
   */
  const volume = buildProbeVolume(scene, 2, 16, 256);
  const plain = leak((x, y, z) => sampleProbeScheme(volume, blend, out, x, y, z, false), points);
  const weighted = leak((x, y, z) => sampleProbeScheme(volume, blend, out, x, y, z, true), points);
  console.log(
    `probe grid, no visibility : worst ${plain.worst.toFixed(4)}  mean ${plain.mean.toFixed(4)}  ` +
      `${kb(volume.grid.layers * 3 * 4)}  ${volume.traces} traces`,
  );
  console.log(
    `probe volume + visibility : worst ${weighted.worst.toFixed(4)}  mean ${weighted.mean.toFixed(4)}  ` +
      `${kb(volume.bytes)}  ${volume.traces} traces`,
  );

  for (const [spacing0, dirEdge0] of [
    [2, 4],
    [2, 8],
  ]) {
    const built = buildCascades(scene, spacing0, dirEdge0, spacing0 * 1.5, 3);
    const cascades = leak((x, y, z) => sampleCascades(built, blend, x, y, z), points);
    console.log(
      `radiance cascades, ${dirEdge0 ** 2} dirs: worst ${cascades.worst.toFixed(4)}  mean ${cascades.mean.toFixed(4)}  ` +
        `${kb(built.bytes)}  ${built.traces} traces`,
    );
  }
}

cost();

/**
 * What the probe grid answers at a world point, on the device.
 *
 * **This is the fourth spelling of one idea and the file says so rather than hoping.**
 * `probeGrid.ts` holds the eight-probe trilinear blend in TypeScript, `octahedral.ts` holds the
 * mapping in TypeScript and again in GLSL, and `shaders/flat/probeGrid.ts` holds both together in
 * the GLSL the lit pass uses. This is WGSL, because a hand-written compute shader cannot include a
 * generated one — and `scripts/probe-bake-parity.mjs` is what holds it to the others rather than
 * a reader's confidence that four copies of an expression say the same thing.
 *
 * **Why a probe reads the grid at all**: the maintainer's answer of 2026-09-17 is that what a field
 * hit is worth comes from the probes, so a probe traced against radiance that is itself probe
 * radiance converges on several bounces over a few refreshes. That is what makes this the multi-
 * bounce half of Wave 4A rather than a single-bounce approximation of it.
 *
 * **No visibility term here, deliberately.** `visibleProbes` exists to stop light reaching a
 * *surface* through a wall it is behind, and it is what `gridIrradiance` applies when shading. A
 * probe asking "what is the radiance out there" is a different question with a different failure:
 * crushing a blind probe's weight would make the bounce darker than the room, and the reference
 * this is checked against — `indirect-parity.mjs` — enters the chain with `visibility: null` for
 * exactly this reason.
 *
 * The accessor an including module must define, before including the core:
 *
 * ```wgsl
 * fn probeLayerSample(layer: u32, uv: vec2<f32>) -> vec3<f32>       // at the radiance level
 * fn probeLayerIrradiance(layer: u32, uv: vec2<f32>) -> vec3<f32>   // at the irradiance level
 * ```
 *
 * and `volume: ProbeVolume` as a uniform. Production samples a texture; the parity module reads a
 * plain buffer of the same numbers.
 */

/**
 * Floats in the volume block, and where each field starts.
 *
 * Named offsets for the reason `probeBake.wgsl.ts` gives and paid for: an `f32` after a `vec3<f32>`
 * fills the vec3's padding rather than starting a new row, so `edge` is float **11**.
 */
export const VOLUME_ORIGIN = 0;
export const VOLUME_INV_SPACING = 4;
export const VOLUME_COUNTS = 8;
export const VOLUME_EDGE = 11;
export const VOLUME_LEVEL = 12;
export const VOLUME_RADIANCE_EDGE = 13;
export const VOLUME_RADIANCE_LEVEL = 14;

/** Fifty-two bytes of fields rounded up to the struct's own sixteen-byte alignment. */
export const PROBE_VOLUME_FLOATS = 16;

export const PROBE_VOLUME_STRUCT_WGSL = /* wgsl */ `
struct ProbeVolume {
  /* Where the grid's first probe stands, and one over the step between them. */
  origin: vec3<f32>,
  invSpacing: vec3<f32>,
  /* How many probes along each axis. Whole numbers carried as floats. */
  counts: vec3<f32>,
  /* Texels across the level being sampled, gutter included. */
  edge: f32,
  /* Which mip of the probe array that level is. */
  level: f32,
  /* And the level that holds *radiance* rather than irradiance, with its own edge. */
  radianceEdge: f32,
  radianceLevel: f32,
  padA: f32,
}
`;

export const PROBE_VOLUME_CORE_WGSL = /* wgsl */ `
/* The octahedral encode, matching "octEncode" in "shaders/octahedral.ts". */
fn probeOctEncode(d: vec3<f32>) -> vec2<f32> {
  let n = d / (abs(d.x) + abs(d.y) + abs(d.z));
  var p = n.xy;
  if (n.z < 0.0) {
    p = (1.0 - abs(vec2<f32>(n.y, n.x))) *
      vec2<f32>(select(-1.0, 1.0, n.x >= 0.0), select(-1.0, 1.0, n.y >= 0.0));
  }
  return p * 0.5 + 0.5;
}

/*
 * Where to sample a direction in a map whose outer ring is a gutter.
 *
 * The inner region is "edge - 2" texels offset by one, so a direction at the very border of the
 * octahedral square lands on the last real texel and the tap that interpolates past it reads the
 * gutter — which the bake filled with the folded direction.
 */
fn probeOctInsetUv(d: vec3<f32>, edge: f32) -> vec2<f32> {
  return (probeOctEncode(d) * (edge - 2.0) + 1.0) / edge;
}

/*
 * One axis of the lookup: which probe is below the point, and how far past it the point is.
 *
 * **The index is integer arithmetic and the fraction is not**, which is the distinction row 139 of
 * the resume file is about. A world position divided by a spacing is a genuine float division and
 * its floor is a genuine floor; what must never be written in floats is a *lattice* — an index
 * decomposed out of a layer number — because a device may implement that division as a
 * multiplication by a reciprocal and answer 3 for 3.0 % 3.0.
 *
 * The lower index stops one short of the last probe so the pair "index" and "index + 1" is always
 * inside the grid, and a single-probe axis has no pair at all — both corners are probe zero and
 * the fraction is zero, so that axis multiplies every weight by one.
 */
struct ProbeCell {
  index: u32,
  fraction: f32,
}

fn probeCell(value: f32, origin: f32, invSpacing: f32, count: u32) -> ProbeCell {
  var out: ProbeCell;
  out.index = 0u;
  out.fraction = 0.0;
  if (count <= 1u) { return out; }
  let local = (value - origin) * invSpacing;
  let span = f32(count - 1u);
  let clamped = clamp(local, 0.0, span);
  let index = min(u32(floor(clamped)), count - 2u);
  out.index = index;
  out.fraction = clamped - f32(index);
  return out;
}

/*
 * The layer a probe at whole lattice coordinates occupies. x fastest, then y, then z.
 *
 * **Not clamped, and "ProbeGrid.layerAt" is** — the difference is who may call them. "layerAt" is a
 * public method whose contract is that it accepts anything, so it clamps; this is reached from one
 * place, under two guarantees that together make the clamp unreachable. "probeCell" returns an
 * index no greater than "count - 2", so "index + 1" is inside; and on an axis only one probe wide
 * it returns index 0 with fraction 0, so the far corner's weight is zero and the caller skips it
 * before asking. A clamp here would be a line no perturbation can make fail, which this session
 * has already had to remove twice.
 */
fn probeLayerAt(ix: u32, iy: u32, iz: u32, counts: vec3<u32>) -> u32 {
  return ix + counts.x * (iy + counts.y * iz);
}

/*
 * What has already bounced onto a surface facing the normal at a point, from the level this writes.
 *
 * **One shared direction, and that is right here where a per-corner one is right for radiance.**
 * An irradiance map is indexed by the *normal of the surface being lit*, not by where the light
 * came from, so every probe is asked the same question: what reaches a surface facing this way.
 * Reading it at the level the bake writes is what closes the loop — the second bounce is the first
 * one read back.
 */
fn probeVolumeIrradianceAt(p: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
  let counts = vec3<u32>(
    max(1u, u32(volume.counts.x)),
    max(1u, u32(volume.counts.y)),
    max(1u, u32(volume.counts.z)),
  );
  let cx = probeCell(p.x, volume.origin.x, volume.invSpacing.x, counts.x);
  let cy = probeCell(p.y, volume.origin.y, volume.invSpacing.y, counts.y);
  let cz = probeCell(p.z, volume.origin.z, volume.invSpacing.z, counts.z);
  let uv = probeOctInsetUv(n, volume.edge);

  var sum = vec3<f32>(0.0);
  for (var oz = 0u; oz < 2u; oz = oz + 1u) {
    let wz = select(1.0 - cz.fraction, cz.fraction, oz == 1u);
    for (var oy = 0u; oy < 2u; oy = oy + 1u) {
      let wy = select(1.0 - cy.fraction, cy.fraction, oy == 1u);
      for (var ox = 0u; ox < 2u; ox = ox + 1u) {
        let wx = select(1.0 - cx.fraction, cx.fraction, ox == 1u);
        let weight = wx * wy * wz;
        if (weight <= 0.0) { continue; }
        let layer = probeLayerAt(cx.index + ox, cy.index + oy, cz.index + oz, counts);
        sum = sum + probeLayerIrradiance(layer, uv) * weight;
      }
    }
  }
  return sum;
}

/* Where a layer's probe stands, which a parallax read needs and the lattice above decides. */
fn probeVolumeProbeAt(layer: u32, counts: vec3<u32>) -> vec3<f32> {
  let x = layer % counts.x;
  let y = (layer / counts.x) % counts.y;
  let z = layer / (counts.x * counts.y);
  let spacing = vec3<f32>(
    select(0.0, 1.0 / volume.invSpacing.x, volume.invSpacing.x != 0.0),
    select(0.0, 1.0 / volume.invSpacing.y, volume.invSpacing.y != 0.0),
    select(0.0, 1.0 / volume.invSpacing.z, volume.invSpacing.z != 0.0),
  );
  return volume.origin + vec3<f32>(f32(x), f32(y), f32(z)) * spacing;
}

/*
 * The radiance leaving a world point, as the grid saw it.
 *
 * **A ray needs radiance and the first version read irradiance**, which is what
 * "demo/dev/bounce.html" measured as a bounce dimmer and greyer than the rasterised grid it was
 * meant to replace. Irradiance is light *arriving* at a point, already cosine-convolved over a
 * hemisphere; what a ray that struck a wall needs is the light *leaving* that wall towards it. The
 * two differ by the surface's albedo — so a red wall and a white wall at the same irradiance
 * returned the same colour, and the red never travelled.
 *
 * **Level 0 of the probe array is that radiance**, and it needs no albedo because it is a
 * rasterised capture of the shaded room: the red wall is red in it. §6.4 of the design names
 * "envProbeArray.ts" as this track's starting point and leaves how much of it to reuse to
 * measurement, which is this.
 *
 * **Each corner is read along its own direction to the point**, which is what makes this a
 * position lookup rather than a direction one. Eight probes sampled along one shared direction
 * answer "what is over there from roughly here"; eight probes each sampled towards "p" answer
 * "what is at "p"", and the difference is the parallax that a marched hit exists to provide. It is
 * also why no direction is passed in: deriving it removes the reversed-direction mistake that
 * "probe-bake-parity.mjs" records being unable to see.
 */
fn probeVolumeRadianceAt(p: vec3<f32>) -> vec3<f32> {
  let counts = vec3<u32>(
    max(1u, u32(volume.counts.x)),
    max(1u, u32(volume.counts.y)),
    max(1u, u32(volume.counts.z)),
  );
  let cx = probeCell(p.x, volume.origin.x, volume.invSpacing.x, counts.x);
  let cy = probeCell(p.y, volume.origin.y, volume.invSpacing.y, counts.y);
  let cz = probeCell(p.z, volume.origin.z, volume.invSpacing.z, counts.z);

  var sum = vec3<f32>(0.0);
  for (var oz = 0u; oz < 2u; oz = oz + 1u) {
    let wz = select(1.0 - cz.fraction, cz.fraction, oz == 1u);
    for (var oy = 0u; oy < 2u; oy = oy + 1u) {
      let wy = select(1.0 - cy.fraction, cy.fraction, oy == 1u);
      for (var ox = 0u; ox < 2u; ox = ox + 1u) {
        let wx = select(1.0 - cx.fraction, cx.fraction, ox == 1u);
        let weight = wx * wy * wz;
        if (weight <= 0.0) { continue; }
        let layer = probeLayerAt(cx.index + ox, cy.index + oy, cz.index + oz, counts);
        /*
         * From that probe towards the point, which is the parallax. A probe standing exactly on
         * the point has no direction to offer and takes its own zeroth texel, which is as good an
         * answer as exists for a point inside a probe.
         */
        let offset = p - probeVolumeProbeAt(layer, counts);
        let reach = length(offset);
        let towards = select(vec3<f32>(0.0, 0.0, 1.0), offset / reach, reach > 0.0);
        let uv = probeOctInsetUv(towards, volume.radianceEdge);
        sum = sum + probeLayerSample(layer, uv) * weight;
      }
    }
  }
  return sum;
}
`;

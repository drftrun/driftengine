---
title: Materials
description: Physically based surfaces from per-vertex values or image maps, albedo, normal, ORM and emissive, how to upload textures, and the per-draw surface dials.
packages: ['@driftengine/core']
plain: ['TexImageSource']
---

# Materials

A surface in DriftEngine can be described two ways, and they combine:

- **Per vertex**, in the mesh: colour, emissive, specular, roughness, grain and relief. A whole world
  can be made this way with no images at all, and a merged mesh of many colours is still one draw.
- **By image maps**, set as a material before the draws that use it: albedo, normal,
  occlusion-roughness-metalness, and emissive. This is the glTF model, so an imported model's
  materials arrive as exactly this.

<!-- run: materials -->

## Images

`renderer.createSurfaceTexture(source, options)` uploads anything the browser calls a
`TexImageSource`: an image element, an `ImageBitmap`, a canvas or a video frame. The engine ships no
images and fetches none, so loading the file is yours.

```ts sample=materials/main.ts#canvas
/** A small canvas of one colour: the whole of an ORM map whose value does not vary. */
function solid(r: number, g: number, b: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 4;
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    ctx.fillStyle = `rgb(${r * 255}, ${g * 255}, ${b * 255})`;
    ctx.fillRect(0, 0, 4, 4);
  }
  return canvas;
}
```

The option that matters most is `colorSpace`. A picture, such as an albedo or emissive map, is
`'srgb'`. A map whose values are numbers, such as a normal map or an ORM map, is `'linear'`; uploaded
as sRGB, its values bend toward zero and every surface looks like glass. The other options are
`wrap` (`'repeat'` or `'clamp'`), `filter` for magnification, `mipmap`, on by default, and
`anisotropy` for textures seen at a grazing angle.

`updateSurfaceTexture` replaces the pixels and keeps the binding, and `disposeSurfaceTexture` frees
one. `createSurfaceTextureArray` uploads several images of one size as one texture whose layer each
face picks; see [Texture arrays](texture-arrays.md).

## Metalness and roughness

```ts sample=materials/main.ts#orm
/**
 * Occlusion in red, roughness in green, metalness in blue. These are data, not colours, so they
 * are uploaded as linear: read as sRGB they would bend toward zero and every surface would look
 * like glass.
 */
function orm(roughness: number, metal: number): SurfaceTextureHandle {
  return renderer.createSurfaceTexture(solid(1, roughness, metal), { colorSpace: 'linear' });
}

const STEPS = 6;
/** Top row: metalness from 0 to 1 at middling roughness. Bottom row: roughness at full metal. */
const metals = Array.from({ length: STEPS }, (_, i) => orm(0.35, i / (STEPS - 1)));
const roughs = Array.from({ length: STEPS }, (_, i) => orm(0.05 + (i / (STEPS - 1)) * 0.9, 1));
```

An ORM map packs three values into one image: ambient occlusion in red, roughness in green and
metalness in blue. Metalness splits a surface into metal, which colours its reflection, and
everything else, which reflects white. Roughness widens and softens the highlight. A material can
scale each channel: `roughnessScale`, `metallicScale` and `occlusionStrength` are glTF's factors.

## A material

```ts sample=materials/main.ts#ground
/** A tile pattern for the albedo, which is a picture and so is sRGB. */
function tiles(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    ctx.fillStyle = '#6b6560';
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = '#8a837b';
    ctx.fillRect(4, 4, 120, 120);
    ctx.fillRect(132, 132, 120, 120);
    ctx.fillStyle = '#7a736b';
    ctx.fillRect(132, 4, 120, 120);
    ctx.fillRect(4, 132, 120, 120);
  }
  return canvas;
}

/** A normal map from the same tile layout: grooves between tiles, and a gentle bevel. */
function tileNormals(): HTMLCanvasElement {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return canvas;
  const image = ctx.createImageData(size, size);
  const height = (x: number, y: number): number => {
    const u = ((x % 128) + 128) % 128;
    const v = ((y % 128) + 128) % 128;
    const edge = Math.min(u, 127 - u, v, 127 - v);
    return Math.min(1, edge / 6);
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = height(x + 1, y) - height(x - 1, y);
      const dy = height(x, y + 1) - height(x, y - 1);
      const length = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      image.data[i] = ((-dx / length) * 0.5 + 0.5) * 255;
      image.data[i + 1] = ((-dy / length) * 0.5 + 0.5) * 255;
      image.data[i + 2] = ((1 / length) * 0.5 + 0.5) * 255;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** `planarUvs` gives the ground texture coordinates; a normal map also needs tangents. */
const groundData = new MeshBuilder()
  .addBox([0, -0.1, 0], [8, 0.1, 6], [1, 1, 1])
  .build({ planarUvs: true });
if (groundData.uvs !== undefined) {
  groundData.tangents = generateTangents(
    groundData.positions,
    groundData.normals,
    groundData.uvs,
    groundData.indices,
  );
}
const ground = renderer.createMesh(groundData);

const groundMaterial = {
  albedo: renderer.createSurfaceTexture(tiles(), { colorSpace: 'srgb' }),
  normal: renderer.createSurfaceTexture(tileNormals(), { colorSpace: 'linear' }),
  orm: orm(0.75, 0),
  uScale: 0.5,
  vScale: 0.5,
};
```

A normal map turns the shading normal per pixel, through the mesh's tangent frame, so a mesh that
uses one needs texture coordinates and tangents. `build({ planarUvs: true })` projects texture
coordinates in metres, and `generateTangents` derives the tangents from them. `normalStrength`
scales the effect.

The rest of the fields:

- `uScale` and `vScale` repeat every map of the material across the mesh's coordinates.
- `uOffset` and `vOffset` move where the maps start, after the scale: a surface samples
  `uv * scale + offset`. That picks one cell of a flipbook or an atlas through the material, so one
  quad draws any cell. A strip of four frames is `uScale: 0.25` with `uOffset: frame * 0.25`. A
  cutout's shadow is cut from the same cell.
- `cutout` discards fragments whose albedo alpha is below it: leaves, grilles, fences. A cutout also
  shapes the shadow the surface casts.
- `doubleSided` draws both faces, for a curtain or a leaf card.
- `emissive` and `emissiveScale` shape where a mesh glows and in what colour. A map modulates the
  mesh's own emission and never creates it, glTF's rule: what is emitted is the mesh's emissive
  times its emissive colour, or its albedo where it has none, times the map, times the scale. A mesh
  built with no emissive stays dark whatever map it is drawn with, and `emissiveScale` with no map
  bound does nothing.

## Drawing with a material

```ts sample=materials/main.ts#draw
render() {
  const angle = Math.sin(time * 0.15) * 0.35;
  camera.position[0] = Math.sin(angle) * 9;
  camera.position[1] = 3.2;
  camera.position[2] = Math.cos(angle) * 9;
  camera.lookAt(0, 1.2, 0);

  renderer.beginFrame([0.62, 0.68, 0.76]);
  renderer.bindMeshPass(camera, ENV);

  renderer.setMaterial(groundMaterial);
  renderer.drawMesh(ground, still.worldMatrix);

  for (let i = 0; i < STEPS; i += 1) {
    const x = (i - (STEPS - 1) / 2) * 1.5;
    renderer.setMaterial({ orm: metals[i] });
    place.setPosition(x, 2.2, 0);
    place.updateWorld();
    renderer.drawMesh(sphere, place.worldMatrix);

    renderer.setMaterial({ orm: roughs[i] });
    place.setPosition(x, 0.7, 0);
    place.updateWorld();
    renderer.drawMesh(sphere, place.worldMatrix);
  }
  renderer.setMaterial(null);
  renderer.endFrame();
},
```

`setMaterial` is pass state: it applies to every `drawMesh` after it until it changes, and
`bindMeshPass` clears it. Group draws by material where you can. Each change costs a slot in a
per-frame ring, and repeating one mesh many times under one material is what
[instancing](instancing.md) is for.

## Surface dials

A few properties apply to the draws that follow, without a map:

- `setSurfaceReflectivity(amount)`: how much of the environment a surface mirrors, 0 to 1. Metal
  reflects by itself; this is for a varnished or wet dielectric.
- `setEnvironmentGain(gain)`: how bright the reflected environment is, for a room too dim for its
  metal to read.
- `setSurfaceGrain(amount)` and `setSurfaceRelief(amount, cyclesPerMetre)`: procedural mineral
  texture and microscopic bumps, so stone reads as stone up close.
- `setSurfaceTextureRelief(scale)`: bumps from the bound albedo's own brightness, for a texture with
  no normal map.
- `setEmissiveGain(gain)`: scale emissive for the next draws, for anything that pulses.
- `setSurfaceFog(enabled)`: take the next draws out of the fog and the global medium's haze, or put
  them back. For a medium that should darken one thing and not another: a floor receding into the
  distance under figures that keep their full value however far away they stand. A translucent
  draw's own `fog` option still decides for that draw.

Each resets with `bindMeshPass`, so a pass starts from the defaults.

## Reflections

A metal is only as convincing as what it reflects. With nothing else set up, it reflects a sky and
ground gradient. [Reflections](reflections.md) covers baked
probes, environment images, planar mirrors and screen-space reflections.

## Three things that look wrong

- **A material that does nothing on a sphere.** `MeshBuilder` shapes carry no texture coordinates
  unless you ask with `planarUvs`, and without them every pixel samples the same texel.
- **A normal map that shades oddly or not at all.** The mesh has no tangents. Add them with
  `generateTangents`.
- **Every surface looks like glass.** The ORM map was uploaded as sRGB, so its roughness collapsed
  toward zero.

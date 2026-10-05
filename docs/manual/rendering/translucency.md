---
title: Translucent and additive meshes
description: Glass that colours the light through it, refraction, light that adds instead of covering, untoned draws, and transparency in any order.
packages: ['@driftengine/core']
---

# Translucent and additive meshes

`drawTranslucentMesh(mesh, model, opacity, options)` draws a mesh blended over what is already in
the frame. Draw translucent things after the opaque ones they show, and, unless order-independent
transparency is on, back to front among themselves.

## Glass

```ts sample=snippets/translucency.ts#glass
/** A frosted green pane: it lets light through, blurs what is behind it, and tints it. */
export function drawPane(renderer: RendererApi, pane: MeshHandle, model: Float32Array): void {
  renderer.drawTranslucentMesh(pane, model, 1, {
    glass: { transmission: 0.85, frost: 0.35, tint: [0.75, 0.95, 0.85] },
  });
}
```

`glass` makes a pane that shows what is behind it by how much light it lets through and how little it
reflects at the angle you see it from, blurred by how frosted it is and tinted by its colour. It keeps
its own highlight.

Glass also casts coloured light. With the `glassShadows` quality option at its default, `'full'`,
light that passes through a pane takes its colour in the sun's and the lamps' shadows: a stained
window throws a coloured patch on the floor. `'half'` halves the memory that costs, and `'off'`
makes glass cast nothing.

## Refraction

```ts sample=snippets/translucency.ts#refraction
/** A thick lens that bends what is behind it and absorbs a little per metre, as real glass does. */
export function drawLens(renderer: RendererApi, lens: MeshHandle, model: Float32Array): void {
  renderer.drawTranslucentMesh(lens, model, 0.25, {
    refraction: 0.02,
    refractTint: [0.92, 0.97, 1],
    thicknessM: 0.08,
  });
}
```

`refraction` bends what is behind the surface, by sampling a copy of the frame's colour offset along
the shading normal, so a normal map bends it too: a heat haze or a distortion wearing a noise map
shimmers rather than acting as a smooth lens. An unlit draw reads its normal map for this alone. `refractTint` is what survives one metre of the medium, per channel, and
`thicknessM` is how many metres the light crosses face-on; absorption follows the Beer-Lambert law,
so a thick piece of tinted glass is darker than a thin one. A per-vertex channel can vary thickness
across a mesh.

A frame that refracts nothing takes no copy and pays nothing.

## Adding light

```ts sample=snippets/translucency.ts#additive
/** A lamp's light cone: added onto what is there, so its dark parts are invisible, not black. */
export function drawBeam(renderer: RendererApi, cone: MeshHandle, model: Float32Array): void {
  renderer.drawTranslucentMesh(cone, model, 0.6, { additive: true, lit: false, depthWrite: false });
}
```

`additive: true` adds the mesh's colour times its opacity onto what is there and never darkens it.
That is the right blend for light itself: a lamp's beam, a glow shell, a spark. Drawn blended, the
dark parts of a light cone would show as a dark cone; drawn additively they are invisible. A sum
needs no order, so additive draws are never held back for sorting.

## Exactly its own colour

```ts sample=snippets/translucency.ts#unlit
/** A marker that is exactly its colour, untouched by light, haze or the tone curve. */
export function drawMarker(renderer: RendererApi, marker: MeshHandle, model: Float32Array): void {
  renderer.drawTranslucentMesh(marker, model, 0.9, { lit: false, fog: false, toneMapped: false });
}
```

`lit: false` draws the mesh as its vertex colour times its texture, with no lighting of any kind.
`fog: false` keeps it out of the haze and the underwater tint. `toneMapped: false` skips the tone
curve, which is right for a meter or an interface element whose colour must be exact. The three are
independent.

## When order matters

Blending is order-dependent: a pane drawn after another pane behind it composes correctly, and the
other way round does not. Sorting back to front fixes most scenes and cannot fix two panes that
intersect, a pane inside another, or a pane with smoke inside it.

The `orderIndependent` quality option replaces the ordering with weighted blending, whose sum and
product do not depend on order. It is exact for one layer and a close approximation for several.
Off by default.

Two options decide how a set of blended surfaces resolves against itself:

- `depthWrite: false` keeps a draw out of the depth buffer, which a set of overlapping panes, or a
  model whose interior is glass, wants. One pane alone should write depth, or the sky drawn later
  paints over it.
- `depthLayer` orders surfaces that lie exactly on top of each other, such as a sign on a wall.

## Instanced

`drawTranslucentInstanced(batch, data, opacity, options)` is the same for an instanced batch. It
takes the same options except a per-vertex thickness, which an instanced draw cannot carry.

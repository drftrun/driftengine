/**
 * Every stage of a capture assembled into one `.drft`, and the proposals read back out of it.
 *
 * **One file, because a capture that arrives as six is a capture somebody has to reassemble.** The
 * cloud draws, the mesh is what a body collides with, the decode program is the surface's material,
 * the polygon mesh is the way across it, and the proposals are what a scene might make of the
 * regions. They were produced by five stages that know nothing about each other; what they have in
 * common is the capture, and that is what a container is for.
 *
 * **The proposals are written as a scene, and they are still proposals.** `ENTS` carries them under
 * a component this package declares — not under a consumer's `transform`, whose field ids belong to
 * that consumer and which this package has no way to know. So a capture proposes in its own words,
 * an editor accepts or rejects, and what a scene ends up holding is the consumer's decision. The
 * schema is written out here rather than built, because `@driftengine/capture` does not depend on
 * the entity model and must not: the file is data, and the data is what the two sides share.
 *
 * **What is not written is the collision mesh**, and that is a payload decision with a reason: it
 * is the drawn mesh with its degenerate triangles removed, which `collisionMesh` does in a
 * millisecond at load. A second copy of the same triangles in the file is a second copy to
 * download. Hulls *are* written, because a convex decomposition is not something to redo on a
 * player's machine.
 */
import {
  writeDrft,
  type DrftMaterial,
  type DrftSplats,
  type DtexEntry,
  type EntsScene,
  type MeshData,
  type NavPolyMesh,
} from '@driftengine/drft';

import type { EntityProposal } from './propose.ts';

export interface CaptureScene {
  /** The surface a capture produced, as it is drawn. */
  readonly mesh: MeshData;
  /** The materials the mesh refers to. A decode program names one of them by index. */
  readonly materials?: readonly DrftMaterial[];
  /** A material as a decode program over a latent, from the texture stage. */
  readonly material?: DtexEntry;
  /** The cloud, for what a mesh cannot show. */
  readonly splats?: DrftSplats;
  /** A prop's convex hulls, from `propHulls`. Three floats a point. */
  readonly hulls?: readonly Float32Array[];
  /** The way across the scene, with the placement it was built at. */
  readonly navigation?: NavPolyMesh;
  /** What a scene might make of each region. */
  readonly proposals?: readonly EntityProposal[];
}

/** The component a capture proposes in. Named for what it is: a proposal, not a thing. */
export const PROPOSAL_COMPONENT = 'captureProposal';

/**
 * The fields a proposal carries, by stable id.
 *
 * **Six numbers rather than a bounds array**, because the field types an entity model declares are
 * scalars and a strings — there is no list among them, and inventing one here would be inventing a
 * type system for a single consumer. `label` is empty where nobody named the region, and
 * `components` is the suggested set joined by spaces, which is what an editor offers and what it is
 * free to ignore.
 */
export const PROPOSAL_SCHEMA = {
  name: PROPOSAL_COMPONENT,
  fields: [
    { id: 'capture::proposal::label', name: 'label', type: 'String' },
    { id: 'capture::proposal::components', name: 'components', type: 'String' },
    { id: 'capture::proposal::walkable', name: 'walkable', type: 'bool' },
    { id: 'capture::proposal::minX', name: 'minX', type: 'f32' },
    { id: 'capture::proposal::minY', name: 'minY', type: 'f32' },
    { id: 'capture::proposal::minZ', name: 'minZ', type: 'f32' },
    { id: 'capture::proposal::maxX', name: 'maxX', type: 'f32' },
    { id: 'capture::proposal::maxY', name: 'maxY', type: 'f32' },
    { id: 'capture::proposal::maxZ', name: 'maxZ', type: 'f32' },
  ],
} as const;

const BOUNDS = ['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'] as const;

/** The proposals as a scene, keyed by field id — the form `serializeWorld` writes. */
export function proposalScene(proposals: readonly EntityProposal[]): EntsScene {
  return {
    version: 1,
    schemas: { [PROPOSAL_COMPONENT]: PROPOSAL_SCHEMA },
    entities: proposals.map((proposal) => {
      const fields: Record<string, unknown> = {
        'capture::proposal::label': proposal.label ?? '',
        'capture::proposal::components': proposal.components.join(' '),
        'capture::proposal::walkable': proposal.walkable,
      };
      BOUNDS.forEach((name, at) => {
        fields[`capture::proposal::${name}`] = proposal.bounds[at] as number;
      });
      return { components: { [PROPOSAL_COMPONENT]: fields } };
    }),
  };
}

/**
 * The proposals a scene carries, in the order they were written.
 *
 * **The way back, and it is here rather than in an editor** because the two halves have to agree
 * about the field ids and one module holding both is how they stay that way. An entity that carries
 * no proposal is skipped: a consumer may have added its own things to the same scene, and a capture
 * reading a file is a guest in it.
 */
export function readProposals(scene: EntsScene): EntityProposal[] {
  const out: EntityProposal[] = [];
  scene.entities.forEach((entity, at) => {
    const fields = entity.components[PROPOSAL_COMPONENT];
    if (fields === undefined) return;
    const bounds = new Float64Array(6);
    BOUNDS.forEach((name, slot) => {
      bounds[slot] = Number(fields[`capture::proposal::${name}`] ?? 0);
    });
    const label = String(fields['capture::proposal::label'] ?? '');
    const components = String(fields['capture::proposal::components'] ?? '');
    out.push({
      region: at,
      bounds,
      label: label === '' ? null : label,
      components: components === '' ? [] : components.split(' '),
      walkable: fields['capture::proposal::walkable'] === true,
    });
  });
  return out;
}

/** Every stage of `scene` as one `.drft`. */
export function captureFile(scene: CaptureScene): ArrayBuffer {
  return writeDrft({
    meshes: [scene.mesh],
    materials: scene.materials,
    dtex: scene.material === undefined ? undefined : [scene.material],
    splats: scene.splats,
    colliders: scene.hulls,
    navigation: scene.navigation,
    entities: scene.proposals === undefined ? undefined : proposalScene(scene.proposals),
  });
}

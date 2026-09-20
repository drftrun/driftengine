/**
 * A `.drft` opened into the editor, and the editor's decisions written back out.
 *
 * **The bytes arrive and are never fetched.** Choosing a file is a platform's business — a browser
 * has a picker, a native host has a dialog, a test has an array — so the seam is two methods and
 * this file has no idea which it is talking to. That is the same rule the assets panel states about
 * walking a filesystem, one layer down.
 *
 * **What comes out is a scene, a tree and a list of proposals, and they are the same objects.** A
 * region becomes a node in the hierarchy, a thing in the viewport and a row in the capture panel
 * by being one entity with one number; three views of one list is how they stay in step, and it is
 * why `openCapture` builds all of them rather than handing the file to each panel to read again.
 *
 * **Saving writes what was accepted, and nothing else.** A rejected proposal is not written as
 * rejected — it is not written. The file a capture produced already carries every region it found,
 * so a second file that also carried the rejections would be a file with two answers in it and no
 * way to tell which one a loader should believe.
 */
import { PROPOSAL_COMPONENT, captureFile, readProposals } from '@driftengine/capture';
import type { EntityProposal } from '@driftengine/capture';
import { readDrft } from '@driftengine/drft';
import type { DrftAsset, MeshData } from '@driftengine/drft';

import { SceneModel } from '../panels/sceneTree.ts';
import type { ShellScene } from '../shell.ts';

/** What a platform has to offer for the editor to open and save a capture. */
export interface CaptureFileHost {
  /** The bytes somebody chose, or `null` where they cancelled. */
  open(): Promise<ArrayBuffer | null>;
  save(name: string, bytes: ArrayBuffer): Promise<void>;
}

/** One thing the editor can select, pick and draw. */
export interface CaptureEntity {
  readonly entity: number;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /**
   * How big the thing is on screen, in metres — the size it is drawn at **and** picked at.
   *
   * **One number, because two of them is a picker that answers a different object from the one
   * under the cursor.** A region's bounds is most of the room it was found in; a marker drawn at
   * that size hides the surface, so the host drew a small one and left the pick radius at the
   * bounds — which gave a grab reach about four times the marker, reaching into empty space and
   * over the neighbours. Measured by a reader who had not written it: a click 80 px away in the
   * dark background above the room selected a marker inside it.
   */
  readonly radius: number;
  /** Which proposal it came from, or −1 for the capture's own surface. */
  readonly region: number;
}

export interface OpenedCapture {
  readonly asset: DrftAsset;
  readonly mesh: MeshData | null;
  readonly proposals: readonly EntityProposal[];
  readonly entities: readonly CaptureEntity[];
  readonly navigation: boolean;
  /** How many triangles the surface has, which is the one number anybody asks first. */
  readonly triangles: number;
}

/** The entity the surface itself is, so a capture with no proposals still has something in it. */
export const SURFACE_ENTITY = 0;

/**
 * How big a region's marker is, from how big the region is.
 *
 * Something between a crate and a wall, so the two do not look alike, and small enough that a room
 * full of them does not hide the surface they were found on.
 */
function markerRadius(half: number): number {
  return Math.min(0.6, Math.max(0.12, half * 0.2));
}

export function openCapture(bytes: ArrayBuffer): OpenedCapture {
  const asset = readDrft(bytes);
  const mesh = asset.meshes[0] ?? null;
  const proposals = asset.entities === null ? [] : readProposals(asset.entities);

  const entities: CaptureEntity[] = [
    { entity: SURFACE_ENTITY, name: 'surface', x: 0, y: 0, z: 0, radius: 0, region: -1 },
  ];
  proposals.forEach((proposal, at) => {
    const b = proposal.bounds;
    const size = [
      (b[3] as number) - (b[0] as number),
      (b[4] as number) - (b[1] as number),
      (b[5] as number) - (b[2] as number),
    ];
    const half = Math.max(size[0] as number, size[1] as number, size[2] as number) / 2;
    entities.push({
      entity: at + 1,
      /*
       * **Named for what is known about it**, which for most regions is nothing: a capture that
       * called every unlabelled surface `object` would be a capture asserting it had recognised
       * them. `region 4` is the number a person can find in the file.
       */
      name: proposal.label ?? `region ${proposal.region}`,
      x: ((b[0] as number) + (b[3] as number)) / 2,
      /*
       * **At the top of the region rather than its middle**, so a floor's marker stands on the
       * floor instead of inside it. Two of the five things in a captured room had no
       * representation on screen at all for exactly that reason.
       */
      y: (b[4] as number) + markerRadius(half),
      z: ((b[2] as number) + (b[5] as number)) / 2,
      radius: markerRadius(half),
      region: proposal.region,
    });
  });

  return {
    asset,
    mesh,
    proposals,
    entities,
    navigation: asset.navigation !== null,
    triangles: mesh === null ? 0 : mesh.indices.length / 3,
  };
}

/** The hierarchy a tree panel shows: the surface, with every region under it. */
export function captureSceneModel(opened: OpenedCapture): SceneModel {
  const model = new SceneModel();
  model.add(SURFACE_ENTITY, -1, 'surface');
  for (const entity of opened.entities) {
    if (entity.entity === SURFACE_ENTITY) continue;
    model.add(entity.entity, SURFACE_ENTITY, entity.name);
  }
  return model;
}

/**
 * The opened capture as the shell's scene.
 *
 * `remove` and `restore` are deliberately absent: deleting a region from a capture is not a thing
 * the editor can undo into the *file*, and an editor that offered it would be offering an edit it
 * cannot carry out. Rejecting a proposal is the operation, and it is one the capture panel has.
 */
export function captureShellScene(opened: OpenedCapture): ShellScene {
  const byEntity = new Map(opened.entities.map((entity) => [entity.entity, entity]));
  return {
    entities: () => opened.entities.map((entity) => entity.entity),
    nameOf: (entity) => byEntity.get(entity)?.name ?? '',
    radiusOf: (entity) => byEntity.get(entity)?.radius ?? 0,
    positionOf: (entity, out) => {
      const held = byEntity.get(entity);
      if (held === undefined) return false;
      out[0] = held.x;
      out[1] = held.y;
      out[2] = held.z;
      return true;
    },
    setPosition: () => {
      /* A capture's regions are where the capture found them: the gizmo has nothing to move. */
    },
  };
}

/**
 * The capture written back out, carrying the proposals somebody accepted.
 *
 * A capture with nothing accepted still writes its surface and its navigation — **what was decided
 * is not the same as what was captured**, and a file that dropped the geometry because nobody had
 * got to the proposals yet would lose the expensive half.
 */
export function saveCapture(
  opened: OpenedCapture,
  decided: ReadonlyMap<number, boolean>,
): ArrayBuffer {
  if (opened.mesh === null) throw new Error('this capture has no surface to write');
  const accepted = opened.proposals.filter((proposal) => decided.get(proposal.region) === true);
  return captureFile({
    mesh: opened.mesh,
    materials: opened.asset.materials.length > 0 ? opened.asset.materials : undefined,
    navigation: opened.asset.navigation ?? undefined,
    proposals: accepted.length > 0 ? accepted : undefined,
  });
}

/** What the component a capture proposes in is called, so a host can say it in a message. */
export { PROPOSAL_COMPONENT };

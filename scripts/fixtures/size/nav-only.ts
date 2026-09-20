import {
  NavMeshQuery,
  buildContours,
  buildPolyMesh,
  buildRegions,
  voxeliseWalkable,
} from '@driftengine/nav';
export const entry = [voxeliseWalkable, buildRegions, buildContours, buildPolyMesh, NavMeshQuery];

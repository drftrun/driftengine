import { createRenderer } from '@driftengine/core';
import { Terrain, heightfieldPatch } from '@driftengine/terrain';
export const entry = [createRenderer, Terrain, heightfieldPatch];

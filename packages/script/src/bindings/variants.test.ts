/**
 * Every enum a binding declares, held to the engine numbering it translates.
 *
 * A variant list is a second copy of an order the engine owns, and the two can drift without a
 * single type error: put `Liquid` before `Solid` here and every script reads ice as water. So each
 * list is checked against the constants it stands for, by name, and each binding is asked for a
 * variant end to end.
 */
import * as core from '@driftengine/core';
import { EVENT_ENTER, EVENT_EXIT, EVENT_STAY, FAILURE, RUNNING, SUCCESS } from '@driftengine/core';
import * as chemistry from '@driftengine/chemistry';
import { HAND_JOINTS } from '@driftengine/xr';
import { describe, expect, it } from 'vitest';
import { BEHAVIOR_TYPES } from './behavior.ts';
import { CHEMISTRY_EVENT, MATTER_PHASE } from './chemistry.ts';
import { CORE_TYPES, persistenceImplementation, physicsImplementation } from './core.ts';
import { EDITOR_TYPES } from './editor.ts';
import { XR_TYPES } from './xr.ts';
import { hostEnum } from './variants.ts';

const variantsOf = (
  types: readonly { name: string; variants?: readonly string[] }[],
  name: string,
) => types.find((type) => type.name === name)?.variants;

/** `SMOULDER_START` as the variant `SmoulderStart`. */
const pascal = (constant: string) =>
  constant
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

describe('a host enum', () => {
  it('answers one frozen variant per code, and reads a variant back to its code', () => {
    const lights = hostEnum('drift/test', 'Light', ['Red', 'Amber', 'Green'], 'A light.');
    expect(lights.of[2]).toEqual({ tag: 'Green' });
    expect(Object.isFrozen(lights.of[2])).toBe(true);
    /* A script's own copy of a variant is a different object with the same tag. */
    expect(lights.code({ tag: 'Amber' })).toBe(1);
    expect(lights.code({ tag: 'Blue' })).toBe(-1);
  });

  it('follows the behaviour tree’s FAILURE, SUCCESS and RUNNING', () => {
    const variants = variantsOf(BEHAVIOR_TYPES, 'TreeStatus') ?? [];
    expect(variants[FAILURE]).toBe('Failure');
    expect(variants[SUCCESS]).toBe('Success');
    expect(variants[RUNNING]).toBe('Running');
  });

  it('follows chemistry’s phases and every one of its event constants, by name', () => {
    expect(MATTER_PHASE.of[chemistry.PHASE_SOLID]).toEqual({ tag: 'Solid' });
    expect(MATTER_PHASE.of[chemistry.PHASE_MIXED]).toEqual({ tag: 'Mixed' });
    const constants = Object.entries(chemistry).filter(
      ([name, value]) =>
        name.startsWith('EVENT_') && name !== 'EVENT_KIND_COUNT' && typeof value === 'number',
    ) as [string, number][];
    expect(constants.length).toBe(chemistry.EVENT_KIND_COUNT);
    expect(CHEMISTRY_EVENT.of.length).toBe(chemistry.EVENT_KIND_COUNT);
    for (const [name, code] of constants) {
      expect(CHEMISTRY_EVENT.of[code]?.tag, name).toBe(pascal(name.slice('EVENT_'.length)));
    }
  });

  it('follows physics’ contact events, and answers them for a ball through a sensor', () => {
    const variants = variantsOf(CORE_TYPES, 'ContactKind') ?? [];
    expect(variants[EVENT_ENTER]).toBe('Enter');
    expect(variants[EVENT_STAY]).toBe('Stay');
    expect(variants[EVENT_EXIT]).toBe('Exit');

    const physics = physicsImplementation() as {
      contactKind(world: unknown, index: number): { tag: string };
    };
    const world = {
      events: { count: 2, data: Int32Array.of(EVENT_ENTER, 1, 2, EVENT_EXIT, 1, 3) },
    };
    expect(physics.contactKind(world, 0)).toEqual({ tag: 'Enter' });
    expect(physics.contactKind(world, 1)).toEqual({ tag: 'Exit' });
    expect(() => physics.contactKind(world, 2)).toThrow(/outside this step's 2/);
  });

  it('answers a synchronous store as idle', () => {
    const persistence = persistenceImplementation() as {
      saveStatus(store: unknown): { tag: string };
    };
    expect(persistence.saveStatus(new Map())).toEqual({ tag: 'Idle' });
  });

  it('names the editor’s handles in the order of the gizmo’s constants, with None first', () => {
    const handles = variantsOf(EDITOR_TYPES, 'GizmoHandle') ?? [];
    const constants = Object.entries(core).filter(
      ([name, value]) =>
        name.startsWith('GIZMO_') && !name.startsWith('GIZMO_GROUP_') && typeof value === 'number',
    ) as [string, number][];
    expect(handles).toHaveLength(constants.length);
    for (const [name, code] of constants) {
      expect(handles[code]?.toUpperCase(), name).toBe(
        name.slice('GIZMO_'.length).replaceAll('_', ''),
      );
    }
  });

  it('has a variant for every hand joint the XR package tracks, in its order', () => {
    const joints = variantsOf(XR_TYPES, 'HandJoint') ?? [];
    expect(joints).toHaveLength(HAND_JOINTS.length);
    expect(joints[HAND_JOINTS.indexOf('index-finger-tip')]).toBe('IndexFingerTip');
    expect(joints[0]).toBe('Wrist');
  });
});

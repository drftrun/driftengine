/**
 * Entity-backed context and tools, and a stale handle refused by generation.
 *
 * The half of AI-6 that links, because Track M shipped. The navigation half is refused
 * in writing and this file introduces no symbol that would end that refusal.
 */
import { describe, expect, it } from 'vitest';
import { defineComponent, World } from '@driftengine/entities';
import { entityContext, entityRef, entityTool, parseEntityRef } from './context.ts';

const Position = defineComponent('AiPosition', { x: 'f32', y: 'f32' });
const Health = defineComponent('AiHealth', { hp: 'f32' });

function populated(count: number): { world: World; refs: string[] } {
  const world = new World();
  const refs: string[] = [];
  for (let i = 0; i < count; i++) {
    const entity = world.create();
    world.add(entity, Position, { x: i, y: i });
    if (i % 2 === 0) world.add(entity, Health, { hp: 100 });
    refs.push(entityRef(entity));
  }
  return { world, refs };
}

describe('entityContext', () => {
  it('yields one item per matching entity, in query order', () => {
    const { world } = populated(6);
    const provider = entityContext(world, {
      id: 'project.visible@1',
      title: 'Visible',
      priority: 10,
      components: [Position, Health],
    });

    const sample = provider.sample('A17');
    /* Three of six carry Health. */
    expect(sample).toHaveLength(3);
  });

  it('stops at maxItems', () => {
    const { world } = populated(20);
    const provider = entityContext(world, {
      id: 'project.visible@1',
      title: 'Visible',
      priority: 10,
      maxItems: 4,
      components: [Position],
    });

    expect(provider.sample('A17')).toHaveLength(4);
  });

  it('describes itself with a schema and a title', () => {
    const { world } = populated(1);
    const described = entityContext(world, {
      id: 'project.visible@1',
      title: 'Visible',
      priority: 10,
      components: [Position],
    }).describe();

    expect(described.title).toBe('Visible');
    expect(described.schema).toEqual({ kind: 'array', of: { kind: 'string' } });
  });
});

describe('entity references', () => {
  it('round-trips a live entity', () => {
    const { world } = populated(3);
    const entity = world.create();
    world.add(entity, Position, { x: 0, y: 0 });

    expect(parseEntityRef(entityRef(entity), world)).toBe(entity);
  });

  it('refuses a reference whose slot has been reused', () => {
    const world = new World();
    const first = world.create();
    const ref = entityRef(first);
    world.destroy(first);
    const second = world.create();

    /*
     * The staleness case a buffer makes likely rather than rare. `second` takes
     * `first`'s index, so a reference checking only the index would resolve — to a
     * different thing. A plan made about one entity running against another is worse
     * than the plan failing.
     */
    expect(entityIndexOf(ref)).toBe(entityIndexOf(entityRef(second)));
    expect(parseEntityRef(ref, world)).toBeNull();
  });

  it('refuses text that is not a reference at all', () => {
    const { world } = populated(1);

    /* A model inventing an identifier is ordinary rather than exceptional, so this
       returns null and the guard turns it into a refusal — never a throw inside a tick. */
    for (const invented of ['the red door', 'e', 'e1', 'e1.', '1.2', '']) {
      expect(parseEntityRef(invented, world)).toBeNull();
    }
  });
});

describe('entityTool', () => {
  it('admits a live target and runs against it', () => {
    const world = new World();
    const entity = world.create();
    world.add(entity, Health, { hp: 100 });

    const tool = entityTool(world, 'inspect@1', 'Inspect an entity.', (e, w) =>
      w.read(e, Health, 'hp'),
    );

    const args = { target: entityRef(entity) };
    expect(tool.admits(args, world)).toBe(true);
    expect(tool.execute(args, world)).toBe(100);
  });

  it('refuses a target whose generation no longer matches', () => {
    const world = new World();
    const first = world.create();
    world.add(first, Health, { hp: 100 });
    const args = { target: entityRef(first) };

    world.destroy(first);
    const second = world.create();
    world.add(second, Health, { hp: 5 });

    const tool = entityTool(world, 'inspect@1', 'Inspect an entity.', () => 1);

    expect(tool.admits(args, world)).toBe(false);
  });

  it('introduces no navigation symbol', () => {
    /* The other half of AI-6 stays refused, and `docs/CAPABILITIES.md` carries a
       sentinel for it. This asserts from the inside as well: the sentinel catches the
       symbol arriving anywhere in `packages/`, and this says the file that would most
       plausibly grow one has not. */
    const source = String(entityTool);
    expect(source).not.toMatch(/AI_NAVIGATION_TOOLS|navigationBridge/);
  });
});

function entityIndexOf(ref: string): number {
  return Number(/^e(\d+)\./.exec(ref)?.[1] ?? -1);
}

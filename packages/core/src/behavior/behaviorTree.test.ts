import { expect, test } from 'vitest';

import { BehaviorRunner, FAILURE, RUNNING, SUCCESS, buildBehaviorTree } from './behaviorTree.ts';
import type { BehaviorSpec } from './behaviorTree.ts';

/** A villager's day, and the shower that interrupts it. */
interface World {
  raining: boolean;
  /** How many ticks of the errand are left. */
  errandLeft: number;
  /** Every action the agent has entered, in order. */
  log: string[];
}

/**
 * Walk to the market, buy bread, walk home — three steps, the middle one taking three ticks — and
 * a higher-priority branch that takes shelter while it rains.
 */
function villager(): BehaviorSpec {
  return {
    name: 'day',
    selector: [
      {
        name: 'weather',
        whileTrue: 'raining',
        does: { name: 'shelter', action: 'shelter' },
      },
      {
        name: 'errand',
        sequence: [
          { name: 'walk out', action: 'walkOut' },
          { name: 'buy bread', action: 'buyBread' },
          { name: 'walk home', action: 'walkHome' },
        ],
      },
    ],
  };
}

function character(): BehaviorRunner<World> {
  const tree = buildBehaviorTree(villager(), {
    actions: {
      shelter: (w: World) => {
        w.log.push('shelter');
        return RUNNING;
      },
      walkOut: (w: World) => {
        w.log.push('walkOut');
        return SUCCESS;
      },
      buyBread: (w: World) => {
        w.log.push('buyBread');
        w.errandLeft--;
        return w.errandLeft > 0 ? RUNNING : SUCCESS;
      },
      walkHome: (w: World) => {
        w.log.push('walkHome');
        return SUCCESS;
      },
    },
    conditions: { raining: (w: World) => w.raining },
  });
  return new BehaviorRunner<World>(tree);
}

/**
 * The requirement the report named, and the one line of implementation it turns on.
 *
 * The villager walks out and starts buying bread, which takes three ticks. It rains after one of
 * them, so the shelter branch preempts. When it stops, the villager finishes buying bread and walks
 * home — it does **not** walk out again. Everything about this test is that `walkOut` appears
 * exactly once.
 */
test('an interrupted routine resumes where it left off', () => {
  const world: World = { raining: false, errandLeft: 3, log: [] };
  const agent = character();

  agent.tick(world); // walkOut, then buyBread (1 of 3)
  expect(world.log).toEqual(['walkOut', 'buyBread']);

  world.raining = true;
  agent.tick(world);
  agent.tick(world);
  expect(world.log.slice(2)).toEqual(['shelter', 'shelter']);

  world.raining = false;
  agent.tick(world); // resumes at buyBread, not at walkOut
  expect(world.log.slice(4)).toEqual(['buyBread']);
  expect(world.errandLeft).toBe(1);

  agent.tick(world); // buyBread finishes, and the villager goes home
  expect(world.log.slice(5)).toEqual(['buyBread', 'walkHome']);
  expect(world.log.filter((entry) => entry === 'walkOut').length, 'set out once').toBe(1);
});

/**
 * The other half: a routine that *finished* starts again from the top.
 *
 * A suspension keeps state and a completion clears it, and a tree that confused the two would give
 * an agent that either forgets its errand every time it is interrupted or never does it twice.
 */
test('a routine that finished starts over rather than resuming', () => {
  const world: World = { raining: false, errandLeft: 1, log: [] };
  const agent = character();
  expect(agent.tick(world)).toBe(SUCCESS);
  expect(world.log).toEqual(['walkOut', 'buyBread', 'walkHome']);

  world.errandLeft = 1;
  world.log.length = 0;
  agent.tick(world);
  expect(world.log, 'from the beginning').toEqual(['walkOut', 'buyBread', 'walkHome']);
});

test('a tree says which node it is in, by the names it was written with', () => {
  const world: World = { raining: true, errandLeft: 3, log: [] };
  const agent = character();
  agent.tick(world);

  const path = new Uint32Array(8);
  const depth = agent.activePath(path);
  const names: string[] = [];
  for (let i = 0; i < depth; i++) names.push(agent.nameOf(path[i] ?? 0));
  expect(names).toEqual(['day', 'weather', 'shelter']);

  world.raining = false;
  agent.tick(world);
  const second = agent.activePath(path);
  const then: string[] = [];
  for (let i = 0; i < second; i++) then.push(agent.nameOf(path[i] ?? 0));
  expect(then, 'and the guard it tried and failed is on the way').toEqual([
    'day',
    'weather',
    'errand',
    'walk out',
    'buy bread',
  ]);
});

test('a paused agent holds still, and steps when told to', () => {
  const world: World = { raining: false, errandLeft: 3, log: [] };
  const agent = character();
  agent.tick(world);
  const after = world.log.length;

  agent.paused = true;
  agent.tick(world);
  agent.tick(world);
  expect(world.log.length, 'nothing happened while paused').toBe(after);
  expect(agent.status, 'and it still reports what it was doing').toBe(RUNNING);

  agent.stepOnce(world);
  expect(world.log.length, 'one tick, on demand').toBe(after + 1);

  agent.paused = false;
  agent.tick(world);
  /* Two, not one: the third `buyBread` finishes the step, and a sequence carries straight on to
     `walkHome` inside the same tick rather than waiting for the next one. A tick is "advance until
     something is still running", which is what makes a routine of instant steps take one tick
     rather than as many ticks as it has steps. */
  expect(world.log.length).toBe(after + 3);
  expect(world.log.slice(-1)).toEqual(['walkHome']);
});

test('a name nothing provides is refused when the tree is built', () => {
  /* A typo that first shows itself when a villager reaches the market is a typo that shows itself
     in front of somebody playing. */
  expect(() =>
    buildBehaviorTree({ name: 'go', action: 'wnader' }, { actions: {}, conditions: {} }),
  ).toThrow(/nothing provides/);
  expect(() =>
    buildBehaviorTree({ name: 'if', condition: 'hungry' }, { actions: {}, conditions: {} }),
  ).toThrow(/nothing answers/);
  expect(() =>
    buildBehaviorTree({ name: 'empty', sequence: [] }, { actions: {}, conditions: {} }),
  ).toThrow(/composite with no children/);
});

test('a selector with nothing eligible fails, and a sequence stops at a failure', () => {
  const log: string[] = [];
  const tree = buildBehaviorTree(
    {
      name: 'root',
      sequence: [
        { name: 'first', action: 'note' },
        { name: 'gate', condition: 'never' },
        { name: 'third', action: 'note' },
      ],
    },
    {
      actions: {
        note: () => {
          log.push('note');
          return SUCCESS;
        },
      },
      conditions: { never: () => false },
    },
  );
  const agent = new BehaviorRunner<undefined>(tree);
  expect(agent.tick(undefined)).toBe(FAILURE);
  expect(log, 'the third step was never reached').toEqual(['note']);

  /* And a failed sequence starts over rather than sitting on the step that failed. */
  log.length = 0;
  agent.tick(undefined);
  expect(log).toEqual(['note']);
});

test('reset forgets a suspension', () => {
  const world: World = { raining: false, errandLeft: 3, log: [] };
  const agent = character();
  agent.tick(world);
  world.log.length = 0;

  agent.reset();
  agent.tick(world);
  expect(world.log, 'out of the door again').toEqual(['walkOut', 'buyBread']);
});

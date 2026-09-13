import { expect, test, vi } from 'vitest';

import { ActionMap } from './actionMap.ts';
import { InputSource } from './input.ts';
import { MemoryStore } from '../core/storage.ts';
import { fakeBrowser } from './inputHarness.ts';

const DEFAULTS = {
  jump: { keys: ['Space'], buttons: ['faceDown'] as const },
  fire: { keys: ['KeyF'], buttons: ['r2'] as const },
  move: { stick: 'left' as const, up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD' },
};

function harness(): {
  browser: ReturnType<typeof fakeBrowser>;
  input: InputSource;
  actions: ActionMap;
} {
  const browser = fakeBrowser();
  const input = new InputSource(browser.target, [], { autoPoll: false });
  return { browser, input, actions: new ActionMap(input, DEFAULTS) };
}

/** The whole point: a game asks whether jump happened, not which device said so. */
test('one action, two devices, either satisfies it', () => {
  const { browser, input, actions } = harness();
  try {
    browser.keyDown('Space');
    input.poll();
    expect(actions.down('jump'), 'the keyboard answers').toBe(true);

    browser.keyUp('Space');
    browser.connect();
    browser.press('faceDown');
    input.poll();
    expect(actions.down('jump'), 'and so does the pad, through the same name').toBe(true);
  } finally {
    browser.restore();
  }
});

test('an action edge is one frame, and a claim takes it from everybody', () => {
  const { browser, input, actions } = harness();
  try {
    browser.connect();
    browser.press('faceDown');
    input.poll();

    expect(actions.pressed('jump'), 'readable').toBe(true);
    expect(actions.pressed('jump'), 'and readable again').toBe(true);
    expect(actions.consumePress('jump'), 'claimed once').toBe(true);
    expect(actions.consumePress('jump'), 'and not twice').toBe(false);
    expect(actions.pressed('jump'), 'gone for anything else asking').toBe(false);
  } finally {
    browser.restore();
  }
});

/**
 * The larger of the two, never the sum.
 *
 * A player holding W while pushing the stick forward is asking to go forward, once. Adding the
 * contributions would send them at twice the speed, which is the bug every naive merge ships with.
 */
test('an analog action takes the larger of stick and keys', () => {
  const { browser, input, actions } = harness();
  const out = { x: 0, y: 0 };
  try {
    browser.keyDown('KeyW');
    input.poll();
    actions.vector('move', out);
    expect(out.y, 'keys alone: up is negative, as the stick is').toBeCloseTo(-1, 10);
    expect(out.x).toBeCloseTo(0, 10);

    browser.connect();
    browser.axis('leftY', -1);
    input.poll();
    actions.vector('move', out);
    expect(Math.hypot(out.x, out.y), 'both at once is still one').toBeCloseTo(1, 10);

    browser.keyUp('KeyW');
    browser.axis('leftY', -0.5);
    input.poll();
    actions.vector('move', out);
    expect(out.y, 'the stick alone keeps its magnitude').toBeGreaterThan(-1);
    expect(out.y).toBeLessThan(0);
  } finally {
    browser.restore();
  }
});

test('a rebind reports what it displaced rather than deciding about it', () => {
  const { browser, actions } = harness();
  try {
    const displaced = actions.rebind('fire', { device: 'gamepad', button: 'faceDown' });
    expect(displaced, 'jump held that button, and the game is told').toEqual(['jump']);

    const clean = actions.rebind('jump', { device: 'gamepad', button: 'faceUp' });
    expect(clean, 'a free binding displaces nothing').toEqual([]);
  } finally {
    browser.restore();
  }
});

/**
 * A diff, not a snapshot, and this is the test that says why.
 *
 * A snapshot freezes the map at the version that saved it: a game that later adds an action finds
 * every returning player without it, and cannot tell a deliberate choice from a stale record.
 */
test('a saved binding survives, and a default added later still arrives', () => {
  const { browser, input, actions } = harness();
  const store = new MemoryStore();
  try {
    actions.rebind('jump', { device: 'keyboard', code: 'KeyJ' });
    actions.save(store, 'bindings');

    /* A later version of the game: jump is rebound by the player, crouch is new. */
    const next = new ActionMap(input, {
      ...DEFAULTS,
      crouch: { keys: ['KeyC'], buttons: ['faceRight'] as const },
    });
    next.load(store, 'bindings');

    expect(next.bindingsFor('jump'), 'the change the player made').toContainEqual({
      device: 'keyboard',
      code: 'KeyJ',
    });
    expect(next.bindingsFor('crouch'), 'and an action the record never knew about').toContainEqual({
      device: 'keyboard',
      code: 'KeyC',
    });
  } finally {
    browser.restore();
  }
});

test('an unreadable record is defaults, said once', () => {
  const { browser, input } = harness();
  const said = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const store = new MemoryStore();
  try {
    store.write('bindings', '{ not json at all');
    const actions = new ActionMap(input, DEFAULTS);
    actions.load(store, 'bindings');
    actions.load(store, 'bindings');

    expect(actions.bindingsFor('jump'), 'a player gets a working game').toContainEqual({
      device: 'keyboard',
      code: 'Space',
    });
    expect(said, 'and is not told twice about one bad record').toHaveBeenCalledTimes(1);
  } finally {
    said.mockRestore();
    browser.restore();
  }
});

test('an analog direction takes several codes, the way a digital action does', () => {
  /*
   * Binding both WASD and the arrows to movement is the ordinary thing to do, and
   * `DigitalAction` could already express it while `AnalogAction` could not. The asymmetry was
   * the gap: the alternative was two analog actions merged by hand at the call site, which is
   * the engine handing back a job it already does.
   */
  const browser = fakeBrowser();
  const input = new InputSource(browser.target, [], { autoPoll: false });
  const actions = new ActionMap(input, {
    move: { stick: 'left' as const, up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'] },
  });
  const out = { x: 0, y: 0 };
  try {
    browser.keyDown('ArrowUp');
    input.poll();
    actions.vector('move', out);
    /* Up is negative: the stick's convention, which the engine keeps rather than flipping. */
    expect(out.y, 'the second code answers').toBe(-1);

    browser.keyUp('ArrowUp');
    browser.keyDown('KeyW');
    input.poll();
    actions.vector('move', out);
    expect(out.y, 'and so does the first').toBe(-1);

    browser.keyUp('KeyW');
    browser.keyDown('KeyQ');
    input.poll();
    actions.vector('move', out);
    expect(out.y, 'and something bound to neither does not').toBe(0);
  } finally {
    browser.restore();
  }
});

test('an analog direction still takes a single code', () => {
  const { browser, input, actions } = harness();
  const out = { x: 0, y: 0 };
  try {
    browser.keyDown('KeyW');
    input.poll();
    actions.vector('move', out);
    expect(out.y).toBe(-1);
  } finally {
    browser.restore();
  }
});

/**
 * The reader for two controls, beside the reader for one direction.
 *
 * **This is the whole of a bug that cost a consumer two weeks**, and the numbers are the point.
 * Holding forward and left is `(-1, -1)` before anything touches it, of length √2, so `vector`
 * divides both by √2 and hands back 0.7071 of each — correct for a walk, because a diagonal must
 * not beat a straight line. At a wheel those two axes are throttle and steering and the division is
 * a driver who can never reach full lock while accelerating. The report was "the car does not turn
 * and it is slow", and the vehicle model was rewritten twice before anybody looked here.
 */
test('one axis at a time is not normalised against the other', () => {
  const { browser, input, actions } = harness();
  const out = { x: 0, y: 0 };
  try {
    browser.keyDown('KeyW');
    browser.keyDown('KeyA');
    input.poll();

    actions.vector('move', out);
    const diagonal = Math.SQRT1_2;
    expect(out.x, 'a direction is shortened to the rim').toBeCloseTo(-diagonal, 10);
    expect(out.y).toBeCloseTo(-diagonal, 10);

    expect(actions.axis('move', 'x'), 'a control is not').toBe(-1);
    expect(actions.axis('move', 'y'), 'full throttle and full lock at once').toBe(-1);

    /* Reading one does not disturb the other: both share the scratch that `vector` fills. */
    expect(actions.axis('move', 'x')).toBe(-1);
    actions.vector('move', out);
    expect(out.x, 'and the direction is still a direction afterwards').toBeCloseTo(-diagonal, 10);
  } finally {
    browser.restore();
  }
});

/**
 * A stick already gives its axes separately, so the two readers agree on one and differ on the
 * other. That asymmetry is the reason `vector` cannot simply stop normalising: the keyboard is the
 * device that needs the choice made for it.
 */
test('on a pad the two readers return the same numbers', () => {
  const { browser, input, actions } = harness();
  const out = { x: 0, y: 0 };
  try {
    browser.connect();
    browser.axis('leftX', 0.6);
    browser.axis('leftY', -0.8);
    input.poll();

    actions.vector('move', out);
    expect(Math.hypot(out.x, out.y), 'a stick at the rim').toBeCloseTo(1, 10);
    expect(actions.axis('move', 'x')).toBeCloseTo(out.x, 10);
    expect(actions.axis('move', 'y')).toBeCloseTo(out.y, 10);
    /* Seven places, not ten: a pad's axes are held in a `Float32Array`, so 0.6 comes back 1.6e-8
       away from 0.6 and a tighter tolerance would be asserting single precision is double. */
    expect(actions.axis('move', 'x')).toBeCloseTo(0.6, 7);
  } finally {
    browser.restore();
  }
});

test('an axis of something that is not a direction is zero rather than an error', () => {
  const { browser, input, actions } = harness();
  try {
    browser.keyDown('Space');
    input.poll();
    /* `jump` is digital and `sprint` is nothing at all. A script reads actions by name, so both
       have to answer rather than throw inside a frame. */
    expect(actions.axis('jump', 'x')).toBe(0);
    expect(actions.axis('sprint', 'y')).toBe(0);
  } finally {
    browser.restore();
  }
});

/**
 * The order systems run in, and what the declarations buy beyond it.
 *
 * **Order is declaration order, adjusted only by explicit `after`.** The design's first draft said
 * the order was derived from the conflict graph — it cannot be: a conflict is *symmetric* (one
 * writes what the other reads or writes), so every conflict would be a two-cycle and a topological
 * sort would refuse every real schedule. What is genuinely directional is what an author states.
 *
 * So there are two things here, and they answer different questions:
 *
 * - **`after` gives ordering**, is directional, is topologically sorted with declaration order as
 *   the tie-break, and a cycle in it is refused naming both systems. That is a real cycle, because
 *   an author asked for two things each to follow the other.
 * - **Conflicts give grouping.** Adjacent systems that touch nothing in common could run together,
 *   and `groups` reports which. It is **reported and not taken**: running two systems in workers
 *   means transferring or sharing component storage, which is a decision about `SharedArrayBuffer`
 *   and a consumer's deployment rather than about scheduling. The declarations are what make it
 *   decidable when somebody wants to decide it.
 */
import type { BoundSystem as BoundSystemType } from './system.ts';
import { BoundSystem, type SystemDefinition } from './system.ts';
import type { World } from './world.ts';

export interface Schedule {
  /** The systems, in the order they run. */
  readonly order: readonly SystemDefinition[];
  /**
   * Runs of adjacent systems that touch nothing in common.
   *
   * Reported rather than used. A group of one is a system that conflicts with its neighbour.
   */
  readonly groups: readonly (readonly SystemDefinition[])[];
}

/**
 * Order the systems, refusing what cannot be ordered.
 *
 * Deterministic: the same definitions in the same order produce the same schedule on every machine
 * and every run, which is what a replay of a recorded session depends on.
 */
export function buildSchedule(systems: readonly SystemDefinition[]): Schedule {
  const byName = new Map<string, number>();
  systems.forEach((system, index) => {
    if (byName.has(system.name)) {
      throw new Error(
        `\`${system.name}\` is declared more than once. \`after\` addresses a system by name, so ` +
          'two of a name is an ordering constraint nobody can write.',
      );
    }
    byName.set(system.name, index);
  });

  for (const system of systems) {
    for (const name of system.after ?? []) {
      if (!byName.has(name)) {
        throw new Error(
          `\`${system.name}\` says it runs after \`${name}\`, which no system declares. A ` +
            'constraint naming nothing is a constraint that silently does nothing.',
        );
      }
    }
  }

  /*
   * Kahn's algorithm over the `after` edges, taking the **lowest-numbered** ready system each time.
   * That is the tie-break: among systems whose constraints are all satisfied, declaration order
   * decides, so the result is a total order rather than whichever the set happened to yield.
   */
  const order: SystemDefinition[] = [];
  const done = new Set<string>();

  for (let placed = 0; placed < systems.length; placed += 1) {
    let chosen = -1;
    for (let i = 0; i < systems.length; i += 1) {
      const system = systems[i] as SystemDefinition;
      if (done.has(system.name)) continue;
      const waiting = (system.after ?? []).some((name) => !done.has(name));
      if (waiting) continue;
      chosen = i;
      break;
    }

    if (chosen < 0) {
      const stuck = systems.filter((system) => !done.has(system.name)).map((s) => s.name);
      throw new Error(
        `these systems each say they run after another of them, so none can go first: ` +
          `${stuck.join(', ')}. One of the \`after\` clauses has to give.`,
      );
    }

    const system = systems[chosen] as SystemDefinition;
    done.add(system.name);
    order.push(system);
  }
  return { order, groups: group(order) };
}

/** Which of a component type's ids a system touches at all. */
function touched(system: SystemDefinition): Set<number> {
  const ids = new Set<number>();
  for (const type of system.reads ?? []) ids.add(type.id);
  for (const type of system.writes ?? []) ids.add(type.id);
  return ids;
}

/** Whether two systems must not run at the same time: one writes what the other touches. */
function conflicts(a: SystemDefinition, b: SystemDefinition): boolean {
  const bTouched = touched(b);
  for (const type of a.writes ?? []) if (bTouched.has(type.id)) return true;
  const aTouched = touched(a);
  for (const type of b.writes ?? []) if (aTouched.has(type.id)) return true;
  return false;
}

function group(order: readonly SystemDefinition[]): (readonly SystemDefinition[])[] {
  const groups: SystemDefinition[][] = [];
  let current: SystemDefinition[] = [];
  for (const system of order) {
    if (current.length > 0 && current.some((other) => conflicts(other, system))) {
      groups.push(current);
      current = [];
    }
    current.push(system);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** Systems bound to a world, made once and reused for the life of it. */
const bound = new WeakMap<World, Map<SystemDefinition, BoundSystemType>>();

/**
 * Systems whose failure has already been reported, per world.
 *
 * A declaration error repeats every step by construction, so the message is said once. Keyed by
 * definition rather than counted, because what a reader needs is the name of each broken system
 * and not how many times it has failed.
 */
const reported = new WeakMap<World, Set<SystemDefinition>>();

/**
 * Run one fixed step of a schedule.
 *
 * `tick` is the simulation's step count and is what `everyTicks` strides over — so a system at
 * stride 60 runs on tick 0, 60, 120, in every replay of the same input.
 *
 * **A system that throws does not take the rest of the tick with it, since 2026-08-28.** It used
 * to: the throw left this function, so every system scheduled after the failing one never ran —
 * once per tick, for as long as the game was up. Reported from outside, and the way it was found is
 * the argument for containing it. A system queried a component it had not declared, which throws by
 * design; the system that stopped was three places later and was the one stepping a vehicle; the
 * symptom was *a car moving in jerks*, and the only evidence was a console line no headless check
 * reads. A broken system must not be able to silently starve its neighbours.
 *
 * So each system's failure is caught, reported **once** naming the system and the reason, and the
 * schedule carries on. Nothing is disabled: a declaration error will throw again next tick and be
 * caught again, which costs a throw per tick and keeps a transient failure recoverable — and this
 * function no longer throws, which is what `AGENTS.md` requires of anything the frame loop calls.
 *
 * **What it gives up** is the stack reaching a debugger's uncaught-exception break, which is how
 * somebody working on a system would rather meet it. **What would change it** is a consumer wanting
 * failures fatal in development; the answer then is a reporter this takes as a parameter rather than
 * a rule chosen here for everybody.
 */
export function runSchedule(world: World, schedule: Schedule, tick: number): void {
  let forWorld = bound.get(world);
  if (forWorld === undefined) {
    forWorld = new Map();
    bound.set(world, forWorld);
  }

  for (const definition of schedule.order) {
    const stride = definition.everyTicks ?? 1;
    if (stride > 1 && tick % stride !== 0) continue;

    let system = forWorld.get(definition);
    if (system === undefined) {
      system = new BoundSystem(world, definition);
      forWorld.set(definition, system);
    }
    try {
      system.run();
    } catch (error) {
      announce(world, definition, error);
    }
  }
}

/** Say what failed, once per system per world. */
function announce(world: World, definition: SystemDefinition, error: unknown): void {
  let seen = reported.get(world);
  if (seen === undefined) {
    seen = new Set();
    reported.set(world, seen);
  }
  if (seen.has(definition)) return;
  seen.add(definition);
  const reason = error instanceof Error ? error.message : String(error);
  console.error(
    `[driftengine] the system \`${definition.name}\` threw and was skipped; every other system ` +
      `in the schedule still ran. This is said once, and it will keep happening every tick until ` +
      `it is fixed: ${reason}`,
  );
}

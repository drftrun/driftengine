/**
 * A DriftScript module hosted for the city: loaded, its components registered and bound to an
 * entity world of its own, its systems scheduled, and stepped by a tick count — never a clock.
 *
 * One entity holds the module's components, which the host writes facts into and reads decisions
 * back from by field name. A handful of fields a step, so `read` and `write` by name cost nothing
 * that matters, and they allocate nothing.
 */
import { World, buildSchedule, runSchedule } from '@driftengine/entities';
import type { ComponentType, Entity, Schedule } from '@driftengine/entities';
import { bindModule, registerEntityModule } from '@driftengine/script';
import type { ComponentRegistry } from '@driftengine/script';
import { loadModule } from 'driftscript';

export class ScriptHost {
  readonly world = new World();
  readonly entity: Entity;
  private readonly registry: ComponentRegistry = new Map();
  private readonly schedule: Schedule;
  private tick = 0;

  constructor(declared: Record<string, unknown>, label: string, components: readonly string[]) {
    const module = loadModule(declared);
    const registered = registerEntityModule(module, this.registry);
    const bound = bindModule(module, { entities: { components: this.registry } });
    if (!bound.bound) throw new Error(`sprawl ${label}: ${bound.reason}`);
    this.schedule = buildSchedule(registered.systems);
    this.entity = this.world.create();
    for (const name of components) this.world.add(this.entity, this.type(name), {});
  }

  /** The module's component named `name`. */
  type(name: string): ComponentType {
    const type = this.registry.get(name);
    if (type === undefined) throw new Error(`sprawl: the module declared no ${name}`);
    return type as ComponentType;
  }

  /** One step of every system. */
  step(): void {
    runSchedule(this.world, this.schedule, this.tick);
    this.tick += 1;
  }

  read(type: ComponentType, field: string): number {
    return this.world.read(this.entity, type, field) as number;
  }

  write(type: ComponentType, field: string, value: number): void {
    this.world.write(this.entity, type, field, value);
  }
}

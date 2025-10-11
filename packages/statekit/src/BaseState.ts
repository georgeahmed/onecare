import { State, MachineContext, MachineEvent, StateName } from './types';

export abstract class BaseState<C extends MachineContext, E extends MachineEvent> implements State<C, E> {
  public readonly name: StateName;

  constructor(name: StateName) {
    this.name = name;
  }

  enter?(ctx: C): Promise<void> | void;
  exit?(ctx: C): Promise<void> | void;

  abstract handle(ctx: C, evt: E): Promise<StateName> | StateName;
}


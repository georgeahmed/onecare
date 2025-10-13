export type StateName = string;

export interface MachineEvent<T = unknown> {
  type: string;
  payload?: T;
}

export interface MachineContext {
  id: string;
  [key: string]: unknown;
}

export interface Transition<C extends MachineContext, E extends MachineEvent> {
  from: StateName;
  to: StateName;
  via: (ctx: C, evt: E) => Promise<void> | void;
}

export interface State<C extends MachineContext, E extends MachineEvent> {
  name: StateName;
  enter?: (ctx: C) => Promise<void> | void;
  handle: (ctx: C, evt: E) => Promise<StateName> | StateName;
  exit?: (ctx: C) => Promise<void> | void;
}


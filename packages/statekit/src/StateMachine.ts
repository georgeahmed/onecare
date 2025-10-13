import { MachineContext, MachineEvent, State, StateName } from './types';

export class StateMachine<C extends MachineContext, E extends MachineEvent> {
  private states: Map<StateName, State<C, E>> = new Map();
  private current: State<C, E>;
  private readonly ctx: C;

  constructor(initial: State<C, E>, ctx: C) {
    this.current = initial;
    this.ctx = ctx;
  }

  register(state: State<C, E>) {
    this.states.set(state.name, state);
  }

  get state(): StateName {
    return this.current.name;
  }

  async start() {
    if (this.current.enter) await this.current.enter(this.ctx);
  }

  async dispatch(evt: E) {
    // Minimal dispatch without side-effect plumbing; plug adapters as needed.
    const nextName = await this.current.handle(this.ctx, evt);
    if (nextName === this.current.name) return; // self-transition no-op
    if (this.current.exit) await this.current.exit(this.ctx);
    const next = this.states.get(nextName);
    if (!next) throw new Error(`Unknown next state: ${nextName}`);
    this.current = next;
    if (this.current.enter) await this.current.enter(this.ctx);
  }
}

import { describe, it, expect } from 'vitest';
import { StateMachine } from '../src/StateMachine';
import { BaseState } from '../src/BaseState';
import type { MachineContext, MachineEvent } from '../src/types';

interface Ctx extends MachineContext {}
type Evt = MachineEvent;

class A extends BaseState<Ctx, Evt> {
  constructor() { super('A'); }
  async handle() { return 'B'; }
}
class B extends BaseState<Ctx, Evt> {
  constructor() { super('B'); }
  async handle() { return 'B'; }
}

describe('StateMachine', () => {
  it('transitions between states', async () => {
    const a = new A();
    const machine = new StateMachine<Ctx, Evt>(a, { id: 't1' });
    machine.register(a);
    machine.register(new B());
    await machine.start();
    await machine.dispatch({ type: 'tick' });
    expect(machine.state).toBe('B');
  });
});


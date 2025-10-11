import { BaseState } from '../../../../packages/statekit/src/BaseState';

export class InboundState extends BaseState<any, any> { constructor(){ super('Inbound'); } async handle(){ return 'Validated'; } }
export class ValidatedState extends BaseState<any, any> { constructor(){ super('Validated'); } async handle(){ return 'Routed'; } }
export class RoutedState extends BaseState<any, any> { constructor(){ super('Routed'); } async handle(){ return 'Acked'; } }
export class AckedState extends BaseState<any, any> { constructor(){ super('Acked'); } async handle(){ return 'Acked'; } }


import { BaseState } from '../../../../packages/statekit/src/BaseState';

export class AnalyzedState extends BaseState<any, any> { constructor(){ super('Analyzed'); } async handle(){ return 'Proceed'; } }
export class DivertedState extends BaseState<any, any> { constructor(){ super('Diverted'); } async handle(){ return 'Diverted'; } }
export class ProceedState extends BaseState<any, any> { constructor(){ super('Proceed'); } async handle(){ return 'Proceed'; } }


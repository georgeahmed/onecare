import { BaseState } from '../../../../packages/statekit/src/BaseState';

export class ClassifiedState extends BaseState<any, any> { constructor(){ super('Classified'); } async handle(){ return 'Eligible'; } }
export class EligibleState extends BaseState<any, any> { constructor(){ super('Eligible'); } async handle(){ return 'Referred'; } }
export class ReferredState extends BaseState<any, any> { constructor(){ super('Referred'); } async handle(){ return 'OutcomeRecorded'; } }
export class OutcomeRecordedState extends BaseState<any, any> { constructor(){ super('OutcomeRecorded'); } async handle(){ return 'OutcomeRecorded'; } }


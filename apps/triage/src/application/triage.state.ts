import { BaseState } from '../../../../packages/statekit/src/BaseState';

export class IntakeState extends BaseState<any, any> { constructor(){ super('Intake'); } async handle(){ return 'Scored'; } }
export class ScoredState extends BaseState<any, any> { constructor(){ super('Scored'); } async handle(){ return 'TaskCreated'; } }
export class TaskCreatedState extends BaseState<any, any> { constructor(){ super('TaskCreated'); } async handle(){ return 'Notified'; } }
export class NotifiedState extends BaseState<any, any> { constructor(){ super('Notified'); } async handle(){ return 'Completed'; } }
export class CompletedState extends BaseState<any, any> { constructor(){ super('Completed'); } async handle(){ return 'Completed'; } }


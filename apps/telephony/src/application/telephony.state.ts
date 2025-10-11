import { BaseState } from '../../../../packages/statekit/src/BaseState';

export class CallReceivedState extends BaseState<any, any> { constructor(){ super('CallReceived'); } async handle(){ return 'Transcribed'; } }
export class TranscribedState extends BaseState<any, any> { constructor(){ super('Transcribed'); } async handle(){ return 'IntentClassified'; } }
export class IntentClassifiedState extends BaseState<any, any> { constructor(){ super('IntentClassified'); } async handle(){ return 'Routed'; } }
export class RoutedState extends BaseState<any, any> { constructor(){ super('Routed'); } async handle(){ return 'Routed'; } }


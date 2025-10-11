import { BaseState } from '../../../../packages/statekit/src/BaseState';

export class AudioReceivedState extends BaseState<any, any> { constructor(){ super('AudioReceived'); } async handle(){ return 'Transcribed'; } }
export class TranscribedState extends BaseState<any, any> { constructor(){ super('Transcribed'); } async handle(){ return 'Drafted'; } }
export class DraftedState extends BaseState<any, any> { constructor(){ super('Drafted'); } async handle(){ return 'Approved'; } }
export class ApprovedState extends BaseState<any, any> { constructor(){ super('Approved'); } async handle(){ return 'WrittenBack'; } }
export class WrittenBackState extends BaseState<any, any> { constructor(){ super('WrittenBack'); } async handle(){ return 'WrittenBack'; } }


import { BaseState } from '../../../../packages/statekit/src/BaseState';

export class SearchState extends BaseState<any, any> { constructor(){ super('Search'); } async handle(){ return 'Selected'; } }
export class SelectedState extends BaseState<any, any> { constructor(){ super('Selected'); } async handle(){ return 'Booked'; } }
export class BookedState extends BaseState<any, any> { constructor(){ super('Booked'); } async handle(){ return 'WrittenBack'; } }
export class WrittenBackState extends BaseState<any, any> { constructor(){ super('WrittenBack'); } async handle(){ return 'Confirmed'; } }
export class ConfirmedState extends BaseState<any, any> { constructor(){ super('Confirmed'); } async handle(){ return 'Confirmed'; } }


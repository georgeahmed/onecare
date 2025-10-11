import { BaseState } from '../../../../packages/statekit/src/BaseState';

export class HoursCheckedState extends BaseState<any, any> { constructor(){ super('HoursChecked'); } async handle(){ return 'PortalStateEnsured'; } }
export class PortalStateEnsuredState extends BaseState<any, any> { constructor(){ super('PortalStateEnsured'); } async handle(){ return 'PortalStateEnsured'; } }


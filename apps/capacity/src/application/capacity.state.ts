import { BaseState } from '../../../../packages/statekit/src/BaseState';

export class TelemetryState extends BaseState<any, any> { constructor(){ super('Telemetry'); } async handle(){ return 'Forecast'; } }
export class ForecastState extends BaseState<any, any> { constructor(){ super('Forecast'); } async handle(){ return 'Shaped'; } }
export class ShapedState extends BaseState<any, any> { constructor(){ super('Shaped'); } async handle(){ return 'Applied'; } }
export class AppliedState extends BaseState<any, any> { constructor(){ super('Applied'); } async handle(){ return 'Applied'; } }


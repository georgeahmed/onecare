import type { CapacityScheduler, ReleaseSlotsRequest, ReleaseSlotsResponse } from '@onecare/ports';

interface InMemorySchedulerState {
  totalSlots: number;
  heldSlots: number;
}

export class InMemoryCapacityScheduler implements CapacityScheduler {
  private state: InMemorySchedulerState;
  public readonly requests: ReleaseSlotsRequest[] = [];

  constructor(initial: InMemorySchedulerState) {
    this.state = { ...initial };
  }

  async releaseHeldSlots(request: ReleaseSlotsRequest): Promise<ReleaseSlotsResponse> {
    this.requests.push(request);
    if (request.dryRun) {
      return {
        releasedSlots: 0,
        heldSlotsRemaining: this.state.heldSlots,
        totalSlots: this.state.totalSlots,
        holdFraction: this.state.totalSlots > 0 ? this.state.heldSlots / this.state.totalSlots : 0,
      };
    }
    const releasable = Math.max(0, Math.min(request.slots, this.state.heldSlots));
    this.state = {
      totalSlots: this.state.totalSlots,
      heldSlots: Math.max(0, this.state.heldSlots - releasable),
    };
    return {
      releasedSlots: releasable,
      heldSlotsRemaining: this.state.heldSlots,
      totalSlots: this.state.totalSlots,
      holdFraction: this.state.totalSlots > 0 ? this.state.heldSlots / this.state.totalSlots : 0,
    };
  }

  snapshot(): InMemorySchedulerState {
    return { ...this.state };
  }

  reset(state: InMemorySchedulerState): void {
    this.state = { ...state };
    this.requests.length = 0;
  }
}

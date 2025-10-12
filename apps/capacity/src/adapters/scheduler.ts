import { logger } from '@onecare/observability';
import type { CapacityScheduler, ReleaseSlotsRequest } from '@onecare/ports';
import type { ReleaseExecutor, ReleaseMeta, ReleasePlan } from '../application/types';

export interface SchedulerReleaseExecutorOptions {
  channel?: string;
  reason?: string;
  clock?: () => Date;
}

export class SchedulerReleaseExecutor implements ReleaseExecutor {
  private readonly channel: string;
  private readonly reason?: string;
  private readonly clock: () => Date;

  constructor(
    private readonly scheduler: CapacityScheduler,
    options: SchedulerReleaseExecutorOptions = {},
  ) {
    this.channel = options.channel ?? 'micro_release';
    this.reason = options.reason;
    this.clock = options.clock ?? defaultClock;
  }

  async apply(plan: ReleasePlan, meta: ReleaseMeta): Promise<void> {
    const requestedAt = this.clock().toISOString();
    const request: ReleaseSlotsRequest = {
      practiceId: meta.practiceId,
      runId: meta.runId,
      correlationId: meta.correlationId,
      slots: plan.slotsToRelease,
      channel: this.channel,
      dryRun: meta.dryRun,
      plan: {
        heldSlotsBefore: plan.heldSlotsBefore,
        heldSlotsAfter: plan.heldSlotsAfter,
        releaseFraction: plan.releaseFraction,
        maxFractionSlots: plan.maxFractionSlots,
        minReserveSlots: plan.minReserveSlots,
        cappedBy: plan.cappedBy,
      },
      reason: this.reason,
      requestedAt,
    };

    logger.info('capacity.scheduler.release_request', {
      practiceId: meta.practiceId,
      runId: meta.runId,
      correlationId: meta.correlationId,
      slots: plan.slotsToRelease,
      channel: request.channel,
      dryRun: Boolean(meta.dryRun),
    });

    const response = await this.scheduler.releaseHeldSlots(request);

    logger.info('capacity.scheduler.release_response', {
      practiceId: meta.practiceId,
      runId: meta.runId,
      correlationId: meta.correlationId,
      releasedSlots: response.releasedSlots,
      heldSlotsRemaining: response.heldSlotsRemaining,
      totalSlots: response.totalSlots,
      holdFraction: response.holdFraction,
    });
  }
}

function defaultClock(): Date {
  return new Date();
}

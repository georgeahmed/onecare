import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchedulerReleaseExecutor } from '../src/adapters/scheduler';
import type { CapacityScheduler } from '@onecare/ports';
import type { ReleasePlan, ReleaseMeta } from '../src/application/types';
import { logger } from '@onecare/observability';

describe('SchedulerReleaseExecutor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('invokes capacity scheduler with plan details', async () => {
    const plan: ReleasePlan = {
      slotsToRelease: 6,
      releaseFraction: 0.05,
      heldSlotsBefore: 12,
      heldSlotsAfter: 6,
      maxFractionSlots: 6,
      minReserveSlots: 4,
      cappedBy: ['delta'],
    };
    const meta: ReleaseMeta = {
      practiceId: 'demo',
      runId: 'run-42',
      correlationId: 'corr-1',
      dryRun: false,
    };
    const releaseHeldSlots = vi.fn(async () => ({ releasedSlots: 6, heldSlotsRemaining: 6 }));
    const scheduler: CapacityScheduler = {
      releaseHeldSlots,
    };
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});

    const executor = new SchedulerReleaseExecutor(scheduler, {
      channel: 'micro_release',
      reason: 'forecast_delta',
      clock: () => new Date('2025-01-01T00:00:00Z'),
    });

    await executor.apply(plan, meta);

    expect(releaseHeldSlots).toHaveBeenCalledTimes(1);
    expect(releaseHeldSlots).toHaveBeenCalledWith({
      practiceId: 'demo',
      runId: 'run-42',
      correlationId: 'corr-1',
      slots: 6,
      channel: 'micro_release',
      dryRun: false,
      plan: {
        heldSlotsBefore: 12,
        heldSlotsAfter: 6,
        releaseFraction: 0.05,
        maxFractionSlots: 6,
        minReserveSlots: 4,
        cappedBy: ['delta'],
      },
      reason: 'forecast_delta',
      requestedAt: '2025-01-01T00:00:00.000Z',
    });
    expect(infoSpy).toHaveBeenCalledWith(
      'capacity.scheduler.release_response',
      expect.objectContaining({ releasedSlots: 6, heldSlotsRemaining: 6 }),
    );
  });
});

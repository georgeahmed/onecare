/// <reference types="vitest/globals" />

import { describe, expect, it } from 'vitest';
import { MockQueueGateway } from '../src/adapters/queue.mock';
import { QueueGatewayError } from '../src/adapters/queue.types';

describe('MockQueueGateway', () => {
  it('filters tasks by clinic', async () => {
    const gateway = new MockQueueGateway();
    const demo = await gateway.list({ clinicId: 'demo' });
    const north = await gateway.list({ clinicId: 'north' });

    expect(demo.items.every((item) => item.clinicId === 'demo')).toBe(true);
    expect(north.items.every((item) => item.clinicId === 'north')).toBe(true);
  });

  it('assigns unassigned tasks and returns updated status', async () => {
    const gateway = new MockQueueGateway();
    const response = await gateway.assign('t-002');
    expect(response.assignee).toBe('clinician-dev');
    expect(response.status).toBe('IN_PROGRESS');
  });

  it('throws conflict when assigning a task already owned by someone else', async () => {
    const gateway = new MockQueueGateway();
    await expect(gateway.assign('t-004')).rejects.toSatisfy((error) => {
      return error instanceof QueueGatewayError && error.code === 'conflict';
    });
  });

  it('records audit entries with the current user context', async () => {
    const gateway = new MockQueueGateway();
    gateway.setAuthContext({ userId: 'auditor-1' });
    const updated = await gateway.assign('t-002', 'auditor-1');
    expect(updated.audit.at(-1)?.who).toBe('auditor-1');
  });
});

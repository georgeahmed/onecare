import { describe, it, expect } from 'vitest';
import { validate } from '@onecare/domain';

const REFERRAL_REQUEST_ID = 'https://onecare/schemas/ics/referral-request.json';
const REFERRAL_ACK_ID = 'https://onecare/schemas/ics/referral-ack.json';
const TASK_CREATED_ID = 'https://onecare/schemas/tasks/task-created.json';

describe('ICS Hub contracts', () => {
  describe('referral.request schema', () => {
    it('accepts valid referral request payloads', () => {
      const payload = {
        referralId: 'ref-001',
        patientId: 'patient-123',
        org: 'ORG1',
        reason: 'support',
      };
      expect(validate(REFERRAL_REQUEST_ID, payload)).toEqual({ ok: true });
    });

    it('rejects invalid referral request payloads', () => {
      const payload = {
        referralId: 'ref-001',
        // missing patientId/org
        reason: 42,
      };
      const result = validate(REFERRAL_REQUEST_ID, payload);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected validation failure');
      const keywords = result.errors.map((error) => error.keyword);
      expect(keywords).toContain('required');
      expect(keywords).toContain('type');
    });
  });

  describe('referral.ack schema', () => {
    it('accepts valid acknowledgements', () => {
      const payload = {
        referralId: 'ref-001',
        accepted: true,
        note: null,
      };
      expect(validate(REFERRAL_ACK_ID, payload)).toEqual({ ok: true });
    });

    it('rejects acknowledgements missing required properties', () => {
      const payload = {
        accepted: 'yes',
      };
      const result = validate(REFERRAL_ACK_ID, payload);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected validation failure');
      const missingFields = result.errors.map((error) => error.params.missingProperty).filter(Boolean);
      expect(missingFields).toContain('referralId');
    });
  });

  describe('tasks.created schema', () => {
    it('accepts valid automation task payloads', () => {
      const payload = {
        taskId: 'task-1',
        patientId: 'patient-123',
        priority: 'ROUTINE',
        owner: 'automation',
      };
      expect(validate(TASK_CREATED_ID, payload)).toEqual({ ok: true });
    });

    it('flags invalid automation task payloads', () => {
      const payload = {
        taskId: 'task-1',
        priority: 'IMMEDIATE',
      };
      const result = validate(TASK_CREATED_ID, payload);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected validation failure');
      const paths = result.errors.map((error) => error.path);
      expect(paths).toContain('/patientId');
    });
  });
});

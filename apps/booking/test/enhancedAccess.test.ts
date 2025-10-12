import { describe, it, expect } from 'vitest';
import type { SlotView } from '../src/adapters/gpconnect.client';
import {
  applyEnhancedAccessFilters,
  loadEnhancedAccessPolicy,
  type EnhancedAccessPolicy,
} from '../src/application/enhancedAccess';
import type { ResolvedConfig } from '@onecare/config';

function makePolicy(): EnhancedAccessPolicy {
  return {
    timezone: 'Europe/London',
    windows: [
      { name: 'evening', days: [1], startMinutes: 18 * 60, endMinutes: 20 * 60 },
    ],
    allowedSlotTypes: ['EA'],
    fairness: { maxPerOrganisation: 1 },
  };
}

describe('applyEnhancedAccessFilters', () => {
  it('filters slots based on window and type', () => {
    const policy = makePolicy();
    const slots: SlotView[] = [
      {
        id: 'inside-window',
        start: '2025-10-13T18:30:00+01:00',
        end: '2025-10-13T18:45:00+01:00',
        organisationId: 'org-1',
        serviceType: 'EA',
      },
      {
        id: 'wrong-type',
        start: '2025-10-13T18:30:00+01:00',
        end: '2025-10-13T18:45:00+01:00',
        organisationId: 'org-1',
        serviceType: 'ROUTINE',
      },
      {
        id: 'outside-window',
        start: '2025-10-13T14:00:00+01:00',
        end: '2025-10-13T14:15:00+01:00',
        organisationId: 'org-1',
        serviceType: 'EA',
      },
    ];

    const result = applyEnhancedAccessFilters(slots, policy);
    expect(result.accepted.map((slot) => slot.id)).toEqual(['inside-window']);
    const reasonsById = Object.fromEntries(result.rejected.map((r) => [r.slot.id, r.reasons]));
    expect(reasonsById['wrong-type']).toContain('slot_type_not_allowed');
    expect(reasonsById['outside-window']).toContain('outside_window');
  });

  it('enforces fairness cap per organisation', () => {
    const policy = makePolicy();
    const slots: SlotView[] = [
      {
        id: 'slot-1',
        start: '2025-10-13T18:30:00+01:00',
        end: '2025-10-13T18:45:00+01:00',
        organisationId: 'org-1',
        serviceType: 'EA',
      },
      {
        id: 'slot-2',
        start: '2025-10-13T18:45:00+01:00',
        end: '2025-10-13T19:00:00+01:00',
        organisationId: 'org-1',
        serviceType: 'EA',
      },
    ];

    const result = applyEnhancedAccessFilters(slots, policy);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected.some((r) => r.reasons.includes('fairness_max_per_org'))).toBe(true);
  });
});

describe('loadEnhancedAccessPolicy', () => {
  it('loads policy from resolved config', () => {
    const config = {
      practiceId: 'demo',
      enhanced_access: {
        timezone: 'Europe/London',
        windows: [
          { name: 'evening', days: [1, 2], start: '18:00', end: '20:00' },
        ],
        allowed_slot_types: ['EA'],
        fairness: { max_per_organisation: 2 },
      },
    } as unknown as ResolvedConfig;

    const policy = loadEnhancedAccessPolicy(config);
    expect(policy?.timezone).toBe('Europe/London');
    expect(policy?.windows[0].startMinutes).toBe(18 * 60);
    expect(policy?.allowedSlotTypes).toEqual(['EA']);
    expect(policy?.fairness.maxPerOrganisation).toBe(2);
  });
});

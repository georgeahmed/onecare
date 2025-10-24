import { describe, it, expect } from 'vitest';
type Actor = 'PRACTICE_ADMIN' | 'CLINICIAN' | 'PATIENT';
type Action = 'booking.write' | 'audit.read' | 'triage.view';

type MatrixRow = {
  actor: Actor;
  action: Action;
  resourceId: string;
  expected: 'allow' | 'deny';
};

const MATRIX: MatrixRow[] = [
  { actor: 'PRACTICE_ADMIN', action: 'booking.write', resourceId: 'practice:demo', expected: 'allow' },
  { actor: 'CLINICIAN', action: 'booking.write', resourceId: 'practice:demo', expected: 'allow' },
  { actor: 'PATIENT', action: 'booking.write', resourceId: 'practice:demo', expected: 'deny' },
  { actor: 'PRACTICE_ADMIN', action: 'audit.read', resourceId: 'audit:global', expected: 'allow' },
  { actor: 'CLINICIAN', action: 'audit.read', resourceId: 'audit:global', expected: 'deny' },
  { actor: 'PATIENT', action: 'triage.view', resourceId: 'triage:own', expected: 'allow' },
  { actor: 'PATIENT', action: 'triage.view', resourceId: 'triage:other', expected: 'deny' },
];

function authorize(actor: Actor, action: Action, resourceId: string): boolean {
  const policy = new Map<string, (resource: string) => boolean>([
    [`${'PRACTICE_ADMIN'}:${'booking.write'}`, () => true],
    [`${'CLINICIAN'}:${'booking.write'}`, (resource) => resource.startsWith('practice:')],
    [`${'PATIENT'}:${'booking.write'}`, () => false],
    [`${'PRACTICE_ADMIN'}:${'audit.read'}`, () => true],
    [`${'CLINICIAN'}:${'audit.read'}`, () => false],
    [`${'PATIENT'}:${'triage.view'}`, (resource) => resource === 'triage:own'],
    [`${'CLINICIAN'}:${'triage.view'}`, () => true],
  ]);
  const entry = policy.get(`${actor}:${action}`);
  if (!entry) return false;
  return entry(resourceId);
}

describe('Authorization matrix', () => {
  MATRIX.forEach((row) => {
    it(`actor ${row.actor} ${row.expected} ${row.action} on ${row.resourceId}`, () => {
      const allowed = authorize(row.actor, row.action, row.resourceId);
      expect(allowed).toBe(row.expected === 'allow');
    });
  });
});

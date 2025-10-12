import { describe, it, expect } from 'vitest';
import type { PharmacyEligibilityRuleset } from '@onecare/config';
import {
  isEligible,
  type EligibilityDocument,
  type EligibilityPatient,
} from '../src/application/eligibility';

const ruleset: PharmacyEligibilityRuleset = {
  defaultRule: {
    age: { min: 16, max: 80 },
    sex: ['female', 'male'],
    severity: { allowed: ['mild', 'moderate'], blocked: ['severe'] },
    exclusions: ['pregnant'],
  },
  conditions: {
    uti: {
      age: { min: 18 },
      sex: ['female'],
      exclusions: ['catheter'],
    },
  },
};

const emptyRuleset: PharmacyEligibilityRuleset = {};

const baseDoc: EligibilityDocument = {
  conditionCode: 'UTI',
  severity: 'mild',
};

const basePatient: EligibilityPatient = {
  ageYears: 25,
  sex: 'female',
};

describe('isEligible', () => {
  it('returns condition_missing when document lacks condition code', () => {
    const result = isEligible({ conditionCode: '' }, basePatient, ruleset);
    expect(result).toEqual({ ok: false, reason: 'condition_missing' });
  });

  it('returns rule_missing if no rule found for condition', () => {
    const result = isEligible({ conditionCode: 'unknown' }, basePatient, emptyRuleset);
    expect(result).toEqual({ ok: false, reason: 'rule_missing' });
  });

  it('returns rules_missing when ruleset absent', () => {
    const result = isEligible(baseDoc, basePatient, undefined);
    expect(result).toEqual({ ok: false, reason: 'rules_missing' });
  });

  it('enforces age bounds', () => {
    const tooYoung = isEligible(baseDoc, { ...basePatient, ageYears: 17 }, ruleset);
    expect(tooYoung).toEqual({ ok: false, reason: 'age_below_min' });
    const tooOld = isEligible(baseDoc, { ...basePatient, ageYears: 90 }, ruleset);
    expect(tooOld).toEqual({ ok: false, reason: 'age_above_max' });
    const unknownAge = isEligible(baseDoc, { ...basePatient, ageYears: undefined }, ruleset);
    expect(unknownAge).toEqual({ ok: false, reason: 'age_unknown' });
  });

  it('enforces allowed sex values', () => {
    const unknownSex = isEligible(baseDoc, { ...basePatient, sex: undefined }, ruleset);
    expect(unknownSex).toEqual({ ok: false, reason: 'sex_unknown' });
    const wrongSex = isEligible(baseDoc, { ...basePatient, sex: 'male' }, ruleset);
    expect(wrongSex).toEqual({ ok: false, reason: 'sex_not_allowed' });
  });

  it('applies severity allow and block lists', () => {
    const blocked = isEligible({ ...baseDoc, severity: 'severe' }, basePatient, ruleset);
    expect(blocked).toEqual({ ok: false, reason: 'severity_blocked' });
    const notAllowed = isEligible({ ...baseDoc, severity: 'unknown' }, basePatient, ruleset);
    expect(notAllowed).toEqual({ ok: false, reason: 'severity_not_allowed' });
    const missing = isEligible({ conditionCode: 'UTI' }, basePatient, ruleset);
    expect(missing).toEqual({ ok: false, reason: 'severity_unknown' });
  });

  it('respects exclusion lists from patient and document flags', () => {
    const patientFlag = isEligible(
      baseDoc,
      { ...basePatient, exclusionFlags: ['Pregnant'] },
      ruleset,
    );
    expect(patientFlag).toEqual({ ok: false, reason: 'exclusion_pregnant' });

    const docFlag = isEligible(
      { ...baseDoc, exclusionFlags: ['catheter'] },
      basePatient,
      ruleset,
    );
    expect(docFlag).toEqual({ ok: false, reason: 'exclusion_catheter' });
  });

  it('approves eligible patients', () => {
    const result = isEligible(
      { ...baseDoc, severity: 'Moderate' },
      { ...basePatient, exclusionFlags: [] },
      ruleset,
    );
    expect(result).toEqual({ ok: true });
  });
});

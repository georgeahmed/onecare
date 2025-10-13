import type {
  PharmacyEligibilityRule,
  PharmacyEligibilityRuleset,
  PharmacyPatientSex,
} from '@onecare/config';

export interface EligibilityDocument {
  conditionCode: string;
  severity?: string;
  exclusionFlags?: string[];
}

export interface EligibilityPatient {
  ageYears?: number;
  sex?: PharmacyPatientSex;
  exclusionFlags?: string[];
}

export interface EligibilityDecision {
  ok: boolean;
  reason?: string;
}

export function isEligible(
  doc: EligibilityDocument,
  patient: EligibilityPatient,
  ruleset: PharmacyEligibilityRuleset | undefined,
): EligibilityDecision {
  if (!doc || !doc.conditionCode || doc.conditionCode.trim().length === 0) {
    return { ok: false, reason: 'condition_missing' };
  }
  if (!ruleset) {
    return { ok: false, reason: 'rules_missing' };
  }

  const conditionKey = doc.conditionCode.trim().toLowerCase();
  const resolvedRule = mergeRules(ruleset.defaultRule, ruleset.conditions?.[conditionKey]);
  if (!resolvedRule) {
    return { ok: false, reason: 'rule_missing' };
  }

  if (resolvedRule.age) {
    const age = typeof patient.ageYears === 'number' ? patient.ageYears : undefined;
    if (age === undefined) {
      return { ok: false, reason: 'age_unknown' };
    }
    if (resolvedRule.age.min !== undefined && age < resolvedRule.age.min) {
      return { ok: false, reason: 'age_below_min' };
    }
    if (resolvedRule.age.max !== undefined && age > resolvedRule.age.max) {
      return { ok: false, reason: 'age_above_max' };
    }
  }

  if (resolvedRule.sex && resolvedRule.sex.length > 0) {
    const sex = patient.sex;
    if (!sex) {
      return { ok: false, reason: 'sex_unknown' };
    }
    if (!resolvedRule.sex.includes(sex)) {
      return { ok: false, reason: 'sex_not_allowed' };
    }
  }

  const severityValue = doc.severity ? doc.severity.trim().toLowerCase() : undefined;
  if (resolvedRule.severity) {
    if (resolvedRule.severity.blocked && severityValue && resolvedRule.severity.blocked.includes(severityValue)) {
      return { ok: false, reason: 'severity_blocked' };
    }
    if (resolvedRule.severity.allowed && resolvedRule.severity.allowed.length > 0) {
      if (!severityValue) {
        return { ok: false, reason: 'severity_unknown' };
      }
      if (!resolvedRule.severity.allowed.includes(severityValue)) {
        return { ok: false, reason: 'severity_not_allowed' };
      }
    }
  }

  if (resolvedRule.exclusions && resolvedRule.exclusions.length > 0) {
    const patientFlags = normaliseFlagList(patient.exclusionFlags);
    const docFlags = normaliseFlagList(doc.exclusionFlags);
    for (const code of resolvedRule.exclusions) {
      if (patientFlags.has(code) || docFlags.has(code)) {
        return { ok: false, reason: `exclusion_${code}` };
      }
    }
  }

  return { ok: true };
}

function mergeRules(
  base: PharmacyEligibilityRule | undefined,
  override: PharmacyEligibilityRule | undefined,
): PharmacyEligibilityRule | undefined {
  if (!base && !override) return undefined;
  const result: PharmacyEligibilityRule = {};

  if (base?.age) {
    result.age = { ...base.age };
  }
  if (override?.age) {
    result.age = { ...(result.age ?? {}), ...override.age };
  }
  if (result.age && result.age.min === undefined && result.age.max === undefined) {
    delete result.age;
  }

  const resolvedSex = override?.sex ?? base?.sex;
  if (resolvedSex && resolvedSex.length > 0) {
    result.sex = [...resolvedSex];
  }

  if (base?.severity) {
    result.severity = {
      allowed: base.severity.allowed ? [...base.severity.allowed] : undefined,
      blocked: base.severity.blocked ? [...base.severity.blocked] : undefined,
    };
  }
  if (override?.severity) {
    if (!result.severity) {
      result.severity = {};
    }
    if (override.severity.allowed) {
      result.severity.allowed = [...override.severity.allowed];
    }
    if (override.severity.blocked) {
      result.severity.blocked = [...override.severity.blocked];
    }
  }
  if (result.severity && !result.severity.allowed && !result.severity.blocked) {
    delete result.severity;
  }

  const exclusionSet = new Set<string>();
  if (base?.exclusions) {
    for (const code of base.exclusions) {
      exclusionSet.add(code);
    }
  }
  if (override?.exclusions) {
    for (const code of override.exclusions) {
      exclusionSet.add(code);
    }
  }
  if (exclusionSet.size > 0) {
    result.exclusions = Array.from(exclusionSet);
  }

  if (!result.age && !result.sex && !result.severity && !result.exclusions) {
    return undefined;
  }

  return result;
}

function normaliseFlagList(flags: string[] | undefined): Set<string> {
  const set = new Set<string>();
  if (!flags) return set;
  for (const flag of flags) {
    if (typeof flag !== 'string') continue;
    const trimmed = flag.trim().toLowerCase();
    if (trimmed) set.add(trimmed);
  }
  return set;
}

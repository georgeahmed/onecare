const CARE_RESOURCES = ['QuestionnaireResponse', 'Communication', 'Slot'] as const;
const FEATURE_RESOURCES = ['FeatureLog'] as const;

function buildConsentEntries(patientId: string) {
  return [
    {
      purpose: 'care',
      resources: [...CARE_RESOURCES],
      reference: `Consent/${patientId}-care`,
      grantedAt: '2024-01-01T00:00:00Z',
      expiresAt: '2030-01-01T00:00:00Z',
    },
    {
      purpose: 'analytics-lite',
      resources: [...FEATURE_RESOURCES],
      reference: `Consent/${patientId}-analytics`,
      grantedAt: '2024-01-01T00:00:00Z',
    },
  ];
}

const CONSENT_MAP: Record<string, ReturnType<typeof buildConsentEntries>> = {
  'patient-123': buildConsentEntries('patient-123'),
  'patient-1': buildConsentEntries('patient-1'),
  'patient-42': buildConsentEntries('patient-42'),
  'patient-rate': buildConsentEntries('patient-rate'),
};

export const CONSENT_FIXTURE = JSON.stringify(CONSENT_MAP);

export function setConsentFixtureEnv(): void {
  process.env.CONSENT_CACHE = CONSENT_FIXTURE;
}

export function consentReference(patientId: string, purpose: 'care' | 'analytics-lite' = 'care'): string {
  return purpose === 'care' ? `Consent/${patientId}-care` : `Consent/${patientId}-analytics`;
}

import type { GuidedHelpSessionRequest, GuidedHelpSessionResponse } from '@onecare/events';

type StepId = GuidedHelpSessionRequest['stepId'];
type FieldName = 'onset' | 'location' | 'severity' | 'otherSymptoms';

const STEP_FIELDS: Partial<Record<StepId, FieldName>> = {
  step1: 'onset',
  step2: 'location',
  step3: 'severity',
  step4: 'otherSymptoms',
};

const ALL_FIELDS: FieldName[] = ['onset', 'location', 'severity', 'otherSymptoms'];

function computeQualityScore(request: GuidedHelpSessionRequest, coveredCount: number): number {
  const conversation = request.conversation ?? [];
  const userTexts = conversation
    .filter((item) => item.role === 'user')
    .map((item) => item.text)
    .filter((text) => typeof text === 'string' && text.trim().length > 0);

  const joined = userTexts.join(' ').trim();
  const words = joined.length > 0 ? joined.split(/\s+/) : [];
  const total = words.length;
  const unique = new Set(words.map((w) => w.toLowerCase())).size;
  const diversity = total > 0 ? unique / total : 0;

  let score = 0;

  // Coverage contribution
  if (coveredCount >= 3) {
    score += 0.4;
  } else if (coveredCount >= 2) {
    score += 0.3;
  } else if (coveredCount >= 1) {
    score += 0.2;
  }

  // Length contribution
  if (total >= 40) {
    score += 0.3;
  } else if (total >= 20) {
    score += 0.2;
  } else if (total >= 5) {
    score += 0.1;
  }

  // Diversity contribution
  if (diversity >= 0.7) {
    score += 0.2;
  } else if (diversity >= 0.4) {
    score += 0.1;
  }

  if (score > 1) score = 1;
  if (score < 0) score = 0;
  return Number(score.toFixed(2));
}

function detectLowSignalReasons(request: GuidedHelpSessionRequest): string[] {
  const conversation = request.conversation ?? [];
  const userTexts = conversation
    .filter((item) => item.role === 'user')
    .map((item) => item.text)
    .filter((text) => typeof text === 'string');

  const joined = userTexts.join(' ').toLowerCase();
  const reasons: string[] = [];

  const lowSignalTokens = ['idk', "i don't know", "don't know", 'n/a', 'nothing', 'fine'];
  if (joined && lowSignalTokens.some((token) => joined.includes(token))) {
    reasons.push('answers contain low-signal phrases like "idk" or "n/a"');
  }

  const totalWords = joined ? joined.split(/\s+/).filter(Boolean).length : 0;
  if (totalWords > 0 && totalWords < 10) {
    reasons.push('very short answers overall');
  }

  return reasons;
}

function getCoveredFieldsFromConversation(request: GuidedHelpSessionRequest): Set<FieldName> {
  const covered = new Set<FieldName>();
  const conversation = request.conversation ?? [];
  for (const item of conversation) {
    if (item.role !== 'user') continue;
    const tags = item.fieldTags ?? [];
    for (const tag of tags) {
      if (tag === 'onset' || tag === 'location' || tag === 'severity' || tag === 'otherSymptoms') {
        covered.add(tag);
      }
    }
  }
  return covered;
}

function detectRedFlags(request: GuidedHelpSessionRequest): GuidedHelpSessionResponse['redFlags'] {
  const conversation = request.conversation ?? [];
  const seed = typeof request.seedNarrative === 'string' ? request.seedNarrative : '';
  const userTexts = conversation
    .filter((item) => item.role === 'user')
    .map((item) => item.text)
    .filter((text) => typeof text === 'string');

  const joined = `${seed} ${userTexts.join(' ')}`.toLowerCase();
  const flags: GuidedHelpSessionResponse['redFlags'] = [];

  if (joined.includes('chest pain') || joined.includes('pain in my chest')) {
    flags.push('chest_pain');
  }
  if (joined.includes('short of breath') || joined.includes('shortness of breath') || joined.includes("can't breathe")) {
    flags.push('shortness_of_breath');
  }
  if (joined.includes('sudden weakness') || joined.includes('suddenly weak') || joined.includes('confused') || joined.includes('confusion')) {
    flags.push('sudden_weakness_or_confusion');
  }
  if (joined.includes('bleeding a lot') || joined.includes('won\'t stop bleeding')) {
    flags.push('heavy_bleeding');
  }
  if (joined.includes('allergic reaction') || joined.includes('swollen lips') || joined.includes('swollen tongue')) {
    flags.push('severe_allergic_reaction');
  }
  if (
    joined.includes('suicidal') ||
    joined.includes('end my life') ||
    joined.includes('kill myself') ||
    joined.includes('don\'t want to live')
  ) {
    flags.push('suicidal_thoughts');
  }

  if (flags.length === 0) {
    return ['none'];
  }
  // De-duplicate while preserving order
  const uniqueFlags: GuidedHelpSessionResponse['redFlags'] = [];
  for (const flag of flags) {
    if (!uniqueFlags.includes(flag)) {
      uniqueFlags.push(flag);
    }
  }
  return uniqueFlags;
}

export function buildGuidedHelpStubResponse(
  request: GuidedHelpSessionRequest,
): GuidedHelpSessionResponse {
  const redFlags = detectRedFlags(request);
  const covered = getCoveredFieldsFromConversation(request);
  const base: GuidedHelpSessionResponse = {
    sessionId: request.sessionId,
    stepId: request.stepId,
    redFlags,
    proceedToSummary: false,
    needsStep6: false,
  };

  const step = request.stepId;
  const axisForStep = STEP_FIELDS[step];
  const missingFields: FieldName[] = axisForStep ? [axisForStep] : [];

  if (step === 'step1') {
    const qualityScore = computeQualityScore(request, covered.size);
    return {
      ...base,
      nextStepId: 'step2',
      question: 'When did this start?',
      rationale: 'establish onset and timing',
      missingFields,
      qualityScore,
    };
  }
  if (step === 'step2') {
    const qualityScore = computeQualityScore(request, covered.size);
    return {
      ...base,
      nextStepId: 'step3',
      question: 'Where in your body do you feel it?',
      rationale: 'understand the location of the symptom',
      missingFields,
      qualityScore,
    };
  }
  if (step === 'step3') {
    const qualityScore = computeQualityScore(request, covered.size);
    return {
      ...base,
      nextStepId: 'step4',
      question: 'On a scale from 1 to 10, how bad is it?',
      rationale: 'capture patient-reported severity',
      missingFields,
      qualityScore,
    };
  }
  if (step === 'step4') {
    const qualityScore = computeQualityScore(request, covered.size);
    return {
      ...base,
      nextStepId: 'step5',
      question: 'Are there any other symptoms, like cough, nausea, or shortness of breath?',
      rationale: 'collect other important symptoms',
      missingFields,
      qualityScore,
    };
  }
  // step5 or anything unexpected falls through here
  const qualityScore = computeQualityScore(request, covered.size);
  const lowSignalReasons = detectLowSignalReasons(request);
  const needsStep6 =
    covered.size < 2 || qualityScore <= 0.4 || lowSignalReasons.length > 0;
  const summarySource = (request.seedNarrative || '').trim();
  const safeSummary =
    summarySource && summarySource.length > 0
      ? summarySource.slice(0, 400)
      : 'I have a symptom and want to share a brief description.';
  const bullets: GuidedHelpSessionResponse['bullets'] | undefined = needsStep6
    ? undefined
    : ([
        ...(covered.has('onset') ? ['Onset provided.'] : []),
        ...(covered.has('location') ? ['Location provided.'] : []),
        ...(covered.has('severity') ? ['Severity provided.'] : []),
        ...(covered.has('otherSymptoms') ? ['Other symptoms provided.'] : []),
      ] as GuidedHelpSessionResponse['bullets']);
  const limitations = lowSignalReasons.slice(0, 8) as GuidedHelpSessionResponse['limitations'];

  return {
    ...base,
    question: 'Is there anything else you would like your clinician to know about this problem?',
    rationale: 'offer a final chance to add important detail',
    missingFields: [],
    proceedToSummary: !needsStep6,
    needsStep6,
    qualityScore,
    summary: needsStep6 ? undefined : safeSummary,
    bullets,
    limitations,
    confidence: qualityScore,
  };
}

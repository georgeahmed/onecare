import { useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import type { GuidedHelpSessionRequest, GuidedHelpSessionResponse } from '../lib/types';
import { requestGuidedHelpStep } from '../lib/api';
import { createCorrelationId } from '../lib/telemetry';
import { sanitizeMultilineText } from '../lib/security';
import Button from './ui/Button';

export interface GuidedHelpPanelProps {
  practiceId: string;
  patientId: string;
  narrative: string;
  locale?: string;
  onUseSummary?: (summary: string, mode: 'replace' | 'append') => void;
  onEditSummary?: (summary: string) => void;
}

type MessageRole = 'user' | 'assistant';

interface Message {
  id: string;
  role: MessageRole;
  text: string;
  fieldTag?: FieldTag;
}

type StepId = GuidedHelpSessionRequest['stepId'];
type FieldTag = 'onset' | 'location' | 'severity' | 'otherSymptoms';

const FIRST_STEP_ID: StepId = 'step1';
const MAX_GUIDED_HELP_TEXT = 800;

const createConversationItem = (
  role: MessageRole,
  text: string,
  sequence: number,
  fieldTag?: FieldTag,
): NonNullable<GuidedHelpSessionRequest['conversation']>[number] => {
  const item: NonNullable<GuidedHelpSessionRequest['conversation']>[number] = {
    role,
    text,
    createdAt: new Date().toISOString(),
    sequence,
  };
  if (fieldTag) {
    item.fieldTags = [fieldTag];
  }
  return item;
};

const getNextStepId = (current: StepId | undefined, response: GuidedHelpSessionResponse): StepId | null => {
  if (response.nextStepId) {
    return response.nextStepId;
  }
  switch (current) {
    case 'step1':
      return 'step2';
    case 'step2':
      return 'step3';
    case 'step3':
      return 'step4';
    case 'step4':
      return 'step5';
    default:
      return null;
  }
};

const getFieldTagForStep = (stepId: StepId | null): FieldTag | undefined => {
  switch (stepId) {
    case 'step1':
      return 'onset';
    case 'step2':
      return 'location';
    case 'step3':
      return 'severity';
    case 'step4':
      return 'otherSymptoms';
    default:
      return undefined;
  }
};

const createAssistantMessageId = (stepId: StepId): string =>
  `assistant-${stepId}-${createCorrelationId()}`;

const GuidedHelpPanel = ({
  practiceId,
  patientId,
  narrative,
  locale,
  onUseSummary,
  onEditSummary,
}: GuidedHelpPanelProps) => {
  const intl = useIntl();
  const [isOpen, setIsOpen] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [seedSignature, setSeedSignature] = useState<string | null>(null);
  const [currentStepId, setCurrentStepId] = useState<StepId | null>(null);
  const [nextStepId, setNextStepId] = useState<StepId | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [answer, setAnswer] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryBullets, setSummaryBullets] = useState<string[]>([]);
  const [isSummaryVisible, setIsSummaryVisible] = useState(false);
  const [canShowSummary, setCanShowSummary] = useState(false);
  const [needsFinalDetail, setNeedsFinalDetail] = useState(false);
  const [hasRedFlags, setHasRedFlags] = useState(false);
  const clientMeta = useMemo(() => {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : undefined;
    const tzOffsetMinutes = typeof Date !== 'undefined' ? -new Date().getTimezoneOffset() : undefined;
    return {
      userAgent: ua ? ua.slice(0, 512) : undefined,
      tzOffsetMinutes,
    };
  }, []);

  const hasNarrative = narrative.trim().length > 0;

  useEffect(() => {
    if (!isOpen) {
      setAnswer('');
      setHasError(false);
      setSummary(null);
      setSummaryBullets([]);
      setCurrentStepId(null);
      setNextStepId(null);
      setIsSummaryVisible(false);
      setCanShowSummary(false);
      setNeedsFinalDetail(false);
      setHasRedFlags(false);
    }
  }, [isOpen]);

  const handleStart = async () => {
    if (!practiceId || !patientId) {
      setHasError(true);
      return;
    }
    setIsOpen(true);
    setHasError(false);
    setIsLoading(true);
    setHasRedFlags(false);
    setCanShowSummary(false);
    setNeedsFinalDetail(false);
    setSummary(null);
    setSummaryBullets([]);
    setIsSummaryVisible(false);
    setAnswer('');

    const rawSeedNarrative = hasNarrative
      ? narrative.trim()
      : intl.formatMessage({
          id: 'intake.guidedHelp.emptyNarrative',
          defaultMessage: 'I need help describing my symptoms.',
        });
    const seedNarrative = sanitizeMultilineText(rawSeedNarrative, MAX_GUIDED_HELP_TEXT) || rawSeedNarrative;
    const seedChanged = seedSignature !== seedNarrative;
    const newSessionId = !sessionId || seedChanged ? createCorrelationId() : sessionId;
    setSessionId(newSessionId);
    setSeedSignature(seedNarrative);

    const baseMessages: Message[] = [
      {
        id: 'seed',
        role: 'user',
        text: seedNarrative,
      },
    ];

    setMessages(baseMessages);

    const payload: GuidedHelpSessionRequest = {
      practiceId,
      patientId,
      sessionId: newSessionId,
      stepId: FIRST_STEP_ID,
      locale,
      seedNarrative,
      conversation: [createConversationItem('user', seedNarrative, 0)],
      clientMeta,
      flags: { fromSummaryButton: false },
    };

    try {
      const { data } = await requestGuidedHelpStep(payload, { locale });
      const nextMessages: Message[] = [
        ...baseMessages,
        ...(data.question
          ? [
              {
                id: createAssistantMessageId(data.stepId),
                role: 'assistant',
                text: data.question,
              } satisfies Message,
            ]
          : []),
      ];
      setMessages(nextMessages);
      setCurrentStepId(data.stepId);
      setNextStepId(getNextStepId(data.stepId, data));
      setHasError(false);
      const flagged =
        Array.isArray(data.redFlags) &&
        data.redFlags.some((value) => value && value !== 'none');
      if (flagged) {
        setHasRedFlags(true);
        setNextStepId(null);
      }
      if (data.summary) {
        setSummary(data.summary);
      }
      if (Array.isArray(data.bullets)) {
        setSummaryBullets(data.bullets);
      }
      const shouldShowSummary = Boolean(data.proceedToSummary) && !flagged;
      setCanShowSummary(shouldShowSummary);
      if (shouldShowSummary) {
        setNextStepId(null);
      }
      setNeedsFinalDetail(Boolean(data.needsStep6));
    } catch {
      setHasError(true);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmitAnswer = async () => {
    if (!sessionId || !practiceId || !patientId) {
      return;
    }
    const trimmed = answer.trim();
    const sanitizedAnswer = sanitizeMultilineText(trimmed, MAX_GUIDED_HELP_TEXT);
    if (!sanitizedAnswer) {
      return;
    }
    setIsLoading(true);
    setHasError(false);
    setAnswer('');

    const stepId: StepId = currentStepId ?? FIRST_STEP_ID;
    const fieldTag = getFieldTagForStep(stepId);

    const existingConversation = messages.map((msg, index) =>
      createConversationItem(msg.role, msg.text, index, msg.fieldTag),
    );

    const userMessage: Message = {
      id: `user-${Date.now().toString(36)}`,
      role: 'user',
      text: sanitizedAnswer,
      fieldTag,
    };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);

    const payload: GuidedHelpSessionRequest = {
      practiceId,
      patientId,
      sessionId,
      stepId,
      locale,
      conversation: [
        ...existingConversation,
        createConversationItem('user', sanitizedAnswer, existingConversation.length, fieldTag),
      ],
      clientMeta,
      flags: { fromSummaryButton: false },
    };

    try {
      const { data } = await requestGuidedHelpStep(payload, { locale });
      const followUpMessages: Message[] = [
        ...updatedMessages,
        ...(data.question
          ? [
              {
                id: createAssistantMessageId(data.stepId),
                role: 'assistant',
                text: data.question,
              } satisfies Message,
            ]
          : []),
      ];
      setMessages(followUpMessages);
      setCurrentStepId(data.stepId);
      setNextStepId(getNextStepId(data.stepId, data));
      setHasError(false);
      const flagged =
        Array.isArray(data.redFlags) &&
        data.redFlags.some((value) => value && value !== 'none');
      if (flagged) {
        setHasRedFlags(true);
        setNextStepId(null);
      }
      if (data.summary) {
        setSummary(data.summary);
      }
      if (Array.isArray(data.bullets)) {
        setSummaryBullets(data.bullets);
      }
      const shouldShowSummary = Boolean(data.proceedToSummary) && !flagged;
      setCanShowSummary(shouldShowSummary);
      if (shouldShowSummary) {
        setNextStepId(null);
      }
      setNeedsFinalDetail(Boolean(data.needsStep6));
    } catch {
      setHasError(true);
    } finally {
      setIsLoading(false);
    }
  };

  const isInputLocked = isLoading || hasRedFlags || canShowSummary;
  const canSubmit = useMemo(() => {
    const sanitized = sanitizeMultilineText(answer.trim(), MAX_GUIDED_HELP_TEXT);
    return !isInputLocked && Boolean(sanitized);
  }, [isInputLocked, answer]);

  if (!isOpen) {
    return (
      <div className="guided-help guided-help--collapsed">
        <p className="guided-help__label">
          {intl.formatMessage({
            id: 'intake.guidedHelp.label',
            defaultMessage: 'Need help describing this?',
          })}
        </p>
        <p className="guided-help__hint">
          {intl.formatMessage({
            id: 'intake.guidedHelp.hint',
            defaultMessage:
              'We can ask a few quick questions and suggest a clearer description for your clinician.',
          })}
        </p>
        <Button
          type="button"
          variant="subtle"
          className="guided-help__start"
          onClick={handleStart}
          disabled={isLoading}
        >
          {intl.formatMessage({
            id: 'intake.guidedHelp.start',
            defaultMessage: 'Start guided help',
          })}
        </Button>
        {hasError ? (
          <p className="guided-help__error">
            {intl.formatMessage({
              id: 'intake.guidedHelp.error',
              defaultMessage: 'We could not start guided help. Please try again in a moment.',
            })}
          </p>
        ) : null}
        {hasRedFlags ? (
          <p className="guided-help__alert" role="alert">
            {intl.formatMessage({
              id: 'intake.guidedHelp.redFlag',
              defaultMessage:
                'Your answers suggest you may need urgent help. If you think this is an emergency, please contact local emergency services or call 999/911 now.',
            })}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <aside className="guided-help guided-help--expanded" aria-label={intl.formatMessage({
      id: 'intake.guidedHelp.ariaLabel',
      defaultMessage: 'Guided help describing your symptoms',
    })}>
      <header className="guided-help__header">
        <div className="guided-help__title">
          <span aria-hidden="true">💡</span>
          <span>
            {intl.formatMessage({
              id: 'intake.guidedHelp.title',
              defaultMessage: 'Guided help',
            })}
          </span>
        </div>
        <Button
          type="button"
          variant="subtle"
          className="guided-help__close"
          onClick={() => setIsOpen(false)}
        >
          {intl.formatMessage({ id: 'intake.guidedHelp.close', defaultMessage: 'Close' })}
        </Button>
      </header>

      <div className="guided-help__body">
        {hasRedFlags ? (
          <p className="guided-help__alert" role="alert">
            {intl.formatMessage({
              id: 'intake.guidedHelp.redFlag',
              defaultMessage:
                'Your answers suggest you may need urgent help. If you think this is an emergency, please contact local emergency services or call 999/911 now.',
            })}
          </p>
        ) : null}
        <div className="guided-help__messages" aria-live="polite">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={
                msg.role === 'assistant'
                  ? 'guided-help__message guided-help__message--assistant'
                  : 'guided-help__message guided-help__message--user'
              }
            >
              <p>{msg.text}</p>
            </div>
          ))}
          {isLoading ? (
            <div className="guided-help__message guided-help__message--assistant">
              <p>
                {intl.formatMessage({
                  id: 'intake.guidedHelp.loading',
                  defaultMessage: 'Thinking…',
                })}
              </p>
            </div>
          ) : null}
        </div>

        <div
          className="guided-help__input"
          role="form"
          aria-label={intl.formatMessage({
            id: 'intake.guidedHelp.answerForm',
            defaultMessage: 'Answer the next guided help question',
          })}
        >
          <label className="guided-help__input-label" htmlFor="guided-help-answer">
            {intl.formatMessage({
              id: 'intake.guidedHelp.answerLabel',
              defaultMessage: 'You',
            })}
          </label>
          <textarea
            id="guided-help-answer"
            className="guided-help__textarea"
            rows={3}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            disabled={isInputLocked}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                if (canSubmit) {
                  void handleSubmitAnswer();
                }
              }
            }}
          />
          <Button
            type="button"
            variant="primary"
            disabled={!canSubmit}
            onClick={() => {
              if (canSubmit) {
                void handleSubmitAnswer();
              }
            }}
          >
            {intl.formatMessage({
              id: 'intake.guidedHelp.next',
              defaultMessage: 'Next question',
            })}
          </Button>
        </div>

        {hasError ? (
          <p className="guided-help__error">
            {intl.formatMessage({
              id: 'intake.guidedHelp.error',
              defaultMessage: 'We could not continue guided help. Please try again in a moment.',
            })}
          </p>
        ) : null}
        {needsFinalDetail && !canShowSummary ? (
          <p className="guided-help__note">
            {intl.formatMessage({
              id: 'intake.guidedHelp.finalDetail',
              defaultMessage:
                'We still need a little more detail so your clinician can understand your main concern.',
            })}
          </p>
        ) : null}
        {summary && canShowSummary ? (
          <section className="guided-help__summary">
            {!isSummaryVisible ? (
              <Button
                type="button"
                variant="subtle"
                onClick={() => setIsSummaryVisible(true)}
              >
                {intl.formatMessage({
                  id: 'intake.guidedHelp.summary.generate',
                  defaultMessage: 'Generate summary',
                })}
              </Button>
            ) : (
              <>
                <h4>
                  {intl.formatMessage({
                    id: 'intake.guidedHelp.summary.title',
                    defaultMessage: 'Suggested description',
                  })}
                </h4>
                <p className="guided-help__summary-text">{summary}</p>
                {summaryBullets.length > 0 ? (
                  <ul className="guided-help__summary-list">
                    {summaryBullets.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : null}
                <div className="guided-help__summary-actions">
                  {onUseSummary ? (
                    <Button
                      type="button"
                      variant="primary"
                      onClick={() => onUseSummary(summary, 'replace')}
                    >
                      {intl.formatMessage({
                        id: 'intake.guidedHelp.summary.use',
                        defaultMessage: 'Use this as my description',
                      })}
                    </Button>
                  ) : null}
                  {onEditSummary ? (
                    <Button
                      type="button"
                      variant="subtle"
                      onClick={() => onEditSummary(summary)}
                    >
                      {intl.formatMessage({
                        id: 'intake.guidedHelp.summary.edit',
                        defaultMessage: 'Edit before using',
                      })}
                    </Button>
                  ) : null}
                </div>
              </>
            )}
          </section>
        ) : null}
      </div>
    </aside>
  );
};

export default GuidedHelpPanel;

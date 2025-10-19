import { useIntl } from 'react-intl';
import type { IntakeWizardStep } from '../application/wizard/intakeWizard';

export interface StepIndicatorProps {
  steps: IntakeWizardStep[];
  currentStepId: string;
  onStepSelect?: (stepId: string) => void;
}

const StepIndicator = ({ steps, currentStepId, onStepSelect }: StepIndicatorProps) => {
  const intl = useIntl();

  return (
    <nav
      aria-label={intl.formatMessage({ id: 'intake.wizard.progress.label' })}
      className="wizard-progress"
    >
      <ol>
        {steps.map((step, index) => {
          const isCurrent = step.id === currentStepId;
          const isComplete = steps.findIndex(({ id }) => id === currentStepId) > index;
          const canNavigate =
            typeof onStepSelect === 'function' && (isComplete || isCurrent);

          return (
            <li
              key={step.id}
              className={[
                'wizard-progress__step',
                isCurrent ? 'wizard-progress__step--current' : '',
                isComplete ? 'wizard-progress__step--complete' : ''
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <span className="wizard-progress__index" aria-hidden="true">
                {index + 1}
              </span>
              {canNavigate ? (
                <button
                  type="button"
                  onClick={() => onStepSelect(step.id)}
                  aria-current={isCurrent ? 'step' : undefined}
                >
                  <span className="wizard-progress__title">
                    {intl.formatMessage({ id: step.titleId })}
                  </span>
                  {step.optional ? (
                    <span className="wizard-progress__optional">
                      {intl.formatMessage({ id: 'intake.wizard.step.optionalBadge' })}
                    </span>
                  ) : null}
                </button>
              ) : (
                <span
                  className="wizard-progress__label"
                  aria-current={isCurrent ? 'step' : undefined}
                >
                  <span className="wizard-progress__title">
                    {intl.formatMessage({ id: step.titleId })}
                  </span>
                  {step.optional ? (
                    <span className="wizard-progress__optional">
                      {intl.formatMessage({ id: 'intake.wizard.step.optionalBadge' })}
                    </span>
                  ) : null}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
};

export default StepIndicator;

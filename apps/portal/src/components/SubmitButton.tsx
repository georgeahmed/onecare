import type { ReactNode } from 'react';
import { useIntl } from 'react-intl';

export interface SubmitButtonProps {
  disabled?: boolean;
  children?: ReactNode;
}

const SubmitButton = ({ disabled, children }: SubmitButtonProps) => {
  const intl = useIntl();
  return (
    <button type="submit" disabled={disabled} aria-live="polite">
      {disabled ? intl.formatMessage({ id: 'intake.submitting' }) : children ?? intl.formatMessage({ id: 'intake.submit' })}
    </button>
  );
};

export default SubmitButton;

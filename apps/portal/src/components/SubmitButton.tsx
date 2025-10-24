import type { ReactNode } from 'react';
import { useIntl } from 'react-intl';
import Button from './ui/Button';

export interface SubmitButtonProps {
  disabled?: boolean;
  children?: ReactNode;
}

const SubmitButton = ({ disabled, children }: SubmitButtonProps) => {
  const intl = useIntl();
  return (
    <Button type="submit" disabled={disabled}>
      <span aria-live="polite" aria-atomic="true">
        {disabled
          ? intl.formatMessage({ id: 'intake.submitting' })
          : children ?? intl.formatMessage({ id: 'intake.submit' })}
      </span>
    </Button>
  );
};

export default SubmitButton;

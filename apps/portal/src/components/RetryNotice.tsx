import { useIntl } from 'react-intl';
import Button from './ui/Button';

export interface RetryNoticeProps {
  attempts: number;
  maxRetries: number;
  onCancel?: () => void;
}

const RetryNotice = ({ attempts, maxRetries, onCancel }: RetryNoticeProps) => {
  const intl = useIntl();
  if (attempts <= 0) return null;
  return (
    <div role="status" aria-live="polite" className="retry-notice">
      <p>{intl.formatMessage({ id: 'retry.notice' }, { attempts, maxRetries })}</p>
      {onCancel ? (
        <Button type="button" variant="subtle" onClick={onCancel}>
          {intl.formatMessage({ id: 'retry.cancel' })}
        </Button>
      ) : null}
    </div>
  );
};

export default RetryNotice;

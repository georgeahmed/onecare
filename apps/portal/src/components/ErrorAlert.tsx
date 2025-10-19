import { useEffect, useMemo, useRef } from 'react';
import { useIntl } from 'react-intl';
import type { ErrorEnvelope } from '../lib/types';
import Alert from './ui/Alert';
import Button from './ui/Button';
import { classNames } from '../lib/classNames';

type ErrorCode = ErrorEnvelope['error']['code'];

const ERROR_MESSAGE_IDS: Record<ErrorCode, { titleId: string; descriptionId: string }> = {
  unauthorized: {
    titleId: 'error.title.unauthorized',
    descriptionId: 'error.description.unauthorized'
  },
  forbidden: {
    titleId: 'error.title.forbidden',
    descriptionId: 'error.description.forbidden'
  },
  invalid_input: {
    titleId: 'error.title.invalid_input',
    descriptionId: 'error.description.invalid_input'
  },
  not_found: {
    titleId: 'error.title.not_found',
    descriptionId: 'error.description.not_found'
  },
  unsupported_media_type: {
    titleId: 'error.title.unsupported_media_type',
    descriptionId: 'error.description.unsupported_media_type'
  },
  payload_too_large: {
    titleId: 'error.title.payload_too_large',
    descriptionId: 'error.description.payload_too_large'
  },
  conflict: {
    titleId: 'error.title.conflict',
    descriptionId: 'error.description.conflict'
  },
  too_many_requests: {
    titleId: 'error.title.too_many_requests',
    descriptionId: 'error.description.too_many_requests'
  },
  rate_limited: {
    titleId: 'error.title.rate_limited',
    descriptionId: 'error.description.rate_limited'
  },
  upstream_timeout: {
    titleId: 'error.title.upstream_timeout',
    descriptionId: 'error.description.upstream_timeout'
  },
  upstream_unavailable: {
    titleId: 'error.title.upstream_unavailable',
    descriptionId: 'error.description.upstream_unavailable'
  },
  busy: {
    titleId: 'error.title.busy',
    descriptionId: 'error.description.busy'
  },
  over_capacity: {
    titleId: 'error.title.over_capacity',
    descriptionId: 'error.description.over_capacity'
  },
  invalid_fhir: {
    titleId: 'error.title.invalid_fhir',
    descriptionId: 'error.description.invalid_fhir'
  },
  internal_error: {
    titleId: 'error.title.internal_error',
    descriptionId: 'error.description.internal_error'
  }
};

export interface ErrorAlertProps {
  error?: ErrorEnvelope | null;
  onRetry?: () => void;
  supportUrl?: string;
  className?: string;
  id?: string;
  autoFocus?: boolean;
}

const DEFAULT_SUPPORT_URL = 'mailto:support@onecare.example';

const ErrorAlert = ({
  error,
  onRetry,
  supportUrl,
  className,
  id,
  autoFocus = true
}: ErrorAlertProps) => {
  const intl = useIntl();
  const containerRef = useRef<HTMLElement>(null);

  const normalized = useMemo(() => {
    if (!error) return null;
    const envelope = error;
    const codeRaw = envelope.error?.code ?? 'internal_error';
    const normalizedCode = (typeof codeRaw === 'string' ? codeRaw.toLowerCase() : 'internal_error') as ErrorCode;
    const mapping = ERROR_MESSAGE_IDS[normalizedCode] ?? ERROR_MESSAGE_IDS.internal_error;

    const title = intl.formatMessage({ id: mapping.titleId });
    const fallbackDescription = intl.formatMessage({ id: mapping.descriptionId });
    const description = mapping === ERROR_MESSAGE_IDS.internal_error && envelope.error?.message
      ? envelope.error.message
      : fallbackDescription;

    return {
      title,
      description,
      correlationId: envelope.error?.correlationId,
      code: codeRaw
    };
  }, [error, intl]);

  useEffect(() => {
    if (!autoFocus || !normalized) return;
    const node = containerRef.current;
    if (!node) return;
    if (typeof node.focus === 'function') {
      node.focus();
    }
  }, [normalized, autoFocus]);

  if (!normalized) {
    return null;
  }

  return (
    <Alert
      variant="error"
      title={normalized.title}
      className={classNames('error-alert', className)}
      id={id}
      ref={containerRef}
      role="alert"
      tabIndex={-1}
      aria-live="assertive"
    >
      <p>{normalized.description}</p>
      {normalized.correlationId ? (
        <p>
          {intl.formatMessage({ id: 'error.supportReference' })}: <code>{normalized.correlationId}</code>
        </p>
      ) : null}
      <div>
        {onRetry ? (
          <Button type="button" variant="subtle" onClick={onRetry}>
            {intl.formatMessage({ id: 'error.retry' })}
          </Button>
        ) : null}
        <a href={supportUrl ?? DEFAULT_SUPPORT_URL}>{intl.formatMessage({ id: 'error.contactSupport' })}</a>
      </div>
    </Alert>
  );
};

export default ErrorAlert;

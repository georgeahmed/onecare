import { useEffect, useMemo, useRef } from 'react';
import { useIntl } from 'react-intl';
import type { ErrorEnvelope } from '../lib/types';

type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'invalid_input'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'conflict'
  | 'upstream_timeout'
  | 'upstream_unavailable'
  | 'too_many_requests'
  | 'busy'
  | 'invalid_fhir'
  | 'internal_error';

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
      correlationId: envelope.correlationId,
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

  const combinedClassName = ['error-alert', className].filter(Boolean).join(' ');

  return (
    <section
      id={id}
      ref={containerRef}
      role="alert"
      tabIndex={-1}
      aria-live="assertive"
      className={combinedClassName}
    >
      <h2>{normalized.title}</h2>
      <p>{normalized.description}</p>
      {normalized.correlationId ? (
        <p>
          {intl.formatMessage({ id: 'error.supportReference' })}: <code>{normalized.correlationId}</code>
        </p>
      ) : null}
      <div>
        {onRetry ? (
          <button type="button" onClick={onRetry}>
            {intl.formatMessage({ id: 'error.retry' })}
          </button>
        ) : null}
        <a href={supportUrl ?? DEFAULT_SUPPORT_URL}>{intl.formatMessage({ id: 'error.contactSupport' })}</a>
      </div>
    </section>
  );
};

export default ErrorAlert;

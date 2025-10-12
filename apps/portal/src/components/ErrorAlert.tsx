import { useEffect, useMemo, useRef } from 'react';
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

const COPY: Record<ErrorCode, { title: string; description: string }> = {
  unauthorized: {
    title: 'Sign-in required',
    description: 'Your session expired or was missing. Please sign in again and resubmit the request.'
  },
  forbidden: {
    title: 'Request not permitted',
    description: 'We cannot process this request for security reasons. Contact support if you believe this is an error.'
  },
  invalid_input: {
    title: 'Check the highlighted details',
    description: 'Some information looks incomplete or invalid. Review the form and try again.'
  },
  unsupported_media_type: {
    title: 'Unsupported format',
    description: 'The submitted file or content type is not supported. Use the recommended format and retry.'
  },
  payload_too_large: {
    title: 'Attachment too large',
    description: 'One or more files exceed the allowed size. Remove large attachments and submit again.'
  },
  conflict: {
    title: 'Already submitted',
    description: 'This request appears to have been sent already. If you need to raise it again, contact support.'
  },
  too_many_requests: {
    title: 'We are receiving a lot of requests',
    description: 'Please wait a moment before trying again.'
  },
  upstream_timeout: {
    title: 'Timed out waiting for a response',
    description: 'It took too long to reach our services. Try again shortly.'
  },
  upstream_unavailable: {
    title: 'Service temporarily unavailable',
    description: 'We cannot complete the request right now. Try again in a few moments.'
  },
  busy: {
    title: 'Please try again soon',
    description: 'We are handling a high volume of requests. Wait a moment and resubmit.'
  },
  invalid_fhir: {
    title: 'Information needs review',
    description: 'Some clinical details could not be validated. Update the information and try again.'
  },
  internal_error: {
    title: 'We hit a snag',
    description: 'Something unexpected happened. Try the request again or reach out to support.'
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
  const containerRef = useRef<HTMLElement>(null);

  const normalized = useMemo(() => {
    if (!error) return null;
    const envelope = error;
    const codeRaw = envelope.error?.code ?? 'internal_error';
    const normalizedCode = typeof codeRaw === 'string' ? codeRaw.toLowerCase() : 'internal_error';
    const copy = COPY[normalizedCode as ErrorCode] ?? null;
    const fallbackMessage =
      envelope.error?.message && typeof envelope.error.message === 'string'
        ? envelope.error.message
        : COPY.internal_error.description;

    return {
      title: (copy ?? COPY.internal_error).title,
      description: copy ? copy.description : fallbackMessage,
      fallbackMessage,
      correlationId: envelope.correlationId,
      code: codeRaw
    };
  }, [error]);

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
          Support reference: <code>{normalized.correlationId}</code>
        </p>
      ) : null}
      <div>
        {onRetry ? (
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        ) : null}
        <a href={supportUrl ?? DEFAULT_SUPPORT_URL}>Contact support</a>
      </div>
    </section>
  );
};

export default ErrorAlert;

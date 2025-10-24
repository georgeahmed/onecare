import { useEffect, useMemo, useState } from 'react';
import type { ClinicianTaskDetail } from '@onecare/events';
import { useIntl } from 'react-intl';
import useAuth from '../hooks/useAuth';

interface CaseHeaderProps {
  detail: ClinicianTaskDetail;
}

const CaseHeader = ({ detail }: CaseHeaderProps) => {
  const intl = useIntl();
  const { session } = useAuth();
  const [copyStatus, setCopyStatus] = useState<string>('');

  const clinicName = useMemo(() => {
    return session?.clinics.find((clinic) => clinic.id === detail.clinicId)?.name ?? detail.clinicId;
  }, [session?.clinics, detail.clinicId]);

  useEffect(() => {
    if (!copyStatus) return;
    const timeout = window.setTimeout(() => setCopyStatus(''), 3000);
    return () => window.clearTimeout(timeout);
  }, [copyStatus]);

  const copyCorrelation = async () => {
    try {
      await navigator.clipboard.writeText(detail.correlationId ?? '');
      setCopyStatus(intl.formatMessage({ id: 'case.correlation.copied' }));
    } catch {
      setCopyStatus(intl.formatMessage({ id: 'case.correlation.copyError' }));
    }
  };

  const waitLabel = intl.formatMessage(
    { id: 'queue.wait.minutes' },
    { minutes: Math.max(0, Math.round(detail.waitMs / 60000)) }
  );

  const priorityLabel = intl.formatMessage({
    id: `queue.priority.${detail.priority.toLowerCase() as 'stat' | 'urgent' | 'soon' | 'routine'}`
  });

  const interpreterLabel = useMemo(() => {
    if (!detail.interpreter) {
      return intl.formatMessage({ id: 'queue.interpreter.none' });
    }
    if (typeof Intl.DisplayNames === 'function') {
      try {
        const display = new Intl.DisplayNames([intl.locale], { type: 'language' });
        return display.of(detail.interpreter) ?? detail.interpreter;
      } catch {
        return detail.interpreter;
      }
    }
    return detail.interpreter;
  }, [detail.interpreter, intl]);

  return (
    <header className="case-header" aria-labelledby="case-heading">
      <div className="case-header__meta">
        <span
          className={`priority-badge priority-badge--${detail.priority.toLowerCase()}`}
          aria-label={priorityLabel}
        >
          {priorityLabel}
        </span>
        <span className="case-header__wait" aria-label={waitLabel}>
          {waitLabel}
        </span>
        <span className="case-header__clinic">{clinicName}</span>
      </div>
      <div className="case-header__correlation">
        <span>{intl.formatMessage({ id: 'case.field.correlation' })}</span>
        <code>{detail.correlationId ?? '—'}</code>
        {detail.correlationId ? (
          <button type="button" className="ui-button ui-button--subtle" onClick={copyCorrelation}>
            {intl.formatMessage({ id: 'case.correlation.copy' })}
          </button>
        ) : null}
      </div>
      <div className="case-header__narrative">
        <h2>{intl.formatMessage({ id: 'case.narrative.title' })}</h2>
        <p>{detail.narrative || intl.formatMessage({ id: 'case.narrative.empty' })}</p>
      </div>
      <div className="case-header__chips" aria-label={intl.formatMessage({ id: 'case.interpreter.label' })}>
        <span className="case-chip">{interpreterLabel}</span>
      </div>
      <div className="visually-hidden" aria-live="polite">
        {copyStatus}
      </div>
    </header>
  );
};

export default CaseHeader;

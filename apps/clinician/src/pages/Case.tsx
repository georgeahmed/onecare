import { useParams } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import type { ClinicianTaskDetail } from '@onecare/events/src/contracts/clinician-task-detail';
import { queueGateway } from '../adapters/gateway';
import { useIntl } from 'react-intl';
import CaseHeader from '../components/CaseHeader';
import ActionBar from '../components/ActionBar';

const CasePage = () => {
  const { id } = useParams();
  const intl = useIntl();
  const [detail, setDetail] = useState<ClinicianTaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [resolveOutcome, setResolveOutcome] = useState('callback_scheduled');
  const [scheduleWhen, setScheduleWhen] = useState('');
  const liveRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    queueGateway.current
      .getById(id)
      .then((res) => {
        if (!cancelled) {
          setDetail(res);
          setError(null);
        }
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const announce = (msg: string) => {
    const node = liveRef.current;
    if (!node) return;
    node.textContent = msg;
  };

  const setErrorMessage = (message: string) => {
    setError(message);
    if (message && liveRef.current) {
      liveRef.current.textContent = message;
    }
  };

  const clearError = () => setError(null);

  const handleResolve = async () => {
    if (!id) {
      setErrorMessage(intl.formatMessage({ id: 'case.error.missingId' }));
      return;
    }
    try {
      const updated = await queueGateway.current.resolve(id, resolveOutcome, note.trim() || undefined);
      setDetail(updated);
      setNote('');
      clearError();
      announce(intl.formatMessage({ id: 'case.status.updated' }));
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSchedule = async () => {
    if (!id) {
      setErrorMessage(intl.formatMessage({ id: 'case.error.missingId' }));
      return;
    }
    if (!scheduleWhen) {
      setErrorMessage(intl.formatMessage({ id: 'case.error.scheduleMissing' }));
      return;
    }
    try {
      const updated = await queueGateway.current.scheduleCallback(id, scheduleWhen, note.trim() || undefined);
      setDetail(updated);
      setNote('');
      clearError();
      announce(intl.formatMessage({ id: 'case.status.updated' }));
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const handleBook = async () => {
    if (!id) {
      setErrorMessage(intl.formatMessage({ id: 'case.error.missingId' }));
      return;
    }
    try {
      const updated = await queueGateway.current.bookSlot(id, 'mock-slot');
      setDetail(updated);
      clearError();
      announce(intl.formatMessage({ id: 'case.status.updated' }));
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const handleEscalate = async () => {
    if (!detail) return;
    const audit = [
      ...(detail.audit ?? []),
      { when: new Date().toISOString(), who: 'me', what: 'escalate:mock' }
    ];
    setDetail({ ...detail, audit });
  };

  const handleCall = async () => {
    if (!detail) return;
    const audit = [
      ...(detail.audit ?? []),
      { when: new Date().toISOString(), who: 'me', what: 'call:initiated' }
    ];
    setDetail({ ...detail, audit });
  };

  if (loading) return <p role="status">{intl.formatMessage({ id: 'loading' })}</p>;
  if (error && !detail) return <p role="alert">{error || intl.formatMessage({ id: 'error.generic' })}</p>;
  if (!detail) return <p role="alert">{intl.formatMessage({ id: 'case.error.notFound' })}</p>;

  return (
    <section className="case-page">
      <h1 id="case-heading">{intl.formatMessage({ id: 'case.title' }, { id: detail.id })}</h1>
      <p className="case-subtitle">{intl.formatMessage({ id: 'case.subtitle' })}</p>

      <CaseHeader detail={detail} />

      <ActionBar
        detail={detail}
        onCall={handleCall}
        onSchedule={handleSchedule}
        onBook={handleBook}
        onEscalate={handleEscalate}
        onResolve={handleResolve}
        onError={setErrorMessage}
        onSuccess={announce}
      />

      <div className="case-forms">
        <label>
          {intl.formatMessage({ id: 'case.schedule.when' })}
          <input
            type="datetime-local"
            className="ui-select"
            value={scheduleWhen}
            onChange={(e) => setScheduleWhen(e.target.value)}
          />
        </label>
        <label>
          {intl.formatMessage({ id: 'case.resolve.outcome' })}
          <select
            className="ui-select"
            value={resolveOutcome}
            onChange={(e) => setResolveOutcome(e.target.value)}
          >
            <option value="callback_scheduled">{intl.formatMessage({ id: 'case.resolve.option.callback' })}</option>
            <option value="advised">{intl.formatMessage({ id: 'case.resolve.option.advised' })}</option>
            <option value="booked">{intl.formatMessage({ id: 'case.resolve.option.booked' })}</option>
          </select>
        </label>
        <label>
          {intl.formatMessage({ id: 'case.note.label' })}
          <textarea
            className="ui-textarea"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      </div>
      {error ? (
        <div role="alert" className="case-error">
          {error}
        </div>
      ) : null}
      <div aria-live="polite" role="status" ref={liveRef} className="visually-hidden" />
    </section>
  );
};

export default CasePage;

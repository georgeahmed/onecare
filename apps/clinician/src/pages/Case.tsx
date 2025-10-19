import { useParams } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import type { ClinicianTaskDetail } from '@onecare/events/src/contracts/clinician-task-detail';
import { queueGateway } from '../adapters/gateway';
import { useIntl } from 'react-intl';

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
    return () => { cancelled = true; };
  }, [id]);

  const announce = (msg: string) => {
    const node = liveRef.current;
    if (!node) return;
    node.textContent = msg;
  };

  const handleResolve = async () => {
    if (!id) return;
    try {
      const updated = await queueGateway.current.resolve(id, resolveOutcome, note.trim() || undefined);
      setDetail(updated);
      setNote('');
      announce(intl.formatMessage({ id: 'case.status.updated' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSchedule = async () => {
    if (!id || !scheduleWhen) return;
    try {
      const updated = await queueGateway.current.scheduleCallback(id, scheduleWhen, note.trim() || undefined);
      setDetail(updated);
      setNote('');
      announce(intl.formatMessage({ id: 'case.status.updated' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleAssign = async () => {
    if (!id) return;
    try {
      const updated = await queueGateway.current.assign(id, 'me');
      setDetail(updated);
      announce(intl.formatMessage({ id: 'case.status.updated' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleUnassign = async () => {
    if (!id) return;
    try {
      const updated = await queueGateway.current.unassign(id);
      setDetail(updated);
      setNote('');
      announce(intl.formatMessage({ id: 'case.status.updated' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (loading) return <p role="status">{intl.formatMessage({ id: 'loading' })}</p>;
  if (error) return <p role="alert">{error || intl.formatMessage({ id: 'error.generic' })}</p>;
  if (!detail) return <p role="alert">Not found</p>;

  return (
    <section>
      <header>
        <h1>{intl.formatMessage({ id: 'case.title' }, { id: detail.id })}</h1>
        <p>{intl.formatMessage({ id: 'case.subtitle' })}</p>
      </header>
      <div className="case-summary">
        <p><strong>{intl.formatMessage({ id: 'case.field.priority' })}:</strong> {detail.priority}</p>
        <p><strong>{intl.formatMessage({ id: 'case.field.waiting' })}:</strong> {(detail.waitMs / 60000) | 0}m</p>
        <p><strong>{intl.formatMessage({ id: 'case.field.interpreter' })}:</strong> {detail.interpreter ?? '—'}</p>
        <p><strong>{intl.formatMessage({ id: 'case.field.correlation' })}:</strong> {detail.correlationId}</p>
      </div>

      <h2>{intl.formatMessage({ id: 'case.actions.title' })}</h2>
      <div className="case-actions" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button className="ui-button">{intl.formatMessage({ id: 'case.action.call' })}</button>
        <button className="ui-button" onClick={handleSchedule}>{intl.formatMessage({ id: 'case.action.schedule' })}</button>
        <button className="ui-button" onClick={async () => { if (id) { try { const updated = await queueGateway.current.bookSlot(id, 'slot-123'); setDetail(updated); announce(intl.formatMessage({ id: 'case.status.updated' })); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } } }}>{intl.formatMessage({ id: 'case.action.book' })}</button>
        <button className="ui-button">{intl.formatMessage({ id: 'case.action.escalate' })}</button>
        <button className="ui-button" onClick={handleResolve}>{intl.formatMessage({ id: 'case.action.resolve' })}</button>
        <button className="ui-button" onClick={handleAssign}>Assign</button>
        <button className="ui-button" onClick={handleUnassign}>Unassign</button>
      </div>

      <div className="case-forms" style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '0.75rem', marginTop: '0.75rem' }}>
        <label>
          {intl.formatMessage({ id: 'case.schedule.when' })}
          <input type="datetime-local" className="ui-select" value={scheduleWhen} onChange={(e) => setScheduleWhen(e.target.value)} />
        </label>
        <label>
          {intl.formatMessage({ id: 'case.resolve.outcome' })}
          <select className="ui-select" value={resolveOutcome} onChange={(e) => setResolveOutcome(e.target.value)}>
            <option value="callback_scheduled">Callback scheduled</option>
            <option value="advised">Advised</option>
            <option value="booked">Booked</option>
          </select>
        </label>
        <label>
          {intl.formatMessage({ id: 'case.note.label' })}
          <textarea className="ui-textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div aria-live="polite" role="status" ref={liveRef} />
      </div>
    </section>
  );
};

export default CasePage;

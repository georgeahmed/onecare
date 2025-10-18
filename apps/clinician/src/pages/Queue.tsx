import { useEffect, useMemo, useState } from 'react';
import type { ClinicianTaskSummary } from '@onecare/events';
import { queueGateway } from '../adapters/gateway';
import { Link } from 'react-router-dom';
import { useIntl } from 'react-intl';

const QueuePage = () => {
  const [items, setItems] = useState<ClinicianTaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [priority, setPriority] = useState<string>('ALL');
  const [status, setStatus] = useState<string>('NEW');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    queueGateway.current
      .list({
        clinicId: 'demo',
        limit: 50,
        priority: priority === 'ALL' ? undefined : (priority as ClinicianTaskSummary['priority']),
        status: status as ClinicianTaskSummary['status']
      })
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setError(null);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [priority, status]);

  const intl = useIntl();
  return (
    <section>
      <header>
        <h1>{intl.formatMessage({ id: 'queue.title' })}</h1>
        <p>{intl.formatMessage({ id: 'queue.subtitle' })}</p>
      </header>
      <div className="queue-filters" role="region" aria-label="Filters">
        <label>
          {intl.formatMessage({ id: 'queue.filters.clinic' })}
          <select className="ui-select" defaultValue="demo">
            <option value="demo">My Clinic</option>
          </select>
        </label>
        <label>
          {intl.formatMessage({ id: 'queue.filters.priority' })}
          <select className="ui-select" value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="ALL">All</option>
            <option value="STAT">STAT</option>
            <option value="URGENT">Urgent</option>
            <option value="SOON">Soon</option>
            <option value="ROUTINE">Routine</option>
          </select>
        </label>
        <label>
          {intl.formatMessage({ id: 'queue.filters.status' })}
          <select className="ui-select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="NEW">New</option>
            <option value="IN_PROGRESS">In‑progress</option>
            <option value="DONE">Done</option>
          </select>
        </label>
      </div>
      {loading ? (
        <p role="status">Loading…</p>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : (
        <ul className="queue-list" role="list">
          {items.map((item) => (
            <li key={item.id} className="queue-row">
              <div>
                <strong>{item.priority}</strong> • {item.shortReason} • waiting {(item.waitMs / 60000) | 0}m
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                <Link to={`/case/${item.id}`} className="ui-button" aria-label={intl.formatMessage({ id: 'queue.action.open' })}>
                  {intl.formatMessage({ id: 'queue.action.open' })}
                </Link>
                <button
                  className="ui-button"
                  onClick={async () => {
                    try {
                      const updated = await queueGateway.current.assign(item.id, 'me');
                      setItems((prev) => prev.map((x) => (x.id === item.id ? { ...x, status: updated.status, assignee: updated.assignee } : x)));
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    }
                  }}
                >
                  {intl.formatMessage({ id: 'queue.action.assign' })}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

export default QueuePage;

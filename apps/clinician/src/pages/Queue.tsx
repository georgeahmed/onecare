import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ClinicianTaskSummary } from '@onecare/events';
import { queueGateway } from '../adapters/gateway';
import { Link } from 'react-router-dom';
import { useIntl } from 'react-intl';
import type { TaskPriority, TaskStatus } from '../adapters/queue.types';
import { QueueGatewayError } from '../adapters/queue.types';
import useAuth from '../hooks/useAuth';

type PriorityFilter = 'ALL' | TaskPriority;
type StatusFilter = 'ALL' | TaskStatus;
type OwnershipFilter = 'any' | 'mine' | 'unassigned';
type TimeFilter = 'any' | 'under15' | 'under60' | 'over60';

interface TimeThreshold {
  minInclusive?: number;
  maxExclusive?: number;
}

const timeThresholdMinutes: Record<TimeFilter, TimeThreshold> = {
  any: {},
  under15: { maxExclusive: 15 },
  under60: { minInclusive: 15, maxExclusive: 60 },
  over60: { minInclusive: 60 }
};

const QueuePage = () => {
  const intl = useIntl();
  const { session, activeClinicId, setActiveClinic } = useAuth();
  const clinics = session?.clinics ?? [];

  const [sourceItems, setSourceItems] = useState<ClinicianTaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [assigningId, setAssigningId] = useState<string | null>(null);

  const [priority, setPriority] = useState<PriorityFilter>('ALL');
  const [status, setStatus] = useState<StatusFilter>('NEW');
  const [ownership, setOwnership] = useState<OwnershipFilter>('any');
  const [timeRange, setTimeRange] = useState<TimeFilter>('any');

  useEffect(() => {
    if (!activeClinicId) {
      setSourceItems([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    queueGateway.current
      .list({
        clinicId: activeClinicId,
        limit: 100,
        priority: priority === 'ALL' ? undefined : priority,
        status: status === 'ALL' ? undefined : status
      })
      .then((res) => {
        if (cancelled) return;
        setSourceItems(res.items);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeClinicId, priority, session?.userId, status]);

  const filteredItems = useMemo(() => {
    const currentUserId = session?.userId;
    return sourceItems
      .filter((item) => {
        if (ownership === 'mine') {
          return item.assignee === currentUserId;
        }
        if (ownership === 'unassigned') {
          return !item.assignee;
        }
        return true;
      })
      .filter((item) => {
        const minutes = item.waitMs / 60000;
        const { minInclusive, maxExclusive } = timeThresholdMinutes[timeRange];
        if (typeof minInclusive === 'number' && minutes < minInclusive) return false;
        if (typeof maxExclusive === 'number' && minutes >= maxExclusive) return false;
        return true;
      })
      .sort((a, b) => b.waitMs - a.waitMs);
  }, [ownership, sourceItems, session?.userId, timeRange]);

  const priorityLabel = useCallback(
    (value: TaskPriority) =>
      intl.formatMessage({ id: `queue.priority.${value.toLowerCase() as Lowercase<TaskPriority>}` }),
    [intl]
  );

  const waitLabel = useCallback(
    (waitMs: number) =>
      intl.formatMessage({ id: 'queue.wait.minutes' }, { minutes: Math.max(0, Math.round(waitMs / 60000)) }),
    [intl]
  );

  const statusLabel = useCallback(
    (value: TaskStatus) =>
      intl.formatMessage({ id: `queue.status.${value.toLowerCase() as Lowercase<TaskStatus>}` }),
    [intl]
  );

  const formatInterpreter = useCallback(
    (language?: string) => {
      if (!language) {
        return intl.formatMessage({ id: 'queue.interpreter.none' });
      }
      if (typeof Intl.DisplayNames === 'function') {
        try {
          const display = new Intl.DisplayNames([intl.locale], { type: 'language' });
          return display.of(language) ?? language;
        } catch {
          return language;
        }
      }
      return language;
    },
    [intl]
  );

  const handleAssign = async (item: ClinicianTaskSummary) => {
    setAssigningId(item.id);
    try {
      const updated = await queueGateway.current.assign(item.id, session?.userId);
      setSourceItems((prev) =>
        prev.map((entry) =>
          entry.id === item.id
            ? { ...entry, assignee: updated.assignee, status: updated.status, waitMs: updated.waitMs }
            : entry
        )
      );
      setError(null);
      setAnnouncement(
        intl.formatMessage({ id: 'queue.announcement.assigned' }, { requestId: item.id, patientId: item.patientId })
      );
    } catch (err) {
      if (err instanceof QueueGatewayError) {
        const message = intl.formatMessage({ id: `queue.error.${err.code}` }, { correlationId: err.correlationId ?? '—' });
        setError(message);
      } else {
        const fallback = err instanceof Error ? err.message : String(err);
        setError(fallback);
      }
    } finally {
      setAssigningId(null);
    }
  };

  useEffect(() => {
    if (!announcement) return;
    const timeout = window.setTimeout(() => setAnnouncement(''), 5000);
    return () => window.clearTimeout(timeout);
  }, [announcement]);

  return (
    <section className="queue-page">
      <header className="queue-header">
        <h1>{intl.formatMessage({ id: 'queue.title' })}</h1>
        <p>{intl.formatMessage({ id: 'queue.subtitle' })}</p>
      </header>

      <section className="queue-toolbar" aria-label={intl.formatMessage({ id: 'queue.filters.region' })}>
        <fieldset className="queue-filter">
          <legend>{intl.formatMessage({ id: 'queue.filters.clinic' })}</legend>
          <select
            className="ui-select"
            value={activeClinicId ?? clinics[0]?.id ?? ''}
            onChange={(event) => setActiveClinic(event.target.value)}
            disabled={clinics.length === 0}
            aria-describedby={clinics.length === 0 ? 'queue-no-clinic' : undefined}
          >
            {clinics.map((clinic) => (
              <option key={clinic.id} value={clinic.id}>
                {clinic.name}
              </option>
            ))}
          </select>
          {clinics.length === 0 ? (
            <span id="queue-no-clinic" className="queue-filter__empty">
              {intl.formatMessage({ id: 'queue.filters.noClinic' })}
            </span>
          ) : null}
        </fieldset>

        <fieldset className="queue-filter">
          <legend>{intl.formatMessage({ id: 'queue.filters.priority' })}</legend>
          <select className="ui-select" value={priority} onChange={(event) => setPriority(event.target.value as PriorityFilter)}>
            <option value="ALL">{intl.formatMessage({ id: 'queue.filters.priority.all' })}</option>
            <option value="STAT">{priorityLabel('STAT')}</option>
            <option value="URGENT">{priorityLabel('URGENT')}</option>
            <option value="SOON">{priorityLabel('SOON')}</option>
            <option value="ROUTINE">{priorityLabel('ROUTINE')}</option>
          </select>
        </fieldset>

        <fieldset className="queue-filter">
          <legend>{intl.formatMessage({ id: 'queue.filters.status' })}</legend>
          <select className="ui-select" value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}>
            <option value="NEW">{statusLabel('NEW')}</option>
            <option value="IN_PROGRESS">{statusLabel('IN_PROGRESS')}</option>
            <option value="DONE">{statusLabel('DONE')}</option>
            <option value="ALL">{intl.formatMessage({ id: 'queue.filters.status.all' })}</option>
          </select>
        </fieldset>

        <fieldset className="queue-filter queue-filter--radio" role="group">
          <legend>{intl.formatMessage({ id: 'queue.filters.ownership' })}</legend>
          <label>
            <input
              type="radio"
              name="queue-ownership"
              value="any"
              checked={ownership === 'any'}
              onChange={() => setOwnership('any')}
            />
            {intl.formatMessage({ id: 'queue.filters.ownership.any' })}
          </label>
          <label>
            <input
              type="radio"
              name="queue-ownership"
              value="mine"
              checked={ownership === 'mine'}
              onChange={() => setOwnership('mine')}
            />
            {intl.formatMessage({ id: 'queue.filters.ownership.mine' })}
          </label>
          <label>
            <input
              type="radio"
              name="queue-ownership"
              value="unassigned"
              checked={ownership === 'unassigned'}
              onChange={() => setOwnership('unassigned')}
            />
            {intl.formatMessage({ id: 'queue.filters.ownership.unassigned' })}
          </label>
        </fieldset>

        <fieldset className="queue-filter queue-filter--radio" role="group">
          <legend>{intl.formatMessage({ id: 'queue.filters.time' })}</legend>
          <label>
            <input
              type="radio"
              name="queue-timerange"
              value="any"
              checked={timeRange === 'any'}
              onChange={() => setTimeRange('any')}
            />
            {intl.formatMessage({ id: 'queue.filters.time.any' })}
          </label>
          <label>
            <input
              type="radio"
              name="queue-timerange"
              value="under15"
              checked={timeRange === 'under15'}
              onChange={() => setTimeRange('under15')}
            />
            {intl.formatMessage({ id: 'queue.filters.time.under15' })}
          </label>
          <label>
            <input
              type="radio"
              name="queue-timerange"
              value="under60"
              checked={timeRange === 'under60'}
              onChange={() => setTimeRange('under60')}
            />
            {intl.formatMessage({ id: 'queue.filters.time.under60' })}
          </label>
          <label>
            <input
              type="radio"
              name="queue-timerange"
              value="over60"
              checked={timeRange === 'over60'}
              onChange={() => setTimeRange('over60')}
            />
            {intl.formatMessage({ id: 'queue.filters.time.over60' })}
          </label>
        </fieldset>
      </section>

      <div className="queue-announcement" aria-live="polite" role="status">
        {announcement}
      </div>
      {error ? (
        <div role="alert" className="queue-error">
          {error}
        </div>
      ) : null}

      {loading ? (
        <p role="status">{intl.formatMessage({ id: 'loading' })}</p>
      ) : filteredItems.length === 0 ? (
        <p role="status">{intl.formatMessage({ id: 'queue.empty' })}</p>
      ) : (
        <div className="queue-table-wrapper" role="region" aria-live="off">
          <table className="queue-table">
            <caption className="visually-hidden">{intl.formatMessage({ id: 'queue.title' })}</caption>
            <thead>
              <tr>
                <th scope="col">{intl.formatMessage({ id: 'queue.column.priority' })}</th>
                <th scope="col">{intl.formatMessage({ id: 'queue.column.reason' })}</th>
                <th scope="col">{intl.formatMessage({ id: 'queue.column.wait' })}</th>
                <th scope="col">{intl.formatMessage({ id: 'queue.column.patient' })}</th>
                <th scope="col">{intl.formatMessage({ id: 'queue.column.interpreter' })}</th>
                <th scope="col">{intl.formatMessage({ id: 'queue.column.status' })}</th>
                <th scope="col" className="queue-column-actions">{intl.formatMessage({ id: 'queue.column.actions' })}</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map((item) => (
                <tr key={item.id}>
                  <td>
                    <span
                      className={`priority-badge priority-badge--${item.priority.toLowerCase()}`}
                      aria-label={priorityLabel(item.priority)}
                    >
                      {priorityLabel(item.priority)}
                    </span>
                  </td>
                  <td>
                    <div className="queue-reason">
                      <span className="queue-reason__text">{item.shortReason}</span>
                      <span className="queue-reason__meta">{new Date(item.createdAt).toLocaleString()}</span>
                    </div>
                  </td>
                  <td>{waitLabel(item.waitMs)}</td>
                  <td>{item.patientId}</td>
                  <td>{formatInterpreter(item.interpreter)}</td>
                  <td>{statusLabel(item.status)}</td>
                  <td className="queue-actions">
                    <Link
                      to={`/case/${encodeURIComponent(item.id)}`}
                      className="ui-button"
                      aria-label={intl.formatMessage({ id: 'queue.action.openWithId' }, { id: item.id })}
                    >
                      {intl.formatMessage({ id: 'queue.action.open' })}
                    </Link>
                    <button
                      type="button"
                      className="ui-button"
                      disabled={assigningId === item.id}
                      onClick={() => void handleAssign(item)}
                    >
                      {intl.formatMessage({ id: 'queue.action.assign' })}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};

export default QueuePage;

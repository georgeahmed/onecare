import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ClinicianTaskSummary } from '@onecare/events';
import { queueGateway } from '../adapters/gateway';
import { Link } from 'react-router-dom';
import { useIntl } from 'react-intl';
import type { TaskPriority, TaskStatus, QueueFilters } from '../adapters/queue.types';
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

const buildTimeWindow = (timeRange: TimeFilter): { from?: string; to?: string } => {
  const now = Date.now();
  if (timeRange === 'under15') {
    return { from: new Date(now - 15 * 60 * 1000).toISOString() };
  }
  if (timeRange === 'under60') {
    return {
      from: new Date(now - 60 * 60 * 1000).toISOString(),
      to: new Date(now - 15 * 60 * 1000).toISOString()
    };
  }
  if (timeRange === 'over60') {
    return { to: new Date(now - 60 * 60 * 1000).toISOString() };
  }
  return {};
};

const QueuePage = () => {
  const intl = useIntl();
  const { session, activeClinicId, setActiveClinic } = useAuth();
  const clinics = session?.clinics ?? [];

  const activeClinic = useMemo(
    () => clinics.find((clinic) => clinic.id === activeClinicId) ?? clinics[0],
    [activeClinicId, clinics]
  );

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
    if (!activeClinicId && clinics[0]) {
      setActiveClinic(clinics[0].id);
    }
  }, [activeClinicId, clinics, setActiveClinic]);

  useEffect(() => {
    if (!activeClinicId) {
      setSourceItems([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const { from, to } = buildTimeWindow(timeRange);
    const assigneeFilter: QueueFilters['assignee'] | undefined =
      ownership === 'mine' ? 'me' : ownership === 'unassigned' ? 'unassigned' : undefined;

    const loadPages = async () => {
      const aggregated: ClinicianTaskSummary[] = [];
      let cursor: string | undefined;
      let guard = 0;
      try {
        do {
          const res = await queueGateway.current.list({
            clinicId: activeClinicId,
            limit: 50,
            priority: priority === 'ALL' ? undefined : priority,
            status: status === 'ALL' ? undefined : status,
            assignee: assigneeFilter,
            from,
            to,
            cursor
          });
          aggregated.push(...res.items);
          cursor = res.nextCursor;
          guard += 1;
        } while (cursor && guard < 10 && !cancelled);
        if (cancelled) return;
        setSourceItems(aggregated);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadPages();

    return () => {
      cancelled = true;
    };
  }, [activeClinicId, ownership, priority, session?.userId, status, timeRange]);

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

  const assigneeLabel = useCallback(
    (assignee?: string) => {
      if (!assignee) return intl.formatMessage({ id: 'queue.assignee.unassigned', defaultMessage: 'Unassigned' });
      if (assignee === session?.userId) return intl.formatMessage({ id: 'queue.assignee.you', defaultMessage: 'Assigned to you' });
      return assignee;
    },
    [intl, session?.userId]
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

  const queueStats = useMemo(() => {
    const scoped = filteredItems;
    const urgent = scoped.filter((item) => item.priority === 'STAT' || item.priority === 'URGENT').length;
    const unassigned = scoped.filter((item) => !item.assignee).length;
    const inProgress = scoped.filter((item) => item.status === 'IN_PROGRESS').length;
    const longestWaitMinutes = scoped.length > 0
      ? Math.max(...scoped.map((item) => Math.round(item.waitMs / 60000)))
      : 0;
    return {
      total: scoped.length,
      urgent,
      unassigned,
      inProgress,
      longestWaitMinutes
    };
  }, [filteredItems]);

  const handleAssign = async (item: ClinicianTaskSummary) => {
    if (item.status === 'DONE') return;
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

  const handleUnassign = async (item: ClinicianTaskSummary) => {
    if (item.status === 'DONE') return;
    setAssigningId(item.id);
    try {
      const updated = await queueGateway.current.unassign(item.id);
      setSourceItems((prev) =>
        prev.map((entry) =>
          entry.id === item.id
            ? { ...entry, assignee: updated.assignee, status: updated.status, waitMs: updated.waitMs }
            : entry
        )
      );
      setError(null);
      setAnnouncement(
        intl.formatMessage({ id: 'queue.announcement.unassigned', defaultMessage: 'Request {requestId} returned to the queue.' }, { requestId: item.id })
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

  return (
    <section className="queue-page">
      <header className="page-hero queue-hero">
        <div className="page-hero__copy">
          <p className="eyebrow">{intl.formatMessage({ id: 'queue.eyebrow', defaultMessage: 'Clinician workspace' })}</p>
          <h1>{intl.formatMessage({ id: 'queue.title' })}</h1>
          <p className="page-hero__lede">
            {intl.formatMessage({ id: 'queue.heroCopy', defaultMessage: 'Keep patients flowing with a calm, prioritized view of today’s requests.' })}
          </p>
          <div className="pill-row">
            {activeClinic ? <span className="pill pill--accent">{activeClinic.name}</span> : null}
            <span className="pill pill--muted">
              {intl.formatMessage({ id: 'queue.hero.patients', defaultMessage: 'Work the longest waits first to keep patients reassured.' })}
            </span>
          </div>
        </div>
        <div className="page-hero__panel">
          <div className="page-hero__panel-label">
            {intl.formatMessage({ id: 'queue.panel.live', defaultMessage: 'Live queue health' })}
          </div>
          <div className="page-hero__panel-value">
            {queueStats.longestWaitMinutes > 0
              ? intl.formatMessage({ id: 'queue.wait.minutes' }, { minutes: queueStats.longestWaitMinutes })
              : intl.formatMessage({ id: 'queue.panel.steady', defaultMessage: 'All caught up' })}
          </div>
          <p className="page-hero__panel-subtext">
            {intl.formatMessage({ id: 'queue.panel.desc', defaultMessage: 'Longest wait in your current filters.' })}
          </p>
        </div>
      </header>

      <div className="summary-grid" aria-label={intl.formatMessage({ id: 'queue.stats.label', defaultMessage: 'Queue summary' })}>
        <div className="summary-card">
          <p className="summary-card__label">{intl.formatMessage({ id: 'queue.stats.total', defaultMessage: 'Active requests' })}</p>
          <p className="summary-card__value">{queueStats.total}</p>
          <p className="summary-card__hint">{intl.formatMessage({ id: 'queue.stats.totalHint', defaultMessage: 'All tasks in this clinic view.' })}</p>
        </div>
        <div className="summary-card">
          <p className="summary-card__label">{intl.formatMessage({ id: 'queue.stats.unassigned', defaultMessage: 'Unassigned' })}</p>
          <p className="summary-card__value">{queueStats.unassigned}</p>
          <p className="summary-card__hint">{intl.formatMessage({ id: 'queue.stats.unassignedHint', defaultMessage: 'Hand offs waiting for ownership.' })}</p>
        </div>
        <div className="summary-card">
          <p className="summary-card__label">{intl.formatMessage({ id: 'queue.stats.urgent', defaultMessage: 'Urgent / STAT' })}</p>
          <p className="summary-card__value">{queueStats.urgent}</p>
          <p className="summary-card__hint">{intl.formatMessage({ id: 'queue.stats.urgentHint', defaultMessage: 'High-acuity requests to handle first.' })}</p>
        </div>
        <div className="summary-card">
          <p className="summary-card__label">{intl.formatMessage({ id: 'queue.stats.inProgress', defaultMessage: 'In progress' })}</p>
          <p className="summary-card__value">{queueStats.inProgress}</p>
          <p className="summary-card__hint">{intl.formatMessage({ id: 'queue.stats.inProgressHint', defaultMessage: 'Calls or callbacks underway.' })}</p>
        </div>
      </div>

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
          <label data-selected={ownership === 'any'}>
            <input
              type="radio"
              name="queue-ownership"
              value="any"
              checked={ownership === 'any'}
              onChange={() => setOwnership('any')}
            />
            {intl.formatMessage({ id: 'queue.filters.ownership.any' })}
          </label>
          <label data-selected={ownership === 'mine'}>
            <input
              type="radio"
              name="queue-ownership"
              value="mine"
              checked={ownership === 'mine'}
              onChange={() => setOwnership('mine')}
            />
            {intl.formatMessage({ id: 'queue.filters.ownership.mine' })}
          </label>
          <label data-selected={ownership === 'unassigned'}>
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
          <label data-selected={timeRange === 'any'}>
            <input
              type="radio"
              name="queue-timerange"
              value="any"
              checked={timeRange === 'any'}
              onChange={() => setTimeRange('any')}
            />
            {intl.formatMessage({ id: 'queue.filters.time.any' })}
          </label>
          <label data-selected={timeRange === 'under15'}>
            <input
              type="radio"
              name="queue-timerange"
              value="under15"
              checked={timeRange === 'under15'}
              onChange={() => setTimeRange('under15')}
            />
            {intl.formatMessage({ id: 'queue.filters.time.under15' })}
          </label>
          <label data-selected={timeRange === 'under60'}>
            <input
              type="radio"
              name="queue-timerange"
              value="under60"
              checked={timeRange === 'under60'}
              onChange={() => setTimeRange('under60')}
            />
            {intl.formatMessage({ id: 'queue.filters.time.under60' })}
          </label>
          <label data-selected={timeRange === 'over60'}>
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
        <div className="panel panel--muted" role="status">{intl.formatMessage({ id: 'loading' })}</div>
      ) : filteredItems.length === 0 ? (
        <div className="panel panel--muted" role="status">{intl.formatMessage({ id: 'queue.empty' })}</div>
      ) : (
        <div className="queue-table-wrapper" role="region" aria-live="off">
          <table className="queue-table">
            <caption className="visually-hidden">{intl.formatMessage({ id: 'queue.title' })}</caption>
            <thead>
              <tr>
                <th scope="col">{intl.formatMessage({ id: 'queue.column.priority' })}</th>
                <th scope="col">{intl.formatMessage({ id: 'queue.column.reason' })}</th>
                <th scope="col">{intl.formatMessage({ id: 'queue.column.wait' })}</th>
                <th scope="col" className="queue-column-patient">{intl.formatMessage({ id: 'queue.column.patient' })}</th>
                <th scope="col">{intl.formatMessage({ id: 'queue.column.interpreter' })}</th>
                <th scope="col">{intl.formatMessage({ id: 'queue.column.status' })}</th>
                <th scope="col" className="queue-column-actions">{intl.formatMessage({ id: 'queue.column.actions' })}</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map((item) => (
                <tr
                  key={item.id}
                  className={`queue-row queue-row--status-${item.status.toLowerCase()} queue-row--priority-${item.priority.toLowerCase()}`}
                >
                  <td>
                    <span
                      className={`priority-badge priority-badge--${item.priority.toLowerCase()}`}
                      aria-label={priorityLabel(item.priority)}
                    >
                      {priorityLabel(item.priority)}
                    </span>
                  </td>
                  <td>
                    <div className="queue-reason" title={item.shortReason}>
                      <span className="queue-reason__text">{item.shortReason}</span>
                      <span className="queue-reason__meta">
                        {new Date(item.createdAt).toLocaleString()}
                        <span className="queue-reason__assignee">• {assigneeLabel(item.assignee)}</span>
                      </span>
                    </div>
                  </td>
                  <td>{waitLabel(item.waitMs)}</td>
                  <td className="queue-cell-patient" title={item.patientId}>{item.patientId}</td>
                  <td className="queue-cell-interpreter" title={formatInterpreter(item.interpreter)}>{formatInterpreter(item.interpreter)}</td>
                  <td>
                    <span className={`pill pill--status pill--status-${item.status.toLowerCase()}`}>
                      {statusLabel(item.status)}
                    </span>
                  </td>
                  <td className="queue-actions">
                    <Link
                      to={`/case/${encodeURIComponent(item.id)}`}
                      className="ui-button ui-button--compact"
                      aria-label={intl.formatMessage({ id: 'queue.action.openWithId' }, { id: item.id })}
                    >
                      {intl.formatMessage({ id: 'queue.action.open' })}
                    </Link>
                    {!item.assignee && item.status !== 'DONE' ? (
                      <button
                        type="button"
                        className="ui-button ui-button--compact"
                        disabled={assigningId === item.id}
                        onClick={() => void handleAssign(item)}
                      >
                        {intl.formatMessage({ id: 'queue.action.assign' })}
                      </button>
                    ) : item.assignee === session?.userId && item.status === 'IN_PROGRESS' ? (
                      <button
                        type="button"
                        className="ui-button ui-button--compact"
                        disabled={assigningId === item.id}
                        onClick={() => void handleUnassign(item)}
                      >
                        {intl.formatMessage({ id: 'queue.action.unassign', defaultMessage: 'Unassign' })}
                      </button>
                    ) : item.assignee ? (
                      <span className="queue-assigned-label" title={item.assignee}>
                        {intl.formatMessage({ id: 'queue.assigned.to', defaultMessage: 'Assigned to {user}' }, { user: item.assignee })}
                      </span>
                    ) : (
                      <span className="queue-assigned-label">
                        {intl.formatMessage({ id: 'queue.assignee.unassigned', defaultMessage: 'Unassigned' })}
                      </span>
                    )}
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

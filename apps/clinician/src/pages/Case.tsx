import { useParams } from 'react-router-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClinicianTaskDetail } from '@onecare/events';
import { queueGateway } from '../adapters/gateway';
import { useIntl } from 'react-intl';
import CaseHeader from '../components/CaseHeader';
import ActionBar from '../components/ActionBar';
import type { RecommendedWindow } from '../adapters/queue.types';
import useAuth from '../hooks/useAuth';

const DEFAULT_ASSIST_LOCATION = 'org-dev';
const DEFAULT_ASSIST_SERVICE = 'GP';

type AssistValidationReason = 'missing' | 'range' | null;

const parseLocalDateTime = (value: string): Date | null => {
  if (!value) return null;
  const normalized = value.length === 16 ? `${value}:00` : value;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(normalized);
  if (!match) return null;
  const [, year, month, day, hours, minutes, seconds] = match;
  const parsed = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hours),
    Number(minutes),
    seconds ? Number(seconds) : 0
  );
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const toIsoFromLocalInput = (value: string): string | null => {
  const parsed = parseLocalDateTime(value);
  return parsed ? parsed.toISOString() : null;
};

const toLocalInputValue = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (num: number) => num.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const CasePage = () => {
  const { id } = useParams();
  const intl = useIntl();
  const { session, activeClinicId } = useAuth();
  const [detail, setDetail] = useState<ClinicianTaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [resolveOutcome, setResolveOutcome] = useState('callback_scheduled');
  const [scheduleWhen, setScheduleWhen] = useState('');
  const [assistStart, setAssistStart] = useState('');
  const [assistEnd, setAssistEnd] = useState('');
  const [assistLocation, setAssistLocation] = useState(DEFAULT_ASSIST_LOCATION);
  const [assistServiceType, setAssistServiceType] = useState(DEFAULT_ASSIST_SERVICE);
  const [assistNotes, setAssistNotes] = useState('');
  const [reco, setReco] = useState<RecommendedWindow[]>([]);
  const [recoLoading, setRecoLoading] = useState(false);
  const [recoError, setRecoError] = useState<string | null>(null);
  const liveRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!id) {
      setDetail(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
      setDetail(null);
      setError(null);
      queueGateway.current
        .getById(id)
        .then((res) => {
          if (!cancelled) {
            const allowed = !session?.clinics?.length || session?.clinics?.some((clinic) => clinic.id === res.clinicId);
            if (!allowed) {
              setDetail(null);
              setError(intl.formatMessage({ id: 'case.error.forbidden', defaultMessage: 'You do not have access to this clinic.' }));
              return;
            }
            setDetail(res);
            setError(null);
          }
        })
      .catch((e) => {
        if (cancelled) return;
        setDetail(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [id, intl, session?.clinics]);

  useEffect(() => {
    setNote('');
    setResolveOutcome('callback_scheduled');
    setScheduleWhen('');
    setAssistStart('');
    setAssistEnd('');
    setAssistLocation(DEFAULT_ASSIST_LOCATION);
    setAssistServiceType(DEFAULT_ASSIST_SERVICE);
    setAssistNotes('');
    setAssistOpen(false);
    setReco([]);
    setRecoError(null);
    setRecoLoading(false);
    setError(null);
  }, [id]);

  useEffect(() => {
    if (!detail) return;
    const fallbackClinic = detail.clinicId || DEFAULT_ASSIST_LOCATION;
    setAssistLocation(fallbackClinic);
    setAssistServiceType((prev) => prev || DEFAULT_ASSIST_SERVICE);
  }, [detail]);

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

  const handleResolve = async (): Promise<boolean> => {
    if (!id) {
      setErrorMessage(intl.formatMessage({ id: 'case.error.missingId' }));
      return false;
    }
    try {
      const updated = await queueGateway.current.resolve(id, resolveOutcome, note.trim() || undefined);
      setDetail(updated);
      setNote('');
      clearError();
      announce(intl.formatMessage({ id: 'case.status.updated' }));
      return true;
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  const handleSchedule = async (): Promise<boolean> => {
    if (!id) {
      setErrorMessage(intl.formatMessage({ id: 'case.error.missingId' }));
      return false;
    }
    if (!scheduleWhen) {
      setErrorMessage(intl.formatMessage({ id: 'case.error.scheduleMissing' }));
      return false;
    }
    const scheduleIso = toIsoFromLocalInput(scheduleWhen);
    if (!scheduleIso) {
      setErrorMessage(intl.formatMessage({ id: 'case.error.scheduleInvalid' }));
      return false;
    }
    try {
      const updated = await queueGateway.current.scheduleCallback(id, scheduleIso, note.trim() || undefined);
      setDetail(updated);
      setNote('');
      clearError();
      announce(intl.formatMessage({ id: 'case.status.updated' }));
      return true;
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  // Replace legacy book action: open assisted modal instead of a direct call
  const [assistOpen, setAssistOpen] = useState(false);
  const handleBook = async (): Promise<boolean> => {
    setAssistOpen(true);
    return false;
  };

  const handleAssistedOutcome = async (
    outcome: 'booked' | 'no_time' | 'pharmacy_referral_sent'
  ): Promise<boolean> => {
    if (!id || !detail) {
      setErrorMessage(intl.formatMessage({ id: 'case.error.missingId' }));
      return false;
    }
    if (!detail.patientId) {
      setErrorMessage(intl.formatMessage({ id: 'case.error.patientMissing', defaultMessage: 'Patient id is required before booking.' }));
      return false;
    }
    let startIso = assistStart ? toIsoFromLocalInput(assistStart) ?? undefined : undefined;
    let endIso = assistEnd ? toIsoFromLocalInput(assistEnd) ?? undefined : undefined;
    if (outcome === 'booked') {
      if (!assistStart || !assistEnd) {
        setErrorMessage(intl.formatMessage({ id: 'case.error.assistMissingTime' }));
        return false;
      }
      if (!startIso || !endIso) {
        setErrorMessage(intl.formatMessage({ id: 'case.error.assistInvalid' }));
        return false;
      }
      if (new Date(endIso) <= new Date(startIso)) {
        setErrorMessage(intl.formatMessage({ id: 'case.error.assistInvalid' }));
        return false;
      }
      if (!assistLocation.trim() || !assistServiceType.trim()) {
        setErrorMessage(intl.formatMessage({ id: 'case.error.assistMissingFields', defaultMessage: 'Location and service type are required.' }));
        return false;
      }
    }
    try {
      const updated = await queueGateway.current.assistedOutcome(id, outcome, {
        start: startIso,
        end: endIso,
        location: assistLocation?.trim() || detail.clinicId,
        serviceType: assistServiceType?.trim() || undefined,
        notes: assistNotes.trim() || undefined,
        patientId: detail.patientId,
      });
      setDetail(updated);
      clearError();
      announce(intl.formatMessage({ id: 'case.status.updated' }));
      return true;
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  const fetchRecommendations = async () => {
    if (!id) return;
    setRecoLoading(true);
    setRecoError(null);
    setReco([]);
    try {
      const windows = await queueGateway.current.recommendWindows(id, {
        windowStart: assistStart ? toIsoFromLocalInput(assistStart) ?? undefined : undefined,
        windowEnd: assistEnd ? toIsoFromLocalInput(assistEnd) ?? undefined : undefined,
        location: assistLocation?.trim() || detail?.clinicId || activeClinicId || undefined,
        serviceType: assistServiceType?.trim() || undefined,
      });
      setReco(windows);
    } catch (e) {
      setRecoError(e instanceof Error ? e.message : String(e));
    } finally {
      setRecoLoading(false);
    }
  };

  const handleEscalate = async (): Promise<boolean> => {
    if (!detail) {
      setErrorMessage(intl.formatMessage({ id: 'case.error.missingId' }));
      return false;
    }
    try {
      const updated = await queueGateway.current.escalate(detail.id);
      setDetail(updated);
      clearError();
      announce(intl.formatMessage({ id: 'case.status.updated' }));
      return true;
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  const handleCall = async (): Promise<boolean> => {
    if (!detail) {
      setErrorMessage(intl.formatMessage({ id: 'case.error.missingId' }));
      return false;
    }
    try {
      const updated = await queueGateway.current.recordCall(detail.id);
      setDetail(updated);
      clearError();
      announce(intl.formatMessage({ id: 'case.status.updated' }));
      return true;
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  const assistValidation = useMemo<{ invalid: boolean; reason: AssistValidationReason }>(() => {
    if (!assistStart || !assistEnd) return { invalid: true, reason: 'missing' };
    const startDate = parseLocalDateTime(assistStart);
    const endDate = parseLocalDateTime(assistEnd);
    if (!startDate || !endDate || endDate <= startDate) {
      return { invalid: true, reason: 'range' };
    }
    return { invalid: false, reason: null };
  }, [assistEnd, assistStart]);

  const assistInvalid = assistValidation.invalid;
  const assistValidationMessage = assistInvalid
    ? intl.formatMessage(
        {
          id: assistValidation.reason === 'missing' ? 'case.assisted.validation.missing' : 'case.assisted.validation',
          defaultMessage: assistValidation.reason === 'missing'
            ? 'Select a start and end time.'
            : 'Please ensure end time is after start time.'
        }
      )
    : intl.formatMessage({ id: 'case.assisted.valid', defaultMessage: 'Selection looks good.' });
  const waitText = useMemo(
    () =>
      detail
        ? intl.formatMessage({ id: 'queue.wait.minutes' }, { minutes: Math.max(0, Math.round(detail.waitMs / 60000)) })
        : '',
    [detail, intl]
  );
  const statusText = useMemo(
    () =>
      detail
        ? intl.formatMessage({ id: `queue.status.${detail.status.toLowerCase() as Lowercase<ClinicianTaskDetail['status']>}` })
        : '',
    [detail, intl]
  );
  const interpreterLabel = useMemo(() => {
    const interpreter = detail?.interpreter;
    if (!interpreter) {
      return intl.formatMessage({ id: 'queue.interpreter.none' });
    }
    if (typeof Intl.DisplayNames === 'function') {
      try {
        const display = new Intl.DisplayNames([intl.locale], { type: 'language' });
        return display.of(interpreter) ?? interpreter;
      } catch {
        return interpreter;
      }
    }
    return interpreter;
  }, [detail?.interpreter, intl]);

  if (loading) return <p role="status">{intl.formatMessage({ id: 'loading' })}</p>;
  if (error && !detail) return <p role="alert">{error || intl.formatMessage({ id: 'error.generic' })}</p>;
  if (!detail) return <p role="alert">{intl.formatMessage({ id: 'case.error.notFound' })}</p>;

  return (
    <section className="case-page">
      <h1 id="case-heading">{intl.formatMessage({ id: 'case.title' }, { id: detail.id })}</h1>
      <p className="case-subtitle">{intl.formatMessage({ id: 'case.subtitle' })}</p>

      <CaseHeader detail={detail} />

      <div className="summary-grid summary-grid--compact" aria-label={intl.formatMessage({ id: 'case.overview.label', defaultMessage: 'Case overview' })}>
        <div className="summary-card summary-card--muted">
          <p className="summary-card__label">{intl.formatMessage({ id: 'case.overview.patient', defaultMessage: 'Patient ID' })}</p>
          <p className="summary-card__value">{detail.patientId}</p>
          <p className="summary-card__hint">{intl.formatMessage({ id: 'case.overview.patientHint', defaultMessage: 'Confirm identifiers before sharing details.' })}</p>
        </div>
        <div className="summary-card">
          <p className="summary-card__label">{intl.formatMessage({ id: 'queue.column.wait' })}</p>
          <p className="summary-card__value">{waitText}</p>
          <p className="summary-card__hint">{intl.formatMessage({ id: 'case.overview.waitHint', defaultMessage: 'Prioritize patients waiting longest.' })}</p>
        </div>
        <div className="summary-card">
          <p className="summary-card__label">{intl.formatMessage({ id: 'queue.column.status' })}</p>
          <p className="summary-card__value"><span className={`pill pill--status pill--status-${detail.status.toLowerCase()}`}>{statusText}</span></p>
          <p className="summary-card__hint">{intl.formatMessage({ id: 'case.overview.statusHint', defaultMessage: 'Keep patients informed when status changes.' })}</p>
        </div>
        <div className="summary-card summary-card--muted">
          <p className="summary-card__label">{intl.formatMessage({ id: 'queue.column.interpreter' })}</p>
          <p className="summary-card__value">{interpreterLabel}</p>
          <p className="summary-card__hint">{intl.formatMessage({ id: 'case.overview.interpreterHint', defaultMessage: 'Arrange interpreter before calling out.' })}</p>
        </div>
      </div>

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

      <div className="panel panel--section">
        <div className="panel__title-row">
          <h2>{intl.formatMessage({ id: 'case.nextSteps.title', defaultMessage: 'Plan the next step' })}</h2>
          <p className="panel__hint">
            {intl.formatMessage({ id: 'case.nextSteps.hint', defaultMessage: 'Confirm the callback window or capture notes before resolving.' })}
          </p>
        </div>
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
      </div>

      <section className="case-timeline" aria-label={intl.formatMessage({ id: 'case.timeline.title', defaultMessage: 'Recent activity' })}>
        <div className="case-timeline__header">
          <h2>{intl.formatMessage({ id: 'case.timeline.title', defaultMessage: 'Recent activity' })}</h2>
          <span className="pill pill--muted">
            {intl.formatMessage(
              { id: 'case.timeline.count', defaultMessage: '{count, plural, one {# event} other {# events}}' },
              { count: detail.audit?.length ?? 0 }
            )}
          </span>
        </div>
        {detail.audit && detail.audit.length > 0 ? (
          <ul className="case-timeline__list">
            {detail.audit.slice(-5).reverse().map((entry) => (
              <li className="timeline-item" key={`${entry.when}-${entry.what}`}>
                <div className="timeline-item__time">{new Date(entry.when).toLocaleString()}</div>
                <div className="timeline-item__body">
                  <div className="timeline-item__what">{entry.what}</div>
                  <div className="timeline-item__who">{entry.who || intl.formatMessage({ id: 'case.timeline.system', defaultMessage: 'System' })}</div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="case-empty">{intl.formatMessage({ id: 'case.timeline.empty', defaultMessage: 'No recorded actions yet.' })}</p>
        )}
      </section>
      {/* Assisted modal */}
      {assistOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={intl.formatMessage({ id: 'case.assisted.title', defaultMessage: 'Assisted Booking (MVP)' })}>
          <div className="modal">
            <header className="modal__header">
              <h2 className="modal__title">{intl.formatMessage({ id: 'case.assisted.title', defaultMessage: 'Assisted Booking (MVP)' })}</h2>
              <button className="modal__close" onClick={() => setAssistOpen(false)} aria-label={intl.formatMessage({ id: 'modal.close', defaultMessage: 'Close' })}>✕</button>
            </header>
            <div className="case-forms">
              <div className="assist-cta">
                <button type="button" className="ui-button ui-button--outline" onClick={() => void fetchRecommendations()}>
                  {recoLoading
                    ? intl.formatMessage({ id: 'case.assisted.recos.loading', defaultMessage: 'Getting recommendations…' })
                    : intl.formatMessage({ id: 'case.assisted.recos', defaultMessage: 'Get recommendations' })}
                </button>
                <button
                  type="button"
                  className="ui-button ui-button--outline"
                  disabled={!reco || reco.length === 0}
                  onClick={() => {
                    if (reco.length > 0) {
                      const [first] = reco;
                      const startValue = toLocalInputValue(first.start);
                      const endValue = toLocalInputValue(first.end);
                      setAssistStart(startValue);
                      setAssistEnd(endValue);
                      const location = first.location?.trim();
                      setAssistLocation(location && location.length > 0 ? location : DEFAULT_ASSIST_LOCATION);
                      const service = first.serviceType?.trim();
                      setAssistServiceType(service && service.length > 0 ? service : DEFAULT_ASSIST_SERVICE);
                    }
                  }}
                >
                  {intl.formatMessage({ id: 'case.assisted.apply_first', defaultMessage: 'Use first recommendation' })}
                </button>
              </div>
              {recoError ? <div role="alert" className="case-error">{recoError}</div> : null}
              {reco && reco.length > 0 ? (
                <div className="assist-reco-list">
                  {reco.map((w, idx) => (
                    <button
                      key={`${w.start}-${idx}`}
                      type="button"
                      className="assist-reco"
                      onClick={() => {
                        setAssistStart(toLocalInputValue(w.start));
                        setAssistEnd(toLocalInputValue(w.end));
                        const location = w.location?.trim();
                        setAssistLocation(location && location.length > 0 ? location : DEFAULT_ASSIST_LOCATION);
                        const service = w.serviceType?.trim();
                        setAssistServiceType(service && service.length > 0 ? service : DEFAULT_ASSIST_SERVICE);
                      }}
                      title={`${w.location ?? ''} ${w.serviceType ?? ''}`.trim()}
                    >
                      <div style={{ fontWeight: 600 }}>{new Date(w.start).toLocaleString()}</div>
                      <div style={{ fontSize: '0.9rem', color: 'var(--color-text-secondary)' }}>{new Date(w.end).toLocaleTimeString()}</div>
                      <div style={{ fontSize: '0.85rem' }}>{[w.location, w.serviceType].filter(Boolean).join(' · ')}</div>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="assist-grid">
              <label>
                {intl.formatMessage({ id: 'case.assisted.start', defaultMessage: 'Start' })}
                <input
                  type="datetime-local"
                  className="ui-select"
                  value={assistStart}
                  onChange={(e) => setAssistStart(e.target.value)}
                />
              </label>
              <label>
                {intl.formatMessage({ id: 'case.assisted.end', defaultMessage: 'End' })}
                <input
                  type="datetime-local"
                  className="ui-select"
                  value={assistEnd}
                  onChange={(e) => setAssistEnd(e.target.value)}
                />
              </label>
              <label>
                {intl.formatMessage({ id: 'case.assisted.location', defaultMessage: 'Location' })}
                <input
                  type="text"
                  className="ui-select"
                  value={assistLocation}
                  onChange={(e) => setAssistLocation(e.target.value)}
                />
              </label>
              <label>
                {intl.formatMessage({ id: 'case.assisted.service', defaultMessage: 'Service Type' })}
                <input
                  type="text"
                  className="ui-select"
                  value={assistServiceType}
                  onChange={(e) => setAssistServiceType(e.target.value)}
                />
              </label>
            </div>
            <label>
              {intl.formatMessage({ id: 'case.assisted.notes', defaultMessage: 'Notes' })}
              <textarea
                className="ui-textarea"
                rows={2}
                value={assistNotes}
                onChange={(e) => setAssistNotes(e.target.value)}
              />
            </label>
            <div className="modal__footer">
              <div className={`assist-validation ${assistInvalid ? 'assist-validation--error' : 'assist-validation--ok'}`}>
                {assistValidationMessage}
              </div>
              <div style={{ marginInlineStart: 'auto', display: 'flex', gap: '0.5rem' }}>
                <button type="button" className="ui-button" onClick={() => setAssistOpen(false)}>
                  {intl.formatMessage({ id: 'cancel', defaultMessage: 'Cancel' })}
                </button>
                <button
                  type="button"
                  className="ui-button ui-button--primary"
                  disabled={assistInvalid}
                  onClick={async () => {
                    const success = await handleAssistedOutcome('booked');
                    if (success) {
                      setAssistOpen(false);
                    }
                  }}
                >
                  {intl.formatMessage({ id: 'case.assisted.booked', defaultMessage: 'Booked in EMIS/TPP' })}
                </button>
                <button
                  type="button"
                  className="ui-button"
                  onClick={async () => {
                    const success = await handleAssistedOutcome('no_time');
                    if (success) {
                      setAssistOpen(false);
                    }
                  }}
                >
                  {intl.formatMessage({ id: 'case.assisted.no_time', defaultMessage: 'No suitable time' })}
                </button>
                <button
                  type="button"
                  className="ui-button"
                  onClick={async () => {
                    const success = await handleAssistedOutcome('pharmacy_referral_sent');
                    if (success) {
                      setAssistOpen(false);
                    }
                  }}
                >
                  {intl.formatMessage({ id: 'case.assisted.pharmacy', defaultMessage: 'Pharmacy referral sent' })}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
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

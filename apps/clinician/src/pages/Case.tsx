import { useParams } from 'react-router-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClinicianTaskDetail } from '@onecare/events';
import { queueGateway } from '../adapters/gateway';
import { useIntl } from 'react-intl';
import CaseHeader from '../components/CaseHeader';
import ActionBar from '../components/ActionBar';
import type { RecommendedWindow } from '../adapters/queue.types';

const DEFAULT_ASSIST_LOCATION = 'org-dev';
const DEFAULT_ASSIST_SERVICE = 'GP';

type AssistValidationReason = 'missing' | 'range' | null;

const parseLocalDateTime = (value: string): Date | null => {
  if (!value) return null;
  const normalized = value.length === 16 ? `${value}:00` : value;
  const parsed = new Date(normalized);
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
    }
    try {
      const updated = await queueGateway.current.assistedOutcome(id, outcome, {
        start: startIso,
        end: endIso,
        location: assistLocation?.trim() || undefined,
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
      const windows = await queueGateway.current.recommendWindows(id, {});
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

  if (loading) return <p role="status">{intl.formatMessage({ id: 'loading' })}</p>;
  if (error && !detail) return <p role="alert">{error || intl.formatMessage({ id: 'error.generic' })}</p>;
  if (!detail) return <p role="alert">{intl.formatMessage({ id: 'case.error.notFound' })}</p>;

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
      {/* Assisted modal */}
      {assistOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={intl.formatMessage({ id: 'case.assisted.title', defaultMessage: 'Assisted Booking (MVP)' })}>
          <div className="modal">
            <header className="modal__header">
              <h2 className="modal__title">{intl.formatMessage({ id: 'case.assisted.title', defaultMessage: 'Assisted Booking (MVP)' })}</h2>
              <button className="modal__close" onClick={() => setAssistOpen(false)} aria-label={intl.formatMessage({ id: 'modal.close', defaultMessage: 'Close' })}>✕</button>
            </header>
            <div className="case-forms">
              <div className="case-action-bar__buttons" style={{ gap: '0.5rem', marginBottom: '0.5rem' }}>
                <button type="button" className="ui-button" onClick={() => void fetchRecommendations()}>
                  {recoLoading
                    ? intl.formatMessage({ id: 'case.assisted.recos.loading', defaultMessage: 'Getting recommendations…' })
                    : intl.formatMessage({ id: 'case.assisted.recos', defaultMessage: 'Get recommendations' })}
                </button>
                <button
                  type="button"
                  className="ui-button"
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

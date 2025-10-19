import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import type { ClinicianTaskDetail } from '@onecare/events/src/contracts/clinician-task-detail';

type ActionKind = 'call' | 'schedule' | 'book' | 'escalate' | 'resolve';

export interface ActionBarHandlers {
  onCall: () => Promise<void> | void;
  onSchedule: () => Promise<void> | void;
  onBook: () => Promise<void> | void;
  onEscalate: () => Promise<void> | void;
  onResolve: () => Promise<void> | void;
}

interface ActionBarProps extends ActionBarHandlers {
  detail: ClinicianTaskDetail;
  onError: (message: string) => void;
  onSuccess: (message: string) => void;
}

const ActionBar = ({ detail, onCall, onSchedule, onBook, onEscalate, onResolve, onError, onSuccess }: ActionBarProps) => {
  const intl = useIntl();
  const [busyAction, setBusyAction] = useState<ActionKind | null>(null);
  const lastFocusedRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!busyAction && lastFocusedRef.current) {
      lastFocusedRef.current.focus();
      lastFocusedRef.current = null;
    }
  }, [busyAction]);

  const runAction = useCallback(
    async (kind: ActionKind, handler: () => Promise<void> | void, requiresConfirm = false) => {
      if (busyAction) return;
      if (requiresConfirm && !window.confirm(intl.formatMessage({ id: `case.action.confirm.${kind}` }))) {
        return;
      }
      setBusyAction(kind);
      try {
        await handler();
        onSuccess(
          intl.formatMessage({ id: 'case.action.success' }, { action: intl.formatMessage({ id: `case.action.${kind}` }) })
        );
      } catch (error) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : intl.formatMessage({ id: 'error.generic' });
        onError(message);
      } finally {
        setBusyAction(null);
      }
    },
    [busyAction, intl, onError, onSuccess]
  );

  const disabled = (action: ActionKind) => busyAction !== null && busyAction !== action;

  return (
    <section className="case-action-bar" aria-label={intl.formatMessage({ id: 'case.actions.title' })}>
      <div className="case-action-bar__correlation">
        <span>{intl.formatMessage({ id: 'case.field.correlation' })}</span>
        <code>{detail.correlationId ?? '—'}</code>
      </div>
      <div className="case-action-bar__buttons">
        <button
          type="button"
          className="ui-button ui-button--primary"
          disabled={disabled('call')}
          aria-keyshortcuts="Control+Shift+C"
          onClick={(event) => {
            lastFocusedRef.current = event.currentTarget;
            void runAction('call', onCall);
          }}
        >
          {busyAction === 'call'
            ? intl.formatMessage({ id: 'case.action.calling' })
            : intl.formatMessage({ id: 'case.action.call' })}
        </button>
        <button
          type="button"
          className="ui-button"
          disabled={disabled('schedule')}
          onClick={(event) => {
            lastFocusedRef.current = event.currentTarget;
            void runAction('schedule', onSchedule);
          }}
        >
          {busyAction === 'schedule'
            ? intl.formatMessage({ id: 'case.action.scheduling' })
            : intl.formatMessage({ id: 'case.action.schedule' })}
        </button>
        <button
          type="button"
          className="ui-button"
          disabled={disabled('book')}
          onClick={(event) => {
            lastFocusedRef.current = event.currentTarget;
            void runAction('book', onBook);
          }}
        >
          {busyAction === 'book'
            ? intl.formatMessage({ id: 'case.action.booking' })
            : intl.formatMessage({ id: 'case.action.book' })}
        </button>
        <button
          type="button"
          className="ui-button ui-button--danger"
          disabled={disabled('escalate')}
          onClick={(event) => {
            lastFocusedRef.current = event.currentTarget;
            void runAction('escalate', onEscalate, true);
          }}
        >
          {busyAction === 'escalate'
            ? intl.formatMessage({ id: 'case.action.escalating' })
            : intl.formatMessage({ id: 'case.action.escalate' })}
        </button>
        <button
          type="button"
          className="ui-button ui-button--danger"
          disabled={disabled('resolve')}
          onClick={(event) => {
            lastFocusedRef.current = event.currentTarget;
            void runAction('resolve', onResolve, true);
          }}
        >
          {busyAction === 'resolve'
            ? intl.formatMessage({ id: 'case.action.resolving' })
            : intl.formatMessage({ id: 'case.action.resolve' })}
        </button>
      </div>
    </section>
  );
};

export default ActionBar;

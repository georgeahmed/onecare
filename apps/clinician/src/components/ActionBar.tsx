import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import type { ClinicianTaskDetail } from '@onecare/events';

type ActionKind = 'call' | 'schedule' | 'book' | 'escalate' | 'resolve';

type ActionInvokeResult = void | boolean | { success?: boolean; message?: string };

const ACTION_CAPABILITIES: Record<ActionKind, readonly string[]> = {
  call: ['CALL'],
  schedule: ['SCHEDULE'],
  book: ['BOOK'],
  escalate: ['ESCALATE'],
  resolve: ['RESOLVE'],
} as const;

const normalizeResult = (result: ActionInvokeResult): { success: boolean; message?: string } => {
  if (typeof result === 'boolean') {
    return { success: result };
  }
  if (result && typeof result === 'object') {
    return { success: result.success ?? true, message: result.message };
  }
  return { success: true };
};

export interface ActionBarHandlers {
  onCall: () => Promise<ActionInvokeResult> | ActionInvokeResult;
  onSchedule: () => Promise<ActionInvokeResult> | ActionInvokeResult;
  onBook: () => Promise<ActionInvokeResult> | ActionInvokeResult;
  onEscalate: () => Promise<ActionInvokeResult> | ActionInvokeResult;
  onResolve: () => Promise<ActionInvokeResult> | ActionInvokeResult;
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
  const allowedActions = useMemo(() => new Set(detail.actionsAllowed ?? []), [detail.actionsAllowed]);

  const isActionAllowed = useCallback(
    (action: ActionKind): boolean => {
      const capabilities = ACTION_CAPABILITIES[action] ?? [];
      return capabilities.some((capability) => allowedActions.has(capability));
    },
    [allowedActions]
  );

  useEffect(() => {
    if (!busyAction && lastFocusedRef.current) {
      lastFocusedRef.current.focus();
      lastFocusedRef.current = null;
    }
  }, [busyAction]);

  const runAction = useCallback(
    async (
      kind: ActionKind,
      handler: () => Promise<ActionInvokeResult> | ActionInvokeResult,
      options?: { confirm?: boolean; announceSuccess?: boolean }
    ) => {
      if (busyAction) return;
      if (!isActionAllowed(kind)) return;
      const { confirm = false, announceSuccess = true } = options ?? {};
      if (confirm && !window.confirm(intl.formatMessage({ id: `case.action.confirm.${kind}` }))) {
        return;
      }
      setBusyAction(kind);
      try {
        const result = await handler();
        const normalized = normalizeResult(result);
        if (normalized.success && announceSuccess) {
          onSuccess(
            normalized.message ??
              intl.formatMessage({ id: 'case.action.success' }, { action: intl.formatMessage({ id: `case.action.${kind}` }) })
          );
        }
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
    [busyAction, intl, isActionAllowed, onError, onSuccess]
  );

  const disabled = (action: ActionKind) => busyAction !== null || !isActionAllowed(action);
  const isBusy = (action: ActionKind) => busyAction === action;

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
          {isBusy('call')
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
          {isBusy('schedule')
            ? intl.formatMessage({ id: 'case.action.scheduling' })
            : intl.formatMessage({ id: 'case.action.schedule' })}
        </button>
        <button
          type="button"
          className="ui-button"
          disabled={disabled('book')}
          onClick={(event) => {
            lastFocusedRef.current = event.currentTarget;
            void runAction('book', onBook, { announceSuccess: false });
          }}
        >
          {isBusy('book')
            ? intl.formatMessage({ id: 'case.action.booking' })
            : intl.formatMessage({ id: 'case.action.book' })}
        </button>
        <button
          type="button"
          className="ui-button ui-button--danger"
          disabled={disabled('escalate')}
          onClick={(event) => {
            lastFocusedRef.current = event.currentTarget;
            void runAction('escalate', onEscalate, { confirm: true });
          }}
        >
          {isBusy('escalate')
            ? intl.formatMessage({ id: 'case.action.escalating' })
            : intl.formatMessage({ id: 'case.action.escalate' })}
        </button>
        <button
          type="button"
          className="ui-button ui-button--danger"
          disabled={disabled('resolve')}
          onClick={(event) => {
            lastFocusedRef.current = event.currentTarget;
            void runAction('resolve', onResolve, { confirm: true });
          }}
        >
          {isBusy('resolve')
            ? intl.formatMessage({ id: 'case.action.resolving' })
            : intl.formatMessage({ id: 'case.action.resolve' })}
        </button>
      </div>
    </section>
  );
};

export default ActionBar;

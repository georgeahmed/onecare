import { useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import {
  getConfiguredCallbackWindows,
  orderedPriorities,
  type CallbackPriority,
  type CallbackWindowCode,
  type CallbackWindowsConfig,
} from '../lib/callbackWindows';

const PRIORITY_LABEL_IDS: Record<CallbackPriority, string> = {
  stat: 'callback.priority.stat',
  urgent: 'callback.priority.urgent',
  soon: 'callback.priority.soon',
  routine: 'callback.priority.routine',
};

const WINDOW_LABEL_IDS: Record<CallbackWindowCode, string> = {
  immediate: 'callback.window.immediate',
  within_2h: 'callback.window.within2h',
  same_day: 'callback.window.sameDay',
  within_48h: 'callback.window.within48h',
};

export interface CallbackWindowsProps {
  config?: CallbackWindowsConfig;
  variant?: 'default' | 'compact';
}

const CallbackWindows = ({ config, variant = 'default' }: CallbackWindowsProps) => {
  const intl = useIntl();
  const [isWide, setIsWide] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(min-width: 768px)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia('(min-width: 768px)');
    const handler = (event: MediaQueryListEvent) => setIsWide(event.matches);
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, []);

  const resolved = useMemo<CallbackWindowsConfig>(
    () => config ?? getConfiguredCallbackWindows(),
    [config]
  );

  const items = orderedPriorities.map((priority) => {
    const windowCode = resolved.windows[priority];
    const priorityLabel = intl.formatMessage({ id: PRIORITY_LABEL_IDS[priority] });
    const windowLabel = intl.formatMessage({ id: WINDOW_LABEL_IDS[windowCode] });
    return { priority, priorityLabel, windowLabel };
  });

  const intro = intl.formatMessage({ id: 'callback.windows.intro' });
  const outsideHoursNote = resolved.outsideHoursMessage?.trim();
  const outsideHoursLabel = intl.formatMessage({
    id: resolved.acceptSubmissionsOutsideHours
      ? 'callback.windows.ooh.accepting'
      : 'callback.windows.ooh.closed',
  });

  const sectionTitle = intl.formatMessage({ id: 'callback.windows.title' });

  if (variant === 'compact') {
    return (
      <section
        aria-labelledby="callback-windows-title"
        className="callback-windows callback-windows--compact"
      >
        <h2 id="callback-windows-title">{sectionTitle}</h2>
        <div className="callback-windows__chips" role="list">
          {items.map(({ priority, priorityLabel, windowLabel }) => (
            <div key={priority} role="listitem" className="callback-chip">
              <span className="callback-chip__label">{priorityLabel}</span>
              <span className="callback-chip__value">{windowLabel}</span>
            </div>
          ))}
        </div>
        <details className="callback-windows__details" open={isWide}>
          <summary>
            {intl.formatMessage({ id: 'callback.windows.viewDetails', defaultMessage: 'View details' })}
          </summary>
          <div className="callback-windows__body">
            <p>{intro}</p>
            <dl>
              {items.map(({ priority, priorityLabel, windowLabel }) => (
                <div key={priority} className="callback-window">
                  <dt>{priorityLabel}</dt>
                  <dd>{windowLabel}</dd>
                </div>
              ))}
            </dl>
            {outsideHoursNote ? (
              <p className="callback-windows-note">
                <strong>{outsideHoursLabel}</strong>{' '}
                <span>{outsideHoursNote}</span>
              </p>
            ) : null}
          </div>
        </details>
      </section>
    );
  }

  return (
    <section aria-labelledby="callback-windows-title" className="callback-windows">
      <h2 id="callback-windows-title">{sectionTitle}</h2>
      <p>{intro}</p>
      <dl>
        {items.map(({ priority, priorityLabel, windowLabel }) => (
          <div key={priority} className="callback-window">
            <dt>{priorityLabel}</dt>
            <dd>{windowLabel}</dd>
          </div>
        ))}
      </dl>
      {outsideHoursNote ? (
        <p className="callback-windows-note">
          <strong>{outsideHoursLabel}</strong>{' '}
          <span>{outsideHoursNote}</span>
        </p>
      ) : null}
    </section>
  );
};

export default CallbackWindows;

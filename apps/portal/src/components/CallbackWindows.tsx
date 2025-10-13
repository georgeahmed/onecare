import { useMemo } from 'react';
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
}

const CallbackWindows = ({ config }: CallbackWindowsProps) => {
  const intl = useIntl();

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

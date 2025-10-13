/// <reference types="vitest/globals" />

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import CallbackWindows from '../src/components/CallbackWindows';
import { I18nProvider } from '../src/i18n';
import {
  resolveCallbackWindowsFromEnv,
  type CallbackWindowsConfig,
} from '../src/lib/callbackWindows';

describe('CallbackWindows component', () => {
  const buildConfig = (overrides: Partial<CallbackWindowsConfig> = {}): CallbackWindowsConfig => ({
    windows: {
      stat: 'immediate',
      urgent: 'within_2h',
      soon: 'same_day',
      routine: 'within_48h',
      ...(overrides.windows ?? {}),
    },
    outsideHoursMessage:
      overrides.outsideHoursMessage ?? 'Outside core hours we review requests next business day.',
    acceptSubmissionsOutsideHours:
      overrides.acceptSubmissionsOutsideHours ?? true,
  });

  it('renders callback windows for each priority with translated copy', () => {
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(CallbackWindows, {
          config: buildConfig({
            windows: {
              stat: 'immediate',
              urgent: 'within_2h',
              soon: 'same_day',
              routine: 'within_48h',
            },
          }),
        })
      )
    );

    expect(html).toContain('Callback expectations');
    expect(html).toContain('Critical (STAT)');
    expect(html).toContain('Urgent');
    expect(html).toContain('We call you back right away');
    expect(html).toContain('We aim to call you back within 2 hours');
  });

  it('shows outside hours note reflecting acceptance status', () => {
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(CallbackWindows, {
          config: buildConfig({
            acceptSubmissionsOutsideHours: false,
            outsideHoursMessage: 'We resume callbacks at 08:00.',
          }),
        })
      )
    );

    expect(html).toContain('Outside core hours we pause callbacks');
    expect(html).toContain('We resume callbacks at 08:00.');
  });
});

describe('resolveCallbackWindowsFromEnv', () => {
  it('parses known window codes and falls back for invalid values', () => {
    const config = resolveCallbackWindowsFromEnv({
      VITE_CALLBACK_WINDOWS_BY_PRIORITY: JSON.stringify({
        stat: 'immediate',
        urgent: 'same_day',
        soon: 'within_2h',
        routine: 'unsupported_code',
      }),
      VITE_CALLBACK_OOH_MESSAGE: 'Outside hours message',
      VITE_CALLBACK_OOH_ACCEPT_SUBMISSIONS: 'false',
    });

    expect(config.windows.urgent).toBe('same_day');
    expect(config.windows.soon).toBe('within_2h');
    expect(config.windows.routine).toBe('within_48h');
    expect(config.outsideHoursMessage).toBe('Outside hours message');
    expect(config.acceptSubmissionsOutsideHours).toBe(false);
  });

  it('returns defaults when env variables are missing or malformed', () => {
    const config = resolveCallbackWindowsFromEnv({});

    expect(config.windows).toEqual({
      stat: 'immediate',
      urgent: 'within_2h',
      soon: 'same_day',
      routine: 'within_48h',
    });
    expect(config.acceptSubmissionsOutsideHours).toBe(true);
    expect(config.outsideHoursMessage).toContain('outside core hours');
  });

  it('allows disabling outside-hours message explicitly', () => {
    const config = resolveCallbackWindowsFromEnv({
      VITE_CALLBACK_OOH_MESSAGE: '    ',
      VITE_CALLBACK_OOH_ACCEPT_SUBMISSIONS: 'true',
    });

    expect(config.outsideHoursMessage).toBeUndefined();
    expect(config.acceptSubmissionsOutsideHours).toBe(true);
  });
});

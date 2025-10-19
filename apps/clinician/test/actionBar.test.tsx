/// <reference types="vitest/globals" />
// @vitest-environment jsdom

import { act } from 'react-dom/test-utils';
import { fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '../src/theme';
import { I18nProvider } from '../src/i18n';
import ActionBar from '../src/components/ActionBar';
import type { ClinicianTaskDetail } from '@onecare/events';

const detail: ClinicianTaskDetail = {
  id: 'task-1',
  clinicId: 'demo',
  priority: 'STAT',
  status: 'NEW',
  shortReason: 'Acute pain',
  patientId: 'p-1',
  waitMs: 10 * 60 * 1000,
  createdAt: new Date().toISOString(),
  narrative: 'Pain rated 9/10',
  attachments: [],
  actionsAllowed: ['CALL'],
  audit: [],
  correlationId: 'corr-xyz'
};

describe('ActionBar', () => {
  it('dispatches resolve after confirmation', async () => {
    const onResolve = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);

    render(
      <ThemeProvider>
        <I18nProvider>
          <ActionBar
            detail={detail}
            onCall={vi.fn()}
            onSchedule={vi.fn()}
            onBook={vi.fn()}
            onEscalate={vi.fn()}
            onResolve={onResolve}
            onError={vi.fn()}
            onSuccess={vi.fn()}
          />
        </I18nProvider>
      </ThemeProvider>
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Resolve/i }));
    });
    expect(onResolve).toHaveBeenCalledTimes(1);
  });
});

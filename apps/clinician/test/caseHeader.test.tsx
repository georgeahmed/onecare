/// <reference types="vitest/globals" />
// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { ThemeProvider } from '../src/theme';
import { I18nProvider } from '../src/i18n';
import { AuthProvider, createDevSession } from '../src/lib/auth';
import CaseHeader from '../src/components/CaseHeader';
import type { ClinicianTaskDetail } from '@onecare/events/src/contracts/clinician-task-detail';

const detail: ClinicianTaskDetail = {
  id: 't-123',
  clinicId: 'demo',
  priority: 'URGENT',
  status: 'NEW',
  shortReason: 'High fever',
  patientId: 'p-1',
  waitMs: 45 * 60 * 1000,
  interpreter: 'es',
  createdAt: new Date().toISOString(),
  narrative: 'Needs assessment for high fever.',
  attachments: [],
  actionsAllowed: ['CALL'],
  audit: [],
  correlationId: 'corr-123'
};

describe('CaseHeader', () => {
  it('renders priority badge, wait time, clinic, narrative, interpreter', () => {
    render(
      <ThemeProvider>
        <I18nProvider>
          <AuthProvider initialSession={createDevSession()}>
            <CaseHeader detail={detail} />
          </AuthProvider>
        </I18nProvider>
      </ThemeProvider>
    );

    expect(screen.getByText('Urgent')).toBeTruthy();
    expect(screen.getByText(/45 minutes/)).toBeTruthy();
    expect(screen.getByText('Downtown Practice')).toBeTruthy();
    expect(screen.getByText('Needs assessment for high fever.')).toBeTruthy();
    expect(screen.getAllByText(/Spanish/)[0]).toBeTruthy();
  });
});

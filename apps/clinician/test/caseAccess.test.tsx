/// <reference types="vitest/globals" />
// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ClinicianTaskDetail, ClinicianTaskSummary } from '@onecare/events';
import CasePage from '../src/pages/Case';
import { ThemeProvider } from '../src/theme';
import { I18nProvider } from '../src/i18n';
import { AuthProvider, createDevSession } from '../src/lib/auth';
import type { QueueGateway, QueueFilters } from '../src/adapters/queue.types';
import { setQueueGateway } from '../src/adapters/gateway';

const foreignDetail: ClinicianTaskDetail = {
  id: 'blocked-1',
  clinicId: 'blocked-clinic',
  priority: 'URGENT',
  status: 'NEW',
  shortReason: 'Test',
  patientId: 'patient-1',
  waitMs: 1000,
  createdAt: new Date().toISOString(),
  narrative: 'narrative',
  attachments: [],
  actionsAllowed: [],
  audit: [],
  correlationId: 'corr-test',
};

const blockedGateway: QueueGateway = {
  setAuthContext: () => {},
  list: async (_f: QueueFilters) => ({ items: [] as ClinicianTaskSummary[] }),
  getById: async (_id: string) => foreignDetail,
  assign: async (_id: string, _assignee?: string) => foreignDetail,
  unassign: async (_id: string) => foreignDetail,
  resolve: async (_id: string, _outcome?: string) => foreignDetail,
  scheduleCallback: async (_id: string, _when?: string) => foreignDetail,
  bookSlot: async (_id: string, _slotId?: string) => foreignDetail,
  assistedOutcome: async (_id: string, _outcome?: string) => foreignDetail,
  recordCall: async (_id: string) => foreignDetail,
  escalate: async (_id: string) => foreignDetail,
  recommendWindows: async (_id: string) => [],
};

describe('CasePage clinic scoping', () => {
  it('renders a forbidden message when the case clinic is not in the session', async () => {
    setQueueGateway(blockedGateway);
    const session = { ...createDevSession(), clinics: [{ id: 'demo', name: 'Demo Clinic' }] };

    render(
      <ThemeProvider>
        <I18nProvider>
          <AuthProvider initialSession={session}>
            <MemoryRouter initialEntries={['/case/blocked-1']}>
              <Routes>
                <Route path="/case/:id" element={<CasePage />} />
              </Routes>
            </MemoryRouter>
          </AuthProvider>
        </I18nProvider>
      </ThemeProvider>
    );

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent ?? '').toContain('access');
  });
});

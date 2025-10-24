/// <reference types="vitest/globals" />
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nProvider } from '../src/i18n';
import { ThemeProvider } from '../src/theme';
import CasePage from '../src/pages/Case';
import type { QueueGateway, QueueFilters } from '../src/adapters/queue.types';
import type { ClinicianTaskDetail, ClinicianTaskSummary } from '@onecare/events';
import { setQueueGateway } from '../src/adapters/gateway';
import { AuthProvider, createDevSession } from '../src/lib/auth';

const detail: ClinicianTaskDetail = {
  id: 'test-1', clinicId: 'demo', priority: 'URGENT', status: 'NEW', shortReason: 'Test', patientId: 'p', waitMs: 1000,
  createdAt: new Date().toISOString(), narrative: 'n', attachments: [], actionsAllowed: ['CALL','SCHEDULE','RESOLVE'], audit: [], correlationId: 'c'
};

const testGateway: QueueGateway = {
  list: async (_f: QueueFilters) => ({ items: [detail as unknown as ClinicianTaskSummary] }),
  getById: async (_id: string) => detail,
  assign: async () => ({ ...detail, status: 'IN_PROGRESS', assignee: 'me' }),
  unassign: async () => ({ ...detail, status: 'NEW', assignee: undefined }),
  resolve: async () => ({ ...detail, status: 'DONE', audit: [{ when: new Date().toISOString(), who: 'me', what: 'resolve' }] }),
  scheduleCallback: async () => ({ ...detail, status: 'IN_PROGRESS' }),
  bookSlot: async () => ({ ...detail, status: 'DONE' }),
  recordCall: async () => ({ ...detail, audit: [...detail.audit, { when: new Date().toISOString(), who: 'me', what: 'call' }] }),
  escalate: async () => ({ ...detail, status: 'IN_PROGRESS' })
};

describe('Case actions basic render', () => {
  it('renders loading state and i18n wiring', () => {
    setQueueGateway(testGateway);
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <I18nProvider>
          <AuthProvider initialSession={createDevSession()}>
            <MemoryRouter initialEntries={["/case/test-1"]}>
              <Routes>
                <Route path="/case/:id" element={<CasePage />} />
              </Routes>
            </MemoryRouter>
          </AuthProvider>
        </I18nProvider>
      </ThemeProvider>
    );
    expect(html).toContain('Loading…');
  });
});

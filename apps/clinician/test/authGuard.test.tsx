/// <reference types="vitest/globals" />
// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '../src/theme';
import { I18nProvider } from '../src/i18n';
import ProtectedRoute from '../src/routes/ProtectedRoute';
import { AuthProvider, createDevSession } from '../src/lib/auth';
import QueuePage from '../src/pages/Queue';
import LoginPage from '../src/pages/Login';

const renderWithProviders = (ui: React.ReactElement, { initialEntries = ['/queue'], session }: { initialEntries?: string[]; session?: ReturnType<typeof createDevSession> | null } = {}) => {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <AuthProvider initialSession={session ?? null}>
          <MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>
        </AuthProvider>
      </I18nProvider>
    </ThemeProvider>
  );
};

describe('ProtectedRoute', () => {
  it('redirects unauthenticated users to login', () => {
    renderWithProviders(
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/queue" element={<QueuePage />} />
        </Route>
        <Route path="/login" element={<LoginPage />} />
      </Routes>,
      { initialEntries: ['/queue'], session: null }
    );

    expect(screen.getByRole('heading', { name: /sign in/i })).toBeTruthy();
  });

  it('renders protected content when authenticated', () => {
    renderWithProviders(
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/queue" element={<div>Protected</div>} />
        </Route>
        <Route path="/login" element={<LoginPage />} />
      </Routes>,
      { initialEntries: ['/queue'], session: createDevSession() }
    );

    expect(screen.getByText('Protected')).toBeTruthy();
  });

  it('blocks settings for non-admin roles', async () => {
    renderWithProviders(
      <Routes>
        <Route element={<ProtectedRoute roles={['admin']} />}>
          <Route path="/settings" element={<div>Settings</div>} />
        </Route>
      </Routes>,
      { initialEntries: ['/settings'], session: createDevSession() }
    );

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Access');
  });
});

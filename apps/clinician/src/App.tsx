import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { useId } from 'react';
import { useIntl } from 'react-intl';
import QueuePage from './pages/Queue';
import CasePage from './pages/Case';
import SettingsPage from './pages/Settings';
import LoginPage from './pages/Login';
import { I18nProvider } from './i18n';
import { ThemeProvider, useTheme } from './theme';
import { AuthProvider } from './lib/auth';
import useAuth from './hooks/useAuth';
import ProtectedRoute from './routes/ProtectedRoute';
import ClinicSwitcher from './components/ClinicSwitcher';

const App = () => {
  return (
    <ThemeProvider>
      <I18nProvider>
        <AuthProvider>
          <AppShell />
        </AuthProvider>
      </I18nProvider>
    </ThemeProvider>
  );
};

const AppShell = () => {
  const intl = useIntl();
  const navLabelId = useId();
  const { status } = useAuth();
  return (
    <div className="app-shell">
      <div className="skip-links" aria-label={intl.formatMessage({ id: 'app.skip.links' })}>
        <a className="skip-link" href="#main-content">{intl.formatMessage({ id: 'app.skip.main' })}</a>
        {status === 'authenticated' ? (
          <a className="skip-link" href="#primary-navigation">{intl.formatMessage({ id: 'app.skip.nav' })}</a>
        ) : null}
      </div>
      <header>
        <div className="app-header-bar">
          {status === 'authenticated' ? (
            <nav id="primary-navigation" aria-labelledby={navLabelId}>
              <h2 id={navLabelId} className="visually-hidden">Primary navigation</h2>
              <Link to="/queue">{intl.formatMessage({ id: 'app.nav.queue' })}</Link>
              <Link to="/settings">{intl.formatMessage({ id: 'app.nav.settings' })}</Link>
            </nav>
          ) : (
            <span className="app-brand">OneCare Clinician Console</span>
          )}
          <div className="app-header-tools">
            <ClinicSwitcher />
            <ThemeSwitcher />
          </div>
        </div>
      </header>
      <main id="main-content" tabIndex={-1}>
        <Routes>
          <Route path="/login" element={status === 'authenticated' ? <Navigate to="/queue" replace /> : <LoginPage />} />
          <Route element={<ProtectedRoute />}> 
            <Route path="/queue" element={<QueuePage />} />
            <Route path="/case/:id" element={<CasePage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
          <Route
            path="*"
            element={<Navigate to={status === 'authenticated' ? '/queue' : '/login'} replace />}
          />
        </Routes>
      </main>
    </div>
  );
};

const ThemeSwitcher = () => {
  const { theme, setTheme } = useTheme();
  const intl = useIntl();
  return (
    <div className="theme-switcher">
      <label htmlFor="theme-select">{intl.formatMessage({ id: 'settings.theme.label' })}</label>
      <select id="theme-select" className="ui-select" value={theme} onChange={(e) => setTheme(e.target.value as any)}>
        <option value="light">{intl.formatMessage({ id: 'settings.theme.light' })}</option>
        <option value="high-contrast">{intl.formatMessage({ id: 'settings.theme.highContrast' })}</option>
      </select>
    </div>
  );
};

export default App;

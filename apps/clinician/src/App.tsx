import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { useId } from 'react';
import { useIntl } from 'react-intl';
import QueuePage from './pages/Queue';
import CasePage from './pages/Case';
import SettingsPage from './pages/Settings';
import { I18nProvider } from './i18n';
import { ThemeProvider, useTheme } from './theme';

const App = () => {
  return (
    <ThemeProvider>
      <I18nProvider>
        <AppShell />
      </I18nProvider>
    </ThemeProvider>
  );
};

const AppShell = () => {
  const intl = useIntl();
  const navLabelId = useId();
  return (
    <div className="app-shell">
      <div className="skip-links" aria-label={intl.formatMessage({ id: 'app.skip.links' })}>
        <a className="skip-link" href="#main-content">{intl.formatMessage({ id: 'app.skip.main' })}</a>
        <a className="skip-link" href="#primary-navigation">{intl.formatMessage({ id: 'app.skip.nav' })}</a>
      </div>
      <header>
        <nav id="primary-navigation" aria-labelledby={navLabelId}>
          <h2 id={navLabelId} className="visually-hidden">Primary navigation</h2>
          <Link to="/queue">{intl.formatMessage({ id: 'app.nav.queue' })}</Link>
          <Link to="/settings">{intl.formatMessage({ id: 'app.nav.settings' })}</Link>
        </nav>
        <ThemeSwitcher />
      </header>
      <main id="main-content" tabIndex={-1}>
        <Routes>
          <Route path="/queue" element={<QueuePage />} />
          <Route path="/case/:id" element={<CasePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/queue" replace />} />
        </Routes>
      </main>
    </div>
  );
};

const ThemeSwitcher = () => {
  const { theme, setTheme } = useTheme();
  return (
    <div style={{ float: 'right' }}>
      <label>
        Theme
        <select className="ui-select" value={theme} onChange={(e) => setTheme(e.target.value as any)}>
          <option value="light">Light</option>
          <option value="high-contrast">High contrast</option>
        </select>
      </label>
    </div>
  );
};

export default App;

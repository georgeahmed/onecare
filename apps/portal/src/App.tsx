import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { useIntl } from 'react-intl';
import IntakePage from './pages/Intake';
import BookingPage from './pages/Booking';
import { I18nProvider } from './i18n';
import LocaleSwitcher from './components/LocaleSwitcher';
import ThemeSwitcher from './components/ThemeSwitcher';
import { ThemeProvider } from './theme';
import useZoomFallback from './hooks/useZoomFallback';
import OfflineNotice from './components/OfflineNotice';
import LocaleNotice from './components/LocaleNotice';

const App = () => (
  <ThemeProvider>
    <I18nProvider>
      <AppLayout />
    </I18nProvider>
  </ThemeProvider>
);

const AppLayout = () => {
  const intl = useIntl();
  useZoomFallback();

  return (
    <div className="app-shell">
      <div className="skip-links" aria-label={intl.formatMessage({ id: 'app.skipLinks.label' })}>
        <a className="skip-link" href="#main-content">
          {intl.formatMessage({ id: 'app.skipToMain' })}
        </a>
        <a className="skip-link" href="#primary-navigation">
          {intl.formatMessage({ id: 'app.skipToNavigation' })}
        </a>
      </div>
      <header>
        <nav
          id="primary-navigation"
          tabIndex={-1}
          aria-label={intl.formatMessage({ id: 'app.primaryNavigation' })}
        >
          <Link to="/intake">{intl.formatMessage({ id: 'app.nav.intake' })}</Link>
          <Link to="/booking">{intl.formatMessage({ id: 'app.nav.booking' })}</Link>
        </nav>
        <div className="app-shell__tools">
          <LocaleSwitcher />
          <ThemeSwitcher />
        </div>
      </header>
      <OfflineNotice />
      <LocaleNotice />
      <Routes>
        <Route path="/intake" element={<IntakePage />} />
        <Route path="/booking" element={<BookingPage />} />
        <Route path="*" element={<Navigate to="/intake" replace />} />
      </Routes>
    </div>
  );
};

export default App;

import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { useIntl } from 'react-intl';
import IntakePage from './pages/Intake';
import BookingPage from './pages/Booking';
import useZoomFallback from './hooks/useZoomFallback';
import OfflineNotice from './components/OfflineNotice';
import LocaleNotice from './components/LocaleNotice';
import LocaleSwitcher from './components/LocaleSwitcher';
import ThemeSwitcher from './components/ThemeSwitcher';
import AppShell from './components/layout/AppShell';

const App = () => {
  const intl = useIntl();
  useZoomFallback();

  const skipLinks = [
    { href: '#main-content', label: intl.formatMessage({ id: 'app.skipToMain' }) },
    { href: '#primary-navigation', label: intl.formatMessage({ id: 'app.skipToNavigation' }) },
  ];

  return (
    <AppShell
      skipLinks={skipLinks}
      skipLinksLabel={intl.formatMessage({ id: 'app.skipLinks.label' })}
      navigationLabel={intl.formatMessage({ id: 'app.primaryNavigation' })}
      navigation={
        <>
          <Link to="/intake">{intl.formatMessage({ id: 'app.nav.intake' })}</Link>
          <Link to="/booking">{intl.formatMessage({ id: 'app.nav.booking' })}</Link>
        </>
      }
      tools={
        <>
          <LocaleSwitcher />
          <ThemeSwitcher />
        </>
      }
    >
      <OfflineNotice />
      <LocaleNotice />
      <Routes>
        <Route path="/intake" element={<IntakePage />} />
        <Route path="/booking" element={<BookingPage />} />
        <Route path="*" element={<Navigate to="/intake" replace />} />
      </Routes>
    </AppShell>
  );
};

export default App;

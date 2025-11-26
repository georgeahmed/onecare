import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { useIntl } from 'react-intl';
import IntakePage from './pages/Intake';
import BookingPage from './pages/Booking';
import useZoomFallback from './hooks/useZoomFallback';
import OfflineNotice from './components/OfflineNotice';
import LocaleNotice from './components/LocaleNotice';
import LocaleSwitcher from './components/LocaleSwitcher';
import ThemeSwitcher from './components/ThemeSwitcher';
import AppShell from './components/layout/AppShell';

const LockIcon = () => (
  <svg
    aria-hidden="true"
    focusable="false"
    className="nav-link__icon"
    viewBox="0 0 24 24"
    role="img"
  >
    <path
      fill="currentColor"
      d="M17 10h-1V7a4 4 0 0 0-8 0v3H7a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1Zm-3 0h-4V7a2 2 0 1 1 4 0v3Zm-2 4.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"
    />
  </svg>
);

const App = () => {
  const intl = useIntl();
  useZoomFallback();

  const bookingLockedReason = intl.formatMessage({ id: 'booking.locked.reason' });

  const skipLinks = [
    { href: '#main-content', label: intl.formatMessage({ id: 'app.skipToMain' }) },
    { href: '#primary-navigation', label: intl.formatMessage({ id: 'app.skipToNavigation' }) },
  ];

  const navLinks = [
    { to: '/intake', label: intl.formatMessage({ id: 'app.nav.intake' }), disabled: false as const },
    {
      to: '/booking',
      label: intl.formatMessage({ id: 'app.nav.booking' }),
      disabled: true as const,
      reason: bookingLockedReason,
    },
  ];

  return (
    <AppShell
      skipLinks={skipLinks}
      skipLinksLabel={intl.formatMessage({ id: 'app.skipLinks.label' })}
      navigationLabel={intl.formatMessage({ id: 'app.primaryNavigation' })}
      brandTitle="Vecells"
      navigation={
        <>
          {navLinks.map(({ to, label, disabled, reason }) => {
            if (!disabled) {
              return (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) => (isActive ? 'nav-link nav-link--active' : 'nav-link')}
                >
                  {label}
                </NavLink>
              );
            }
            const lockedMessage = reason ?? bookingLockedReason;
            return (
              <span
                key={to}
                className="nav-link nav-link--disabled nav-link--locked"
                aria-disabled="true"
                role="link"
                title={lockedMessage}
                aria-label={`${label} — ${lockedMessage}`}
              >
                <LockIcon />
                <span aria-hidden="true">{label}</span>
                <span className="visually-hidden">{lockedMessage}</span>
              </span>
            );
          })}
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

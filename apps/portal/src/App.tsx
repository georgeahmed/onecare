import { Link, Navigate, Route, Routes } from 'react-router-dom';
import IntakePage from './pages/Intake';
import BookingPage from './pages/Booking';
import { I18nProvider } from './i18n';
import LocaleSwitcher from './components/LocaleSwitcher';
import ThemeSwitcher from './components/ThemeSwitcher';
import { ThemeProvider } from './theme';

const App = () => {
  return (
    <ThemeProvider>
      <I18nProvider>
        <div className="app-shell">
          <header>
            <nav aria-label="Primary navigation">
              <Link to="/intake">Intake</Link>
              <Link to="/booking">Booking</Link>
            </nav>
            <div className="app-shell__tools">
              <LocaleSwitcher />
              <ThemeSwitcher />
            </div>
          </header>
          <Routes>
            <Route path="/intake" element={<IntakePage />} />
            <Route path="/booking" element={<BookingPage />} />
            <Route path="*" element={<Navigate to="/intake" replace />} />
          </Routes>
        </div>
      </I18nProvider>
    </ThemeProvider>
  );
};

export default App;

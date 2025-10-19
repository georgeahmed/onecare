import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import AppErrorBoundary from './components/AppErrorBoundary';
import { I18nProvider } from './i18n';
import { startPerformanceMonitoring } from './lib/performance';
import { safeLog } from './lib/telemetry';
import { ThemeProvider } from './theme';
import './styles/global.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

if (typeof window !== 'undefined') {
  startPerformanceMonitoring();
}

const registerPortalServiceWorker = () => {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }

  const serviceWorkerUrl = new URL('./sw.ts', import.meta.url);
  navigator.serviceWorker
    .register(serviceWorkerUrl, { type: 'module' })
    .then((registration) => {
      safeLog('sw.register.success', {
        scope: registration.scope
      });
      if (registration.waiting) {
        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      }
    })
    .catch((error) => {
      safeLog('sw.register.error', {
        message: error instanceof Error ? error.message : String(error)
      });
    });
};

if (typeof window !== 'undefined') {
  window.addEventListener('load', () => {
    registerPortalServiceWorker();
  });
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <I18nProvider>
        <ThemeProvider>
          <AppErrorBoundary>
            <App />
          </AppErrorBoundary>
        </ThemeProvider>
      </I18nProvider>
    </BrowserRouter>
  </React.StrictMode>
);

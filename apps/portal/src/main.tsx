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

const resolveBasename = () => {
  const env =
    typeof import.meta !== 'undefined'
      ? (import.meta as { env?: { BASE_URL?: string } }).env
      : undefined;
  const candidate = typeof env?.BASE_URL === 'string' ? env.BASE_URL : undefined;
  const raw = candidate && candidate.length > 0 ? candidate : '/';
  if (raw === '/') {
    return '/';
  }
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
};

const routerBasename = resolveBasename();

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
    <BrowserRouter basename={routerBasename}>
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

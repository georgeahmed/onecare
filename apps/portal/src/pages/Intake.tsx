import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import IntakeForm from '../components/IntakeForm';
import CallbackWindows from '../components/CallbackWindows';
import { useLocale } from '../i18n';

const IntakePage = () => {
  const intl = useIntl();
  const { direction } = useLocale();
  const mainRef = useRef<HTMLElement>(null);
  const [isWide, setIsWide] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(min-width: 768px)').matches;
  });
  const [showCallbacks, setShowCallbacks] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(min-width: 768px)').matches;
  });

  useEffect(() => {
    mainRef.current?.focus();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia('(min-width: 768px)');
    const handler = (event: MediaQueryListEvent) => {
      setIsWide(event.matches);
      if (event.matches) {
        setShowCallbacks(true);
      }
    };
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const title = intl.formatMessage({ id: 'app.title' });
    document.title = `${title} – Vecells`;
  }, [intl]);

  return (
    <main id="main-content" ref={mainRef} tabIndex={-1} dir={direction} className="page page--intake">
      <section className="page-hero page-hero--compact page-hero--single">
        <div className="page-hero__content">
          <p className="page-hero__eyebrow">{intl.formatMessage({ id: 'app.nav.intake' })}</p>
          <h1 className="page-hero__title">{intl.formatMessage({ id: 'app.title' })}</h1>
          <p className="page-hero__lede">{intl.formatMessage({ id: 'app.description' })}</p>
        </div>
      </section>

      <section className="page-card page-card--surface">
        <IntakeForm />
      </section>

      <section className="page-card page-card--ghost">
        {!showCallbacks ? (
          <button
            type="button"
            className="ui-button ui-button--subtle callback-toggle"
            onClick={() => setShowCallbacks(true)}
          >
            {intl.formatMessage({ id: 'callback.windows.reveal' })}
          </button>
        ) : (
          <CallbackWindows variant="compact" />
        )}
      </section>
    </main>
  );
};

export default IntakePage;

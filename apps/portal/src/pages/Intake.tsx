import { useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';
import IntakeForm from '../components/IntakeForm';
import CallbackWindows from '../components/CallbackWindows';

const IntakePage = () => {
  const intl = useIntl();
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    mainRef.current?.focus();
  }, []);

  return (
    <main id="main-content" ref={mainRef} tabIndex={-1}>
      <header>
        <h1>{intl.formatMessage({ id: 'app.title' })}</h1>
        <p>{intl.formatMessage({ id: 'app.description' })}</p>
        <CallbackWindows />
      </header>
      <IntakeForm />
    </main>
  );
};

export default IntakePage;

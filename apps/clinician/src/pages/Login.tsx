import { useEffect } from 'react';
import { useIntl } from 'react-intl';
import useAuth from '../hooks/useAuth';
import { createDevSession } from '../lib/auth';

const LoginPage = () => {
  const intl = useIntl();
  const { status, login } = useAuth();

  useEffect(() => {
    // In development we can auto-provide a stub session when navigating via dev consoles.
    if (status === 'unauthenticated' && import.meta.env.MODE !== 'production') {
      // no-op: keep manual button; dev helper available on window for quick demos.
    }
  }, [status]);

  const handleDevLogin = () => {
    const session = createDevSession();
    login(session);
  };

  return (
    <main className="login-layout" aria-labelledby="login-heading">
      <section className="login-card">
        <h1 id="login-heading">{intl.formatMessage({ id: 'login.title' })}</h1>
        <p>{intl.formatMessage({ id: 'login.subtitle' })}</p>
        <button type="button" className="ui-button" onClick={handleDevLogin}>
          {intl.formatMessage({ id: 'login.devCta' })}
        </button>
        <p className="login-note">{intl.formatMessage({ id: 'login.note' })}</p>
      </section>
    </main>
  );
};

export default LoginPage;

import { useEffect } from 'react';
import { useIntl } from 'react-intl';
import useAuth from '../hooks/useAuth';
import { createDevSession, isDevLoginEnabled } from '../lib/auth';

const LoginPage = () => {
  const intl = useIntl();
  const { status, login } = useAuth();
  const devLoginEnabled = isDevLoginEnabled();

  useEffect(() => {
    // In development we can auto-provide a stub session when navigating via dev consoles.
    if (status === 'unauthenticated' && import.meta.env.MODE !== 'production') {
      // no-op: keep manual button; dev helper available on window for quick demos.
    }
  }, [status]);

  const handleDevLogin = () => {
    if (!devLoginEnabled) return;
    const session = createDevSession();
    login(session);
  };

  return (
    <main className="login-layout" aria-labelledby="login-heading">
      <section className="login-card">
        <h1 id="login-heading">{intl.formatMessage({ id: 'login.title' })}</h1>
        <p>{intl.formatMessage({ id: 'login.subtitle' })}</p>
        <button type="button" className="ui-button" onClick={handleDevLogin} disabled={!devLoginEnabled}>
          {intl.formatMessage({ id: 'login.devCta' })}
        </button>
        {!devLoginEnabled ? (
          <p className="login-note">
            {intl.formatMessage({ id: 'login.disabled', defaultMessage: 'Sign-in requires a configured identity provider.' })}
          </p>
        ) : null}
        <div className="login-highlights">
          <p className="login-note">{intl.formatMessage({ id: 'login.note' })}</p>
          <ul>
            <li>{intl.formatMessage({ id: 'login.highlight.privacy', defaultMessage: 'No patient data leaves your clinic domain.' })}</li>
            <li>{intl.formatMessage({ id: 'login.highlight.clarity', defaultMessage: 'Gentle colors, high contrast, and accessible controls.' })}</li>
            <li>{intl.formatMessage({ id: 'login.highlight.fast', defaultMessage: 'Purpose-built for today’s queue with instant mock data.' })}</li>
          </ul>
        </div>
      </section>
    </main>
  );
};

export default LoginPage;

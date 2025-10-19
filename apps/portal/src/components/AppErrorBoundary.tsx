import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useIntl, type IntlShape } from 'react-intl';
import Button from './ui/Button';
import { getSessionCorrelationId, recordRumEvent, safeLog } from '../lib/telemetry';

interface AppErrorBoundaryProps {
  children: ReactNode;
  intl: IntlShape;
}

interface AppErrorBoundaryState {
  hasError: boolean;
}

class AppErrorBoundaryImpl extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const correlationId = getSessionCorrelationId();
    safeLog('app.errorBoundary', {
      correlationId,
      message: error?.message ?? 'Unknown error',
      componentStack: info?.componentStack ?? ''
    });
    recordRumEvent('app.error', {
      correlationId,
      message: error?.message ?? 'Unknown error',
      componentStack: info?.componentStack ?? ''
    });
  }

  render(): ReactNode {
    const { hasError } = this.state;
    const { children, intl } = this.props;

    if (!hasError) {
      return children;
    }

    const correlationId = getSessionCorrelationId();

    return (
      <section className="app-fallback" role="alert" aria-live="assertive">
        <h1>{intl.formatMessage({ id: 'app.fallback.title' })}</h1>
        <p>
          {intl.formatMessage({ id: 'app.fallback.body' }, { correlationId })}
        </p>
        <div className="app-fallback__actions">
          <Button
            type="button"
            onClick={() => window.location.reload()}
          >
            {intl.formatMessage({ id: 'app.fallback.reload' })}
          </Button>
          <Button
            type="button"
            variant="subtle"
            onClick={() => window.location.assign('/intake')}
          >
            {intl.formatMessage({ id: 'app.fallback.intake' })}
          </Button>
        </div>
      </section>
    );
  }
}

const AppErrorBoundary = ({ children }: { children: ReactNode }) => {
  const intl = useIntl();
  return <AppErrorBoundaryImpl intl={intl}>{children}</AppErrorBoundaryImpl>;
};

export default AppErrorBoundary;

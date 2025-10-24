import { MouseEvent, useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';
import Alert from './ui/Alert';
import { toFieldId } from '../features/schemaForm/SchemaForm';

type ErrorSummaryItem = {
  path: string;
  message: string;
};

export interface ErrorSummaryProps {
  errors: ErrorSummaryItem[];
  autoFocus?: boolean;
}

const ErrorSummary = ({ errors, autoFocus = false }: ErrorSummaryProps) => {
  const intl = useIntl();
  const containerRef = useRef<HTMLElement | null>(null);

  if (!errors.length) {
    return null;
  }

  const handleClick = (event: MouseEvent<HTMLAnchorElement>, path: string) => {
    event.preventDefault();
    const targetId = toFieldId(path);
    const node = document.getElementById(targetId);
    node?.focus?.();
    node?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  };

  useEffect(() => {
    if (!autoFocus) return;
    const node = containerRef.current;
    if (!node) return;
    node.focus();
  }, [autoFocus]);

  return (
    <Alert
      ref={containerRef}
      variant="error"
      role="alert"
      tabIndex={-1}
      aria-live="assertive"
      className="error-summary"
      title={intl.formatMessage({ id: 'schemaForm.errorSummary.title' })}
    >
      <p>{intl.formatMessage({ id: 'schemaForm.errorSummary.description' })}</p>
      <ul>
        {errors.map((item) => (
          <li key={item.path}>
            <a href={`#${toFieldId(item.path)}`} onClick={(event) => handleClick(event, item.path)}>
              {item.message}
            </a>
          </li>
        ))}
      </ul>
    </Alert>
  );
};

export default ErrorSummary;

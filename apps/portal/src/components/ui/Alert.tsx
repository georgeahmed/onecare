import { forwardRef } from 'react';
import { classNames } from '../../lib/classNames';

export interface AlertProps extends React.HTMLAttributes<HTMLElement> {
  variant?: 'info' | 'error';
  title?: string;
}

const Alert = forwardRef<HTMLElement, AlertProps>(
  ({ variant = 'info', title, className, children, ...rest }, ref) => {
    const variantClass = variant === 'error' ? 'ui-alert--error' : '';

    return (
      <section ref={ref} className={classNames('ui-alert', variantClass, className)} {...rest}>
        {title ? <h2>{title}</h2> : null}
        {children}
      </section>
    );
  }
);

Alert.displayName = 'Alert';

export default Alert;

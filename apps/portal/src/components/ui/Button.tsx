import { forwardRef } from 'react';
import { classNames } from '../../lib/classNames';

export type ButtonVariant = 'primary' | 'subtle' | 'danger';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ variant = 'primary', className, ...rest }, ref) => {
  const variantClass =
    variant === 'danger'
      ? 'ui-button--danger'
      : variant === 'subtle'
      ? 'ui-button--subtle'
      : '';

  return <button ref={ref} className={classNames('ui-button', variantClass, className)} {...rest} />;
});

Button.displayName = 'Button';

export default Button;

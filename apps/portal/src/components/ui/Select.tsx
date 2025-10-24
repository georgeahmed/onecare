import { forwardRef } from 'react';
import { classNames } from '../../lib/classNames';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  fieldClassName?: string;
  label?: string;
  hint?: string;
  hintId?: string;
}

const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, fieldClassName, label, hint, hintId, id, required, children, ...rest }, ref) => {
    const descriptionId = hint ? hintId ?? `${id}-hint` : undefined;

    return (
      <div className={classNames('ui-field', fieldClassName)}>
        {label ? (
          <label className="ui-field__label" htmlFor={id}>
            {label}
            {required ? (
              <span aria-hidden="true">
                {' '}
                *
              </span>
            ) : null}
          </label>
        ) : null}
        <select
          ref={ref}
          className={classNames('ui-select', className)}
          id={id}
          aria-describedby={descriptionId}
          {...rest}
        >
          {children}
        </select>
        {hint ? (
          <p className="ui-field__hint" id={descriptionId}>
            {hint}
          </p>
        ) : null}
      </div>
    );
  }
);

Select.displayName = 'Select';

export default Select;

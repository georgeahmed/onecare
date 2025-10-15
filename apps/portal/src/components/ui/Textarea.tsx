import { forwardRef } from 'react';
import { classNames } from '../../lib/classNames';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  fieldClassName?: string;
  label?: string;
  hint?: string;
  hintId?: string;
}

const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, fieldClassName, label, hint, hintId, id, required, ...rest }, ref) => {
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
        <textarea
          ref={ref}
          className={classNames('ui-textarea', className)}
          id={id}
          aria-describedby={descriptionId}
          {...rest}
        />
        {hint ? (
          <p className="ui-field__hint" id={descriptionId}>
            {hint}
          </p>
        ) : null}
      </div>
    );
  }
);

Textarea.displayName = 'Textarea';

export default Textarea;

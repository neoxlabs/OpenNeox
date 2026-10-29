import React from 'react';

interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  className?: string;
}

/* NeoxInput — text input, 1px hairline + focus ring (primary-ring).
 *   多行用 NeoxTextarea (下面那个). */
export const NeoxInput = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...rest }, ref) => {
    const cls = ['nx-input', className].filter(Boolean).join(' ');
    return <input ref={ref} {...rest} className={cls} />;
  },
);
NeoxInput.displayName = 'NeoxInput';

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  className?: string;
}

export const NeoxTextarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...rest }, ref) => {
    const cls = ['nx-input', className].filter(Boolean).join(' ');
    return <textarea ref={ref} {...rest} className={cls} />;
  },
);
NeoxTextarea.displayName = 'NeoxTextarea';

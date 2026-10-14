import * as React from 'react';
import { cn } from '@/lib/utils';

export const fieldClasses =
  'flex w-full rounded-md border border-input bg-background/60 px-3 text-sm text-foreground shadow-sm transition-[border-color,box-shadow] placeholder:text-subtle hover:border-subtle/60 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger/20';

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, type, ...props }, ref) => (
  <input ref={ref} type={type ?? 'text'} className={cn(fieldClasses, 'h-10 sm:h-9', className)} {...props} />
));
Input.displayName = 'Input';

const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(fieldClasses, 'min-h-[88px] py-2 leading-relaxed', className)} {...props} />
));
Textarea.displayName = 'Textarea';

export { Input, Textarea };

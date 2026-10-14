import { OTPInput, OTPInputContext, REGEXP_ONLY_DIGITS } from 'input-otp';
import * as React from 'react';
import { cn } from '@/lib/utils';

const InputOTP = React.forwardRef<React.ElementRef<typeof OTPInput>, React.ComponentPropsWithoutRef<typeof OTPInput>>(({ className, containerClassName, ...props }, ref) => (
  <OTPInput
    ref={ref}
    containerClassName={cn('flex items-center gap-2 has-[:disabled]:opacity-50', containerClassName)}
    className={cn('disabled:cursor-not-allowed', className)}
    {...props}
  />
));
InputOTP.displayName = 'InputOTP';

const InputOTPGroup = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('flex items-center gap-1.5', className)} {...props} />
));
InputOTPGroup.displayName = 'InputOTPGroup';

const InputOTPSlot = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { index: number; invalid?: boolean }>(({ index, invalid, className, ...props }, ref) => {
  const context = React.useContext(OTPInputContext);
  const slot = context.slots[index];
  return (
    <div
      ref={ref}
      className={cn(
        'relative flex h-12 w-10 items-center justify-center rounded-md border border-input bg-background/60 font-mono text-lg font-medium tabular shadow-sm transition-[border-color,box-shadow]',
        slot?.isActive && 'z-10 border-ring ring-2 ring-ring/25',
        invalid && 'border-danger',
        className,
      )}
      {...props}
    >
      {slot?.char}
      {slot?.hasFakeCaret ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-5 w-px animate-caret-blink bg-foreground" />
        </div>
      ) : null}
    </div>
  );
});
InputOTPSlot.displayName = 'InputOTPSlot';

interface CodeInputProps {
  length: number;
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  id?: string;
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  /** `one-time-code` pour les codes reçus ou générés ; `off` sinon. */
  autoComplete?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  className?: string;
}

/** Champ de code numérique (TOTP, code mail, code d'appareil), coupé en deux groupes lisibles. */
function CodeInput({ length, value, onChange, onComplete, invalid, className, autoComplete = 'one-time-code', ...props }: CodeInputProps) {
  const half = Math.ceil(length / 2);
  const indexes = Array.from({ length }, (_, index) => index);
  return (
    <InputOTP
      maxLength={length}
      value={value}
      onChange={onChange}
      onComplete={onComplete}
      pattern={REGEXP_ONLY_DIGITS}
      inputMode="numeric"
      autoComplete={autoComplete}
      aria-invalid={invalid || undefined}
      containerClassName={className}
      {...props}
    >
      <InputOTPGroup>
        {indexes.slice(0, half).map((index) => (
          <InputOTPSlot key={index} index={index} invalid={invalid} className={length > 6 ? 'w-9' : undefined} />
        ))}
      </InputOTPGroup>
      <span className="h-px w-2 shrink-0 bg-input" aria-hidden />
      <InputOTPGroup>
        {indexes.slice(half).map((index) => (
          <InputOTPSlot key={index} index={index} invalid={invalid} className={length > 6 ? 'w-9' : undefined} />
        ))}
      </InputOTPGroup>
    </InputOTP>
  );
}

export { CodeInput, InputOTP, InputOTPGroup, InputOTPSlot };

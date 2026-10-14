import * as ProgressPrimitive from '@radix-ui/react-progress';
import * as React from 'react';
import { clamp, cn } from '@/lib/utils';

interface ProgressProps extends Omit<React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>, 'value'> {
  value: number;
  indicatorClassName?: string;
}

const Progress = React.forwardRef<React.ElementRef<typeof ProgressPrimitive.Root>, ProgressProps>(({ className, value, indicatorClassName, ...props }, ref) => {
  const safe = clamp(Number.isFinite(value) ? value : 0, 0, 100);
  return (
    <ProgressPrimitive.Root ref={ref} value={safe} className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-muted', className)} {...props}>
      <ProgressPrimitive.Indicator
        className={cn('h-full rounded-full bg-primary transition-[width] duration-500 ease-out', indicatorClassName)}
        style={{ width: `${safe}%` }}
      />
    </ProgressPrimitive.Root>
  );
});
Progress.displayName = 'Progress';

export { Progress };

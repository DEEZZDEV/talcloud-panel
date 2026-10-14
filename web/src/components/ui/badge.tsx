import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-xs font-medium leading-none', {
  variants: {
    tone: {
      neutral: 'border-border bg-muted text-muted-foreground',
      success: 'border-success/20 bg-success/10 text-success',
      warning: 'border-warning/25 bg-warning/10 text-warning',
      danger: 'border-danger/25 bg-danger/10 text-danger',
      info: 'border-info/25 bg-info/10 text-info',
      primary: 'border-primary/30 bg-primary/10 text-link',
      outline: 'border-border bg-transparent text-foreground',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export { Badge, badgeVariants };

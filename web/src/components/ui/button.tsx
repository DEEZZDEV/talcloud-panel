import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { LoaderCircle } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'relative inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90',
        secondary: 'border border-border bg-secondary text-secondary-foreground hover:bg-accent',
        outline: 'border border-input bg-transparent text-foreground hover:bg-accent',
        ghost: 'text-foreground hover:bg-accent',
        subtle: 'text-muted-foreground hover:bg-accent hover:text-foreground',
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
        'destructive-outline': 'border border-danger/30 bg-danger/5 text-danger hover:bg-danger/10',
        link: 'h-auto p-0 text-link underline-offset-4 hover:underline active:scale-100',
      },
      size: {
        default: 'h-10 px-4 sm:h-9',
        sm: 'h-10 px-3 text-[13px] sm:h-8',
        lg: 'h-11 px-5 text-[15px]',
        icon: 'size-10 sm:size-9',
        'icon-sm': 'size-10 sm:size-8',
      },
    },
    compoundVariants: [{ variant: 'link', class: 'h-auto px-0 sm:h-auto' }],
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** Affiche un indicateur de chargement et désactive le bouton. */
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild = false, loading = false, disabled, children, type, ...props }, ref) => {
  if (asChild) {
    return (
      <Slot ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props}>
        {children}
      </Slot>
    );
  }
  return (
    <button ref={ref} type={type ?? 'button'} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {loading ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
});
Button.displayName = 'Button';

export { Button, buttonVariants };

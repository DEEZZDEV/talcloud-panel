import * as AvatarPrimitive from '@radix-ui/react-avatar';
import * as React from 'react';
import { cn } from '@/lib/utils';

const Avatar = React.forwardRef<React.ElementRef<typeof AvatarPrimitive.Root>, React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Root ref={ref} className={cn('relative flex size-8 shrink-0 overflow-hidden rounded-full', className)} {...props} />
));
Avatar.displayName = 'Avatar';

const AvatarFallback = React.forwardRef<React.ElementRef<typeof AvatarPrimitive.Fallback>, React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>>(
  ({ className, ...props }, ref) => (
    <AvatarPrimitive.Fallback
      ref={ref}
      className={cn('flex size-full items-center justify-center rounded-full border bg-muted text-[11px] font-semibold uppercase tracking-wide text-muted-foreground', className)}
      {...props}
    />
  ),
);
AvatarFallback.displayName = 'AvatarFallback';

export { Avatar, AvatarFallback };

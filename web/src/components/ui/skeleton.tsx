import * as React from 'react';
import { cn } from '@/lib/utils';

/** Bloc de chargement avec reflet discret. Décoratif : masqué aux lecteurs d'écran. */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn(
        'relative overflow-hidden rounded-md bg-muted before:absolute before:inset-0 before:-translate-x-full before:animate-shimmer before:bg-gradient-to-r before:from-transparent before:via-foreground/[0.06] before:to-transparent',
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };

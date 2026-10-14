import { Badge } from '@/components/ui/badge';
import type { StatusDescriptor, Tone } from '@/lib/status';
import { cn } from '@/lib/utils';

const DOT: Record<Tone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  neutral: 'bg-subtle',
};

/** Point de couleur seul (listes denses). Toujours accompagné d'un libellé visible ou lu. */
export function StatusDot({ tone, pulse, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-1.5 shrink-0 rounded-full', DOT[tone], pulse && 'animate-pulse-dot', className)} />;
}

/** Badge de statut : même vocabulaire visuel dans tout le panel (point + libellé). */
export function StatusBadge({ status, className }: { status: StatusDescriptor; className?: string }) {
  return (
    <Badge tone={status.tone} className={className}>
      <StatusDot tone={status.tone} pulse={status.pulse} />
      {status.label}
    </Badge>
  );
}

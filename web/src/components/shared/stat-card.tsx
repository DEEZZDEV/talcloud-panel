import { ArrowDownRight, ArrowUpRight, Minus, type LucideIcon } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDelta } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Variation en % : flèche + valeur signée ; la couleur dépend du sens ET de « une hausse est-elle une bonne nouvelle ». */
export function Delta({ value, positiveIsGood = true, className }: { value: number | null | undefined; positiveIsGood?: boolean; className?: string }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const flat = Math.abs(value) < 0.05;
  const good = value > 0 === positiveIsGood;
  const Icon = flat ? Minus : value > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        'tabular inline-flex h-5 shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full px-1.5 text-xs font-medium',
        flat ? 'bg-muted text-muted-foreground' : good ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger',
        className,
      )}
    >
      <Icon className="size-3" aria-hidden />
      <span className="sr-only">{flat ? 'Stable : ' : value > 0 ? 'En hausse : ' : 'En baisse : '}</span>
      {formatDelta(value)}
    </span>
  );
}

/** Mini-courbe (12 points max) sur toute la largeur de la carte : tracé discret, dernier point mis en avant. */
export function Sparkline({ values, className, label }: { values: number[]; className?: string; label?: string }) {
  const id = useId();
  if (values.length < 2) return null;
  const width = 100;
  const height = 32;
  const pad = 4;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - pad - ((value - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });
  const line = points.map(([x, y], index) => (index === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2)).join(' ');
  const last = points[points.length - 1] ?? ([0, 0] as const);
  const area = line + ' L' + width + ' ' + height + ' L0 ' + height + ' Z';
  return (
    <div className={cn('relative h-8 w-full', className)} role="img" aria-label={label ?? 'Tendance sur 12 mois'}>
      <div className="absolute inset-y-0 left-0 right-1">
        <svg viewBox={'0 0 ' + width + ' ' + height} className="size-full overflow-visible" preserveAspectRatio="none" aria-hidden>
          <defs>
            <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity="0.2" />
              <stop offset="100%" stopColor="var(--chart-1)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={'url(#' + id + ')'} />
          <path d={line} fill="none" stroke="var(--chart-1)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" opacity="0.8" />
        </svg>
      </div>
      {/* Dernier point : pastille HTML (un cercle SVG serait déformé par l'étirement horizontal). */}
      <span aria-hidden className="absolute right-0 size-2 -translate-y-1/2 rounded-full ring-2 ring-card" style={{ top: (last[1] / height) * 100 + '%', backgroundColor: 'var(--chart-1)' }} />
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: ReactNode;
  icon?: LucideIcon;
  delta?: number | null;
  positiveIsGood?: boolean;
  /** Texte secondaire sous la valeur (« vs mois précédent », détail…). */
  hint?: ReactNode;
  trend?: number[];
  tone?: 'default' | 'warning' | 'danger';
  className?: string;
}

/** Carte de statistique : libellé, valeur, variation colorée et mini-courbe quand elle est pertinente. */
export function StatCard({ label, value, icon: Icon, delta, positiveIsGood, hint, trend, tone = 'default', className }: StatCardProps) {
  return (
    <Card className={cn('flex h-full min-h-[124px] flex-col gap-3 p-4 sm:p-5', className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-[13px] font-medium text-muted-foreground">{label}</p>
        {Icon ? <Icon className={cn('size-4 shrink-0', tone === 'warning' ? 'text-warning' : tone === 'danger' ? 'text-danger' : 'text-subtle')} aria-hidden /> : null}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <p className="truncate text-2xl font-semibold leading-none tracking-tight sm:text-[26px]">{value}</p>
        <div className="flex min-h-5 items-center gap-2">
          <Delta value={delta} positiveIsGood={positiveIsGood} />
          {hint ? <span className="min-w-0 truncate text-xs text-muted-foreground">{hint}</span> : null}
        </div>
      </div>
      {trend && trend.length > 1 ? <Sparkline values={trend} className="mt-auto" /> : null}
    </Card>
  );
}

export function StatCardSkeleton({ className }: { className?: string }) {
  return (
    <Card className={cn('flex min-h-[124px] flex-col gap-3 p-4 sm:p-5', className)}>
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="size-4 rounded" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-28" />
      </div>
      <Skeleton className="mt-auto h-8 w-full" />
    </Card>
  );
}

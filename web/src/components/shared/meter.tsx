import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { clamp, cn } from '@/lib/utils';

/** Couleur de remplissage selon la charge : accent → avertissement → critique. */
function severityClass(percent: number): string {
  if (percent >= 90) return 'bg-danger';
  if (percent >= 75) return 'bg-warning';
  return 'bg-primary';
}

interface MeterProps {
  label: string;
  /** 0–100, ou null si la mesure est indisponible / sans limite. */
  percent: number | null;
  /** Texte de droite (« 2,1 Go / 4 Go », « 37 % »…). */
  value: ReactNode;
  icon?: LucideIcon;
  className?: string;
}

/** Jauge de ressource (CPU, RAM, disque) avec libellé et valeur lisibles. */
export function Meter({ label, percent, value, icon: Icon, className }: MeterProps) {
  const safe = percent === null || !Number.isFinite(percent) ? null : clamp(percent, 0, 100);
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          {Icon ? <Icon className="size-3.5" aria-hidden /> : null}
          {label}
        </span>
        <span className="tabular truncate font-medium text-foreground">{value}</span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={safe === null ? undefined : Math.round(safe)}
        aria-valuetext={safe === null ? 'Indisponible' : `${Math.round(safe)} %`}
      >
        {safe === null ? null : (
          <div className={cn('h-full rounded-full transition-[width,background-color] duration-500 ease-out', severityClass(safe))} style={{ width: `${Math.max(safe, safe > 0 ? 2 : 0)}%` }} />
        )}
      </div>
    </div>
  );
}

/** Rapport en % ; null si le total est nul (illimité / inconnu). */
export const ratio = (used: number | null | undefined, total: number | null | undefined): number | null =>
  used === null || used === undefined || !total || total <= 0 ? null : (used / total) * 100;

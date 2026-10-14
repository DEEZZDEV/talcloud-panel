import { Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

/** Avertissement discret : WHMCS contient plus de données que ce que le panel a pu parcourir. */
export function TruncatedNotice({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <p role="status" className={cn('flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground', className)}>
      <Info className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
      <span>{children ?? 'Résultats partiels : WHMCS contient plus de données que ce que le panel a pu parcourir. Affinez la recherche pour être exhaustif.'}</span>
    </p>
  );
}

/** Lien vers la fiche d'un client (le nom vient de WHMCS : rendu en texte). */
export function ClientLink({ id, name, className }: { id: number; name: string; className?: string }) {
  if (!Number.isInteger(id) || id <= 0) return <span className={className}>{name || '—'}</span>;
  return (
    <Link to={`/whmcs/clients/${id}`} className={cn('font-medium underline-offset-4 hover:text-link hover:underline', className)}>
      {name || `Client #${id}`}
    </Link>
  );
}

export const COST_CATEGORY_LABELS = {
  servers: 'Serveurs',
  licenses: 'Licences',
  network: 'Réseau',
  software: 'Logiciels',
  staff: 'Personnel',
  fees: 'Frais',
  other: 'Autre',
} as const;

export const COST_RECURRENCE_LABELS = {
  monthly: 'Mensuel',
  yearly: 'Annuel',
  one_time: 'Ponctuel',
} as const;

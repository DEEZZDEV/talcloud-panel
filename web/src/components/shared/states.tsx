import type { IntegrationName } from '@shared/api-types';
import type { UseQueryResult } from '@tanstack/react-query';
import { CircleAlert, PlugZap, RotateCw, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { errorMessage, isApiError, isNotConfigured } from '@/lib/api';
import { cn } from '@/lib/utils';

export const INTEGRATION_LABELS: Record<IntegrationName, string> = {
  whmcs: 'WHMCS',
  pterodactyl: 'Pterodactyl',
  proxmox: 'Proxmox',
  mail: 'Mails',
  notifications: 'Notifications',
};

interface StateProps {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  tone?: 'neutral' | 'danger' | 'primary';
  className?: string;
}

/** Gabarit commun des états vides, d'erreur et « non configuré ». */
export function StateBlock({ icon: Icon, title, description, action, compact, tone = 'neutral', className }: StateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'gap-2 px-4 py-8' : 'gap-3 px-6 py-14', className)}>
      {Icon ? (
        <div
          className={cn(
            'flex items-center justify-center rounded-full border',
            compact ? 'size-9' : 'size-11',
            tone === 'danger' && 'border-danger/25 bg-danger/10 text-danger',
            tone === 'primary' && 'border-primary/30 bg-primary/10 text-link',
            tone === 'neutral' && 'bg-muted text-muted-foreground',
          )}
        >
          <Icon className={compact ? 'size-4' : 'size-5'} aria-hidden />
        </div>
      ) : null}
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-sm font-medium">{title}</p>
        {description ? <p className="text-[13px] leading-relaxed text-muted-foreground">{description}</p> : null}
      </div>
      {action ? <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </div>
  );
}

export function EmptyState(props: StateProps) {
  return <StateBlock {...props} />;
}

export function ErrorState({ error, onRetry, compact, className, title }: { error: unknown; onRetry?: () => void; compact?: boolean; className?: string; title?: string }) {
  const upstream = isApiError(error) && error.code === 'UPSTREAM_ERROR';
  return (
    <div role="alert" className={className}>
      <StateBlock
        icon={CircleAlert}
        tone="danger"
        compact={compact}
        title={title ?? (upstream ? 'Le service distant ne répond pas' : 'Chargement impossible')}
        description={errorMessage(error, 'Une erreur inattendue est survenue.')}
        action={
          onRetry ? (
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RotateCw aria-hidden />
              Réessayer
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}

export function NotConfiguredState({ integration, compact, className }: { integration: IntegrationName; compact?: boolean; className?: string }) {
  const label = INTEGRATION_LABELS[integration];
  return (
    <StateBlock
      icon={PlugZap}
      tone="primary"
      compact={compact}
      className={className}
      title={`${label} n'est pas encore configuré`}
      description={`Renseignez l'accès à ${label} dans les réglages pour afficher ces données.`}
      action={
        <Button asChild size="sm">
          <Link to={`/settings#${integration}`}>Configurer</Link>
        </Button>
      }
    />
  );
}

interface QueryBoundaryProps<T> {
  query: UseQueryResult<T>;
  /** Squelette fidèle à la mise en page finale. */
  skeleton: ReactNode;
  /** Intégration affichée si l'API ne précise pas laquelle manque. */
  integration?: IntegrationName;
  compact?: boolean;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}

/**
 * Rend un bloc selon l'état de sa requête : chargement, intégration non configurée, erreur (avec « Réessayer »),
 * vide ou données. Chaque bloc d'une page l'utilise indépendamment des autres.
 */
export function QueryBoundary<T>({ query, skeleton, integration, compact, isEmpty, empty, children }: QueryBoundaryProps<T>) {
  if (query.data !== undefined) {
    if (isEmpty?.(query.data) && empty) return <>{empty}</>;
    return <>{children(query.data)}</>;
  }
  if (query.isError) {
    if (isNotConfigured(query.error)) {
      const name = query.error.integration ?? integration;
      if (name) return <NotConfiguredState integration={name} compact={compact} />;
    }
    return <ErrorState error={query.error} compact={compact} onRetry={() => void query.refetch()} />;
  }
  return <>{skeleton}</>;
}

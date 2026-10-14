import { Check, Copy, ExternalLink as ExternalLinkIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button, type ButtonProps } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { cn, safeExternalUrl } from '@/lib/utils';

/** Copie dans le presse-papiers avec retour visuel. */
export function CopyButton({ value, label = 'Copier', ...props }: { value: string; label?: string } & Omit<ButtonProps, 'onClick' | 'value'>) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      variant="outline"
      size="sm"
      {...props}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          toast.error('Copie impossible : sélectionnez le texte manuellement.');
        }
      }}
    >
      {copied ? <Check className="text-success" aria-hidden /> : <Copy aria-hidden />}
      {copied ? 'Copié' : label}
    </Button>
  );
}

/**
 * Lien externe construit à partir d'une donnée d'API : rendu uniquement si l'URL est en http(s),
 * toujours avec `rel="noopener noreferrer"`.
 */
export function ExternalLink({ href, children, className, asButton }: { href: string | null | undefined; children: ReactNode; className?: string; asButton?: boolean }) {
  const safe = safeExternalUrl(href);
  if (!safe) return null;
  if (asButton) {
    return (
      <Button asChild variant="outline" size="sm" className={className}>
        <a href={safe} target="_blank" rel="noopener noreferrer">
          {children}
          <ExternalLinkIcon aria-hidden />
        </a>
      </Button>
    );
  }
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer" className={cn('inline-flex items-center gap-1 text-link underline-offset-4 hover:underline', className)}>
      {children}
      <ExternalLinkIcon className="size-3.5" aria-hidden />
    </a>
  );
}

/** Champ de formulaire : libellé, aide, message d'erreur reliés au contrôle. */
export function Field({
  id,
  label,
  hint,
  error,
  children,
  className,
  optional,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
  optional?: boolean;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={id} className="flex items-center gap-1.5">
        {label}
        {optional ? <span className="text-xs font-normal leading-none text-subtle">facultatif</span> : null}
      </Label>
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs leading-snug text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Ligne « libellé : valeur » des fiches de détail. */
export function DetailRow({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-start justify-between gap-4 py-2 text-[13px]', className)}>
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium">{children}</dd>
    </div>
  );
}

import { ArrowLeft, Compass } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';

export default function NotFoundPage() {
  const location = useLocation();
  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] items-center justify-center px-6 py-16">
      <div className="relative flex max-w-md flex-col items-center gap-4 text-center">
        <p aria-hidden className="tabular select-none bg-gradient-to-b from-foreground/25 to-foreground/[0.03] bg-clip-text text-[112px] font-semibold leading-none tracking-tighter text-transparent sm:text-[144px]">
          404
        </p>
        <div className="-mt-6 flex size-11 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-card">
          <Compass className="size-5" aria-hidden />
        </div>
        <h1 className="text-xl font-semibold">Cette page n'existe pas</h1>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          L'adresse <span className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{location.pathname}</span> ne correspond à aucune page du panel. Elle a
          peut-être été déplacée.
        </p>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          <Button asChild>
            <Link to="/">
              <ArrowLeft aria-hidden />
              Retour à l'accueil
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/notifications">Voir les notifications</Link>
          </Button>
        </div>
        <p className="mt-2 text-xs text-subtle">Astuce : Ctrl+K ouvre la recherche globale.</p>
      </div>
    </div>
  );
}

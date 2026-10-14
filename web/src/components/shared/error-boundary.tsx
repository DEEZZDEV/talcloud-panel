import { Bug } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

interface Props {
  children: ReactNode;
  /** Change de valeur pour réinitialiser la limite (ex. changement de page). */
  resetKey?: string;
  fullScreen?: boolean;
}
interface State {
  failed: boolean;
}

/** Limite d'erreur React : une page qui plante n'emporte pas tout le panel, et aucun détail technique n'est affiché. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Trace dans la console du navigateur uniquement (diagnostic) : rien n'est affiché à l'écran ni envoyé ailleurs.
    console.error('[TalCloud Panel] erreur de rendu', error, import.meta.env.DEV ? info.componentStack : '');
  }

  override componentDidUpdate(previous: Props): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className={this.props.fullScreen ? 'flex min-h-dvh items-center justify-center p-6' : 'flex min-h-[60vh] items-center justify-center p-6'}>
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <div className="flex size-11 items-center justify-center rounded-full border border-danger/25 bg-danger/10 text-danger">
            <Bug className="size-5" aria-hidden />
          </div>
          <h1 className="text-base font-semibold">Un problème d'affichage est survenu</h1>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Cette page n'a pas pu s'afficher correctement. Vos données ne sont pas affectées. Réessayez, ou rechargez le panel si le problème persiste.
          </p>
          <div className="mt-1 flex flex-wrap justify-center gap-2">
            <Button variant="outline" onClick={() => this.setState({ failed: false })}>
              Réessayer
            </Button>
            <Button onClick={() => window.location.reload()}>Recharger le panel</Button>
          </div>
        </div>
      </div>
    );
  }
}

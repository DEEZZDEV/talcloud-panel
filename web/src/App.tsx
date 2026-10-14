import { LoaderCircle, WifiOff } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Logo } from '@/components/layout/sidebar';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/auth/auth-context';
import { StepUpDialog } from '@/features/auth/step-up-dialog';

// Chargement paresseux : chaque page (et la coquille connectée) est un bundle séparé.
const AppLayout = lazy(() => import('@/components/layout/app-layout'));
const LoginPage = lazy(() => import('@/pages/login'));
const HomePage = lazy(() => import('@/pages/home'));
const WhmcsDashboardPage = lazy(() => import('@/pages/whmcs/dashboard'));
const WhmcsClientsPage = lazy(() => import('@/pages/whmcs/clients'));
const WhmcsClientPage = lazy(() => import('@/pages/whmcs/client-detail'));
const WhmcsOrdersPage = lazy(() => import('@/pages/whmcs/orders'));
const WhmcsInvoicesPage = lazy(() => import('@/pages/whmcs/invoices'));
const WhmcsCostsPage = lazy(() => import('@/pages/whmcs/costs'));
const NotificationsPage = lazy(() => import('@/pages/notifications'));
const MailPage = lazy(() => import('@/pages/mail'));
const GameServersPage = lazy(() => import('@/pages/game-servers'));
const ProxmoxPage = lazy(() => import('@/pages/proxmox'));
const SecurityPage = lazy(() => import('@/pages/security'));
const SettingsPage = lazy(() => import('@/pages/settings'));
const NotFoundPage = lazy(() => import('@/pages/not-found'));

function Splash() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5" role="status" aria-label="Chargement du panel">
      <Logo />
      <LoaderCircle className="size-5 animate-spin text-muted-foreground" aria-hidden />
    </div>
  );
}

function Unreachable() {
  const { refresh } = useAuth();
  return (
    <div className="flex min-h-dvh items-center justify-center p-6" role="alert">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <div className="flex size-11 items-center justify-center rounded-full border bg-muted text-muted-foreground">
          <WifiOff className="size-5" aria-hidden />
        </div>
        <h1 className="text-base font-semibold">Serveur injoignable</h1>
        <p className="text-[13px] leading-relaxed text-muted-foreground">Le panel ne répond pas pour le moment. Vérifiez votre connexion, puis réessayez.</p>
        <Button className="mt-1" onClick={() => void refresh(true)}>
          Réessayer
        </Button>
      </div>
    </div>
  );
}

/** N'affiche l'application que pour une session ouverte ; sinon renvoie à la connexion en mémorisant la page demandée. */
function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Splash />;
  if (status === 'error') return <Unreachable />;
  if (status !== 'authenticated') return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  return <AppLayout />;
}

export default function App() {
  return (
    <>
      <Suspense fallback={<Splash />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireAuth />}>
            <Route index element={<HomePage />} />
            <Route path="whmcs" element={<WhmcsDashboardPage />} />
            <Route path="whmcs/clients" element={<WhmcsClientsPage />} />
            <Route path="whmcs/clients/:id" element={<WhmcsClientPage />} />
            <Route path="whmcs/orders" element={<WhmcsOrdersPage />} />
            <Route path="whmcs/invoices" element={<WhmcsInvoicesPage />} />
            <Route path="whmcs/costs" element={<WhmcsCostsPage />} />
            <Route path="notifications" element={<NotificationsPage />} />
            <Route path="mail" element={<MailPage />} />
            <Route path="servers" element={<GameServersPage />} />
            <Route path="proxmox" element={<ProxmoxPage />} />
            <Route path="security" element={<SecurityPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </Suspense>
      {/* Re-confirmation 2FA : une seule boîte de dialogue pour toute l'application. */}
      <StepUpDialog />
    </>
  );
}
